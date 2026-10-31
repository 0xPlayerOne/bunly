import { NativeStateError, type NativeNode, type NativeWindow } from '@bun-native/core'
import { createMemo, createRoot, createSignal } from 'solid-js'
import type { JSX } from './jsx.ts'
import { Node, snapshot, visit, type Owner, type Snapshot } from './nodes.ts'
import { renderer } from './renderer.ts'
import { commitNativeTree, type Committed, type Counts } from './native-tree.ts'

export interface RenderRoot {
  /** Initial native acknowledgement. A synchronous JSX evaluation error rejects this promise. */
  readonly ready: Promise<void>
  /** Ends after unmount or OS close; asynchronous renderer failures reject it. */
  readonly closed: Promise<void>
  readonly diagnostics: Readonly<{
    nodes: number
    listeners: number
    pending: boolean
    commits: number
    mutations: Readonly<Counts>
  }>
  /** Wait until all currently scheduled reactive mutations have native acknowledgements. */
  flush(): Promise<void>
  /** Dispose the Solid owner, revoke callbacks and remove only this root's subtree. */
  dispose(): Promise<void>
}

function assertReactiveRuntime(): void {
  let observed = -1
  createRoot((dispose) => {
    const [value, set] = createSignal(0)
    const derived = createMemo(value)
    set(1)
    observed = derived()
    dispose()
  })
  if (observed !== 1)
    throw new Error(
      'Solid native rendering requires Bun --conditions=browser (reactive Solid exports)'
    )
}

class Root implements RenderRoot, Owner {
  readonly token = {}
  readonly root = new Node('box')
  readonly ready: Promise<void>
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private rejectClosed!: (error: Error) => void
  private disposeSolid: (() => void) | undefined
  private committed = new Map<Node, Committed>()
  private operation: Promise<void> | undefined
  private version = 0
  private acknowledged = -1
  private phase: 'active' | 'disposing' | 'closed' = 'active'
  private windowEnded = false
  private failure: Error | undefined
  private commits = 0
  private readonly mutations: Counts = { create: 0, set: 0, insert: 0, remove: 0 }

  constructor(
    private readonly window: NativeWindow,
    component: () => JSX.Element
  ) {
    this.closed = new Promise((resolve, reject) => {
      this.resolveClosed = resolve
      this.rejectClosed = reject
    })
    void this.closed.catch(() => {})
    this.root.owner = this
    this.root.scope = this.token
    void window.closed.then(() => {
      this.windowEnded = true
      this.stop()
      this.finish()
    })
    try {
      createRoot((dispose) => {
        this.disposeSolid = dispose
        renderer.insert(this.root, component())
      })
    } catch (cause) {
      this.failure = cause instanceof Error ? cause : new Error(String(cause))
      this.stop()
    }
    this.start()
    this.ready = this.flush()
    void this.ready.catch(() => {})
  }

  get diagnostics() {
    return Object.freeze({
      nodes: this.committed.size,
      listeners: [...this.committed.values()].filter((node) => node.unsubscribe).length,
      pending: this.operation !== undefined,
      commits: this.commits,
      mutations: Object.freeze({ ...this.mutations }),
    })
  }

  changed(): void {
    if (this.phase !== 'active') return
    this.version += 1
    this.start()
  }

  detached(node: Node): void {
    visit(node, (child) => {
      const current = this.committed.get(child)
      current?.unsubscribe?.()
      if (current) current.unsubscribe = undefined
    })
  }

  private start(): void {
    if (this.operation || this.phase === 'closed') return
    this.operation = Promise.resolve()
      .then(async () => {
        while (this.phase === 'active' && this.acknowledged !== this.version) {
          const version = this.version
          await this.commit(snapshot(this.root))
          this.acknowledged = version
        }
        if (this.phase === 'disposing') await this.cleanup()
      })
      .catch(async (cause: unknown) => {
        if (!this.windowEnded) {
          this.failure ??= cause instanceof Error ? cause : new Error(String(cause))
          this.stop()
          try {
            await this.cleanup()
          } catch (cleanupError) {
            this.failure = new AggregateError(
              [this.failure, cleanupError],
              'Solid native cleanup failed'
            )
            this.finish()
          }
        }
      })
      .finally(() => {
        this.operation = undefined
        if (
          this.phase === 'disposing' ||
          (this.phase === 'active' && this.acknowledged !== this.version)
        )
          this.start()
      })
  }

  async flush(): Promise<void> {
    while (this.operation) await this.operation
    if (this.failure) throw this.failure
  }

  async dispose(): Promise<void> {
    this.stop()
    this.start()
    await this.flush()
    await this.closed
  }

  private stop(): void {
    if (this.phase === 'closed') return
    this.phase = 'disposing'
    const dispose = this.disposeSolid
    this.disposeSolid = undefined
    try {
      dispose?.()
    } catch (cause) {
      this.failure ??= cause instanceof Error ? cause : new Error(String(cause))
    }
    this.detached(this.root)
    visit(this.root, (node) => {
      node.owner = undefined
    })
  }

  private finish(): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.committed.clear()
    this.root.children.length = 0
    if (this.failure) this.rejectClosed(this.failure)
    else this.resolveClosed()
  }

  private async cleanup(): Promise<void> {
    const root = this.committed.get(this.root)
    if (root && !this.windowEnded) {
      await this.window.batch((batch) => batch.remove(root.handle))
      this.mutations.remove += 1
      this.commits += 1
    }
    this.finish()
  }

  private async commit(desired: ReadonlyMap<Node, Snapshot>): Promise<void> {
    const previous = this.committed
    const { nodes: next, counts } = await commitNativeTree(
      this.window,
      this.root,
      previous,
      desired
    )
    if (this.windowEnded) return
    this.committed = next
    this.commits += 1
    for (const field of ['create', 'set', 'insert', 'remove'] as const)
      this.mutations[field] += counts[field]
    if (this.phase !== 'active') return
    for (const [node, state] of next) {
      const old = previous.get(node)
      if (old?.click !== state.click || old?.input !== state.input || !state.unsubscribe) {
        state.unsubscribe?.()
        state.unsubscribe = undefined
        if (state.click) {
          const listener = state.click
          state.unsubscribe = this.window.onClick(
            state.handle as NativeNode<'button'>,
            async (event) => {
              if (node.owner !== this || node.properties.onClick !== listener) return
              await listener(event)
              await this.flush()
            }
          )
        } else if (state.input) {
          const listener = state.input
          state.unsubscribe = this.window.onInput(
            state.handle as NativeNode<'input'>,
            async (event) => {
              if (node.owner !== this || node.properties.onInput !== listener) return
              await listener(event)
              await this.flush()
            }
          )
        }
      }
    }
  }
}

/** Mount one Solid owner into an independently disposable native container. */
export function render(component: () => JSX.Element, window: NativeWindow): RenderRoot {
  if (typeof component !== 'function')
    throw new NativeStateError('invalid_state', 'Solid render requires a component function')
  assertReactiveRuntime()
  return new Root(window, component)
}
