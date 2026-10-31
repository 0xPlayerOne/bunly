import type { Element, Limits, Style } from '@bun-native/protocol'
import type { HostOptions } from '@bun-native/runtime'

export type { Element, Style }
export type ApplicationOptions = HostOptions
export type ElementKind = Element['kind']
declare const nodeType: unique symbol

/** Opaque identity. Copying its properties does not create a usable handle. */
export interface NativeNode<K extends ElementKind = ElementKind> {
  readonly kind: K
  readonly [nodeType]: K
}

export interface ClickEvent {
  readonly type: 'click'
  readonly node: NativeNode<'button'>
  readonly sequence: number
  readonly signal: AbortSignal
}

export interface InputState {
  readonly value: string
  readonly revision: number
}

export interface InputEvent extends InputState {
  readonly type: 'input'
  readonly node: NativeNode<'input'>
  readonly sequence: number
  readonly signal: AbortSignal
}

export type Listener<T> = (event: T) => void | Promise<void>

export interface NativeBatch {
  create<E extends Element>(element: E): NativeNode<E['kind']>
  set(
    node: NativeNode<'input'>,
    element: Extract<Element, { kind: 'input' }>,
    expectedInputRevision: number
  ): void
  set<K extends Exclude<ElementKind, 'input'>>(
    node: NativeNode<K>,
    element: Extract<Element, { kind: K }>
  ): void
  /** Index is evaluated after detaching the child from its previous parent. */
  insert(parent: NativeNode<'box'>, child: NativeNode, index: number): void
  append(parent: NativeNode<'box'>, child: NativeNode): void
  /** Deletes the complete subtree; deleting a revoked node is an error. */
  remove(node: NativeNode): void
}

export interface WindowOptions {
  title: string
  width?: number
  height?: number
}

export interface NativeWindow {
  readonly root: NativeNode<'box'>
  readonly closed: Promise<void>
  readonly revision: number
  /** The callback is synchronous. Its changes commit atomically after acknowledgement. */
  batch<T>(update: (batch: NativeBatch) => T): Promise<T>
  onClick(node: NativeNode<'button'>, listener: Listener<ClickEvent>): () => void
  onInput(node: NativeNode<'input'>, listener: Listener<InputEvent>): () => void
  input(node: NativeNode<'input'>): InputState
  /** Idempotent. Revokes listeners before requesting native window removal. */
  close(): Promise<void>
}

export interface NativeApplication {
  readonly closed: Promise<void>
  readonly limits: Readonly<Limits>
  readonly diagnostics: Readonly<{
    windows: number
    nodes: number
    callbacks: number
    queuedTransactions: number
    queuedCallbacks: number
    activeCallbacks: number
  }>
  openWindow(options: WindowOptions): Promise<NativeWindow>
  /** May be called from a listener. Await closed outside that listener to join dispatch. */
  shutdown(): Promise<void>
}

export class NativeStateError extends Error {
  override readonly name = 'NativeStateError'
  constructor(
    readonly code: 'invalid_handle' | 'invalid_state' | 'stale_revision' | 'limit_exceeded',
    message: string
  ) {
    super(message)
  }
}
