/**
 * Command-line parsing shared by both entrypoints.
 *
 * index.js and engine.js each kept their own copy, and the copies disagreed.
 * The engine learned --tunnel-host so run_shell would refuse to execute a
 * remote workspace path against the local voice host; index.js never learned
 * anything of the sort, even though bin/herdr-voice-run starts it on the near
 * side of an SSH tunnel and hands it a forwarded socket. Its herdr is just as
 * remote, so the refusal was written and then never fired where it was needed.
 *
 * One parser, one vocabulary, and a flag added in one place reaches both.
 */
export function parseArgs(argv) {
  const out = {
    session: undefined,
    socket: undefined,
    mode: 'voice',
    mic: true,
    hud: false,
    device: undefined,
    tunnelHost: undefined,
    remoteHost: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session') out.session = argv[++i]
    else if (a === '--socket') out.socket = argv[++i]
    else if (a === '--tunnel-host') out.tunnelHost = argv[++i]
    else if (a === '--remote-host') out.remoteHost = argv[++i]
    else if (a === '--text') out.mode = 'text'
    else if (a === '--no-mic') out.mic = false
    else if (a === '--hud') out.hud = true
    else if (a === '--full') out.hud = false
    else if (a === '--device') out.device = argv[++i]
  }
  return out
}

/**
 * The machine herdr runs on, or undefined when that machine is this one.
 *
 * Two flags arrive at the same fact from different directions: --tunnel-host
 * asks the engine to build the tunnel itself, --remote-host says a tunnel is
 * already open because the launcher built it. Either way, every path herdr
 * reports belongs to somewhere else.
 *
 * It has to be declared. herdr 0.8.2 exposes no server or host identity call to
 * ask, and an SSH-forwarded unix socket looks exactly like a local one. That is
 * also why the "does this directory exist?" check in run_shell is a second line
 * of defence and not a test of host identity: the same repo at the same path on
 * two machines is the ordinary case, not an exotic one.
 */
export function remoteHerdrHost(opts) {
  return opts.remoteHost ?? opts.tunnelHost
}

/** The options both entrypoints hand to startCore. */
export function coreOptions(opts) {
  return {
    mode: opts.mode,
    wantMic: opts.mic,
    micDevice: opts.device,
    remoteHost: remoteHerdrHost(opts),
  }
}
