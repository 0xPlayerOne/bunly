// @ts-check
/** A JavaScript consumer of the public API; native interaction is driven externally. */
import { createApplication } from '@bun-native/core'
import { resolve } from 'node:path'
import { recordEvidence } from '../../examples/native-window/content.ts'

/**
 * @param {import('@bun-native/core').NativeWindow} window
 * @returns {Promise<{
 *   label: import('@bun-native/core').NativeNode<'text'>,
 *   button: import('@bun-native/core').NativeNode<'button'>,
 *   input: import('@bun-native/core').NativeNode<'input'>
 * }>}
 */
function mount(window) {
  return window.batch((batch) => {
    batch.set(window.root, {
      kind: 'box',
      style: { direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 },
    })
    const heading = batch.create({
      kind: 'text',
      text: 'JavaScript consumer',
      style: { font_size: 28 },
    })
    const label = batch.create({ kind: 'text', text: 'Updates: 0' })
    const button = batch.create({
      kind: 'button',
      text: 'Update',
      style: { width: 160, height: 44 },
    })
    const inputLabel = batch.create({ kind: 'text', text: 'Native input from JavaScript' })
    const input = batch.create({
      kind: 'input',
      value: '',
      placeholder: 'Type here…',
      style: { width: 'fill', font_size: 24 },
    })
    for (const node of [heading, label, button, inputLabel, input]) batch.append(window.root, node)
    return { label, button, input }
  })
}

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the prebuilt native host executable')
const app = await createApplication({ executable: resolve(executable) })
try {
  const window = await app.openWindow({ title: 'Bun Native JavaScript', width: 560, height: 380 })
  try {
    const { label, button, input } = await mount(window)
    // An intentional replacement uses the public observed revision. Later native
    // input is already stored by the host and is never echoed back as a snapshot.
    await window.batch((batch) =>
      batch.set(
        input,
        {
          kind: 'input',
          value: 'JavaScript is ready',
          placeholder: 'Type here…',
          style: { width: 'fill', font_size: 24 },
        },
        window.input(input).revision
      )
    )
    if (window.input(input).revision !== 1 || window.input(input).value !== 'JavaScript is ready')
      throw new Error('Public input state did not commit the JavaScript replacement')

    let updates = 0
    window.onClick(button, async (event) => {
      recordEvidence({ type: event.type, sequence: event.sequence, target: 'javascript-update' })
      updates += 1
      await window.batch((batch) => batch.set(label, { kind: 'text', text: `Updates: ${updates}` }))
    })
    window.onInput(input, (event) => {
      recordEvidence({
        type: event.type,
        sequence: event.sequence,
        value: event.value,
        input_revision: event.revision,
      })
    })
    await window.closed
    recordEvidence({ type: 'closed', consumer: 'javascript' })
  } finally {
    await window.close()
  }
} finally {
  await app.shutdown()
  await app.closed
}
if (Object.values(app.diagnostics).some((count) => count !== 0))
  throw new Error('JavaScript consumer retained application resources after shutdown')
