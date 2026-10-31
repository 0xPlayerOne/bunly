import {
  encodeFrame,
  FrameDecoder,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  ProtocolError,
  type Command,
  type NativeEvent,
  type ErrorCode,
  type Limits,
} from '@bun-native/protocol'
import { isAbsolute } from 'node:path'
import type { ReadableStreamDefaultReader } from 'node:stream/web'

type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
export type WindowCommand = WithoutId<Extract<Command, { type: 'open' | 'batch' | 'close' }>>
export type WindowEvent = Extract<NativeEvent, { type: 'click' | 'input' | 'closed' }>
export type HostResponse = Extract<NativeEvent, { type: 'ack' | 'opened' | 'applied' }>

export class NativeCommandError extends Error {
  override readonly name = 'NativeCommandError'
  constructor(
    readonly code: ErrorCode,
    readonly requestId: number,
    message: string
  ) {
    super('Native ' + code + ': ' + message)
  }
}

export interface HostOptions {
  /** Explicit prebuilt executable; starting an app never invokes Cargo. */
  executable: string
  /** Optional native process arguments, passed without a shell. */
  args?: readonly string[]
  requestTimeoutMs?: number
}

type Pending = {
  command: Command
  resolve: (response: HostResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type WaitingReader = {
  resolve: (value: IteratorResult<WindowEvent>) => void
  reject: (error: Error) => void
}

const MAX_PENDING_COMMANDS = 128
const MAX_QUEUED_EVENTS = 128

/**
 * Owns one native process and its bounded, versioned channel. Private transport;
 * framework-specific reconciliation belongs above this shared connection.
 */
export class NativeHost implements AsyncIterable<WindowEvent> {
  readonly exited: Promise<number>
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private readonly stdout: ReadableStreamDefaultReader<Uint8Array>
  private readonly stderr: ReadableStreamDefaultReader<Uint8Array>
  private readonly timeout: number
  private readonly pending = new Map<number, Pending>()
  private readonly events: WindowEvent[] = []
  private readonly finished: Promise<void>
  private waiting: WaitingReader | undefined
  private failure: Error | undefined
  private phase: 'starting' | 'running' | 'stopping' | 'closed' = 'starting'
  private ready = false
  private negotiatedLimits: Readonly<Limits> | undefined
  private sequence = 0
  private nextId = 1
  private writeTail: Promise<void> = Promise.resolve()
  private stderrTail = ''
  private iteratorTaken = false

  private constructor(options: HostOptions) {
    this.timeout = options.requestTimeoutMs ?? 5_000
    this.process = Bun.spawn({
      cmd: [options.executable, ...(options.args ?? [])],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.stdout = this.process.stdout.getReader()
    this.stderr = this.process.stderr.getReader()
    this.exited = this.process.exited
    this.finished = this.watch()
  }

  static async launch(options: HostOptions): Promise<NativeHost> {
    if (!isAbsolute(options.executable)) throw new Error('Native host path must be absolute')
    const timeout = options.requestTimeoutMs ?? 5_000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
      throw new Error('requestTimeoutMs must be an integer between 1 and 60000')
    const host = new NativeHost(options)
    try {
      await host.request({ type: 'hello', protocol: PROTOCOL_VERSION })
      if (!host.ready) throw new ProtocolError('Host acknowledged hello before protocol readiness')
      host.phase = 'running'
      return host
    } catch (error) {
      host.fail(error)
      await host.finished
      throw host.failure
    }
  }

  get limits(): Readonly<Limits> {
    if (!this.negotiatedLimits) throw new ProtocolError('Native limits are not negotiated')
    return this.negotiatedLimits
  }

  /** Resolves after the native UI thread acknowledges the operation. */
  send(
    command: Extract<WindowCommand, { type: 'open' }>
  ): Promise<Extract<HostResponse, { type: 'opened' }>>
  send(
    command: Extract<WindowCommand, { type: 'batch' }>
  ): Promise<Extract<HostResponse, { type: 'applied' }>>
  send(
    command: Extract<WindowCommand, { type: 'close' }>
  ): Promise<Extract<HostResponse, { type: 'ack' }>>
  send(command: WindowCommand): Promise<HostResponse>
  send(command: WindowCommand): Promise<HostResponse> {
    if (this.phase !== 'running') return Promise.reject(this.closedError())
    return this.request(command)
  }

  async shutdown(): Promise<void> {
    if (this.phase === 'closed' || this.phase === 'stopping') {
      await this.finished
      if (this.failure) throw this.failure
      return
    }
    this.phase = 'stopping'
    try {
      await this.request({ type: 'shutdown' })
      this.process.stdin.end()
      const deadline = setTimeout(
        () => this.fail(new Error('Native host did not exit')),
        this.timeout
      )
      try {
        await this.finished
      } finally {
        clearTimeout(deadline)
      }
      if (this.failure) throw this.failure
    } catch (error) {
      this.fail(error)
      await this.finished
      throw this.failure
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<WindowEvent> {
    if (this.iteratorTaken) throw new Error('Native events have exactly one consumer')
    this.iteratorTaken = true
    return {
      next: () => {
        if (this.failure) return Promise.reject(this.failure)
        const event = this.events.shift()
        if (event) return Promise.resolve({ done: false, value: event })
        if (this.phase === 'closed') return Promise.resolve({ done: true, value: undefined })
        if (this.waiting)
          return Promise.reject(new Error('Concurrent event reads are not supported'))
        return new Promise<IteratorResult<WindowEvent>>((resolve, reject) => {
          this.waiting = { resolve, reject }
        })
      },
      return: async () => {
        await this.shutdown()
        return { done: true, value: undefined }
      },
    }
  }

  private request(input: WithoutId<Command>): Promise<HostResponse> {
    if (this.phase === 'closed') return Promise.reject(this.closedError())
    if (this.pending.size >= MAX_PENDING_COMMANDS)
      return Promise.reject(new Error('Native command limit exceeded'))
    let command: Command
    let frame: Uint8Array
    try {
      command = parseCommand({ ...input, id: this.nextId++ })
      frame = encodeFrame(command)
      if (this.negotiatedLimits) {
        if (frame.byteLength - 1 > this.negotiatedLimits.max_frame_bytes)
          throw new ProtocolError('Command exceeds the negotiated frame limit')
        if (
          command.type === 'batch' &&
          command.operations.length > this.negotiatedLimits.max_operations
        )
          throw new ProtocolError('Command exceeds the negotiated batch limit')
      }
    } catch (error) {
      return Promise.reject(error)
    }
    const result = new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`Native ${command.type} request ${command.id} timed out`)),
        this.timeout
      )
      this.pending.set(command.id, {
        command,
        resolve,
        reject,
        timer,
      })
    })
    // FileSink buffering is bounded by the pending-command cap and frame limit.
    this.writeTail = this.writeTail
      .then(async () => {
        if (this.phase === 'closed') return
        this.process.stdin.write(frame)
        await this.process.stdin.flush()
      })
      .catch((error: unknown) => this.fail(error))
    return result
  }

  private async readStdout(): Promise<void> {
    const decoder = new FrameDecoder()
    try {
      for (;;) {
        const { done, value } = await this.stdout.read()
        if (done) break
        for (const raw of decoder.push(value)) this.receive(parseEvent(raw))
      }
      decoder.finish()
      if (this.phase !== 'stopping' && this.phase !== 'closed')
        throw new ProtocolError('Native output closed before shutdown')
    } finally {
      this.stdout.releaseLock()
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await this.stderr.read()
        if (done) break
        this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-4_096)
      }
      this.stderrTail = (this.stderrTail + decoder.decode()).slice(-4_096)
    } finally {
      this.stderr.releaseLock()
    }
  }

  private cancelOutput(): void {
    // The host can exit while another process still holds inherited pipe ends.
    // Cancel our reads directly; killing the already-exited host cannot close them.
    void this.stdout.cancel().catch(() => {})
    void this.stderr.cancel().catch(() => {})
  }

  private async watch(): Promise<void> {
    const streams = [this.readStdout(), this.readStderr()]
    let drainDeadline: ReturnType<typeof setTimeout> | undefined
    const exit = this.exited.then((code) => {
      // Allow buffered acknowledgements/diagnostics to drain, but bound EOF wait.
      drainDeadline = setTimeout(
        () => this.fail(new Error('Native output remained open after host exit')),
        this.timeout
      )
      return code
    })
    try {
      const [code] = await Promise.all([exit, ...streams])
      if (code !== 0 || this.phase !== 'stopping' || this.pending.size)
        throw new Error(`Native host exited unexpectedly (${code}). ${this.stderrTail}`)
      this.phase = 'closed'
      this.waiting?.resolve({ done: true, value: undefined })
      this.waiting = undefined
    } catch (error) {
      this.fail(error)
      await this.exited
    } finally {
      clearTimeout(drainDeadline)
      this.cancelOutput()
      await Promise.allSettled(streams)
    }
  }

  private receive(event: NativeEvent): void {
    if (this.phase === 'closed') return
    if (event.type === 'ready') {
      if (this.ready || this.phase !== 'starting') throw new ProtocolError('Unexpected ready event')
      if (!event.capabilities.includes('tree') || !event.capabilities.includes('input_revisions'))
        throw new ProtocolError('Native host lacks the required tree/input capabilities')
      this.negotiatedLimits = Object.freeze(event.limits)
      this.ready = true
      return
    }
    if (
      event.type === 'ack' ||
      event.type === 'opened' ||
      event.type === 'applied' ||
      event.type === 'error'
    ) {
      if (event.type === 'error' && event.id === undefined)
        throw new ProtocolError(`Native ${event.code}: ${event.message}`)
      const requestId = event.id
      const request = requestId === undefined ? undefined : this.pending.get(requestId)
      if (!request || requestId === undefined) throw new ProtocolError('Unknown native response id')
      clearTimeout(request.timer)
      this.pending.delete(requestId)
      if (event.type === 'error')
        request.reject(new NativeCommandError(event.code, requestId, event.message))
      else if (!this.matchesResponse(request.command, event)) {
        const error = new ProtocolError(
          'Native response does not match its request, owner or revision'
        )
        request.reject(error)
        throw error
      } else request.resolve(event)
      return
    }
    if (!this.ready) throw new ProtocolError('Native input arrived before protocol readiness')
    if (event.sequence !== this.sequence + 1)
      throw new ProtocolError('Native event sequence is out of order')
    this.sequence = event.sequence
    if (this.waiting) {
      this.waiting.resolve({ done: false, value: event })
      this.waiting = undefined
    } else {
      if (this.events.length >= MAX_QUEUED_EVENTS)
        throw new ProtocolError('Native event limit exceeded')
      this.events.push(event)
    }
  }

  private matchesResponse(command: Command, response: HostResponse): boolean {
    switch (command.type) {
      case 'open':
        return (
          response.type === 'opened' &&
          response.window_id === command.window_id &&
          response.root_id === command.root_id &&
          response.tree_revision === 0
        )
      case 'batch':
        return (
          response.type === 'applied' &&
          response.window_id === command.window_id &&
          response.tree_revision === command.base_revision + 1
        )
      case 'hello':
      case 'close':
      case 'shutdown':
        return response.type === 'ack'
    }
  }

  private closedError(): Error {
    return this.failure ?? new Error('Native host is not running')
  }

  private fail(cause: unknown): void {
    if (this.failure) return
    this.failure = cause instanceof Error ? cause : new Error(String(cause))
    this.phase = 'closed'
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(this.failure)
    }
    this.pending.clear()
    this.events.length = 0
    this.waiting?.reject(this.failure)
    this.waiting = undefined
    this.cancelOutput()
    this.process.kill('SIGKILL')
  }
}
