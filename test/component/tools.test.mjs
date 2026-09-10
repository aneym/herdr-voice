/**
 * Component test: the tools return what actually happened.
 *
 * The model can only describe what a tool hands back. When a tool returns an
 * echo of the request rather than its result, the model has no way to know
 * whether the build passed — and will cheerfully say that it did. These check
 * the three tools where that distinction is the whole point.
 */
import { createExecutor } from '../../src/tools.js'
import { fakeHerdr } from '../support/fake-herdr.mjs'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- run_in_pane: types into a pane, and says so ----
{
  const herdr = fakeHerdr()
  const run = createExecutor(herdr, { onNotice: () => {} })
  const res = await run('run_in_pane', { command: 'npm test' })
  const sent = herdr.sent('pane.send_text')
  check('run_in_pane types the command into the focused pane', sent.length === 1 && sent[0].pane_id === 'p1', JSON.stringify(sent[0]))
  check('run_in_pane submits it with a newline', sent[0]?.text === 'npm test\n', JSON.stringify(sent[0]?.text))
  // It genuinely cannot know the outcome, and must not imply otherwise.
  check('run_in_pane returns no output or exit code to mistake for a result', res.ok === true && !('stdout' in res) && !('exit_code' in res), JSON.stringify(res))
}

// ---- run_shell: runs it, waits, reports what happened ----
{
  const herdr = fakeHerdr()
  const run = createExecutor(herdr, { onNotice: () => {} })
  const res = await run('run_shell', { command: 'echo hello-from-the-shell' })
  check('run_shell returns real stdout', res.ok === true && res.stdout.includes('hello-from-the-shell'), JSON.stringify(res.stdout))
  check('run_shell reports a zero exit code on success', res.exit_code === 0)
  check('run_shell does not touch a pane', herdr.sent('pane.send_text').length === 0)
}
{
  const herdr = fakeHerdr()
  const run = createExecutor(herdr, { onNotice: () => {} })
  const res = await run('run_shell', { command: 'echo to-stderr 1>&2; exit 3' })
  // A failure reported as success is the worst outcome here: the model would
  // tell the user the command worked.
  check('a failing command reports its non-zero exit code', res.exit_code === 3, `exit_code=${res.exit_code}`)
  check('a failing command is not reported as ok', res.ok === false, `ok=${res.ok}`)
  check('stderr is returned, not discarded', String(res.stderr).includes('to-stderr'), JSON.stringify(res.stderr))
  // The core UI reads result.error on failures; without it a nonzero exit
  // shows as success in the HUD and stays pending in the TUI.
  check('a failing command carries an error message for the UI', typeof res.error === 'string' && res.error.includes('3'), JSON.stringify(res.error))
}
{
  // Spawn errors and timeouts must surface an error too, not just nonzero
  // exits.
  const herdr = fakeHerdr()
  const run = createExecutor(herdr, { onNotice: () => {}, shellTimeoutMs: 500 })
  const res = await run('run_shell', { command: 'sleep 5' })
  check('a timed-out command is a failure with an error message', res.ok === false && typeof res.error === 'string' && res.error.length > 0, JSON.stringify(res))
  check('a timed-out command says it timed out', res.timed_out === true && /timed out/.test(res.error), JSON.stringify(res.error))
}

// ---- prompt_agent: waits for the turn, returns the reply ----
{
  // The agent goes idle -> working -> idle, and its screen gains the answer.
  let polls = 0
  const herdr = fakeHerdr({
    agents: [{ name: 'reviewer', pane_id: 'p1', status: 'idle' }],
    screens: { p1: () => (polls > 2 ? 'the tests pass, 41 of them' : 'waiting') },
  })
  const realRequest = herdr.request.bind(herdr)
  herdr.request = async (method, params) => {
    if (method === 'agent.list') {
      polls++
      // idle at first, working while it thinks, idle again when done
      herdr.state.agents[0].status = polls <= 1 ? 'idle' : polls <= 3 ? 'working' : 'idle'
    }
    return realRequest(method, params)
  }
  const run = createExecutor(herdr, { onNotice: () => {} })
  const started = Date.now()
  const res = await run('prompt_agent', { agent: 'reviewer', text: 'run the tests' })
  const took = Date.now() - started

  check('prompt_agent delivers the prompt', herdr.sent('agent.prompt')[0]?.text === 'run the tests')
  check('prompt_agent waits for the turn instead of returning at once', took > 700, `returned after ${took}ms`)
  check('prompt_agent returns the agent\'s reply', String(res.reply).includes('the tests pass'), JSON.stringify(res.reply))
  check('prompt_agent reports that a turn actually happened', res.turn === 'completed', res.turn)
}

// ---- an agent that never stirs must not be reported as having answered ----
{
  const herdr = fakeHerdr({
    agents: [{ name: 'idler', pane_id: 'p1', status: 'idle' }],
    screens: { p1: 'nothing here' },
  })
  const run = createExecutor(herdr, { onNotice: () => {} })
  const res = await run('prompt_agent', { agent: 'idler', text: 'hello' })
  check('an agent that never worked is reported honestly', res.turn !== 'completed', res.turn)
}

// ---- a deadline hit mid-work must not be reported as a completed turn ----
{
  // The agent starts working and never comes back to idle. The tool's wait
  // deadline expires while it is still going: returning turn="completed" here
  // is a lie the model will relay to the user as a finished answer.
  let polls = 0
  const herdr = fakeHerdr({
    agents: [{ name: 'worker', pane_id: 'p1', status: 'idle' }],
    screens: { p1: () => (polls > 1 ? 'still editing src/foo.js, halfway through the refactor' : 'waiting') },
  })
  const realRequest = herdr.request.bind(herdr)
  herdr.request = async (method, params) => {
    if (method === 'agent.list') {
      polls++
      herdr.state.agents[0].status = 'working' // and stays working past the deadline
    }
    return realRequest(method, params)
  }
  const run = createExecutor(herdr, { onNotice: () => {}, promptTimeoutMs: 1200 })
  const res = await run('prompt_agent', { agent: 'worker', text: 'do the big refactor' })
  check('an agent still working at the deadline is not reported completed', res.turn !== 'completed', res.turn)
  check('the deadline hit says so explicitly', res.turn === 'still_running' && res.timed_out === true, JSON.stringify({ turn: res.turn, timed_out: res.timed_out }))
  check('partial output comes back with the timeout', String(res.reply).includes('halfway through the refactor'), JSON.stringify(res.reply))
  check('the prompt itself was still delivered', herdr.sent('agent.prompt')[0]?.text === 'do the big refactor')
}

// ---- run_shell executes on the voice host, and must say so ----
{
  // A remote/tunnel session: the snapshot's foreground_cwd is a path on the
  // herdr host, not on the machine running the voice engine. Pointing a local
  // exec at it runs against the wrong checkout — or fails confusingly.
  const probe = path.join(os.tmpdir(), `herdr-voice-remote-probe-${process.pid}`)
  fs.rmSync(probe, { force: true })
  const herdr = fakeHerdr({
    panes: [{ pane_id: 'p1', workspace_id: 'w1', foreground_cwd: '/home/dev/repos/app' }],
  })
  const run = createExecutor(herdr, { onNotice: () => {}, remoteHost: 'build.lan' })
  const res = await run('run_shell', { command: `touch ${probe}` })
  check('a remote session is not executed on the local voice host', res.ok === false && !fs.existsSync(probe), JSON.stringify(res))
  check('the rejection names the remote host', String(res.error).includes('build.lan'), res.error)
  check('the rejection points at run_in_pane as the way to run it there', String(res.error).includes('run_in_pane'), res.error)
  fs.rmSync(probe, { force: true })
}
{
  // No remoteHost flag, but the focused pane's cwd is not a path on this
  // machine (e.g. connected to a remote herdr via an explicit socket). A local
  // exec there would throw ENOENT or silently run in a fallback directory.
  const cwd = path.join(os.tmpdir(), `herdr-voice-not-on-this-host-${process.pid}`)
  fs.rmSync(cwd, { force: true })
  const herdr = fakeHerdr({
    panes: [{ pane_id: 'p1', workspace_id: 'w1', foreground_cwd: cwd }],
  })
  const run = createExecutor(herdr, { onNotice: () => {} })
  const res = await run('run_shell', { command: 'pwd' })
  check('a workspace path that is not on this machine is refused, not executed elsewhere', res.ok === false && !('stdout' in res) && !('exit_code' in res), JSON.stringify(res))
  check('the refusal says the directory is missing on the voice host', String(res.error).includes(cwd), res.error)
  check('the refusal still suggests run_in_pane', String(res.error).includes('run_in_pane'), res.error)
}

// ---- agents are addressed by pane id, not by the name we made up ----
{
  // herdr 0.8 stopped returning a `name` field. The name shown to the user is
  // synthesised from the terminal title so they can say it out loud; sending it
  // back as the target is what broke every agent tool with agent_not_found
  // while the agents still listed and displayed perfectly.
  const herdr = fakeHerdr({
    agents: [{ pane_id: 'p1', agent: 'claude', terminal_title_stripped: 'reviewer', status: 'idle' }],
    screens: { p1: 'all 41 tests pass' },
  })
  const run = createExecutor(herdr, { onNotice: () => {} })
  const res = await run('read_agent', { agent: 'reviewer' })
  const target = herdr.sent('agent.read')[0]?.target
  check('an agent with no name of its own is still found by what it is called', res.ok !== false, JSON.stringify(res).slice(0, 80))
  check('and is addressed by pane id, not by that name', target === 'p1', `target=${JSON.stringify(target)}`)
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
