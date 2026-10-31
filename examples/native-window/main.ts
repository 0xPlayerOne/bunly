import { createApplication } from '@bun-native/core'
import { resolve } from 'node:path'
import { mountContent, recordEvidence } from './content.ts'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the prebuilt native host executable')
const app = await createApplication({ executable: resolve(executable) })
let clicks = 0
try {
  const window = await app.openWindow({ title: 'Bun Native BN1', width: 560, height: 380 })
  const { label, button, input } = await mountContent(window)
  window.onClick(button, async (event) => {
    recordEvidence({ type: event.type, sequence: event.sequence, target: 'increment' })
    clicks += 1
    await window.batch((batch) => batch.set(label, { kind: 'text', text: `Clicks: ${clicks}` }))
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
  recordEvidence({ type: 'closed' })
} finally {
  await app.shutdown()
  await app.closed
}
