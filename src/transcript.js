import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const STATE_DIR = path.join(os.homedir(), '.local/state/herdr-voice/transcripts')

/**
 * Append-only JSONL transcript of a voice session, plus a plain-text rendering
 * for copying. One file per session, `latest.jsonl` symlinked to it.
 */
export class TranscriptStore {
  constructor() {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    this.file = path.join(STATE_DIR, `${stamp}.jsonl`)
    fs.writeFileSync(this.file, '')
    const latest = path.join(STATE_DIR, 'latest.jsonl')
    try {
      fs.rmSync(latest, { force: true })
      fs.symlinkSync(this.file, latest)
    } catch {
      /* symlink is a convenience, not a requirement */
    }
    this.entries = []
  }

  add(kind, data) {
    const entry = { at: new Date().toISOString(), kind, ...data }
    this.entries.push(entry)
    fs.appendFile(this.file, JSON.stringify(entry) + '\n', () => {})
    return entry
  }

  user(text, { typed = false } = {}) {
    return this.add('user', { text, typed })
  }
  assistant(text) {
    return this.add('assistant', { text })
  }
  tool(name, args, result) {
    return this.add('tool', { name, args, result })
  }
  system(text) {
    return this.add('system', { text })
  }

  /** Plain-text rendering of the whole session (for the clipboard). */
  asText({ includeTools = true } = {}) {
    const lines = []
    for (const e of this.entries) {
      if (e.kind === 'user') lines.push(`you: ${e.text}`)
      else if (e.kind === 'assistant') lines.push(`ai:  ${e.text}`)
      else if (e.kind === 'tool' && includeTools)
        lines.push(`  -> ${e.name}(${JSON.stringify(e.args)}) = ${JSON.stringify(e.result)}`)
    }
    return lines.join('\n')
  }

  lastExchangeText() {
    const lastUserIdx = this.entries.findLastIndex((e) => e.kind === 'user')
    if (lastUserIdx === -1) return this.asText()
    return this.entries
      .slice(lastUserIdx)
      .filter((e) => e.kind === 'user' || e.kind === 'assistant')
      .map((e) => (e.kind === 'user' ? `you: ${e.text}` : `ai:  ${e.text}`))
      .join('\n')
  }
}

/** Copy text to the local clipboard (macOS). Returns true on success. */
export function copyToClipboard(text) {
  return new Promise((resolve) => {
    const p = spawn('pbcopy')
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0))
    p.stdin.end(text)
  })
}

export { STATE_DIR as TRANSCRIPT_DIR }
