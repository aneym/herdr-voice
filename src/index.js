#!/usr/bin/env node
// Standalone mode: engine + UI in one process (the floating Ghostty window,
// or a full TUI / text session anywhere). The split architecture lives in
// engine.js (headless, mic machine) + ui.js (herdr pane client).
import { loadApiKey, resolveSocket, MODEL } from './config.js'
import { HerdrClient } from './herdr.js'
import { VoiceTUI } from './tui.js'
import { VoiceHUD } from './hud.js'
import { startCore } from './core.js'

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
  const { name: sessionName, socket, exists } = resolveSocket(opts)
  if (!exists) {
    console.error(`herdr session "${sessionName}" not found at ${socket}`)
    console.error('Start it first, or pass --session <name> / --socket <path>.')
    process.exit(1)
  }
  const { value: apiKey } = loadApiKey()

  const herdr = new HerdrClient(socket)
  await herdr.connect()

  const ui = opts.hud
    ? new VoiceHUD({ sessionName, model: MODEL })
    : new VoiceTUI({ sessionName, model: MODEL })
  ui.start()

  const core = await startCore({
    herdr,
    ui,
    apiKey,
    mode: opts.mode,
    wantMic: opts.mic,
    micDevice: opts.device,
  })

  ui.on('toggle-mic', core.toggleMic)
  ui.on('toggle-mute', core.toggleMic) // full-TUI event name
  ui.on('toggle-sound', core.toggleSound)
  ui.on('toggle-text', () => ui.setText?.(!(ui.textOn ?? true)))
  ui.on('copy', () => core.copy(false))
  ui.on('copy-all', () => core.copy(true))
  ui.on('submit', core.submit)

  const shutdown = () => {
    core.stop()
    herdr.close()
    ui.stop()
    process.exit(0)
  }
  ui.on('quit', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')
  console.error(err)
  process.exit(1)
})
