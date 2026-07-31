#!/usr/bin/env node
/**
 * Headless voice engine — runs on the machine with the microphone (the MacBook).
 * Holds the Realtime session, mic, speakers, tool execution, and transcript.
 * UI clients (the herdr HUD pane, possibly several) attach over a unix control
 * socket and receive every UI event as JSON lines; they send back commands.
 *
 * Protocol:
 *   engine -> ui : {m:"addUser", a:[...]}          (HUD surface method calls)
 *   ui -> engine : {cmd:"toggle-mic"|"toggle-sound"|"copy"|"copy-all"|
 *                   "submit"|"stop", text?}
 * New clients get a state snapshot replay on connect.
 */
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadApiKey, resolveSocket } from './config.js'
import { HerdrClient } from './herdr.js'
import { startCore } from './core.js'

const CTL_DIR = path.join(os.homedir(), '.cache/herdr-voice')
const CTL_SOCK = process.env.HERDR_VOICE_CTL || path.join(CTL_DIR, 'ctl.sock')

function parseArgs(argv) {
  const out = { session: undefined, socket: undefined, mic: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session') out.session = argv[++i]
    else if (a === '--socket') out.socket = argv[++i]
    else if (a === '--no-mic') out.mic = false
    else if (a === '--device') out.device = argv[++i]
  }
  return out
}

/** Implements the HUD surface; broadcasts each call and keeps a replayable snapshot. */
class Broadcaster {
  constructor() {
    this.clients = new Set()
    this.state = {} // latest per sticky method
    this.feed = [] // replayable event log (bounded)
  }
  _send(client, msg) {
    try {
      client.write(JSON.stringify(msg) + '\n')
    } catch {
      /* dead client; cleaned up on close */
    }
  }
  emitCall(m, ...a) {
    const msg = { m, a }
    const STICKY = new Set(['setStatus', 'setMic', 'setSound', 'setSpeaking', 'setPartial', 'setHerdrState'])
    if (STICKY.has(m)) this.state[m] = msg
    else {
      this.feed.push(msg)
      if (this.feed.length > 400) this.feed.splice(0, this.feed.length - 400)
    }
    for (const c of this.clients) this._send(c, msg)
  }
  attach(client) {
    this.clients.add(client)
    for (const msg of Object.values(this.state)) this._send(client, msg)
    for (const msg of this.feed) this._send(client, msg)
    this._send(client, { m: 'notify', a: ['connected to engine'] })
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { name: sessionName, socket, exists } = resolveSocket(opts)
  if (!exists) {
    console.error(`herdr socket not found at ${socket}`)
    process.exit(1)
  }
  const { value: apiKey } = loadApiKey()
  const herdr = new HerdrClient(socket)
  await herdr.connect()

  const bc = new Broadcaster()
  const ui = new Proxy(
    {},
    { get: (_, m) => (typeof m === 'string' ? (...a) => bc.emitCall(m, ...a) : undefined) }
  )

  const core = await startCore({
    herdr,
    ui,
    apiKey,
    mode: 'voice',
    wantMic: opts.mic,
    micDevice: opts.device,
  })

  // control socket
  fs.mkdirSync(CTL_DIR, { recursive: true })
  fs.rmSync(CTL_SOCK, { force: true })
  const server = net.createServer((client) => {
    client.setEncoding('utf8')
    let buf = ''
    bc.attach(client)
    client.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let cmd
        try {
          cmd = JSON.parse(line)
        } catch {
          continue
        }
        handleCommand(cmd)
      }
    })
    const drop = () => {
      bc.clients.delete(client)
      // Ephemeral-HUD safety: no attached UI means no visible mic indicator,
      // so never leave a hot mic running unwatched.
      if (bc.clients.size === 0 && core.micLive) {
        core.muteMic()
        bc.emitCall('notify', 'mic muted — HUD closed')
      }
    }
    client.on('close', drop)
    client.on('error', drop)
  })
  server.listen(CTL_SOCK)
  console.log(`engine up: session=${sessionName} ctl=${CTL_SOCK} pid=${process.pid}`)

  function handleCommand(cmd) {
    switch (cmd.cmd) {
      case 'toggle-mic':
        return core.toggleMic()
      case 'toggle-sound':
        return core.toggleSound()
      case 'copy':
        return core.copy(false)
      case 'copy-all':
        return core.copy(true)
      case 'submit':
        if (typeof cmd.text === 'string' && cmd.text.trim()) core.submit(cmd.text.trim())
        return
      case 'stop':
        return shutdown()
    }
  }

  const shutdown = () => {
    core.stop()
    herdr.close()
    server.close()
    fs.rmSync(CTL_SOCK, { force: true })
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('engine failed:', err.message)
  process.exit(1)
})
