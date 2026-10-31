import { describe, expect, test } from 'bun:test'
import { transformSolid } from '../../scripts/solid/transform.ts'

// These tests establish the JSX transformation boundary, not native rendering.
describe('official Solid universal JSX transform', () => {
  test('uses the native helper module for reactive native elements and control flow', () => {
    const output = transformSolid(
      `import { For } from 'solid-js';
       export const List = (props: { items: string[] }) =>
         <box><text>{props.items.length}</text>
           <For each={props.items}>{item => <text text={item}/>}</For>
         </box>`,
      'native-list.tsx'
    )
    expect(output).toContain('from "@bun-native/solid"')
    expect(output).toContain('createElement')
    expect(output).toContain('"box"')
    expect(output).not.toContain('solid-js/web')
    expect(output).not.toContain('document.')
    expect(output).not.toContain('createElementNS')
  })

  test('reports invalid JSX instead of passing untransformed source to another renderer', () => {
    expect(() => transformSolid('const view = <box>', 'invalid.tsx')).toThrow()
  })
})
