/**
 * End-to-end test: real Realtime session -> real tool calls -> real herdr sandbox.
 * Each step asserts against herdr's actual state, not just the model's reply.
 */
import { loadApiKey, resolveSocket } from '../src/config.js'
import { HerdrClient } from '../src/herdr.js'
import { RealtimeSession } from '../src/realtime.js'
import { createExecutor, readState } from '../src/tools.js'

const SESSION = process.env.HERDR_VOICE_SESSION || 'voicelab'
const log = (...a) => console.log(...a)

const STEPS = [
  {
    say: 'create a new space called billing fix',
    expectTool: 'create_space',
    verify: (s) => s.snapshot.workspaces.some((w) => w.label === 'billing fix'),
    desc: 'space "billing fix" exists',
  },
  {
    say: 'rename that space to payments',
    expectTool: 'rename_space',
    verify: (s) => s.snapshot.workspaces.some((w) => w.label === 'payments'),
    desc: 'space renamed to "payments"',
  },
  {
    say: 'split the current pane to the right',
    expectTool: 'split_pane',
    verify: (s, before) => s.snapshot.panes.length > before.snapshot.panes.length,
    desc: 'pane count increased',
  },
  {
    say: 'what spaces do I have right now?',
    expectTool: 'get_state',
    verify: () => true,
    desc: 'model read state',
  },
  {
    say: 'set up the agent and logs layout in payments',
    expectTool: 'apply_layout',
    verify: (s) => {
      const w = s.snapshot.workspaces.find((x) => x.label === 'payments')
      return w && w.pane_count >= 2
    },
    desc: 'payments has a 2-pane layout',
  },
  {
    say: 'start a claude agent in payments called reviewer',
    expectTool: 'start_agent',
    verify: (s) => s.agents.some((a) => a.name === 'reviewer'),
    desc: 'agent "reviewer" is registered',
  },
  {
    say: 'what agents are running?',
    expectTool: 'get_state',
    verify: () => true,
    desc: 'model read agent state',
  },
  {
    // Destructive gate: first turn must NOT close anything.
    say: 'close the payments space',
    expectTool: null,
    verify: (s) => s.snapshot.workspaces.some((w) => w.label === 'payments'),
    desc: 'nothing closed before confirmation',
  },
  {
    // Second turn: explicit confirmation should actually close it.
    say: 'yes, I confirm, close it',
    expectTool: 'close_space',
    verify: (s) => !s.snapshot.workspaces.some((w) => w.label === 'payments'),
    desc: 'space closed after confirmation',
  },
]

async function main() {
  const { socket, exists } = resolveSocket({ session: SESSION })
  if (!exists) throw new Error(`sandbox session "${SESSION}" not running`)
  const { value: apiKey } = loadApiKey()

  const herdr = new HerdrClient(socket)
  await herdr.connect()
  log(`herdr connected: ${socket}`)

  const execute = createExecutor(herdr)
  const session = new RealtimeSession({ apiKey, mode: 'text' })

  const calls = []
  let assistantText = ''
  let responseDone = null

  session.on('status', (s) => {
    if (s.state === 'error') log(`  ! realtime error: ${s.message}`)
  })
  session.on('assistant_done', ({ text }) => {
    assistantText = text
    responseDone?.()
  })
  session.on('tool_call', async ({ name, callId, args }) => {
    calls.push({ name, args })
    log(`  tool: ${name}(${JSON.stringify(args)})`)
    let result
    try {
      result = await execute(name, args)
    } catch (e) {
      result = { ok: false, error: e.message }
    }
    log(`    -> ${JSON.stringify(result).slice(0, 220)}`)
    session.sendToolResult(callId, result)
  })

  await new Promise((resolve, reject) => {
    session.on('status', (s) => {
      if (s.state === 'ready') resolve()
      if (s.state === 'error') reject(new Error(s.message))
    })
    session.connect()
    setTimeout(() => reject(new Error('realtime connect timeout')), 20000)
  })
  log(`realtime ready\n`)

  let passed = 0
  let failed = 0

  for (const step of STEPS) {
    const before = await readState(herdr)
    calls.length = 0
    assistantText = ''
    log(`SAY: "${step.say}"`)

    await new Promise((resolve) => {
      responseDone = resolve
      session.sendText(step.say)
      setTimeout(resolve, 25000)
    })
    // let any trailing tool result settle
    await new Promise((r) => setTimeout(r, 900))

    const after = await readState(herdr)
    // expectTool null means: assert this tool was deliberately NOT called
    const toolOk =
      step.expectTool === null
        ? !calls.some((c) => c.name === 'close_space' && c.args?.confirm)
        : calls.some((c) => c.name === step.expectTool)
    const stateOk = step.verify(after, before)
    const ok = toolOk && stateOk

    log(`  ai: ${assistantText || '(no text)'}`)
    const toolDesc =
      step.expectTool === null
        ? `no destructive call: ${toolOk ? 'yes' : 'NO'}`
        : `tool ${step.expectTool}: ${toolOk ? 'yes' : 'NO (' + calls.map((c) => c.name).join(',') + ')'}`
    log(`  ${ok ? 'PASS' : 'FAIL'} — ${toolDesc}; ${step.desc}: ${stateOk ? 'yes' : 'NO'}\n`)
    ok ? passed++ : failed++
  }

  log(`\n=== ${passed} passed, ${failed} failed`)

  // cleanup: remove test spaces from the sandbox
  const final = await readState(herdr)
  for (const w of final.snapshot.workspaces) {
    if (['payments', 'billing fix', 'probe-space'].includes(w.label)) {
      await herdr.request('workspace.close', { workspace_id: w.workspace_id }).catch(() => {})
    }
  }

  session.close()
  herdr.close()
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e.message)
  process.exit(1)
})
