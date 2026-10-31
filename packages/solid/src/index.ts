import { renderer } from './renderer.ts'

export { render } from './mount.ts'
export type { RenderRoot } from './mount.ts'
export type { SolidNode } from './nodes.ts'
export type { JSX } from './jsx.ts'

// This is the helper contract emitted by Solid's official universal JSX compiler.
export const {
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} = renderer

export { For, Show, Switch, Match, Index, ErrorBoundary } from 'solid-js'
