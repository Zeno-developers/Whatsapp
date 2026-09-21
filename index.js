const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const preferredEnvFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env'
const envFile = fs.existsSync(path.join(__dirname, preferredEnvFile)) ? preferredEnvFile : '.env'

require('dotenv').config({ path: path.join(__dirname, envFile) })

// Suppress libsignal/Baileys noise that prints directly to stdout/stderr,
// bypassing our structured logger. Covers: session key dumps, Bad MAC walls,
// "error in sending message again" on stale queued retries.
const _NOISE_LOG = /Closing session|Opening session|Closing open session|Failed to decrypt message with any known session/i
const _NOISE_ERR = /Session error|Bad MAC|PreKeyError|SessionError|failed to decrypt|No session record|Invalid PreKey|Timed Out|error in sending message again/i
// Temporary escape hatch for diagnosing the "waiting for this message"
// delivery issue — set WA_DEBUG_ALL=1 to see the real session/decrypt
// errors this filter normally hides. Remove once diagnosed.
const _DEBUG_ALL = process.env.WA_DEBUG_ALL === '1'

const _log = console.log
console.log = (...a) => {
  const first = typeof a[0] === 'string' ? a[0] : ''
  if (!_DEBUG_ALL && _NOISE_LOG.test(first)) return
  _log(...a)
}

const _err = console.error
console.error = (...a) => {
  const s = a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')
  if (!_DEBUG_ALL && _NOISE_ERR.test(s)) return
  _err(...a)
}

// libsignal bypasses console and writes directly to process.stdout
const _stdoutWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, encoding, cb) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString()
  if (!_DEBUG_ALL && (_NOISE_LOG.test(s) || _NOISE_ERR.test(s))) {
    if (typeof encoding === 'function') encoding()
    else if (typeof cb === 'function') cb()
    return true
  }
  return _stdoutWrite(chunk, encoding, cb)
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const QRCode = require('qrcode')
const express = require('express')
const cron = require('node-cron')

const app = express()
// Default (~100kb) is far too small for a base64-encoded report/certificate
// PDF attachment sent via /send.
app.use(express.json({ limit: '20mb' }))

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000'
const WEBHOOK_URL = process.env.WHATSAPP_STATUS_WEBHOOK_URL || `${BACKEND_URL}/api/v1/webhooks/whatsapp/status`
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || process.env.CRON_SECRET || ''
const DOWN_GRACE_MS = Math.max(parseInt(process.env.WHATSAPP_DOWN_GRACE_MS || '60000', 10), 1000)

// Shared files PHP reads to show QR status
const STATUS_FILE = path.join(__dirname, 'wa_status.txt')
const QR_FILE = path.join(__dirname, 'wa_qr.png')
const AUTH_DIR = path.join(__dirname, '.wa_auth')
const LOCK_FILE = path.join(__dirname, '.wa_service.lock')

function writeStatus(status) {
  try { fs.writeFileSync(STATUS_FILE, status, 'utf8') } catch { }
}

function readStatus() {
  try {
    return fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

async function writeQrFile(qrString) {
  try {
    const buf = await QRCode.toBuffer(qrString, { width: 300, margin: 2 })
    fs.writeFileSync(QR_FILE, buf)
    writeStatus('qr')
  } catch (err) {
    console.error('[wa] Failed to write QR file:', err.message)
  }
}

function clearAuthState() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
      console.log('[wa] Auth state cleared automatically')
    }
  } catch (err) {
    console.error('[wa] Failed to clear auth state:', err.message)
  }
}

async function resetWhatsAppSession() {
  isReady = false
  latestQr = null
  writeStatus('resetting')
  try { fs.unlinkSync(QR_FILE) } catch { }

  try {
    if (sock?.end) {
      sock.end(undefined)
    }
  } catch (err) {
    console.warn('[wa] Socket end during reset failed:', err.message)
  }

  clearAuthState()
  await connectToWhatsApp()
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireSingleInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = fs.readFileSync(LOCK_FILE, 'utf8').trim()
      if (existingPid && isProcessRunning(Number(existingPid))) {
        console.warn(`[wa] Another WhatsApp service instance is already running (PID ${existingPid}). Exiting.`)
        process.exit(0)
      }
      fs.rmSync(LOCK_FILE, { force: true })
    }

    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8')
    console.log(`[wa] Single-instance lock acquired (PID ${process.pid})`)
  } catch (err) {
    console.error('[wa] Failed to acquire single-instance lock:', err.message)
    process.exit(1)
  }
}

function releaseSingleInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.rmSync(LOCK_FILE, { force: true })
    }
  } catch (err) {
    console.warn('[wa] Failed to release single-instance lock:', err.message)
  }
}

process.on('exit', releaseSingleInstanceLock)
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// ─── Persistent message store ─────────────────────────────────────────────────
// Survives restarts so getMessage() never returns blank hours later.
const STORE_FILE = path.join(__dirname, '.wa_auth', 'msg_store.json')
let msgStore = {}

function loadMsgStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      msgStore = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
      console.log(`[wa] Message store loaded — ${Object.keys(msgStore).length} entries`)
    }
  } catch (err) {
    console.warn('[wa] Could not load message store:', err.message)
    msgStore = {}
  }
}

let _storeTimer = null
function saveMsgStore() {
  if (_storeTimer) return
  _storeTimer = setTimeout(() => {
    _storeTimer = null
    try {
      const keys = Object.keys(msgStore)
      if (keys.length > 2000) {
        const trimmed = {}
        keys.slice(-2000).forEach(k => { trimmed[k] = msgStore[k] })
        msgStore = trimmed
      }
      fs.writeFileSync(STORE_FILE, JSON.stringify(msgStore), 'utf8')
    } catch (err) {
      console.warn('[wa] Could not save message store:', err.message)
    }
  }, 500)
}

loadMsgStore()

let isReady = false
let latestQr = null
let sock = null
let settlingUntil = 0  // timestamp until which the session is still stabilising after reconnect
let lifecycleStatus = null
let downTimer = null

// Silent logger — Baileys is extremely verbose by default
// PreKeyError / SessionError / "failed to decrypt" are expected noise after a reconnect:
// old messages in the queue were encrypted with pre-keys that are no longer in the store.
// They don't affect sending and cannot be fixed at runtime — clear .wa_auth to reset.
const DECRYPT_NOISE = /PreKeyError|SessionError|failed to decrypt|No session record|Invalid PreKey|unexpected error in 'init queries'|Timed Out|error in sending message again|Bad MAC|remoteJid.*undefined/i

const logger = {
  level: 'silent',
  child: () => logger,
  trace: () => { }, debug: () => { }, info: () => { },
  warn: (...a) => {
    const s = a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')
    if (DECRYPT_NOISE.test(s)) return
    console.warn('[wa]', ...a)
  },
  error: (...a) => {
    const s = a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')
    if (DECRYPT_NOISE.test(s)) return
    console.error('[wa]', ...a)
  },
  fatal: (...a) => console.error('[wa]', ...a),
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const { version } = await fetchLatestBaileysVersion().catch(() => ({
    version: [2, 3000, 1015901307],
  }))

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['GMR Server', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    getMessage: async (key) => {
      return msgStore[key.id] || { conversation: '' }
    },
  })

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (msg.key?.id && msg.message) {
        msgStore[msg.key.id] = msg.message
      }
    }
    saveMsgStore()
  })

  // Track actual delivery — status 2=server ACK, 3=delivered to device, 4=read
  const STATUS_LABEL = { 0: 'ERROR', 1: 'PENDING', 2: 'SERVER_ACK', 3: 'DELIVERED', 4: 'READ', 5: 'PLAYED' }
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (update?.status !== undefined && key?.fromMe) {
        const label = STATUS_LABEL[update.status] ?? `STATUS_${update.status}`
        const recipient = key.remoteJid?.split('@')[0] ?? '?'
        console.log(`[wa] Delivery update → ${recipient}: ${label}`)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      latestQr = qr
      console.log('\nNew QR code received — writing to wa_qr.png\n')
      qrcode.generate(qr, { small: true })
      writeQrFile(qr)
    }

    if (connection === 'close') {
      isReady = false
      writeStatus('waiting')
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      console.warn('[wa] Connection closed:', JSON.stringify({
        ...describeError(lastDisconnect?.error),
        statusCode,
        loggedOut,
      }))
      scheduleDownReport(lastDisconnect?.error)
      if (loggedOut) {
        clearAuthState()
        console.log('[wa] Logged out. A fresh session will be created automatically.')
        setTimeout(() => {
          connectToWhatsApp().catch(err => {
            console.error('[wa] Reconnect after auth reset failed:', err.message)
            writeStatus('error: ' + err.message)
          })
        }, 5_000)
      } else {
        console.log('[wa] Reconnecting in 10s...')
        setTimeout(connectToWhatsApp, 10_000)
      }
    } else if (connection === 'open') {
      if (downTimer) {
        clearTimeout(downTimer)
        downTimer = null
      }
      isReady = true
      settlingUntil = Date.now() + 8_000  // give the Signal session 8s to fully stabilise
      latestQr = null
      writeStatus('connected')
      try { fs.unlinkSync(QR_FILE) } catch { }
      console.log('WhatsApp client ready — GMR messaging is now active')
      reportLifecycle('up')
    }
  })
}

acquireSingleInstanceLock()
writeStatus('starting')
connectToWhatsApp().catch(err => {
  console.error('[wa] Fatal init error:', err.message)
  writeStatus('error: ' + err.message)
})

// Normalize SA phone to Baileys JID format
// 0760803332 → 27760803332@s.whatsapp.net
function toWhatsAppJid(phone) {
  phone = phone.replace(/[\s\-()]/g, '')
  if (phone.startsWith('+')) phone = phone.slice(1)
  if (phone.startsWith('0')) phone = '27' + phone.slice(1)
  return phone + '@s.whatsapp.net'
}

function sanitizeWhatsAppText(message) {
  return String(message)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function describeError(error) {
  if (!error) return { message: 'unknown error' }
  return {
    name: error.name,
    message: error.message,
    statusCode: error.output?.statusCode,
    stack: error.stack,
  }
}

async function reportLifecycle(status, error) {
  if (lifecycleStatus === status || !WEBHOOK_SECRET) return

  const payload = {
    status,
    reason: status === 'down' ? 'connection_closed' : 'connection_open',
    error_code: error?.output?.statusCode || null,
    occurred_at: new Date().toISOString(),
  }
  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Timestamp': timestamp,
      },
      body,
    })
    if (!response.ok) {
      console.warn(`[wa] Lifecycle webhook returned HTTP ${response.status}`)
      return
    }
    lifecycleStatus = status
  } catch (webhookError) {
    console.warn('[wa] Lifecycle webhook failed:', webhookError.message)
  }
}

function scheduleDownReport(error) {
  if (downTimer) clearTimeout(downTimer)
  downTimer = setTimeout(() => {
    downTimer = null
    reportLifecycle('down', error)
  }, DOWN_GRACE_MS)
}

app.get('/status', (req, res) => {
  const fileStatus = readStatus()
  res.json({
    ready: isReady,
    status: isReady ? 'connected' : (latestQr ? 'qr' : (fileStatus || 'waiting')),
    hasQr: !isReady && !!latestQr,
    uptime: Math.floor(process.uptime()),
  })
})

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    ready: isReady,
    status: readStatus() || (isReady ? 'connected' : 'waiting'),
    uptime: Math.floor(process.uptime()),
  })
})

// Returns the QR as a raw PNG image (for PHP to fetch and embed)
// 200 = QR image, 204 = connected (no content), 202 = not ready yet
app.get('/qr.png', async (req, res) => {
  if (isReady) return res.status(204).end()
  if (!latestQr) {
    try {
      if (fs.existsSync(QR_FILE)) {
        return res.set('Content-Type', 'image/png').send(fs.readFileSync(QR_FILE))
      }
    } catch (err) {
      console.warn('[wa] Could not serve QR file fallback:', err.message)
    }
    return res.status(202).end()
  }
  try {
    const buf = await QRCode.toBuffer(latestQr, { width: 280, margin: 2 })
    res.set('Content-Type', 'image/png').send(buf)
  } catch (err) {
    res.status(500).end()
  }
})

app.post('/reset-auth', async (req, res) => {
  const expected = process.env.CRON_SECRET || process.env.WHATSAPP_SERVICE_SECRET || ''
  const provided = req.header('x-cron-secret') || req.header('x-whatsapp-secret') || ''

  if (!expected || provided !== expected) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    await resetWhatsAppSession()
    res.json({ success: true, status: readStatus() || 'resetting' })
  } catch (err) {
    console.error('[wa] Reset auth failed:', err.message)
    writeStatus('error: ' + err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─── Serialized send queue ──────────────────────────────────────────────
// Baileys holds one Signal Protocol session per socket — sending several
// messages/documents concurrently (e.g. a learner's transcript plus a
// handful of distinction certificates, arriving as separate /send requests
// close together once a learner has enough of them) races that shared
// session state. That's exactly what the DECRYPT_NOISE filter above is
// already hiding symptoms of (Bad MAC, SessionError, PreKeyError), and
// concurrent large document uploads sharing one socket also just time out
// under load. Every send — text or document, to any recipient — now goes
// through this single FIFO queue so only one is ever in flight, with a
// short settle delay after each one finishes before the next starts
// (Baileys' internal session bookkeeping isn't fully done the instant
// sendMessage's promise resolves).
let sendQueue = Promise.resolve()
const SEND_SETTLE_MS = Math.max(parseInt(process.env.WHATSAPP_SEND_SETTLE_MS || '1500', 10), 0)
// If a send neither resolves nor rejects (a real Baileys/WebSocket failure
// mode — a dropped connection doesn't always surface as an error), waiting
// on it forever would wedge this entire FIFO: every send behind it, for
// every recipient, would queue up permanently. Below Laravel's 120s
// document HTTP timeout so PHP gets a real error response instead of its
// own connection timeout firing first.
const SEND_TASK_TIMEOUT_MS = Math.max(parseInt(process.env.WHATSAPP_SEND_TASK_TIMEOUT_MS || '90000', 10), 1000)

function enqueueSend(task) {
  const run = sendQueue.then(async () => {
    const taskPromise = task()
    // We stop *waiting* on taskPromise below if it doesn't settle in time,
    // but we never cancel it (Baileys gives no way to). If it rejects late,
    // after we've moved on, nothing would otherwise be listening — without
    // this it's an unhandled rejection, which crashes recent Node by default.
    taskPromise.catch(() => {})

    let timeoutId
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Send timed out after ${SEND_TASK_TIMEOUT_MS}ms — a previous WhatsApp operation may be stuck`))
      }, SEND_TASK_TIMEOUT_MS)
    })

    try {
      return await Promise.race([taskPromise, timeoutPromise])
    } finally {
      clearTimeout(timeoutId)
      if (SEND_SETTLE_MS > 0) {
        await new Promise(resolve => setTimeout(resolve, SEND_SETTLE_MS))
      }
    }
  })
  // Keep the chain alive even when this task rejects, so one failed send
  // doesn't stall every send queued behind it forever.
  sendQueue = run.catch(() => {})
  return run
}

app.post('/send', async (req, res) => {
  // Opt-in auth: unlike /reset-auth (always locked down), /send stays open
  // — matching today's behaviour — until WHATSAPP_SERVICE_SECRET (or
  // CRON_SECRET) is actually set in this service's env, so deploying this
  // check doesn't break Laravel until both sides are configured and
  // restarted together.
  const expectedSendSecret = process.env.WHATSAPP_SERVICE_SECRET || process.env.CRON_SECRET || ''
  if (expectedSendSecret) {
    const providedSendSecret = req.header('x-whatsapp-secret') || req.header('x-cron-secret') || ''
    if (providedSendSecret !== expectedSendSecret) {
      return res.status(403).json({ error: 'Forbidden' })
    }
  }

  const { phone, message, document, fileName, mimetype } = req.body

  // A document send may carry no caption at all; a text-only send still
  // requires a message.
  if (!phone || (!message && !document)) {
    return res.status(400).json({ error: 'phone and (message or document) are required' })
  }

  if (!isReady || !sock) {
    return res.status(503).json({ error: 'WhatsApp client not connected — scan the QR code first' })
  }

  const remaining = settlingUntil - Date.now()
  if (remaining > 0) {
    console.warn(`[wa] Send rejected — session still settling (${Math.ceil(remaining / 1000)}s left)`)
    return res.status(503).json({
      error: 'WhatsApp session is stabilising after reconnect — please retry in a few seconds',
      retryAfterSeconds: Math.ceil(remaining / 1000),
    })
  }

  const jid = toWhatsAppJid(phone)

  // SA numbers must be 11 digits after normalisation (27 + 9 digits)
  const digits = jid.replace('@s.whatsapp.net', '')
  if (!/^27\d{9}$/.test(digits)) {
    console.error(`[wa] Rejected invalid SA number: ${phone} → ${digits}`)
    return res.status(400).json({ error: `Invalid SA phone number: ${phone} (normalised to ${digits})` })
  }

  // Validate up front, before this request even joins the send queue, so a
  // bad payload fails fast instead of waiting in line behind other sends.
  let buffer = null
  let text = null
  if (document) {
    try {
      buffer = Buffer.from(document, 'base64')
    } catch {
      return res.status(400).json({ error: 'document must be base64-encoded' })
    }
    if (!buffer.length) {
      return res.status(400).json({ error: 'document is empty' })
    }
  } else {
    text = sanitizeWhatsAppText(message)
    if (!text) {
      return res.status(400).json({ error: 'message is empty after removing links' })
    }
  }

  try {
    const { sent, storeEntry } = await enqueueSend(async () => {
      if (document) {
        const caption = message ? sanitizeWhatsAppText(message) : undefined
        const sentMsg = await sock.sendMessage(jid, {
          document: buffer,
          fileName: fileName || 'document.pdf',
          mimetype: mimetype || 'application/pdf',
          caption,
        })
        return { sent: sentMsg, storeEntry: { conversation: caption || fileName || 'document' } }
      }

      const sentMsg = await sock.sendMessage(jid, { text }, { linkPreview: false })
      return { sent: sentMsg, storeEntry: { conversation: text } }
    })

    if (sent?.key?.id) {
      msgStore[sent.key.id] = storeEntry
      saveMsgStore()
    }
    console.log(`[wa] Queued → ${phone} (${document ? 'document' : 'text'}, awaiting delivery ACK)`)
    res.json({ sent: true, to: phone, message_id: sent?.key?.id || null })
  } catch (err) {
    console.error(`[wa] Failed to send to ${phone}:`, JSON.stringify(describeError(err)))
    res.status(500).json({ error: err.message })
  }
})

// ─── Cron helpers ────────────────────────────────────────────────────────────
const CRON_SECRET = process.env.CRON_SECRET || ''

async function cronPost(url, label) {
  if (!CRON_SECRET) {
    console.warn(`[cron] CRON_SECRET not set — skipping ${label}`)
    return
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': CRON_SECRET },
    })
    const text = await res.text()
    let body = {}
    try { body = text ? JSON.parse(text) : {} } catch { body = { message: text } }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    console.error(`[cron] ${label} fetch error:`, err.message)
    return null
  }
}


function startKeepAwake(serverPort) {
  const enabled = String(process.env.KEEP_ALIVE_ENABLED || 'true').toLowerCase() !== 'false'
  if (!enabled) {
    console.log('[keep-awake] Disabled by KEEP_ALIVE_ENABLED=false')
    return
  }

  const intervalMs = Math.max(parseInt(process.env.KEEP_ALIVE_INTERVAL_MS || '240000', 10), 60_000)
  const host = process.env.HOST || '0.0.0.0'
  const localHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const url = process.env.KEEP_ALIVE_URL || `http://${localHost}:${serverPort}/healthz`

  async function ping() {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) {
        console.warn(`[keep-awake] Ping returned HTTP ${res.status}: ${url}`)
      }
    } catch (err) {
      console.warn(`[keep-awake] Ping failed: ${err.message}`)
    }
  }

  setInterval(ping, intervalMs)
  setTimeout(ping, 10_000)
  console.log(`[keep-awake] Pinging ${url} every ${Math.round(intervalMs / 1000)}s`)
}

function startServer(port, maxPort) {
  const host = process.env.HOST || '0.0.0.0'
  const server = app.listen(port, host, () => {
    console.log(`WhatsApp service HTTP running on ${host}:${port}`)
    startKeepAwake(port)
  })
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < maxPort) {
      console.warn(`[wa] Port ${port} in use, trying ${port + 1}...`)
      startServer(port + 1, maxPort)
    } else {
      console.warn(`[wa] HTTP server could not start (${err.message}) — file-based QR still works`)
    }
  })
}

const PORT = parseInt(process.env.PORT || '3002', 10)
startServer(PORT, PORT + 10)
