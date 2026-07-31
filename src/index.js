#!/usr/bin/env node
import { loadApiKey, resolveSocket, MODEL } from './config.js'
import { HerdrClient } from './herdr.js'
import { RealtimeSession } from './realtime.js'
import { MicCapture, AudioPlayer } from './audio.js'
import { VoiceTUI } from './tui.js'
import { VoiceHUD } from './hud.js'
import { TranscriptStore, copyToClipboard } from './transcript.js'
import { createExecutor, readState } from './tools.js'

function parseArgs(argv) {
  const out = { session: undefined, socket: undefined, mode: 'voice', mic: true, hud: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session') out.session = argv[++i]
    else if (a === '--socket') out.socket = argv[++i]
    else if (a === '--text') out.mode = 'text'
    else if (a === '--no-mic') out.mic = false
    else if (a === '--hud') out.hud = true
    else if (a === '--full') out.hud = false
    else if (a === '--device') out.device = argv[++i]
  }
  return out
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { name: sessionName, socket, exists } = resolveSocket({
    session: opts.session,
    socket: opts.socket,
  })
  if (!exists) {
    console.error(`herdr session "${sessionName}" not found at ${socket}`)
    console.error('Start it first, or pass --session <name> / --socket <path>.')
    process.exit(1)
  }
  const { value: apiKey } = loadApiKey()

  const herdr = new HerdrClient(socket)
  await herdr.connect()

  const transcript = new TranscriptStore()
  const ui = opts.hud
    ? new VoiceHUD({ sessionName, model: MODEL })
    : new VoiceTUI({ sessionName, model: MODEL })
  ui.start()
  const player = new AudioPlayer().start()
  let soundOn = true

  const refreshState = async () => {
    try {
      const state = await readState(herdr)
      ui.setHerdrState({
        spaces: (state.snapshot.workspaces ?? []).map((w) => ({
          name: w.label,
          number: w.number,
          current: w.workspace_id === state.snapshot.focused_workspace_id,
        })),
        agents: (state.agents ?? []).map((a) => ({ name: a.name, status: a.status })),
      })
    } catch {
      /* transient — the next refresh will catch up */
    }
  }
  await refreshState()
  herdr
    .subscribe([
      'workspace.created',
      'workspace.closed',
      'workspace.renamed',
      'workspace.focused',
      'workspace.updated',
      'tab.created',
      'tab.closed',
      'pane.created',
      'pane.closed',
      'pane.focused',
    ])
    .on('herdr-event', () => refreshState())
  const stateTimer = setInterval(refreshState, 4000)

  const execute = createExecutor(herdr, {
    onNotice: (m) => {
      ui.addSystem(m)
      transcript.system(m)
    },
  })
  const session = new RealtimeSession({ apiKey, mode: opts.mode })

  session.on('status', (s) => {
    ui.setStatus(s)
    if (s.state === 'error') {
      ui.addSystem(`error: ${s.message}`)
      transcript.system(`error: ${s.message}`)
    }
    if (s.state === 'ready') ui.addSystem('connected — say or type a command')
  })
  session.on('speech', ({ active }) => ui.setSpeaking(active))
  session.on('user_partial', ({ text }) => ui.setPartial?.(text))
  session.on('user_transcript', ({ text, done }) => {
    if (!text) return
    ui.addUser(text, { done })
    if (done) transcript.user(text)
  })
  session.on('assistant_delta', ({ text }) => ui.updateAssistant(text, false))
  session.on('assistant_done', ({ text }) => {
    ui.updateAssistant(text, true)
    if (text) transcript.assistant(text)
  })
  session.on('audio', (b64) => {
    if (soundOn) player.play(b64)
  })

  session.on('tool_call', async ({ name, callId, args }) => {
    ui.addToolCall({ callId, name, args })
    try {
      const result = await execute(name, args)
      ui.updateToolCall(callId, {
        result: summarizeResult(result),
        error: result?.ok === false && !result.confirmation_required ? result.error : undefined,
      })
      transcript.tool(name, args, result)
      session.sendToolResult(callId, result)
      refreshState()
    } catch (err) {
      ui.updateToolCall(callId, { error: err.message })
      transcript.tool(name, args, { ok: false, error: err.message })
      session.sendToolResult(callId, { ok: false, error: err.message })
    }
  })

  session.connect()

  // ---- mic ----
  let mic = null
  if (opts.mic && opts.mode === 'voice') {
    const devices = await MicCapture.listDevices()
    const picked = MicCapture.pickDevice(devices)
    if (!picked && !opts.device) {
      ui.setMic({ available: false })
      ui.addSystem(
        devices.length
          ? `only virtual audio devices found (${devices.map((d) => d.name).join(', ')}) — no real microphone. Text input works.`
          : 'no microphone available — grant mic permission to this terminal (System Settings > Privacy & Security > Microphone). Text input still works.'
      )
    } else {
      const device = opts.device ?? `:${picked.index}`
      mic = new MicCapture({ device }).start()
      ui.setMic({ available: true, muted: true })
      ui.addSystem(`mic: ${opts.device ?? picked.name} — tab or click to unmute`)
      mic.on('chunk', (b64) => session.sendAudio(b64))
      mic.on('level', (l) => ui.setMic({ level: l }))
      mic.on('error', (e) => {
        ui.setMic({ available: false })
        ui.addSystem(`mic error: ${e.message}`)
      })
    }
  } else {
    ui.setMic({ available: false })
  }

  // ---- UI events ----
  const toggleMic = () => {
    if (!mic) return
    const next = !mic.muted
    mic.setMuted(next)
    ui.setMic({ muted: next, level: 0 })
  }
  ui.on('toggle-mic', toggleMic)
  ui.on('toggle-mute', toggleMic) // legacy name from the full TUI
  ui.on('toggle-sound', () => {
    soundOn = !soundOn
    ui.setSound?.(soundOn)
    ui.notify?.(soundOn ? 'voice on' : 'voice off')
  })
  ui.on('toggle-text', () => {
    ui.setText?.(!(ui.textOn ?? true))
  })
  ui.on('copy', async () => {
    const ok = await copyToClipboard(transcript.lastExchangeText())
    ui.notify?.(ok ? 'copied last exchange' : 'copy failed (no pbcopy?)')
  })
  ui.on('copy-all', async () => {
    const ok = await copyToClipboard(transcript.asText())
    ui.notify?.(ok ? 'copied full transcript' : 'copy failed (no pbcopy?)')
  })
  ui.on('submit', (text) => {
    transcript.user(text, { typed: true })
    session.sendText(text)
  })

  const shutdown = () => {
    clearInterval(stateTimer)
    mic?.stop()
    player.stop()
    session.close()
    herdr.close()
    ui.stop()
    process.exit(0)
  }
  ui.on('quit', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function summarizeResult(r) {
  if (!r || typeof r !== 'object') return String(r)
  if (r.confirmation_required) return 'needs confirmation'
  if (r.ok === false) return ''
  const keys = Object.keys(r).filter((k) => k !== 'ok' && r[k] !== undefined && r[k] !== null)
  if (!keys.length) return 'ok'
  return keys
    .slice(0, 4)
    .map((k) => {
      const v = r[k]
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      return `${k}=${s.length > 60 ? s.slice(0, 60) + '…' : s}`
    })
    .join(' ')
}

main().catch((err) => {
  process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')
  console.error(err)
  process.exit(1)
})
