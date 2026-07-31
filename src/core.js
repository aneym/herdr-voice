import { RealtimeSession } from './realtime.js'
import { MicCapture, AudioPlayer } from './audio.js'
import { createExecutor, readState } from './tools.js'
import { TranscriptStore, copyToClipboard } from './transcript.js'

/**
 * Shared voice-core wiring used by both process shapes:
 *  - index.js  — UI and engine in one process (the standalone floating window)
 *  - engine.js — headless engine broadcasting to remote HUD clients
 *
 * `ui` is anything implementing the HUD surface (VoiceHUD, VoiceTUI, or the
 * engine's broadcaster): setStatus/setMic/setSound/setSpeaking/setPartial/
 * notify/addUser/updateAssistant/addSystem/addToolCall/updateToolCall/
 * setHerdrState. Returns handles the host wires to its input events.
 */
export async function startCore({ herdr, ui, apiKey, mode = 'voice', wantMic = true, micDevice }) {
  const transcript = new TranscriptStore()
  const player = new AudioPlayer().start()
  player.on('error', (e) => ui.addSystem(`audio out failed: ${e.message}`))
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
  const session = new RealtimeSession({ apiKey, mode })

  session.on('status', (s) => {
    ui.setStatus(s)
    if (s.state === 'error') {
      ui.addSystem(`error: ${s.message}`)
      transcript.system(`error: ${s.message}`)
    }
    if (s.state === 'ready') ui.addSystem('connected — say or type a command')
  })
  session.on('speech', ({ active }) => ui.setSpeaking(active))
  session.on('user_partial', ({ text }) => ui.setPartial(text))
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
  if (wantMic && mode === 'voice') {
    const devices = await MicCapture.listDevices()
    const picked = MicCapture.pickDevice(devices)
    if (!picked && !micDevice) {
      ui.setMic({ available: false })
      ui.addSystem(
        devices.length
          ? `only virtual audio devices found (${devices.map((d) => d.name).join(', ')}) — no real microphone. Text input works.`
          : 'no microphone available — grant mic permission (System Settings > Privacy & Security > Microphone). Text input still works.'
      )
    } else {
      const device = micDevice ?? `:${picked.index}`
      mic = new MicCapture({ device }).start()
      ui.setMic({ available: true, muted: true })
      ui.addSystem(`mic: ${micDevice ?? picked.name} — unmute to talk`)
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

  return {
    session,
    transcript,
    get micLive() {
      return Boolean(mic && !mic.muted)
    },
    muteMic() {
      if (!mic || mic.muted) return
      mic.setMuted(true)
      ui.setMic({ muted: true, level: 0 })
    },
    toggleMic() {
      if (!mic) return
      const next = !mic.muted
      mic.setMuted(next)
      ui.setMic({ muted: next, level: 0 })
    },
    toggleSound() {
      soundOn = !soundOn
      ui.setSound(soundOn)
      ui.notify(soundOn ? 'voice on' : 'voice off')
    },
    async copy(all = false) {
      const ok = await copyToClipboard(all ? transcript.asText() : transcript.lastExchangeText())
      ui.notify(ok ? (all ? 'copied full transcript' : 'copied last exchange') : 'copy failed')
    },
    submit(text) {
      transcript.user(text, { typed: true })
      session.sendText(text)
    },
    stop() {
      clearInterval(stateTimer)
      mic?.stop()
      player.stop()
      session.close()
    },
  }
}

export function summarizeResult(r) {
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
