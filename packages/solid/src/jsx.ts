import type { ClickEvent, InputEvent, Listener, Style } from '@bun-native/core'
import type { SolidNode } from './nodes.ts'

export namespace JSX {
  export type Element = SolidNode | string | number | boolean | null | undefined | Element[]
  export interface ElementChildrenAttribute {
    children: unknown
  }
  type Base = { style?: Style; ref?: (node: SolidNode) => void }
  type TextContent = { text?: string; children?: Element }
  export interface IntrinsicElements {
    box: Base & { children?: Element }
    text: Base & TextContent
    button: Base & TextContent & { disabled?: boolean; onClick?: Listener<ClickEvent> }
    input: Base & { value?: string; placeholder?: string; onInput?: Listener<InputEvent> }
  }
}
