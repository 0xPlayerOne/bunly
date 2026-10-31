import { describe, expect, test } from 'bun:test'
import { NativeHost } from '@bun-native/runtime'
import { ProtocolError, type Command, type Element } from '@bun-native/protocol'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const fixture = resolve(import.meta.dir, 'protocol-peer.ts')
const options = (mode = 'normal', requestTimeoutMs = 1_000) => ({
  executable: process.execPath,
  args: [fixture, mode],
  requestTimeoutMs,
})
const open = {
  type: 'open',
  window_id: 1,
  root_id: 1,
  title: 'Test',
  width: 560,
  height: 380,
} as const

function batch(
  element: Element,
  base_revision = 0,
  node_id = 2
): Omit<Extract<Command, { type: 'batch' }>, 'id'> {
  return {
    type: 'batch',
    window_id: 1,
    base_revision,
    operations: [
      { type: 'create', node_id, element },
      { type: 'insert', parent_id: 1, child_id: node_id, index: 0 },
    ],
  }
}

async function deadline<T>(operation: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Test deadline exceeded: ${name}`)), 1_500)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function releasePipeHolder(directory: string): Promise<void> {
  // Only this test's holder reads its private release file. The holder also has
  // a hard self-expiry; cleanup never signals an unrelated process.
  writeFileSync(join(directory, 'release'), '')
  if (!existsSync(join(directory, 'ready'))) return
  const finished = join(directory, 'finished')
  const until = performance.now() + 1_500
  while (!existsSync(finished) && performance.now() < until) await Bun.sleep(10)
  if (!existsSync(finished)) throw new Error('Test-owned pipe holder did not release')
}

async function withPipeHolder(
  mode: 'shutdown' | 'exit',
  run: (host: NativeHost, finished: string) => Promise<void>
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'bun-native-pipe-holder-'))
  const finished = join(directory, 'finished')
  let host: NativeHost | undefined
  try {
    host = await NativeHost.launch({
      ...options(`inherited-pipe-${mode}`, 300),
      args: [fixture, `inherited-pipe-${mode}`, directory],
    })
    await run(host, finished)
  } finally {
    await releasePipeHolder(directory)
    if (host)
      await deadline(
        host.shutdown().catch(() => {}),
        'host cleanup'
      )
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('native process transport (headless protocol peer)', () => {
  test('negotiates, opens, updates, receives ordered events, closes and tears down', async () => {
    const host = await NativeHost.launch(options())
    const events = host[Symbol.asyncIterator]()
    try {
      expect(await host.send(open)).toEqual({
        type: 'opened',
        id: 2,
        window_id: 1,
        root_id: 1,
        tree_revision: 0,
      })
      expect(await host.send(batch({ kind: 'input', value: '世界' }))).toEqual({
        type: 'applied',
        id: 3,
        window_id: 1,
        tree_revision: 1,
      })
      expect(await events.next()).toEqual({
        done: false,
        value: {
          type: 'input',
          sequence: 1,
          window_id: 1,
          node_id: 2,
          value: '世界',
          input_revision: 1,
        },
      })
      await host.send(batch({ kind: 'button', text: 'Click' }, 1, 3))
      expect(await events.next()).toEqual({
        done: false,
        value: { type: 'click', sequence: 2, window_id: 1, node_id: 3 },
      })
      expect(await host.send({ type: 'close', window_id: 1 })).toEqual({ type: 'ack', id: 5 })
      expect(await events.next()).toEqual({
        done: false,
        value: { type: 'closed', sequence: 3, window_id: 1 },
      })
    } finally {
      await host.shutdown()
    }
    expect(await host.exited).toBe(0)
    expect(await events.next()).toEqual({ done: true, value: undefined })
    await host.shutdown()
    await expect(host.send({ type: 'close', window_id: 1 })).rejects.toThrow('not running')
  })

  test('command rejection preserves the healthy session', async () => {
    const host = await NativeHost.launch(options())
    try {
      await host.send(open)
      await expect(host.send(batch({ kind: 'text', text: 'reject' }))).rejects.toThrow(
        'invalid_state'
      )
      await host.send(batch({ kind: 'text', text: 'accepted' }))
    } finally {
      await host.shutdown()
    }
    expect(await host.exited).toBe(0)
  })

  test('returning from the event iterator releases the owned native process', async () => {
    const host = await NativeHost.launch(options())
    const reader = host[Symbol.asyncIterator]()
    const waiting = reader.next()
    await reader.return?.()
    expect(await waiting).toEqual({ done: true, value: undefined })
    expect(await host.exited).toBe(0)
    expect(() => host[Symbol.asyncIterator]()).toThrow('exactly one consumer')
  })

  test.each([
    'wrong-version',
    'missing-capability',
    'bad-json',
    'wrong-id',
    'wrong-ack',
    'duplicate-ready',
    'exit',
  ])('rejects and reaps a host with %s', async (mode) => {
    await expect(NativeHost.launch(options(mode))).rejects.toThrow()
  })

  test('bounds startup when the native process stops responding', async () => {
    await expect(NativeHost.launch(options('silent', 100))).rejects.toThrow('timed out')
  })

  test('rejects invalid options before spawning', async () => {
    await expect(NativeHost.launch({ executable: 'relative' })).rejects.toThrow('absolute')
    await expect(NativeHost.launch(options('normal', 0))).rejects.toThrow('requestTimeoutMs')
  })

  test('bounds an unconsumed event flood and terminates the native process', async () => {
    const host = await NativeHost.launch(options('flood'))
    await host.send(open)
    await host.send(batch({ kind: 'button', text: 'Flood' }))
    await host.exited
    await expect(host.shutdown()).rejects.toThrow('event limit')
  })

  test('bounds shutdown after native exit when inherited pipes stay open', async () => {
    await withPipeHolder('shutdown', async (host, finished) => {
      await expect(deadline(host.shutdown(), 'shutdown')).rejects.toThrow('Native')
      expect(await host.exited).toBe(0)
      expect(existsSync(finished)).toBe(false)
    })
  })

  test('rejects a waiting iterator on unexpected exit despite inherited pipes', async () => {
    await withPipeHolder('exit', async (host, finished) => {
      const events = host[Symbol.asyncIterator]()
      const pending = deadline(events.next(), 'event after native exit')
      // The peer acknowledges this request before exiting. There is no pending
      // command timeout to rescue the event iterator when the process exits.
      await host.send(open)
      await host.send(batch({ kind: 'text', text: 'exit-after-ack' }))
      await expect(pending).rejects.toThrow('Native')
      expect(await host.exited).toBe(23)
      expect(existsSync(finished)).toBe(false)
    })
  })

  test.each(['wrong-window', 'wrong-root', 'wrong-initial-revision'])(
    'rejects an opened response with %s',
    async (mode) => {
      const host = await NativeHost.launch(options(mode))
      try {
        await expect(deadline(host.send(open), 'invalid opened response')).rejects.toBeInstanceOf(
          ProtocolError
        )
      } finally {
        await deadline(
          host.shutdown().catch(() => {}),
          'failed host cleanup'
        )
      }
    }
  )

  test.each(['wrong-batch-window', 'wrong-revision'])(
    'rejects an applied response with %s',
    async (mode) => {
      const host = await NativeHost.launch(options(mode))
      try {
        await host.send(open)
        await expect(
          deadline(host.send(batch({ kind: 'text', text: 'Update' })), 'invalid applied response')
        ).rejects.toBeInstanceOf(ProtocolError)
      } finally {
        await deadline(
          host.shutdown().catch(() => {}),
          'failed host cleanup'
        )
      }
    }
  )

  test.each(['wrong-sequence', 'out-of-order-sequence'])(
    'terminates on %s and rejects further event reads',
    async (mode) => {
      const host = await NativeHost.launch(options(mode))
      const events = host[Symbol.asyncIterator]()
      try {
        await host.send(open)
        await host.send(batch({ kind: 'button', text: 'Sequence test' }))
        await deadline(host.exited, 'invalid event sequence')
        await expect(events.next()).rejects.toBeInstanceOf(ProtocolError)
      } finally {
        await deadline(
          host.shutdown().catch(() => {}),
          'failed host cleanup'
        )
      }
    }
  )
})
