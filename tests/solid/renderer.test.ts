import { describe, expect, test } from 'bun:test'
import { createApplication, type NativeApplication } from '@bun-native/core'
import {
  createComponent,
  createElement,
  createTextNode,
  For,
  insert,
  render,
  setProp,
  type RenderRoot,
} from '@bun-native/solid'
import { batch, createEffect, createSignal, onCleanup } from 'solid-js'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function withApp(run: (app: NativeApplication) => Promise<void>) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, '../core/protocol-peer.ts')],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics.nodes).toBe(0)
  expect(app.diagnostics.callbacks).toBe(0)
}

function label(text: string) {
  const node = createElement('text')
  setProp(node, 'text', text)
  return node
}

describe('Solid universal adapter over the public core (headless subprocess)', () => {
  test('signals coalesce native updates; unmount disposes effects and owned nodes', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid signals' })
      let setCount!: (value: number) => number
      const effects: number[] = []
      let cleaned = 0
      const root = render(() => {
        const [count, set] = createSignal(0)
        setCount = set
        createEffect(() => effects.push(count()))
        onCleanup(() => cleaned++)
        const box = createElement('box')
        insert(box, () => `Count: ${count()}`)
        return box
      }, window)
      await root.ready
      expect(effects).toEqual([0])
      expect(app.diagnostics.nodes).toBe(4)
      const before = root.diagnostics
      batch(() => {
        setCount(1)
        setCount(2)
        setCount(3)
      })
      await root.flush()
      expect(effects).toEqual([0, 3])
      expect(root.diagnostics.mutations.set - before.mutations.set).toBe(1)
      expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
      await root.dispose()
      await root.dispose()
      setCount(4)
      expect(effects).toEqual([0, 3])
      expect(cleaned).toBe(1)
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('keyed moves preserve native identities and dispose only removed owners', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid keyed list' })
      const a = { id: 'a' }
      const b = { id: 'b' }
      const c = { id: 'c' }
      let update!: (value: { id: string }[]) => { id: string }[]
      const created: string[] = []
      const removed: string[] = []
      const root = render(() => {
        const [items, set] = createSignal([a, b, c])
        update = set
        const box = createElement('box')
        insert(box, () =>
          createComponent(For, {
            get each() {
              return items()
            },
            children: (item: { id: string }) => {
              created.push(item.id)
              onCleanup(() => removed.push(item.id))
              return label(item.id)
            },
          })
        )
        return box
      }, window)
      await root.ready
      const before = root.diagnostics
      update([c, a, b])
      await root.flush()
      expect(created).toEqual(['a', 'b', 'c'])
      expect(removed).toEqual([])
      expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
      expect(root.diagnostics.mutations.remove).toBe(before.mutations.remove)
      expect(root.diagnostics.mutations.insert).toBeGreaterThan(before.mutations.insert)
      update([c, b])
      await root.flush()
      expect(removed).toEqual(['a'])
      expect(root.diagnostics.nodes).toBe(4)
      await root.dispose()
      expect(removed.sort()).toEqual(['a', 'b', 'c'])
    }))

  test('event replacement and removal revoke old subscriptions', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid events' })
      let clicks = 0
      const button = createElement('button')
      const text = label('initial')
      setProp(button, 'text', 'Click')
      setProp(button, 'onClick', () => clicks++)
      const root = render(() => {
        const box = createElement('box')
        insert(box, [text, button])
        return box
      }, window)
      await root.ready
      expect(app.diagnostics.callbacks).toBe(1)
      setProp(button, 'onClick', () => (clicks += 10))
      setProp(text, 'text', 'emit click')
      await root.flush()
      for (let attempt = 0; attempt < 100 && clicks === 0; attempt++) await Bun.sleep(5)
      expect(clicks).toBe(10)
      await root.dispose()
      expect(app.diagnostics.callbacks).toBe(0)
    }))

  test('OS/window close disposes Solid owners without retaining a subtree', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid close' })
      let cleaned = 0
      const root = render(() => {
        onCleanup(() => cleaned++)
        return label('Native lifetime')
      }, window)
      await root.ready
      await window.close()
      await root.closed
      await root.dispose()
      expect(cleaned).toBe(1)
      expect(root.diagnostics.nodes).toBe(0)
    }))

  test('failed property commit cleans the root and exposes the original error', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid failure' })
      const node = label('valid')
      const root = render(() => node, window)
      await root.ready
      setProp(node, 'style', { font_size: -1 })
      await assert.rejects(root.flush(), /font_size/)
      await assert.rejects(root.closed, /font_size/)
      expect(app.diagnostics.nodes).toBe(1)
      expect(root.diagnostics.nodes).toBe(0)
    }))

  test('rejects browser tags, forged children and cross-root ownership', () =>
    withApp(async (app) => {
      assert.throws(() => createElement('div'), /solid-element:div/)
      const window = await app.openWindow({ title: 'Solid ownership' })
      const node = createTextNode('owned')
      let first: RenderRoot | undefined
      try {
        first = render(() => node, window)
        await first.ready
        const second = render(() => node, window)
        await assert.rejects(second.ready, /between render roots/)
        expect(app.diagnostics.nodes).toBe(3)
        const forged = render(() => ({}) as never, window)
        await assert.rejects(forged.ready, /owned Solid native node/)
      } finally {
        await first?.dispose()
      }
    }))
})
