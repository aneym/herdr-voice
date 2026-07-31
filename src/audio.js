import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { SAMPLE_RATE } from './config.js'

/**
 * Mic capture via ffmpeg/avfoundation -> PCM16 mono @24k -> base64 chunks.
 *
 * macOS gates microphone access per-application (TCC). A terminal that has never
 * been granted mic access sees no input devices at all, so we surface that as a
 * clear, actionable error instead of silently sending empty audio.
 */
export class MicCapture extends EventEmitter {
  constructor({ device = ':0', chunkMs = 100 } = {}) {
    super()
    this.device = device
    this.chunkMs = chunkMs
    this.proc = null
    this.muted = true
    this.stderr = ''
  }

  static async listDevices() {
    return new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''])
      let buf = ''
      p.stderr.on('data', (d) => (buf += d.toString()))
      p.on('close', () => {
        const audio = []
        const section = buf.split('AVFoundation audio devices:')[1] ?? ''
        for (const line of section.split('\n')) {
          const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
          if (m) audio.push({ index: Number(m[1]), name: m[2] })
        }
        resolve(audio)
      })
      p.on('error', () => resolve([]))
    })
  }

  /**
   * Pick a real microphone, never a virtual loopback. "Microsoft Teams Audio",
   * BlackHole, etc. enumerate as audio devices but capture silence (or the wrong
   * thing) — picking one is exactly the "mic connected but hears nothing" trap.
   * Returns null when only virtual devices exist so the UI can say so honestly.
   */
  static pickDevice(devices) {
    const VIRTUAL = /teams|virtual|blackhole|loopback|soundflower|aggregate|zoomaudio|multi-output/i
    const PREFERRED = /macbook.*microphone|built-in|external microphone|usb|airpods|studio display/i
    const real = devices.filter((d) => !VIRTUAL.test(d.name))
    if (real.length === 0) return null
    return real.find((d) => PREFERRED.test(d.name)) ?? real[0]
  }

  start() {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'avfoundation',
      '-i', this.device,
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-f', 's16le',
      '-',
    ]
    const proc = spawn('ffmpeg', args)
    this.proc = proc

    // bytes per chunk: 2 bytes/sample * rate * ms/1000
    const chunkBytes = Math.floor((SAMPLE_RATE * 2 * this.chunkMs) / 1000)
    let pending = Buffer.alloc(0)

    proc.stdout.on('data', (data) => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= chunkBytes) {
        const chunk = pending.subarray(0, chunkBytes)
        pending = pending.subarray(chunkBytes)
        if (!this.muted) {
          this.emit('chunk', chunk.toString('base64'))
          this.emit('level', rms(chunk))
        }
      }
    })
    proc.stderr.on('data', (d) => {
      this.stderr += d.toString()
      const msg = this.stderr.toLowerCase()
      if (msg.includes('permission') || msg.includes('input/output error')) {
        this.emit('error', new Error('microphone unavailable (grant Terminal mic permission)'))
      }
    })
    proc.on('error', (e) => this.emit('error', e))
    proc.on('close', (code) => this.emit('closed', { code, stderr: this.stderr.slice(-400) }))
    return this
  }

  setMuted(m) {
    this.muted = m
    this.emit('muted', m)
  }

  stop() {
    this.proc?.kill('SIGTERM')
    this.proc = null
  }
}

/**
 * Playback of assistant PCM16 audio through a long-lived ffplay stdin pipe.
 * NOTE: ffplay rejects `-ac` (that silently killed audio out for days — every
 * play exited code 1 unseen). Channel count must be `-ch_layout mono`, and any
 * player death is surfaced via 'error' and recovered by respawning on next play.
 */
export class AudioPlayer extends EventEmitter {
  constructor() {
    super()
    this.proc = null
    this.failed = false
  }

  _spawn() {
    const proc = spawn('ffplay', [
      '-hide_banner', '-loglevel', 'error',
      '-nodisp', '-autoexit',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ch_layout', 'mono',
      '-i', 'pipe:0',
    ])
    let err = ''
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', (e) => {
      this.failed = true
      this.emit('error', new Error(`ffplay unavailable: ${e.message}`))
    })
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null
      if (code !== 0 && code !== null && !this.failed) {
        this.failed = true
        this.emit('error', new Error(`ffplay exited ${code}: ${err.slice(0, 160)}`))
      }
    })
    proc.stdin.on('error', () => {})
    return proc
  }

  start() {
    this.proc = this._spawn()
    return this
  }

  play(base64) {
    if (!this.proc?.stdin.writable) {
      if (this.failed) return
      this.proc = this._spawn() // respawn after a clean autoexit
    }
    this.proc.stdin.write(Buffer.from(base64, 'base64'))
  }

  stop() {
    try {
      this.proc?.stdin.end()
      this.proc?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    this.proc = null
  }
}

function rms(buf) {
  let sum = 0
  const n = Math.floor(buf.length / 2)
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768
    sum += s * s
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, n)) * 4)
}
