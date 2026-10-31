import {
  UnsupportedFeatureError,
  type Element,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'
import type { Node, Snapshot } from './nodes.ts'

export type Counts = { create: number; set: number; insert: number; remove: number }
export type Committed = Snapshot & { handle: NativeNode; unsubscribe: (() => void) | undefined }

function key(element: Element): string {
  return JSON.stringify(element)
}

/** Framework-independent native diff. Publish its handles only after atomic acknowledgement. */
export async function commitNativeTree(
  window: NativeWindow,
  root: Node,
  previous: ReadonlyMap<Node, Committed>,
  desired: ReadonlyMap<Node, Snapshot>
): Promise<{ nodes: Map<Node, Committed>; counts: Counts }> {
  const counts: Counts = { create: 0, set: 0, insert: 0, remove: 0 }
  const next = await window.batch((batch) => {
    const handles = new Map([...previous].map(([node, state]) => [node, state.handle]))
    const parents = new Map([...previous].map(([node, state]) => [node, state.parent]))
    const children = new Map([...previous].map(([node, state]) => [node, [...state.children]]))
    const attach = (parent: Node, child: Node, index: number) => {
      const oldParent = parents.get(child)
      const oldChildren = oldParent && children.get(oldParent)
      if (oldChildren) oldChildren.splice(oldChildren.indexOf(child), 1)
      const siblings = children.get(parent)!
      siblings.splice(index, 0, child)
      parents.set(child, parent)
      batch.insert(handles.get(parent)! as NativeNode<'box'>, handles.get(child)!, index)
      counts.insert += 1
    }
    // Rescue retained keyed descendants before deleting an obsolete ancestor.
    // Moving them temporarily to this root also frees capacity before creations.
    const rescue = (node: Node): void => {
      // attach mutates the source sibling array, so traversal needs a snapshot.
      const descendants = children.get(node)?.slice() ?? []
      for (const child of descendants) {
        if (desired.has(child)) attach(root, child, children.get(root)!.length)
        else rescue(child)
      }
    }
    for (const [node, state] of previous) {
      if (desired.has(node) || (state.parent && !desired.has(state.parent))) continue
      rescue(node)
      batch.remove(state.handle)
      counts.remove += 1
      const siblings = state.parent && children.get(state.parent)
      if (siblings) siblings.splice(siblings.indexOf(node), 1)
    }
    for (const [node, state] of desired) {
      const old = previous.get(node)
      if (!old) {
        const handle = batch.create(state.element)
        handles.set(node, handle)
        children.set(node, [])
        counts.create += 1
        if (node === root) {
          batch.append(window.root, handle)
          counts.insert += 1
        }
      } else if (key(old.element) !== key(state.element)) {
        if (state.element.kind === 'input') {
          // BN2 #234 owns controlled edits. Reject a changed value explicitly
          // until its Solid intent is paired with a native input revision.
          if (old.element.kind !== 'input' || old.element.value !== state.element.value)
            throw new UnsupportedFeatureError('solid-controlled-input-value')
          const input = window.input(old.handle as NativeNode<'input'>)
          batch.set(
            old.handle as NativeNode<'input'>,
            { ...state.element, value: input.value },
            input.revision
          )
        } else {
          batch.set(old.handle as NativeNode<Exclude<Element['kind'], 'input'>>, state.element)
        }
        counts.set += 1
      }
    }
    for (const [parent, state] of desired) {
      for (let index = 0; index < state.children.length; index += 1) {
        const child = state.children[index]!
        if (children.get(parent)![index] !== child) attach(parent, child, index)
      }
    }
    return new Map(
      [...desired].map(([node, state]) => [
        node,
        { ...state, handle: handles.get(node)!, unsubscribe: previous.get(node)?.unsubscribe },
      ])
    )
  })
  return { nodes: next, counts }
}
