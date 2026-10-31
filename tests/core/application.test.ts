import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeCommandError,
  NativeStateError,
  UnsupportedFeatureError,
  type NativeApplication,
  type NativeBatch,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function withApp(run: (app: NativeApplication) => Promise<void>, mode = 'normal') {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'protocol-peer.ts'), mode],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics).toEqual({
    windows: 0,
    nodes: 0,
    callbacks: 0,
    queuedTransactions: 0,
    queuedCallbacks: 0,
    activeCallbacks: 0,
  })
}

async function controls(window: NativeWindow) {
  return window.batch((batch) => {
    const label = batch.create({ kind: 'text', text: 'Count: 0' })
    const button = batch.create({ kind: 'button', text: 'Click' })
    const input = batch.create({ kind: 'input', value: '' })
    batch.append(window.root, label)
    batch.append(window.root, button)
    batch.append(window.root, input)
    return { label, button, input }
  })
}

describe('owned application API (headless subprocess)', () => {
  test('exposes immutable capabilities and rejects unsupported JavaScript elements explicitly', () =>
    withApp(async (app) => {
      expect(app.capabilities).toEqual(['tree', 'input_revisions'])
      expect(Object.isFrozen(app.capabilities)).toBe(true)
      expect(Object.isFrozen(app.limits)).toBe(true)
      const window = await app.openWindow({ title: 'Capability contract' })
      await assert.rejects(
        window.batch((batch) => batch.create({ kind: 'webview' } as never)),
        (error: unknown) =>
          error instanceof UnsupportedFeatureError && error.feature === 'element:webview'
      )
      expect(window.revision).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('serializes transactions across windows, disposes subtrees and closes idempotently', () =>
    withApp(async (app) => {
      const [one, two] = await Promise.all([
        app.openWindow({ title: 'One' }),
        app.openWindow({ title: 'Two' }),
      ])
      const [first, second] = await Promise.all([controls(one), controls(two)])
      one.onClick(first.button, () => {})
      one.onInput(first.input, () => {})
      two.onClick(second.button, () => {})
      expect(app.diagnostics).toEqual({
        windows: 2,
        nodes: 8,
        callbacks: 3,
        queuedTransactions: 0,
        queuedCallbacks: 0,
        activeCallbacks: 0,
      })
      await one.batch((batch) => {
        batch.remove(first.button)
        batch.remove(first.input)
      })
      expect(app.diagnostics.callbacks).toBe(1)
      expect(one.revision).toBe(2)
      await one.close()
      await one.close()
      await one.closed
      assert.throws(() => one.onClick(first.button, () => {}), /closed/)
      await assert.rejects(
        one.batch((batch) => batch.remove(first.label)),
        /closed/
      )
      await two.close()
      expect(app.diagnostics.nodes).toBe(0)
    }))

  test('rejects forged and cross-window handles before dispatch', () =>
    withApp(async (app) => {
      const one = await app.openWindow({ title: 'One' })
      const two = await app.openWindow({ title: 'Two' })
      const first = await controls(one)
      const forged = { kind: 'button' } as NativeNode<'button'>
      assert.throws(() => one.onClick(forged, () => {}), NativeStateError)
      assert.throws(() => two.onClick(first.button, () => {}), /another window/)
      await assert.rejects(
        two.batch((batch) => batch.append(two.root, first.button)),
        /another window/
      )
      expect(two.revision).toBe(0)
      expect(one.revision).toBe(1)
    }))

  test('rolls back rejected batches, revokes temporary handles and keeps the session usable', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Rollback' })
      const { label } = await controls(window)
      let rolledBack: NativeNode<'button'> | undefined
      await assert.rejects(
        window.batch((batch) => {
          rolledBack = batch.create({ kind: 'button', text: 'Temporary' })
          batch.append(window.root, rolledBack)
          batch.set(label, { kind: 'text', text: 'reject transaction' })
        }),
        NativeCommandError
      )
      assert.throws(() => window.onClick(rolledBack!, () => {}), /disposed/)
      expect(window.revision).toBe(1)
      expect(app.diagnostics.nodes).toBe(4)
      await window.batch((batch) => batch.set(label, { kind: 'text', text: 'Still usable' }))
      expect(window.revision).toBe(2)
    }))

  test('rejects asynchronous or escaped transaction callbacks', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Callback lifetime' })
      let escaped: NativeBatch | undefined
      await window.batch((batch) => {
        escaped = batch
      })
      assert.throws(() => escaped!.create({ kind: 'text', text: 'late' }), /already returned/)
      await assert.rejects(
        // @ts-expect-error JavaScript callers must also get the runtime contract failure.
        window.batch(async (batch) => {
          await Promise.resolve()
          batch.create({ kind: 'text', text: 'after await' })
        }),
        /synchronous/
      )
      // The rejected async callback must be consumed after its transaction is revoked.
      await new Promise<void>((resolve) => setImmediate(resolve))
      // oxlint-disable-next-line unicorn/no-thenable -- A non-callable field is deliberately not a PromiseLike.
      const ordinary = { then: 'ordinary property' }
      expect(await window.batch(() => ordinary)).toBe(ordinary)
      expect(window.revision).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('validates attachment, cycles, ordering, root disposal and immutable node kinds', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Tree validation' })
      await assert.rejects(
        window.batch((batch) => batch.create({ kind: 'text', text: 'orphan' })),
        /attached/
      )
      const { box, child } = await window.batch((batch) => {
        const box = batch.create({ kind: 'box' })
        const child = batch.create({ kind: 'box' })
        batch.append(window.root, box)
        batch.append(box, child)
        return { box, child }
      })
      await assert.rejects(
        window.batch((batch) => batch.append(child, box)),
        /cycle/
      )
      await assert.rejects(
        window.batch((batch) => batch.insert(window.root, child, 9)),
        /index/
      )
      await assert.rejects(
        window.batch((batch) => batch.remove(window.root)),
        /root/
      )
      await assert.rejects(
        window.batch((batch) => batch.set(box, { kind: 'text', text: '' } as never)),
        /kind/
      )
      await window.batch((batch) => batch.append(window.root, child))
      await window.batch((batch) => batch.remove(box))
      expect(app.diagnostics.nodes).toBe(2)
    }))

  test('preserves native input received during an unrelated transaction', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Input revision' })
      const { label, input } = await controls(window)
      const observed: string[] = []
      window.onInput(input, (event) => {
        observed.push(event.value)
      })
      await window.batch((batch) =>
        batch.set(label, { kind: 'text', text: 'input before acknowledgement' })
      )
      expect(window.input(input)).toEqual({ value: 'newer native edit', revision: 1 })
      expect(observed).toEqual(['newer native edit'])
      await assert.rejects(
        window.batch((batch) => batch.set(input, { kind: 'input', value: 'stale' }, 0)),
        /revision/
      )
      await window.batch((batch) => batch.set(input, { kind: 'input', value: 'intentional' }, 1))
      expect(window.input(input)).toEqual({ value: 'intentional', revision: 2 })
    }))

  test('permits reentrant updates and shutdown from an event callback', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Reentrancy' })
      const { label, button } = await controls(window)
      let called = 0
      window.onClick(button, async (event) => {
        expect(event.node).toBe(button)
        expect(event.signal.aborted).toBe(false)
        called += 1
        await window.batch((batch) =>
          batch.set(label, { kind: 'text', text: 'Updated inside listener' })
        )
        await app.shutdown()
        expect(event.signal.aborted).toBe(true)
      })
      await window.batch((batch) => batch.set(label, { kind: 'text', text: 'emit click' }))
      await app.closed
      expect(called).toBe(1)
    }))

  test('an old unsubscribe cannot remove its replacement and disposal drops late callbacks', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Listener ownership' })
      const { label, button } = await controls(window)
      let called = 0
      const clicked = Promise.withResolvers<void>()
      const removeOld = window.onClick(button, () => {
        called += 100
      })
      const removeCurrent = window.onClick(button, () => {
        called += 1
        clicked.resolve()
      })
      removeOld()
      await window.batch((batch) => batch.set(label, { kind: 'text', text: 'emit click' }))
      await clicked.promise
      expect(called).toBe(1)
      removeCurrent()
      removeCurrent()
      window.onClick(button, () => {
        called += 1_000
      })
      await window.batch((batch) => batch.remove(button))
      await window.batch((batch) => batch.set(label, { kind: 'text', text: 'After deletion' }))
      expect(called).toBe(1)
      expect(app.diagnostics.callbacks).toBe(0)
    }, 'late-event'))

  test('listener failure reaches closed and releases every owned resource', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Listener failure' })
      const { label, button } = await controls(window)
      window.onClick(button, () => {
        throw new Error('application listener failed')
      })
      await window.batch((batch) => batch.set(label, { kind: 'text', text: 'emit click' }))
      await assert.rejects(app.closed, /application listener failed/)
      await assert.rejects(app.shutdown(), /application listener failed/)
    }))

  test('cancels waiting dispatch without retaining an uncooperative listener', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Cancellation' })
      const { label, button } = await controls(window)
      const started = Promise.withResolvers<void>()
      let signal: AbortSignal | undefined
      window.onClick(button, (event) => {
        signal = event.signal
        started.resolve()
        return new Promise<void>(() => {})
      })
      await window.batch((batch) => batch.set(label, { kind: 'text', text: 'emit click' }))
      await started.promise
      await app.shutdown()
      await app.closed
      expect(signal?.aborted).toBe(true)
    }))

  test('rejects wrong-window native events and shuts down the host', () =>
    withApp(async (app) => {
      const one = await app.openWindow({ title: 'One' })
      const two = await app.openWindow({ title: 'Two' })
      const { label } = await controls(one)
      await controls(two)
      await one.batch((batch) => batch.set(label, { kind: 'text', text: 'emit wrong owner' }))
      await assert.rejects(app.closed, /outside its owner/)
    }, 'wrong-owner'))

  test('bounds queued work while reserving capacity for window cleanup', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Backpressure' })
      const { label } = await controls(window)
      const pending = Array.from({ length: 128 }, (_, i) =>
        window
          .batch((batch) => batch.set(label, { kind: 'text', text: `Value ${i}` }))
          .catch((error) => error)
      )
      await assert.rejects(
        window.batch(() => {}),
        /queue is full/
      )
      const close = window.close()
      await Promise.all(pending)
      await close
      expect(app.diagnostics.windows).toBe(0)
    }))

  test('enforces negotiated resource limits before native dispatch', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Small limits' })
      await app.openWindow({ title: 'Second' })
      await assert.rejects(app.openWindow({ title: 'Too many' }), /window limit/)
      await assert.rejects(
        window.batch((batch) => {
          for (let i = 0; i < 4; i += 1) batch.create({ kind: 'box' })
        }),
        /node limit/
      )
      await assert.rejects(
        window.batch((batch) => {
          const text = batch.create({ kind: 'text', text: 'x'.repeat(33) })
          batch.append(window.root, text)
        }),
        /text limit/
      )
      await assert.rejects(
        window.batch((batch) => {
          for (let i = 0; i < 2; i += 1) {
            const text = batch.create({ kind: 'text', text: 'x'.repeat(21) })
            batch.append(window.root, text)
          }
        }),
        /text memory limit/
      )
      expect(window.revision).toBe(0)
    }, 'small'))
})
