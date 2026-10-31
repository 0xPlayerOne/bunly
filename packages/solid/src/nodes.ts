import {
  NativeStateError,
  UnsupportedFeatureError,
  type ClickEvent,
  type Element,
  type InputEvent,
  type Listener,
  type Style,
} from '@bun-native/core'

declare const identity: unique symbol

/** An adapter-owned JSX reference, not a DOM node or a native handle. */
export interface SolidNode {
  readonly [identity]: true
}

export interface Owner {
  readonly token: object
  changed(): void
  detached(node: Node): void
}

type Properties = {
  style?: Style
  text?: string
  value?: string
  placeholder?: string
  disabled?: boolean
  onClick?: Listener<ClickEvent>
  onInput?: Listener<InputEvent>
}

const nodes = new WeakSet<object>()

export class Node implements SolidNode {
  declare readonly [identity]: true
  readonly children: Node[] = []
  readonly properties: Properties = {}
  parent: Node | undefined
  owner: Owner | undefined
  scope: object | undefined
  data = ''

  constructor(readonly kind: Element['kind'] | 'text-node') {
    nodes.add(this)
  }
}

export function asNode(value: SolidNode): Node {
  if (!value || typeof value !== 'object' || !nodes.has(value))
    throw new NativeStateError('invalid_handle', 'Expected an owned Solid native node')
  return value as Node
}

export function createElement(tag: string): Node {
  if (tag !== 'box' && tag !== 'text' && tag !== 'button' && tag !== 'input')
    throw new UnsupportedFeatureError('solid-element:' + tag)
  return new Node(tag)
}

export function createTextNode(value: string): Node {
  const node = new Node('text-node')
  node.data = String(value)
  return node
}

export function visit(node: Node, fn: (node: Node) => void): void {
  fn(node)
  for (const child of node.children) visit(child, fn)
}

export function insertNode(parent: Node, node: Node, anchor?: Node): void {
  if (parent.kind === 'input' || parent.kind === 'text-node')
    throw new NativeStateError('invalid_state', 'This native element cannot have children')
  if (parent.kind !== 'box' && node.kind !== 'text-node')
    throw new NativeStateError('invalid_state', 'Text and button children must be text')
  if (anchor && anchor.parent !== parent)
    throw new NativeStateError('invalid_handle', 'Insertion anchor belongs to another parent')
  if (anchor === node) return
  for (let ancestor: Node | undefined = parent; ancestor; ancestor = ancestor.parent)
    if (ancestor === node) throw new NativeStateError('invalid_state', 'Native tree cycle')
  const owner = parent.owner
  if (owner)
    visit(node, (child) => {
      if (child.scope && child.scope !== owner.token)
        throw new NativeStateError('invalid_handle', 'Solid nodes cannot move between render roots')
    })
  const previousOwner = node.owner
  if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
  node.parent = parent
  parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, node)
  visit(node, (child) => {
    child.owner = owner
    if (owner) child.scope = owner.token
  })
  previousOwner?.changed()
  owner?.changed()
}

export function removeNode(parent: Node, node: Node): void {
  if (node.parent !== parent)
    throw new NativeStateError('invalid_handle', 'Removal target belongs to another parent')
  const owner = parent.owner
  owner?.detached(node)
  parent.children.splice(parent.children.indexOf(node), 1)
  node.parent = undefined
  visit(node, (child) => {
    child.owner = undefined
  })
  owner?.changed()
}

export function replaceText(node: Node, value: string): void {
  if (node.kind !== 'text-node')
    throw new NativeStateError('invalid_state', 'Text replacement requires a text node')
  if (node.data === value) return
  node.data = value
  node.owner?.changed()
}

export function setProperty(node: Node, name: string, value: unknown): void {
  const props = node.properties
  switch (name) {
    case 'style':
      if (value === undefined) delete props.style
      else if (value && typeof value === 'object' && !Array.isArray(value))
        props.style = { ...value }
      else throw new TypeError('Native style must be an object')
      break
    case 'text':
      if (node.kind !== 'text' && node.kind !== 'button')
        throw new TypeError('Only text and button elements accept text')
      if (value === undefined) delete props.text
      else if (typeof value === 'string') props.text = value
      else throw new TypeError('Native text must be a string')
      break
    case 'value':
    case 'placeholder':
      if (node.kind !== 'input') throw new TypeError('Only inputs accept ' + name)
      if (value === undefined) delete props[name]
      else if (typeof value === 'string') props[name] = value
      else throw new TypeError('Native input ' + name + ' must be a string')
      break
    case 'disabled':
      if (node.kind !== 'button') throw new TypeError('Only buttons accept disabled')
      if (value === undefined) delete props.disabled
      else if (typeof value === 'boolean') props.disabled = value
      else throw new TypeError('Native disabled must be boolean')
      break
    case 'onClick':
      if (node.kind !== 'button') throw new TypeError('Only buttons accept onClick')
      if (value === undefined) delete props.onClick
      else if (typeof value === 'function') props.onClick = value as Listener<ClickEvent>
      else throw new TypeError('Native onClick must be a function')
      break
    case 'onInput':
      if (node.kind !== 'input') throw new TypeError('Only inputs accept onInput')
      if (value === undefined) delete props.onInput
      else if (typeof value === 'function') props.onInput = value as Listener<InputEvent>
      else throw new TypeError('Native onInput must be a function')
      break
    default:
      throw new UnsupportedFeatureError('solid-property:' + name)
  }
  node.owner?.changed()
}

export type Snapshot = {
  element: Element
  children: readonly Node[]
  parent: Node | undefined
  click: Listener<ClickEvent> | undefined
  input: Listener<InputEvent> | undefined
}

/** Capture values before awaiting the core queue; later effects form another batch. */
export function snapshot(root: Node): Map<Node, Snapshot> {
  const result = new Map<Node, Snapshot>()
  const capture = (node: Node, parent?: Node): void => {
    const props = node.properties
    const style = props.style ? { style: { ...props.style } } : {}
    let element: Element
    if (node.kind === 'box') element = { kind: 'box', ...style }
    else if (node.kind === 'input')
      element = {
        kind: 'input',
        value: props.value ?? '',
        ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
        ...style,
      }
    else {
      if (props.text !== undefined && node.children.length)
        throw new TypeError('Choose text properties or text children, not both')
      const text =
        node.kind === 'text-node'
          ? node.data
          : (props.text ?? node.children.map((child) => child.data).join(''))
      element =
        node.kind === 'button'
          ? {
              kind: 'button',
              text,
              ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
              ...style,
            }
          : { kind: 'text', text, ...style }
    }
    const children = node.kind === 'box' ? [...node.children] : []
    result.set(node, { element, children, parent, click: props.onClick, input: props.onInput })
    for (const child of children) capture(child, node)
  }
  capture(root)
  return result
}
