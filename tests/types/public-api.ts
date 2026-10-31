/** Compile-only consumer contract. This module is never executed as a native test. */
import {
  createApplication,
  type Element,
  type NativeApplication,
  type NativeBatch,
  type NativeCapability,
  type NativeNode,
  type NativeWindow,
} from '@bun-native/core'

export const applicationFactory: (options: { executable: string }) => Promise<NativeApplication> =
  createApplication

export function checkCapabilities(application: NativeApplication): readonly NativeCapability[] {
  // @ts-expect-error Negotiated capabilities cannot be mutated by a consumer.
  application.capabilities.push('tree')
  return application.capabilities
}

export function checkPublicApi(window: NativeWindow, batch: NativeBatch): void {
  const box = batch.create({ kind: 'box', style: { direction: 'column', gap: 8 } })
  const text = batch.create({ kind: 'text', text: 'Typed native text' })
  const button = batch.create({ kind: 'button', text: 'Update', disabled: false })
  const input = batch.create({ kind: 'input', value: '', placeholder: 'Type here' })
  const inferredKinds: readonly ['box', 'text', 'button', 'input'] = [
    box.kind,
    text.kind,
    button.kind,
    input.kind,
  ]
  void inferredKinds

  batch.append(window.root, box)
  for (const node of [text, button, input]) batch.append(box, node)
  batch.insert(box, input, 0)
  batch.set(text, { kind: 'text', text: 'Updated', style: { color: 0x112233 } })
  batch.set(button, { kind: 'button', text: 'Updated button' })
  batch.set(
    input,
    { kind: 'input', value: 'Intentional replacement' },
    window.input(input).revision
  )

  const stopClick = window.onClick(button, async (event) => {
    const target: NativeNode<'button'> = event.node
    const signal: AbortSignal = event.signal
    if (signal.aborted) return
    await window.batch((update) => update.set(target, { kind: 'button', text: 'Clicked' }))
  })
  const stopInput = window.onInput(input, (event) => {
    const target: NativeNode<'input'> = event.node
    const observed: Readonly<{ value: string; revision: number }> = window.input(target)
    void observed
  })
  stopClick()
  stopInput()

  // @ts-expect-error A batch callback cannot wait for asynchronous work.
  void window.batch(async () => {
    await Promise.resolve()
  })
  // @ts-expect-error Returning a promise from a non-async callback is also invalid.
  void window.batch(() => Promise.resolve())
  // @ts-expect-error Only the explicit native element kinds are supported.
  batch.create({ kind: 'webview', url: 'https://example.invalid' })
  // @ts-expect-error A node's element kind cannot change in place.
  batch.set(button, { kind: 'text', text: 'Wrong kind' })
  // @ts-expect-error A plain object cannot manufacture the private handle brand.
  batch.append(window.root, { kind: 'text' })
  // @ts-expect-error Only boxes can own children.
  batch.append(text, button)
  // @ts-expect-error A text node does not expose native input state.
  window.input(text)
  // @ts-expect-error A click listener requires a button handle.
  window.onClick(input, () => {})
  // @ts-expect-error An input replacement requires an observed edit revision.
  batch.set(input, { kind: 'input', value: 'Missing revision' })
  // @ts-expect-error The observed input revision is a number.
  batch.set(input, { kind: 'input', value: 'Wrong revision type' }, '0')
  // @ts-expect-error Non-input elements do not accept an input revision.
  batch.set(text, { kind: 'text', text: 'Unexpected revision' }, 0)
  // @ts-expect-error Style is a native contract, not a CSS declaration object.
  const unsupportedStyle: Element = { kind: 'box', style: { display: 'flex' } }
  void unsupportedStyle
}
