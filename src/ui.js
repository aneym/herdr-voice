#!/usr/bin/env node
/**
 * Thin HUD client — renders the voice HUD inside a herdr pane (or any terminal)
 * by mirroring events from a running engine over its control socket.
 * All heavy lifting (mic, speakers, Realtime, tools) happens in the engine on
 * the machine with the microphone; this process just draws and relays input.
 */
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { VoiceHUD } from './hud.js'

const CTL_SOCK =
  process.argv.includes('--ctl')
    ? process.argv[process.argv.indexOf('--ctl') + 1]
    : process.env.HERDR_VOICE_CTL || path.join(os.homedir(), '.cache/herdr-voice/ctl.sock')

const hud = new VoiceHUD({ sessionName: 'engine', model: 'voice' }).start()

let sock = null
let closed = false
let retries = 0

function connect() {
  if (closed) return
  sock = net.createConnection(CTL_SOCK)
  sock.setEncoding('utf8')
  let buf = ''

  sock.on('connect', () => {
    retries = 0
  })
  sock.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const fn = hud[msg.m]
      if (typeof fn === 'function') fn.apply(hud, msg.a ?? [])
    }
  })
  const onDown = () => {
    if (closed) return
    hud.setStatus({ state: retries === 0 ? 'engine gone' : 'waiting for engine' })
    if (retries === 0) hud.addSystem('engine not reachable — start voice (prefix+m) or herdr-voice-mac')
    retries++
    setTimeout(connect, Math.min(5000, 500 * retries))
  }
  sock.on('error', onDown)
  sock.on('close', onDown)
}
connect()

const send = (cmd, extra = {}) => {
  try {
    sock?.write(JSON.stringify({ cmd, ...extra }) + '\n')
  } catch {
    /* engine down; reconnect loop is already running */
  }
}

hud.on('toggle-mic', () => send('toggle-mic'))
hud.on('toggle-sound', () => send('toggle-sound'))
hud.on('toggle-text', () => hud.setText(!hud.textOn)) // purely local
hud.on('copy', () => send('copy'))
hud.on('copy-all', () => send('copy-all'))
hud.on('submit', (text) => send('submit', { text }))
hud.on('quit', () => {
  closed = true
  sock?.destroy()
  hud.stop()
  process.exit(0)
})
process.on('SIGTERM', () => {
  closed = true
  hud.stop()
  process.exit(0)
})
