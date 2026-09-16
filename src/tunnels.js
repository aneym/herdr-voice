import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IS_WIN, isTcp, netOptions, sshLocalEnd } from './endpoint.js'

const RUN_DIR = path.join(os.homedir(), '.cache/herdr-voice')

/**
 * SSH tunnels owned and monitored by the engine process.
 *
 * Previously these were `ssh -f` daemons started by the launcher — but
 * `launchctl kickstart -k` kills the service's whole process group, so every
 * engine restart silently orphaned the HUD (tunnels dead, engine "up").
 * As children of the engine they live and die with it, and get respawned
 * with backoff if they drop.
 *
 * Local ends are unix sockets on macOS and loopback TCP on Windows (OpenSSH for
 * Windows forwards TCP<->remote unix socket fine; it just can't bind a local
 * unix socket). Remote ends are always the server's unix sockets.
 */
export function startTunnels({ host, ctlSock, log = () => {} }) {
  fs.mkdirSync(RUN_DIR, { recursive: true })
  const herdrSock = IS_WIN
    ? process.env.HERDR_VOICE_HERDR_LOCAL || 'tcp:127.0.0.1:47822'
    : path.join(RUN_DIR, `${host}.sock`)

  // ssh -L/-R need ABSOLUTE remote paths — resolve the remote HOME once, and
  // honour a target-socket file the summon script writes so the engine drives
  // the herdr session that actually invoked it (named profiles), not always
  // the default session.
  const [remoteHome, remoteTarget] = execFileSync(
    'ssh',
    [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host,
      'printf %s "$HOME"; printf "\\n"; cat "$HOME/.cache/herdr-voice/target-socket" 2>/dev/null',
    ],
    { encoding: 'utf8' }
  ).split('\n')
  const remoteHerdr = (remoteTarget || '').trim() || `${remoteHome}/.config/herdr/herdr.sock`
  const remoteCtl = `${remoteHome}/.cache/herdr-voice/ctl.sock`
  log(`tunnels: herdr ${remoteHerdr} <- ${herdrSock}; ctl ${remoteCtl} -> ${ctlSock}`)

  const children = new Set()
  let stopped = false

  function keep(name, makeArgs, { preflight } = {}) {
    let delay = 500
    const dial = () => {
      if (stopped) return
      try {
        preflight?.()
      } catch (e) {
        log(`${name} preflight failed: ${e.message}`)
      }
      const proc = spawn('ssh', makeArgs(), { stdio: ['ignore', 'ignore', 'pipe'] })
      children.add(proc)
      let err = ''
      proc.stderr.on('data', (d) => (err += d.toString()))
      proc.on('close', (code) => {
        children.delete(proc)
        if (stopped) return
        log(`${name} tunnel exited (${code}) ${err.trim().slice(0, 120)} — retrying in ${delay}ms`)
        setTimeout(dial, delay)
        delay = Math.min(15000, delay * 2)
      })
      proc.on('spawn', () => {
        // reset backoff once a tunnel has held for a while
        setTimeout(() => {
          if (!proc.killed && children.has(proc)) delay = 500
        }, 20000)
      })
    }
    dial()
  }

  const common = [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    // A ControlMaster mux client exits 0 immediately and its forward dies with
    // it — tunnels must be dedicated connections that hold.
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
  ]

  keep('herdr(-L)', () => ['-L', `${sshLocalEnd(herdrSock)}:${remoteHerdr}`, ...common, host], {
    preflight: () => {
      if (!isTcp(herdrSock)) fs.rmSync(herdrSock, { force: true })
    },
  })
  keep('ctl(-R)', () => ['-R', `${remoteCtl}:${sshLocalEnd(ctlSock)}`, ...common, host], {
    // sshd refuses to bind over a stale remote socket (StreamLocalBindUnlink
    // defaults to no) — remove it right before every dial.
    preflight: () =>
      execFileSync('ssh', ['-o', 'BatchMode=yes', host, `mkdir -p ~/.cache/herdr-voice && rm -f ${remoteCtl}`]),
  })

  return {
    herdrSock,
    async waitForHerdr({ timeoutMs = 15000 } = {}) {
      const net = await import('node:net')
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        const ok = await new Promise((resolve) => {
          const s = net.createConnection(netOptions(herdrSock))
          s.setEncoding('utf8')
          let done = false
          const fin = (v) => {
            if (!done) {
              done = true
              s.destroy()
              resolve(v)
            }
          }
          s.on('connect', () => s.write('{"id":"t","method":"ping","params":{}}\n'))
          s.on('data', (d) => fin(d.includes('pong')))
          s.on('error', () => fin(false))
          setTimeout(() => fin(false), 2000)
        })
        if (ok) return true
        await new Promise((r) => setTimeout(r, 400))
      }
      return false
    },
    stop() {
      stopped = true
      for (const p of children) p.kill('SIGTERM')
    },
  }
}
