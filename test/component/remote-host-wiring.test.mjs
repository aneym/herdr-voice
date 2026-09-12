/**
 * Component test: the standalone app knows which machine herdr is on.
 *
 * run_shell refuses to execute when herdr's workspaces live on another host,
 * but only when it is told that they do. engine.js was told, through
 * --tunnel-host. src/index.js was not, and src/index.js is what
 * bin/herdr-voice-run starts on the near side of an SSH tunnel it built itself.
 * So in the one setup the refusal was written for, it never fired.
 *
 * Nothing in the herdr protocol can supply the missing fact: 0.8.2 has no
 * server or host identity call, and an SSH-forwarded unix socket is
 * indistinguishable from a local one. The host has to be declared, which makes
 * the declaration itself the thing worth testing, end to end: from the shell
 * line that starts the app to the refusal that comes out the other side.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, coreOptions, remoteHerdrHost } from '../../src/args.js'
import { createExecutor } from '../../src/tools.js'
import { fakeHerdr } from '../support/fake-herdr.mjs'

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * The argv `bin/herdr-voice-run` hands to node, read from the script itself.
 * $HOST is the machine it opened the tunnel to; $SOCK is the local end of it.
 */
function launcherArgv() {
  const script = fs.readFileSync(new URL('../../bin/herdr-voice-run', import.meta.url), 'utf8')
  const line = script.split('\n').find((l) => /^\s*node\s.*src\/index\.js/.test(l)) ?? ''
  return {
    line,
    argv: line
      .replace(/^\s*node\s+\S*src\/index\.js"?\s*/, '')
      .replace(/\\\s*$/, '')
      .split(/\s+/)
      .map((t) => t.replace(/"/g, ''))
      .filter((t) => t && t !== '$@')
      .map((t) => (t === '$SOCK' ? '/tmp/herdr-tunnel.sock' : t === '$HOST' ? 'studio-ts' : t)),
  }
}

// ---- the launcher declares the host it tunnelled to ----
{
  const { line, argv } = launcherArgv()
  check('the launcher still starts the standalone app', line !== '', JSON.stringify(line))
  const opts = parseArgs(argv)
  check('the launcher passes the host herdr is on', remoteHerdrHost(opts) === 'studio-ts', JSON.stringify(argv))
  check('along with the socket it tunnelled through', opts.socket === '/tmp/herdr-tunnel.sock', JSON.stringify(opts.socket))
  check('so the options handed to startCore carry that host', coreOptions(opts).remoteHost === 'studio-ts', JSON.stringify(coreOptions(opts)))
}

// ---- a local run is still local ----
{
  const opts = parseArgs(['--socket', '/tmp/local.sock'])
  check('a run that declares no host is treated as local', remoteHerdrHost(opts) === undefined, JSON.stringify(remoteHerdrHost(opts)))
  check('and hands startCore no remote host', coreOptions(opts).remoteHost === undefined, JSON.stringify(coreOptions(opts)))
}

// ---- the engine's own flag keeps its meaning ----
{
  const opts = parseArgs(['--tunnel-host', 'studio-ts', '--no-mic'])
  check('--tunnel-host still declares a remote herdr', remoteHerdrHost(opts) === 'studio-ts', JSON.stringify(opts.tunnelHost))
  check('and the parser still reads the flags it already read', opts.mic === false, JSON.stringify(opts.mic))
}

// ---- and the end of the chain: a declared host actually refuses ----
{
  // Wiring the host through is only worth something if run_shell then refuses.
  // The remote workspace path exists on this machine too. The same repo at the
  // same path on both machines is the ordinary case, so nothing except the
  // declared host can tell that it is the wrong checkout.
  const probe = path.join(os.tmpdir(), `herdr-voice-standalone-probe-${process.pid}`)
  fs.rmSync(probe, { force: true })
  const herdr = fakeHerdr({
    panes: [{ pane_id: 'p1', workspace_id: 'w1', foreground_cwd: process.cwd() }],
  })
  const { remoteHost } = coreOptions(parseArgs(launcherArgv().argv))
  const run = createExecutor(herdr, { onNotice: () => {}, remoteHost })
  const res = await run('run_shell', { command: `touch ${probe}` })
  check('a standalone launcher session does not run the command on the voice host', res.ok === false && !fs.existsSync(probe), JSON.stringify(res))
  check('and says which host the workspaces are on', String(res.error).includes('studio-ts'), res.error)
  fs.rmSync(probe, { force: true })
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
