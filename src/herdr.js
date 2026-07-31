import net from 'node:net'
import { EventEmitter } from 'node:events'

/**
 * Client for the herdr unix-socket JSON API.
 *
 * Wire format is newline-delimited JSON: {id, method, params} -> {id, result} | {id, error}.
 * The ping response advertises the server's protocol; API clients do not send a
 * protocol version in their requests.
 *
 * Important protocol detail (verified empirically against herdr 0.7.5): the server
 * closes the connection immediately after answering a request — it is strictly
 * one-request-per-connection. The single exception is `events.subscribe`, which
 * keeps the socket open and streams events. So `request()` dials a fresh socket
 * each call, and `subscribe()` owns a separate long-lived one.
 */
export class HerdrClient extends EventEmitter {
  constructor(socketPath) {
    super()
    this.socketPath = socketPath
    this.seq = 0
    this.eventSocket = null
    this.closed = false
  }

  /** Fire a single request on its own connection. */
  request(method, params = {}, { timeoutMs = 15000 } = {}) {
    const id = `hv:${++this.seq}`
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath)
      socket.setEncoding('utf8')
      let buffer = ''
      let settled = false

      const done = (fn, arg) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        fn(arg)
      }
      const timer = setTimeout(
        () => done(reject, new Error(`herdr request timed out: ${method}`)),
        timeoutMs
      )

      socket.on('connect', () => {
        this.emit('request', { method, params })
        socket.write(JSON.stringify({ id, method, params }) + '\n')
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          let msg
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg.error) return done(reject, new Error(`${msg.error.code}: ${msg.error.message}`))
          if (msg.result !== undefined) return done(resolve, msg.result)
        }
      })
      socket.on('error', (err) => done(reject, err))
      socket.on('close', () => {
        if (!settled) done(reject, new Error(`herdr closed connection during ${method}`))
      })
    })
  }

  /** Verify the socket is reachable. */
  async connect() {
    const pong = await this.request('ping', {}, { timeoutMs: 5000 })
    this.emit('connect', pong)
    return pong
  }

  /**
   * Open a long-lived subscription. Emits 'herdr-event' per streamed event.
   * Auto-reconnects unless close() was called.
   */
  subscribe(types) {
    const subscriptions = types.map((t) => ({ type: t }))
    const dial = () => {
      if (this.closed) return
      const socket = net.createConnection(this.socketPath)
      this.eventSocket = socket
      socket.setEncoding('utf8')
      let buffer = ''

      socket.on('connect', () =>
        socket.write(JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions } }) + '\n')
      )
      socket.on('data', (chunk) => {
        buffer += chunk
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          let msg
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg.event) this.emit('herdr-event', msg)
        }
      })
      socket.on('error', () => {})
      socket.on('close', () => {
        if (!this.closed) setTimeout(dial, 1000)
      })
    }
    dial()
    return this
  }

  close() {
    this.closed = true
    this.eventSocket?.destroy()
    this.eventSocket = null
  }
}
