import { EventEmitter } from 'node:events'

const ESC = '\x1b['
const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'
const HIDE = '\x1b[?25l'
const SHOW = '\x1b[?25h'
// SGR mouse reporting: presses arrive as \x1b[<btn;x;yM. Shift+drag still does
// native terminal selection (terminals bypass reporting with shift held).
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l'

const C = {
  faint: '\x1b[38;5;238m',
  dim: '\x1b[38;5;243m',
  text: '\x1b[38;5;252m',
  bright: '\x1b[38;5;255m',
  accent: '\x1b[38;5;117m',
  ok: '\x1b[38;5;114m',
  warn: '\x1b[38;5;179m',
  err: '\x1b[38;5;174m',
  bold: '\x1b[1m',
  off: '\x1b[0m',
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const pad = (s, n) => {
  const len = strip(s).length
  return len >= n ? clip(s, n) : s + ' '.repeat(n - len)
}
function clip(s, n) {
  let out = ''
  let len = 0
  let i = 0
  while (i < s.length && len < n) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/)
      if (m) {
        out += m[0]
        i += m[0].length
        continue
      }
    }
    out += s[i]
    len++
    i++
  }
  return out
}
const tail = (s, n) => {
  const plain = String(s)
  return plain.length <= n ? plain : '…' + plain.slice(-(n - 1))
}

const METER_GLYPHS = '▁▁▂▃▄▅▆▇█'

/**
 * Compact always-on-top voice HUD.
 *
 * A fixed small window (Ghostty can't resize at runtime — CSI 8 t is
 * unimplemented), so "show/hide text" toggles how the fixed rows are used:
 * text ON fills the middle with transcript + tool lines, text OFF leaves only
 * the meter/dictation strip and buttons.
 *
 * Clickable buttons (SGR mouse) with key equivalents:
 *   [mic]   tab — capture user audio on/off
 *   [voice] s   — play agent speech on/off
 *   [text]  t   — show/hide transcript + tool calls
 *   [copy]  c   — copy last exchange (C = whole session)
 */
export class VoiceHUD extends EventEmitter {
  constructor({ sessionName, model }) {
    super()
    this.sessionName = sessionName
    this.model = model
    this.status = { state: 'connecting' }
    this.micLevel = 0
    this.levelHistory = new Array(24).fill(0)
    this.muted = true
    this.micAvailable = false
    this.soundOn = true
    this.textOn = true
    this.speaking = false
    this.partial = '' // live dictation
    this.lastUser = ''
    this.lastAssistant = ''
    this.assistantDone = true
    this.feed = [] // interleaved {role:'you'|'ai'|'sys'|'tool', text, ok}
    this.input = ''
    this.flash = null // transient notice, e.g. "copied"
    this.buttons = [] // hit regions computed at render: {x1,x2,y,id}
    this.dirty = true
    this.closed = false
  }

  start() {
    process.stdout.write(ALT_ON + HIDE + MOUSE_ON)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (k) => this._input(k))
    }
    process.stdout.on('resize', () => (this.dirty = true))
    this.timer = setInterval(() => {
      if (this.dirty) this._render()
    }, 80)
    this._render()
    return this
  }

  _input(data) {
    // mouse first: SGR sequences may arrive batched with keys
    let rest = data
    const mouseRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
    let m
    let consumed = false
    while ((m = mouseRe.exec(data))) {
      consumed = true
      if (m[4] === 'M' && Number(m[1]) === 0) this._click(Number(m[2]), Number(m[3]))
    }
    if (consumed) rest = data.replace(mouseRe, '')
    for (const k of rest) this._key(k, rest)
    if (rest.startsWith('\x1b')) return // swallow other escape sequences
  }

  _key(k) {
    if (k === '\x03' || k === '\x04') return this.emit('quit')
    if (k === '\t') return this.emit('toggle-mic')
    if (k === '\r' || k === '\n') {
      const text = this.input.trim()
      this.input = ''
      this.dirty = true
      if (text) this.emit('submit', text)
      return
    }
    if (k === '\x7f' || k === '\b') {
      this.input = this.input.slice(0, -1)
      this.dirty = true
      return
    }
    if (k.charCodeAt(0) < 32) return
    // single-key commands only when the input line is empty (so typing stays natural)
    if (this.input === '') {
      if (k === 's') return this.emit('toggle-sound')
      if (k === 't') return this.emit('toggle-text')
      if (k === 'c') return this.emit('copy')
      if (k === 'C') return this.emit('copy-all')
    }
    this.input += k
    this.dirty = true
  }

  _click(x, y) {
    for (const b of this.buttons) {
      if (y === b.y && x >= b.x1 && x <= b.x2) {
        this.emit(b.id)
        return
      }
    }
  }

  // ---- state ---------------------------------------------------------------
  setStatus(s) {
    this.status = { ...this.status, ...s }
    this.dirty = true
  }
  setMic({ level, muted, available }) {
    if (level !== undefined) {
      this.micLevel = level
      this.levelHistory.push(level)
      this.levelHistory.shift()
    }
    if (muted !== undefined) this.muted = muted
    if (available !== undefined) this.micAvailable = available
    this.dirty = true
  }
  setSound(on) {
    this.soundOn = on
    this.dirty = true
  }
  setText(on) {
    this.textOn = on
    this.dirty = true
  }
  setSpeaking(v) {
    this.speaking = v
    if (!v) this.levelHistory.fill(0)
    this.dirty = true
  }
  setPartial(text) {
    this.partial = text
    this.dirty = true
  }
  notify(text) {
    this.flash = { text, until: Date.now() + 1800 }
    this.dirty = true
  }

  addUser(text) {
    this.partial = ''
    this.lastUser = text
    this.feed.push({ role: 'you', text })
    this.dirty = true
  }
  updateAssistant(text, done) {
    this.lastAssistant = text
    this.assistantDone = done
    const last = this.feed[this.feed.length - 1]
    if (last && last.role === 'ai' && !last.done) {
      last.text = text
      last.done = done
    } else this.feed.push({ role: 'ai', text, done })
    this.dirty = true
  }
  addSystem(text) {
    this.feed.push({ role: 'sys', text })
    this.dirty = true
  }
  addToolCall({ callId, name, args }) {
    this.feed.push({ role: 'tool', callId, name, args, pending: true })
    this.dirty = true
  }
  updateToolCall(callId, { error } = {}) {
    const e = this.feed.find((t) => t.role === 'tool' && t.callId === callId)
    if (e) {
      e.pending = false
      e.error = error
    }
    this.dirty = true
  }
  setHerdrState() {} // HUD doesn't show the space list; the full TUI does

  // ---- render --------------------------------------------------------------
  _render() {
    if (this.closed) return
    this.dirty = false
    if (this.flash && Date.now() > this.flash.until) this.flash = null
    const W = Math.max(44, process.stdout.columns || 58)
    const H = Math.max(8, process.stdout.rows || 12)
    const rows = []
    this.buttons = []

    // 1 — status + waveform strip
    const dot =
      this.status.state === 'ready'
        ? this.speaking
          ? C.accent + '◉' + C.off
          : C.ok + '●' + C.off
        : this.status.state === 'error'
          ? C.err + '●' + C.off
          : C.warn + '◌' + C.off
    const label = this.speaking
      ? `${C.accent}listening${C.off}`
      : this.status.state === 'ready'
        ? `${C.dim}${this.muted || !this.micAvailable ? 'standby' : 'live'}${C.off}`
        : `${C.dim}${this.status.state}${C.off}`
    const meterW = Math.min(26, W - 24)
    const hist = this.levelHistory.slice(-meterW)
    const meter = hist
      .map((l) => {
        const g = METER_GLYPHS[Math.min(8, Math.round(l * 8))]
        return (l > 0.02 ? C.accent : C.faint) + g
      })
      .join('')
    rows.push(` ${dot} ${label}  ${meter}${C.off}  ${C.faint}${this.sessionName}${C.off}`)

    // 2 — dictation line: live partial beats last-final; flash beats both
    let dictation
    if (this.flash) dictation = ` ${C.ok}✓ ${this.flash.text}${C.off}`
    else if (this.partial) dictation = ` ${C.accent}»${C.off} ${C.bright}${tail(this.partial, W - 4)}${C.off}`
    else if (this.lastUser) dictation = ` ${C.faint}»${C.off} ${C.dim}${tail(this.lastUser, W - 4)}${C.off}`
    else dictation = ` ${C.faint}» say or type a command${C.off}`
    rows.push(dictation)

    // 3..n — reply / feed area
    const bodyRows = H - 4 // header, dictation, buttons, input
    if (this.textOn) {
      const lines = []
      for (const e of this.feed) {
        if (e.role === 'you') lines.push(`${C.accent}you${C.off} ${C.text}${tail(e.text, W - 6)}${C.off}`)
        else if (e.role === 'ai')
          lines.push(
            `${C.bright}ai${C.off}  ${e.done ? C.text : C.dim}${tail(e.text, W - 6)}${C.off}${e.done ? '' : C.accent + '▌' + C.off}`
          )
        else if (e.role === 'sys') lines.push(`${C.faint}· ${tail(e.text, W - 5)}${C.off}`)
        else if (e.role === 'tool') {
          const mark = e.pending ? C.warn + '▸' : e.error ? C.err + '✗' : C.ok + '✓'
          const detail = e.error ? ` ${C.err}${tail(e.error, W - 20)}` : ''
          lines.push(`${mark}${C.off} ${C.dim}${e.name}${detail}${C.off}`)
        }
      }
      const view = lines.slice(-bodyRows)
      for (let i = 0; i < bodyRows; i++) rows.push(view[i] ? ' ' + view[i] : '')
    } else {
      // text hidden: just the streaming reply line (if any), centered-ish
      for (let i = 0; i < bodyRows; i++) {
        if (i === 0 && this.lastAssistant && !this.assistantDone)
          rows.push(` ${C.dim}${tail(this.lastAssistant, W - 3)}${C.off}${C.accent}▌${C.off}`)
        else rows.push('')
      }
    }

    // buttons row — record hit regions (1-indexed terminal coords)
    const btnY = rows.length + 1
    let cursor = 2
    const mkBtn = (id, label, on, activeColor = C.ok) => {
      const txt = `${on ? activeColor : C.faint}${on ? '●' : '○'} ${label}${C.off}`
      const width = strip(txt).length
      this.buttons.push({ id, x1: cursor, x2: cursor + width - 1, y: btnY })
      cursor += width + 3
      return txt
    }
    const parts = [
      mkBtn('toggle-mic', 'mic', this.micAvailable && !this.muted),
      mkBtn('toggle-sound', 'voice', this.soundOn),
      mkBtn('toggle-text', 'text', this.textOn, C.accent),
      mkBtn('copy', 'copy', false),
    ]
    const btnRow = ' ' + parts.join(`${C.faint} · ${C.off}`)
    rows.push(pad(btnRow, W - 1))

    // input line
    rows.push(` ${C.accent}›${C.off} ${C.text}${this.input}${C.off}${C.accent}▌${C.off}`)

    const frame =
      ESC + 'H' + rows.slice(0, H).map((r) => pad(r, W - 1) + ESC + 'K').join('\n') + ESC + '0J'
    process.stdout.write(frame)
  }

  stop() {
    this.closed = true
    clearInterval(this.timer)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdout.write(MOUSE_OFF + SHOW + ALT_OFF)
  }
}
