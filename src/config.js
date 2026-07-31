import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_CANDIDATES = [
  path.join(APP_ROOT, '.env'), // works wherever the plugin/repo is checked out
  path.join(HOME, '.config/herdr-voice/.env'),
]

function readKeyFromFiles() {
  for (const file of ENV_CANDIDATES) {
    if (!fs.existsSync(file)) continue
    const line = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('OPENAI_API_KEY='))
    if (!line) continue
    const value = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
    if (value) return { value, source: file }
  }
  return null
}

export function loadApiKey() {
  if (process.env.OPENAI_API_KEY) {
    return { value: process.env.OPENAI_API_KEY, source: 'env:OPENAI_API_KEY' }
  }
  const found = readKeyFromFiles()
  if (!found) {
    throw new Error(
      'No OPENAI_API_KEY found. Set the env var or add it to herdr-voice/.env'
    )
  }
  return found
}

/**
 * Resolve which herdr session socket to drive.
 * A named session is strongly preferred for testing so we never touch live workspaces.
 */
export function resolveSocket({ session, socket: socketOverride } = {}) {
  // Explicit socket path wins over everything — this is how the remote launcher
  // points the app at an SSH-forwarded studio socket.
  const explicit = socketOverride || process.env.HERDR_VOICE_SOCKET
  if (explicit) {
    return { name: 'remote', socket: explicit, exists: fs.existsSync(explicit) }
  }
  // herdr injects HERDR_SOCKET_PATH into [[keys.command]] commands, so when we are
  // launched from a keybinding we drive exactly the session that launched us —
  // no --session needed. An explicit flag still wins.
  if (!session && process.env.HERDR_SOCKET_PATH) {
    const socket = process.env.HERDR_SOCKET_PATH
    const parent = path.basename(path.dirname(socket))
    return {
      name: parent === 'herdr' ? 'default' : parent,
      socket,
      exists: fs.existsSync(socket),
    }
  }
  const name = session || process.env.HERDR_VOICE_SESSION || 'default'
  const base = path.join(HOME, '.config/herdr')
  const socket =
    name === 'default'
      ? path.join(base, 'herdr.sock')
      : path.join(base, 'sessions', name, 'herdr.sock')
  return { name, socket, exists: fs.existsSync(socket) }
}

export const MODEL = process.env.HERDR_VOICE_MODEL || 'gpt-realtime-2.1'
export const VOICE = process.env.HERDR_VOICE_VOICE || 'marin'
export const SAMPLE_RATE = 24000
