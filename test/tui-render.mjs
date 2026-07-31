/** Render one TUI frame with representative state and dump it for visual inspection. */
import { VoiceTUI } from '../src/tui.js'

process.stdout.columns = Number(process.env.TCOLS || 108)
process.stdout.rows = 30

const frames = []
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk) => {
  frames.push(chunk.toString())
  return true
}

const tui = new VoiceTUI({ sessionName: 'voicelab', model: 'gpt-realtime-2.1' })
tui.setStatus({ state: 'ready' })
tui.setMic({ available: true, muted: false, level: 0.45 })
tui.setSpeaking(true)
tui.addSystem('connected — say or type a command')
tui.addUser('start a claude agent in the iris repo and call it reviewer', { done: true })
tui.updateAssistant('Started claude as "reviewer" in iris.', true)
tui.addUser('what is it doing', { done: true })
tui.updateAssistant('Reviewer is working — it is reading the auth middleware', false)
tui.addToolCall({
  callId: 'c1',
  name: 'start_agent',
  args: { kind: 'claude', name: 'reviewer', project: 'iris' },
  result: 'started=claude name=reviewer pane_id=w6:p1',
})
tui.addToolCall({ callId: 'c2', name: 'read_agent', args: { agent: 'reviewer' }, result: 'status=working' })
tui.addToolCall({ callId: 'c3', name: 'close_space', args: { space: 'payments' }, result: 'needs confirmation' })
tui.addToolCall({ callId: 'c4', name: 'focus_space', args: { space: 'nope' }, error: 'No space matching "nope"' })
tui.setHerdrState({
  spaces: [
    { name: 'aneyman', number: 1, current: false },
    { name: 'iris', number: 2, current: true },
    { name: 'payments', number: 3, current: false },
  ],
  agents: [
    { name: 'reviewer', status: 'working' },
    { name: 'codex-2', status: 'idle' },
  ],
})
tui.input = 'split the pane down'

// force a synchronous render without entering raw mode / alt screen
tui._render()
process.stdout.write = realWrite

const frame = frames.filter((f) => f.includes('herdr voice')).pop() ?? frames.join('')
console.log(frame.replace(/\x1b\[2J\x1b\[H/, ''))
console.log('\n[frame bytes]', frame.length)
