import http from 'node:http'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { decodeAudioFrame, PROTOCOL_VERSION, parseClientMessage, type ServerMessage } from '@spiegel/shared'
import { config, validateConfig } from './config'
import { log } from './log'
import { Session } from './session/session'
import { renderReportHtml } from './report/html'
import { FileStore } from './store/fileStore'
import { createSttAdapter } from './stt'

const problems = validateConfig()
if (problems.length) {
  for (const p of problems) log.error(p)
  process.exit(1)
}

const adapter = createSttAdapter()
const store = config.persistTranscripts ? new FileStore(path.join(config.dataDir, 'sessions')) : null
if (config.devAudioDump) log.warn('DEV_AUDIO_DUMP=true: Clients dürfen Rohaudio zu Testzwecken mitschneiden.')
if (!config.analysis.enabled) log.warn('Analyse aus (kein ANTHROPIC_API_KEY oder ANALYSIS_ENABLED=false): nur Transkription.')

// ---------- HTTP: Sessions lesen/löschen (Companion-UI, Bench) ----------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true, stt: adapter.name, persist: Boolean(store), analysis: config.analysis.enabled })

  const rep = url.pathname.match(/^\/report\/([a-zA-Z0-9_-]+)$/)
  if (rep && req.method === 'GET') {
    const rec = store ? await store.load(rep[1]!) : null
    if (!rec) return json(res, 404, { error: 'nicht gefunden' })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS })
    return res.end(renderReportHtml(rec))
  }

  const m = url.pathname.match(/^\/api\/sessions(?:\/([a-zA-Z0-9_-]+))?$/)
  if (m) {
    if (!store) return json(res, 200, m[1] ? null : [])
    const id = m[1]
    if (!id && req.method === 'GET') return json(res, 200, await store.list())
    if (id && req.method === 'GET') {
      const rec = await store.load(id)
      return rec ? json(res, 200, rec) : json(res, 404, { error: 'nicht gefunden' })
    }
    if (id && req.method === 'DELETE') {
      const ok = await store.delete(id)
      log.info(`session ${id}: ${ok ? 'gelöscht' : 'Löschen fehlgeschlagen (nicht vorhanden)'}`)
      return json(res, ok ? 200 : 404, { deleted: ok })
    }
  }
  json(res, 404, { error: 'unbekannter Pfad' })
})

// ---------- WebSocket: Brillen-App / Bench ----------

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws: WebSocket, req) => {
  const peer = req.socket.remoteAddress ?? '?'
  let session: Session | null = null
  let wantDump = false
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  log.info(`client verbunden (${peer})`)
  send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, sttProvider: adapter.name, debugDumpAvailable: config.devAudioDump })
  send({ type: 'session.state', state: 'idle', sessionId: null, startedAt: null, debugDump: false })

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])
      const frame = decodeAudioFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      if (frame && session) session.onAudio(frame)
      return
    }
    const msg = parseClientMessage(data.toString())
    if (!msg) return send({ type: 'error', message: 'unlesbare Nachricht', fatal: false })
    switch (msg.type) {
      case 'hello':
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          send({ type: 'error', message: `Protokollversion ${msg.protocolVersion} passt nicht zu ${PROTOCOL_VERSION}`, fatal: true })
        }
        break
      case 'session.start':
        if (session && session.state === 'active') return send({ type: 'error', message: 'Session läuft bereits', fatal: false })
        session = new Session(adapter, send, store, msg.language)
        if (wantDump) session.setDebugDump(true)
        send({ type: 'session.state', state: 'active', sessionId: session.id, startedAt: session.startedAt.toISOString(), debugDump: session.debugDump })
        break
      case 'session.stop':
        if (session) await session.stop()
        else send({ type: 'session.state', state: 'idle', sessionId: null, startedAt: null, debugDump: false })
        break
      case 'debug.dump':
        wantDump = Boolean(msg.enabled) && config.devAudioDump
        session?.setDebugDump(wantDump)
        if (msg.enabled && !config.devAudioDump) send({ type: 'error', message: 'DEV_AUDIO_DUMP ist auf dem Server nicht aktiviert', fatal: false })
        break
    }
  })

  ws.on('close', () => {
    log.info(`client getrennt (${peer})`)
    // Client weg (z. B. Even App geschlossen): Session sauber abschließen und speichern.
    if (session && session.state === 'active') void session.stop()
  })
  ws.on('error', err => log.warn('ws-Fehler', err.message))
})

server.listen(config.port, () => {
  log.info(`Kommunikations-Spiegel Server: http://localhost:${config.port}  ws://localhost:${config.port}/ws  (stt=${adapter.name})`)
})
