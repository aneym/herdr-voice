/** Render HUD frames in both text modes and verify mouse hit-testing. */
import { VoiceHUD } from '../src/hud.js'

process.stdout.columns = Number(process.env.TCOLS || 58)
process.stdout.rows = Number(process.env.TROWS || 12)

const frames = []
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (c) => (frames.push(c.toString()), true)

const hud = new VoiceHUD({ sessionName: 'studio', model: 'gpt-realtime-2.1' })
hud.setStatus({ state: 'ready' })
hud.setMic({ available: true, muted: false })
for (const l of [0.1, 0.4, 0.8, 0.6, 0.3, 0.7, 0.2, 0.5]) hud.setMic({ level: l })
hud.setSpeaking(true)
hud.setPartial('create a space called scratch and start claude in')
hud.addSystem('connected — say or type a command')
hud.addUser('what agents are running?')
hud.addToolCall({ callId: 'c1', name: 'get_state', args: {} })
hud.updateToolCall('c1', {})
hud.updateAssistant('Reviewer is working; codex-2 is idle.', true)
hud._render()
const textOnFrame = frames.pop()

// verify buttons registered and clicks dispatch
const clicks = []
hud.on('toggle-mic', () => clicks.push('mic'))
hud.on('toggle-sound', () => clicks.push('sound'))
hud.on('toggle-text', () => clicks.push('text'))
hud.on('copy', () => clicks.push('copy'))
for (const b of hud.buttons) hud._click(Math.floor((b.x1 + b.x2) / 2), b.y)

hud.setText(false)
hud._render()
const textOffFrame = frames.pop()
process.stdout.write = realWrite

const show = (f) =>
  f
    .replace(/\x1b\[[0-9;]*[mHKJ]/g, (m) => (m.endsWith('m') ? '' : m === '\x1b[H' ? '' : ''))
    .replace(/\x1b\[0J/g, '')
    .split('\n')
    .map((l) => '|' + l + '|')
    .join('\n')

console.log('=== text ON ===')
console.log(show(textOnFrame))
console.log('=== text OFF ===')
console.log(show(textOffFrame))
console.log('=== buttons:', JSON.stringify(hud.buttons))
console.log('=== clicks dispatched:', clicks.join(','))
if (clicks.join(',') !== 'mic,sound,text,copy') {
  console.error('FAIL: click dispatch mismatch')
  process.exit(1)
}
console.log('PASS')
