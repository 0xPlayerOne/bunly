import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeStateError,
  type NativeApplication,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function within<T>(promise: Promise<T>, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), 1_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(condition: () => boolean, reason: string): Promise<void> {
  const deadline = performance.now() + 1_000
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(reason)
    await Bun.sleep(1)
  }
}

async function withApp(
  run: (application: NativeApplication) => Promise<void>,
  expectedFailure?: RegExp
): Promise<void> {
  const application = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'lifecycle-peer.ts')],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(application)
  } finally {
    const stopped = within(application.shutdown(), 'Application shutdown retained callback work')
    const closed = within(application.closed, 'Application event ingestion did not finish')
    if (expectedFailure) {
      await Promise.all([
        assert.rejects(stopped, expectedFailure),
        assert.rejects(closed, expectedFailure),
      ])
    } else {
      await Promise.all([stopped, closed])
    }
    expect(application.diagnostics).toMatchObject({
      windows: 0,
      nodes: 0,
      callbacks: 0,
      queuedTransactions: 0,
      queuedCallbacks: 0,
      activeCallbacks: 0,
    })
  }
}

async function controls(window: NativeWindow) {
  return window.batch((batch) => {
    const label = batch.create({ kind: 'text', text: 'Trigger' })
    const button = batch.create({ kind: 'button', text: 'First' })
    const second = batch.create({ kind: 'button', text: 'Second' })
    const input = batch.create({ kind: 'input', value: '' })
    for (const node of [label, button, second, input]) batch.append(window.root, node)
    return { label, button, second, input }
  })
}

function trigger(window: NativeWindow, label: NativeNode<'text'>, marker: string): Promise<void> {
  return window.batch((batch) => batch.set(label, { kind: 'text', text: `edge:${marker}` }))
}

async function osClose(window: NativeWindow, label: NativeNode<'text'>): Promise<void> {
  // The actual close event may be ingested before the triggering transaction's
  // application-level continuation. Only that exact revocation race is accepted.
  await trigger(window, label, 'os-close').catch((error: unknown) => {
    assert(error instanceof NativeStateError && error.code === 'invalid_handle')
  })
  await within(window.closed, 'OS close was blocked by an application callback')
}

describe('callback lifecycle edges (headless real protocol process)', () => {
  test('OS close revokes an uncooperative callback and ignores its late native event', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'OS close while callback waits' })
      const { label, button } = await controls(window)
      const started = Promise.withResolvers<AbortSignal>()
      let calls = 0
      window.onClick(button, (event) => {
        calls += 1
        started.resolve(event.signal)
        return new Promise<void>(() => {})
      })
      await trigger(window, label, 'click')
      const signal = await within(started.promise, 'Initial callback did not start')
      expect(signal.aborted).toBe(false)
      await osClose(window, label)
      expect(signal.aborted).toBe(true)
      expect(calls).toBe(1)
      expect(application.diagnostics.windows).toBe(0)
    }))

  test('sibling input state and close are ingested while global callback execution waits', () =>
    withApp(async (application) => {
      const one = await application.openWindow({ title: 'Blocked callback owner' })
      const two = await application.openWindow({ title: 'Independent input owner' })
      const first = await controls(one)
      const second = await controls(two)
      const started = Promise.withResolvers<void>()
      let siblingCallbacks = 0
      one.onClick(first.button, () => {
        started.resolve()
        return new Promise<void>(() => {})
      })
      two.onInput(second.input, () => {
        siblingCallbacks += 1
      })
      await trigger(one, first.label, 'click')
      await within(started.promise, 'Blocking callback did not start')
      await trigger(two, second.label, 'input')
      await until(
        () => two.input(second.input).revision === 1,
        'Sibling input state was blocked by another window callback'
      )
      expect(two.input(second.input)).toEqual({ value: 'sibling native edit', revision: 1 })
      expect(siblingCallbacks).toBe(0)
      await osClose(two, second.label)
      expect(siblingCallbacks).toBe(0)
      expect(application.diagnostics.windows).toBe(1)
      await one.close()
      expect(siblingCallbacks).toBe(0)
    }))

  test('queued callbacks execute in global event order after the active callback settles', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'Ordered callback backlog' })
      const { label, button } = await controls(window)
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const sequences: number[] = []
      window.onClick(button, async (event) => {
        sequences.push(event.sequence)
        if (sequences.length === 1) {
          started.resolve()
          await release.promise
        }
      })
      await trigger(window, label, 'click')
      await within(started.promise, 'Initial ordered callback did not start')
      await trigger(window, label, 'burst:4')
      await until(
        () => application.diagnostics.queuedCallbacks === 4,
        'Native events were not queued independently of callback completion'
      )
      expect(sequences).toEqual([1])
      release.resolve()
      await until(() => sequences.length === 5, 'Queued callbacks did not resume')
      expect(sequences).toEqual([1, 2, 3, 4, 5])
    }))

  test('callback flood is bounded independently of the native event transport queue', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'Bounded callback backlog' })
      const { label, button } = await controls(window)
      const started = Promise.withResolvers<AbortSignal>()
      window.onClick(button, (event) => {
        started.resolve(event.signal)
        return new Promise<void>(() => {})
      })
      await trigger(window, label, 'click')
      const signal = await within(started.promise, 'Flood blocker did not start')
      // Each chunk is below NativeHost's event cap. Wait for ingestion between
      // chunks so this specifically reaches the application callback queue cap.
      await trigger(window, label, 'burst:64')
      await until(
        () => application.diagnostics.queuedCallbacks === 64,
        'First bounded burst was not ingested'
      )
      await trigger(window, label, 'burst:63')
      await until(
        () => application.diagnostics.queuedCallbacks === 127,
        'Second bounded burst was not ingested'
      )
      await trigger(window, label, 'burst:2').catch(() => {})
      await assert.rejects(
        within(application.closed, 'Callback overflow did not terminate the session'),
        /callback.*(full|limit|capacity)/i
      )
      expect(signal.aborted).toBe(true)
    }, /callback.*(full|limit|capacity)/i))

  test('deleting a node aborts its active listener, purges queued work and preserves sibling callbacks', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'Node listener disposal' })
      const { label, button, second } = await controls(window)
      const started = Promise.withResolvers<AbortSignal>()
      let firstCalls = 0
      const secondSequences: number[] = []
      window.onClick(button, (event) => {
        firstCalls += 1
        started.resolve(event.signal)
        return new Promise<void>(() => {})
      })
      window.onClick(second, (event) => {
        secondSequences.push(event.sequence)
      })
      await trigger(window, label, 'click')
      const signal = await within(started.promise, 'Deleted-node listener did not start')
      await trigger(window, label, 'burst:4')
      await trigger(window, label, 'second-button')
      await until(
        () => application.diagnostics.queuedCallbacks === 5,
        'Disposal backlog was not ingested'
      )
      await window.batch((batch) => batch.remove(button))
      expect(signal.aborted).toBe(true)
      await until(
        () => secondSequences.length === 1,
        'Sibling callback was retained behind deleted-node work'
      )
      expect(firstCalls).toBe(1)
      expect(secondSequences).toEqual([6])
      await until(
        () =>
          application.diagnostics.activeCallbacks === 0 &&
          application.diagnostics.queuedCallbacks === 0,
        'Disposed callback jobs remained retained'
      )
    }))

  test('application close aborts callbacks synchronously before the native acknowledgement', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'Immediate close cancellation' })
      const { label, button } = await controls(window)
      const started = Promise.withResolvers<AbortSignal>()
      let calls = 0
      window.onClick(button, (event) => {
        calls += 1
        started.resolve(event.signal)
        return new Promise<void>(() => {})
      })
      await trigger(window, label, 'click')
      const signal = await within(started.promise, 'Close listener did not start')
      const closing = window.close()
      expect(signal.aborted).toBe(true)
      await within(closing, 'Native close did not finish')
      await within(window.closed, 'Closed window was retained')
      expect(calls).toBe(1)
    }))

  test('an old unsubscribe cannot remove a replacement using the identical function', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'Registration identity' })
      const { label, button } = await controls(window)
      const called = Promise.withResolvers<void>()
      let count = 0
      const listener = () => {
        count += 1
        called.resolve()
      }
      const removeOld = window.onClick(button, listener)
      window.onClick(button, listener)
      removeOld()
      await trigger(window, label, 'click')
      await within(called.promise, 'Old unsubscribe removed the replacement registration')
      expect(count).toBe(1)
    }))

  test('an abort-handler replacement survives the unsubscribe that revoked its predecessor', () =>
    withApp(async (application) => {
      const window = await application.openWindow({
        title: 'Abort-handler registration reentrancy',
      })
      const { label, button } = await controls(window)
      const started = Promise.withResolvers<void>()
      const replacementCalled = Promise.withResolvers<void>()
      const remove = window.onClick(button, (event) => {
        event.signal.addEventListener(
          'abort',
          () => {
            window.onClick(button, () => {
              replacementCalled.resolve()
            })
          },
          { once: true }
        )
        started.resolve()
        return new Promise<void>(() => {})
      })
      await trigger(window, label, 'click')
      await within(started.promise, 'Abort-handler predecessor did not start')
      remove()
      await trigger(window, label, 'click')
      await within(
        replacementCalled.promise,
        'Outer unsubscribe deleted the replacement installed by its abort handler'
      )
    }))

  test('reentrant replacement keeps each unsubscribe paired with the listener it installed', () =>
    withApp(async (application) => {
      const window = await application.openWindow({ title: 'Reentrant registration ownership' })
      const { label, button, second } = await controls(window)
      const started = Promise.withResolvers<void>()
      const drained = Promise.withResolvers<void>()
      let nestedCalls = 0
      let removeNested: (() => void) | undefined
      window.onClick(button, (event) => {
        event.signal.addEventListener(
          'abort',
          () => {
            removeNested = window.onClick(button, () => {
              nestedCalls += 1
            })
          },
          { once: true }
        )
        started.resolve()
        return new Promise<void>(() => {})
      })
      window.onClick(second, () => {
        drained.resolve()
      })
      await trigger(window, label, 'click')
      await within(started.promise, 'Reentrant predecessor did not start')
      window.onClick(button, () => {})
      assert(removeNested)
      removeNested()
      await trigger(window, label, 'click')
      await trigger(window, label, 'second-button')
      await within(drained.promise, 'Global callback queue did not drain the ownership probe')
      expect(nestedCalls).toBe(0)
    }))
})
