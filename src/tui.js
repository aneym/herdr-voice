import { EventEmitter } from 'node:events'

const ESC = '\x1b['
const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'
const HIDE = '\x1b[?25l'
const SHOW = '\x1b[?25h'

// Two-tone monochrome + a single accent; hierarchy by weight/alpha, not hue.
const C = {
  dim: '\x1b[38;5;242m',
  faint: '\x1b[38;5;238m',
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
function wrap(text, width) {
  const lines = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line.length) line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else {
        lines.push(line)
        line = word
      }
      while (line.length > width) {
        lines.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    lines.push(line)
  }
  return lines
}

export class VoiceTUI extends EventEmitter {
  constructor({ sessionName, model }) {
    super()
    this.sessionName = sessionName
    this.model = model
    this.status = { state: 'connecting', message: '' }
    this.transcript = [] // {role:'you'|'ai'|'sys', text, done}
    this.toolLog = [] // {name, args, result, error, at}
    this.spaces = []
    this.agents = []
    this.micLevel = 0
    this.muted = true
    this.micAvailable = false
    this.speaking = false
    this.input = ''
    this.dirty = true
    this.closed = false
  }

  start() {
    process.stdout.write(ALT_ON + HIDE)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (k) => this._key(k))
    }
    process.stdout.on('resize', () => this._render(true))
    this.timer = setInterval(() => {
      if (this.dirty) this._render()
    }, 60)
    this._render(true)
    return this
  }

  _key(k) {
    if (k === '' || k === '') return this.emit('quit') // ctrl-c/d
    if (k === '\t') return this.emit('toggle-mute')
    if (k === '\r' || k === '\n') {
      const text = this.input.trim()
      this.input = ''
      this.dirty = true
      if (text) this.emit('submit', text)
      return
    }
    if (k === '' || k === '\b') {
      this.input = this.input.slice(0, -1)
      this.dirty = true
      return
    }
    // ignore control/escape sequences, accept printable text
    if (k.charCodeAt(0) < 32 || k.startsWith('\x1b')) return
    this.input += k
    this.dirty = true
  }

  // ---- state updates -------------------------------------------------------
  // no-ops for HUD-only concepts so index.js can wire either UI uniformly
  setPartial() {}
  setSound() {}
  setText() {}
  notify(text) {
    this.addSystem(text)
  }
  setStatus(s) {
    this.status = { ...this.status, ...s }
    this.dirty = true
  }
  setHerdrState({ spaces, agents }) {
    if (spaces) this.spaces = spaces
    if (agents) this.agents = agents
    this.dirty = true
  }
  setMic({ level, muted, available }) {
    if (level !== undefined) this.micLevel = level
    if (muted !== undefined) this.muted = muted
    if (available !== undefined) this.micAvailable = available
    this.dirty = true
  }
  setSpeaking(v) {
    this.speaking = v
    this.dirty = true
  }

  addUser(text, { done = true } = {}) {
    const last = this.transcript[this.transcript.length - 1]
    if (last && last.role === 'you' && !last.done) {
      last.text = text
      last.done = done
    } else this.transcript.push({ role: 'you', text, done })
    this.dirty = true
  }
  updateAssistant(text, done = false) {
    const last = this.transcript[this.transcript.length - 1]
    if (last && last.role === 'ai' && !last.done) {
      last.text = text
      last.done = done
    } else this.transcript.push({ role: 'ai', text, done })
    this.dirty = true
  }
  addSystem(text) {
    this.transcript.push({ role: 'sys', text, done: true })
    this.dirty = true
  }
  addToolCall(entry) {
    this.toolLog.push(entry)
    this.dirty = true
  }
  updateToolCall(callId, patch) {
    const e = this.toolLog.find((t) => t.callId === callId)
    if (e) Object.assign(e, patch)
    this.dirty = true
  }

  // ---- rendering -----------------------------------------------------------
  _render() {
    if (this.closed) return
    this.dirty = false
    const W = Math.max(80, process.stdout.columns || 100)
    const H = Math.max(20, process.stdout.rows || 30)
    const out = []
    out.push(ESC + '2J' + ESC + 'H')

    // Geometry: a two-column body row is
    //   │ <left:leftW> │ <right:rightW> │  ==  leftW + rightW + 6 columns
    const leftW = Math.floor((W - 6) * 0.56)
    const rightW = W - 6 - leftW
    const bodyH = H - 8

    // header
    const dot =
      this.status.state === 'ready' ? C.ok + '●' :
      this.status.state === 'error' ? C.err + '●' : C.warn + '●'
    const right = `${dot} ${C.dim}${this.status.state}${C.off} ${C.faint}·${C.off} ${C.dim}${this.model}${C.off} ${C.faint}·${C.off} ${C.accent}${this.sessionName}${C.off}`
    const title = `${C.bold}${C.bright}herdr voice${C.off}`
    // ┌─ <title> <fill> <right> ─┐  == 3 + title + 1 + fill + 1 + right + 3
    const fill = Math.max(1, W - strip(title).length - strip(right).length - 8)
    out.push(
      `${C.faint}┌─${C.off} ${title} ${C.faint}${'─'.repeat(fill)}${C.off} ${right} ${C.faint}─┐${C.off}`
    )

    // column headers
    out.push(
      `${C.faint}│${C.off} ${pad(C.dim + 'TRANSCRIPT' + C.off, leftW)} ${C.faint}│${C.off} ${pad(C.dim + 'TOOL CALLS' + C.off, rightW)}${C.faint}│${C.off}`
    )

    // build left (transcript) lines
    const leftLines = []
    for (const t of this.transcript) {
      const tag =
        t.role === 'you' ? `${C.accent}you${C.off}` :
        t.role === 'ai' ? `${C.bright}ai ${C.off}` : `${C.faint}sys${C.off}`
      const body = wrap(t.text || '…', leftW - 5)
      body.forEach((l, i) => {
        const prefix = i === 0 ? tag + ' ' : '    '
        const color = t.role === 'sys' ? C.faint : t.done ? C.text : C.dim
        leftLines.push(`${prefix}${color}${l}${C.off}${!t.done && i === body.length - 1 ? C.accent + '▌' + C.off : ''}`)
      })
    }

    // build right (tool calls) lines
    const rightLines = []
    for (const e of this.toolLog) {
      const mark = e.error ? `${C.err}✗${C.off}` : e.result ? `${C.ok}✓${C.off}` : `${C.warn}▸${C.off}`
      rightLines.push(`${mark} ${C.bright}${e.name}${C.off}`)
      const argStr = JSON.stringify(e.args ?? {})
      if (argStr !== '{}') wrap(argStr, rightW - 6).forEach((l) => rightLines.push(`  ${C.faint}${l}${C.off}`))
      if (e.error) wrap(e.error, rightW - 6).forEach((l) => rightLines.push(`  ${C.err}${l}${C.off}`))
      else if (e.result) wrap(e.result, rightW - 6).forEach((l) => rightLines.push(`  ${C.dim}${l}${C.off}`))
    }

    const lv = leftLines.slice(-bodyH)
    const rv = rightLines.slice(-bodyH)
    for (let i = 0; i < bodyH; i++) {
      const l = lv[i] ?? ''
      const r = rv[i] ?? ''
      out.push(`${C.faint}│${C.off} ${pad(l, leftW)} ${C.faint}│${C.off} ${pad(r, rightW)}${C.faint}│${C.off}`)
    }

    // state bar
    out.push(`${C.faint}├${'─'.repeat(leftW + 2)}┴${'─'.repeat(rightW + 1)}┤${C.off}`)
    const spaceStr = this.spaces.length
      ? this.spaces
          .map((s) => `${C.dim}${s.number}${C.off} ${s.current ? C.accent + s.name + '*' + C.off : C.text + s.name + C.off}`)
          .join(`${C.faint} · ${C.off}`)
      : `${C.faint}none${C.off}`
    const agentStr = this.agents.length
      ? this.agents
          .map((a) => {
            const col = a.status === 'working' ? C.warn : a.status === 'blocked' ? C.err : C.ok
            return `${C.text}${a.name}${C.off} ${col}${a.status}${C.off}`
          })
          .join(`${C.faint} · ${C.off}`)
      : `${C.faint}none${C.off}`
    out.push(`${C.faint}│${C.off} ${pad(`${C.dim}SPACES${C.off}  ${spaceStr}`, W - 4)} ${C.faint}│${C.off}`)
    out.push(`${C.faint}│${C.off} ${pad(`${C.dim}AGENTS${C.off}  ${agentStr}`, W - 4)} ${C.faint}│${C.off}`)
    out.push(`${C.faint}├${'─'.repeat(W - 2)}┤${C.off}`)

    // footer: mic meter + input + keys
    const bars = 10
    const filled = Math.round(this.micLevel * bars)
    const meter = this.micAvailable
      ? (this.muted ? C.faint : C.accent) +
        Array.from({ length: bars }, (_, i) => (i < filled ? '█' : '▁')).join('') +
        C.off
      : ''
    const micTag = !this.micAvailable
      ? `${C.faint}unavailable — type below${C.off}`
      : this.muted
        ? `${C.faint}muted${C.off}`
        : `${C.ok}live${C.off}`
    const spk = this.speaking ? `${C.accent}◉ hearing you${C.off}` : ''
    const keys = `${C.faint}[tab] mute  [enter] send  [ctrl-c] quit${C.off}`
    out.push(
      `${C.faint}│${C.off} ${pad(`${C.dim}mic${C.off} ${micTag} ${meter} ${spk}`, W - 5 - strip(keys).length)} ${keys} ${C.faint}│${C.off}`
    )
    out.push(
      `${C.faint}│${C.off} ${pad(`${C.accent}›${C.off} ${C.text}${this.input}${C.off}${C.accent}▌${C.off}`, W - 4)} ${C.faint}│${C.off}`
    )
    out.push(`${C.faint}└${'─'.repeat(W - 2)}┘${C.off}`)

    process.stdout.write(out.join('\n'))
  }

  stop() {
    this.closed = true
    clearInterval(this.timer)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdout.write(SHOW + ALT_OFF)
  }
}
