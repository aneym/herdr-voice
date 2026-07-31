import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import { MODEL, VOICE, SAMPLE_RATE } from './config.js'
import { REALTIME_TOOLS, INSTRUCTIONS } from './tools.js'

const REALTIME_URL = 'wss://api.openai.com/v1/realtime'

/**
 * Node-side Realtime session over WebSocket.
 *
 * Three API quirks are handled deliberately here (all verified against the live API):
 *  1. output_modalities must be exactly ['audio'] OR exactly ['text'] — never both.
 *     In 'voice' mode we still get text for the TUI via audio-transcript events.
 *  2. Function calls surface twice (response.function_call_arguments.done AND inside
 *     response.done.output) — we dedupe by call_id.
 *  3. Sending response.create while a response is active errors with
 *     "conversation already has an active response in progress" — so every
 *     response.create goes through a gate that queues one pending request.
 */
export class RealtimeSession extends EventEmitter {
  constructor({ apiKey, mode = 'voice' }) {
    super()
    this.apiKey = apiKey
    this.mode = mode
    this.ws = null
    this.ready = false
    this.responseActive = false
    this.pendingResponse = false
    this.handledCallIds = new Set()
    this.assistantBuffer = ''
  }

  connect() {
    this.emit('status', { state: 'connecting', model: MODEL })
    const ws = new WebSocket(`${REALTIME_URL}?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    this.ws = ws

    ws.on('open', () => this._configure())
    ws.on('message', (raw) => {
      let ev
      try {
        ev = JSON.parse(raw.toString())
      } catch {
        return
      }
      this._handle(ev)
    })
    ws.on('error', (err) => this.emit('status', { state: 'error', message: err.message }))
    ws.on('close', (code) => {
      this.ready = false
      this.emit('status', { state: 'closed', code })
    })
    return this
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj))
  }

  _configure() {
    const speaks = this.mode === 'voice'
    this._send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: INSTRUCTIONS,
        // Quirk 1: exactly one modality.
        output_modalities: speaks ? ['audio'] : ['text'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            turn_detection: { type: 'semantic_vad' },
            transcription: { model: 'gpt-4o-transcribe', language: 'en' },
          },
          ...(speaks ? { output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, voice: VOICE } } : {}),
        },
        tools: REALTIME_TOOLS,
        tool_choice: 'auto',
      },
    })
  }

  /** Quirk 3: never let two responses overlap. */
  requestResponse() {
    if (this.responseActive) {
      this.pendingResponse = true
      return
    }
    this.responseActive = true
    this._send({ type: 'response.create' })
  }

  _releaseResponse() {
    this.responseActive = false
    if (this.pendingResponse) {
      this.pendingResponse = false
      this.requestResponse()
    }
  }

  /** Send typed text as a user turn (used by the TUI's text input and for testing). */
  sendText(text) {
    this._send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })
    this.emit('user_transcript', { itemId: `typed:${Date.now()}`, text, done: true, typed: true })
    this.requestResponse()
  }

  /** Append base64 PCM16 mic audio. Server VAD handles turn boundaries. */
  sendAudio(base64Pcm) {
    this._send({ type: 'input_audio_buffer.append', audio: base64Pcm })
  }

  sendToolResult(callId, result) {
    this._send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    })
    this.requestResponse()
  }

  _dispatchCall(name, callId, argsRaw) {
    // Quirk 2: dedupe — the same call arrives via two event paths.
    if (!name || !callId || this.handledCallIds.has(callId)) return
    this.handledCallIds.add(callId)
    let args = {}
    try {
      args = JSON.parse(argsRaw || '{}')
    } catch {
      /* malformed args -> let the tool layer report it */
    }
    this.emit('tool_call', { name, callId, args })
  }

  _handle(ev) {
    switch (ev.type) {
      case 'session.updated':
        if (!this.ready) {
          this.ready = true
          this.emit('status', { state: 'ready', model: MODEL, mode: this.mode })
        }
        break

      case 'input_audio_buffer.speech_started':
        this.emit('speech', { active: true })
        break
      case 'input_audio_buffer.speech_stopped':
        this.emit('speech', { active: false })
        break

      case 'conversation.item.input_audio_transcription.delta': {
        // live dictation: accumulate per item and stream to the UI
        const id = ev.item_id ?? ev.item?.id ?? 'live'
        this._partials ??= new Map()
        const acc = (this._partials.get(id) ?? '') + (ev.delta ?? '')
        this._partials.set(id, acc)
        this.emit('user_partial', { itemId: id, text: acc })
        break
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const id = ev.item_id ?? ev.item?.id
        this._partials?.delete(id)
        this.emit('user_transcript', {
          itemId: id,
          text: ev.transcript ?? '',
          done: true,
        })
        break
      }

      // Assistant text — alias-tolerant per observed API variants.
      case 'response.output_text.delta':
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (ev.delta) {
          this.assistantBuffer += ev.delta
          this.emit('assistant_delta', { text: this.assistantBuffer, delta: ev.delta })
        }
        break

      case 'response.output_text.done':
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const final = ev.text ?? ev.transcript ?? this.assistantBuffer
        this.assistantBuffer = ''
        this.emit('assistant_done', { text: final })
        break
      }

      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (ev.delta) this.emit('audio', ev.delta)
        break

      case 'response.function_call_arguments.done':
        this._dispatchCall(ev.name, ev.call_id, ev.arguments)
        break

      case 'response.created':
        this.responseActive = true
        break

      case 'response.done': {
        for (const item of ev.response?.output ?? []) {
          if (item.type === 'function_call') this._dispatchCall(item.name, item.call_id, item.arguments)
        }
        this._releaseResponse()
        break
      }

      case 'error':
        this.emit('status', {
          state: 'error',
          message: ev.error?.message ?? 'unknown realtime error',
        })
        this._releaseResponse()
        break
    }
  }

  close() {
    this.ws?.close()
  }
}
