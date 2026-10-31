import { NativeHost, type WindowEvent } from '@bun-native/runtime'
import type { Element, Operation } from '@bun-native/protocol'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the prebuilt native host executable')
const host = await NativeHost.launch({ executable: resolve(executable) })
const evidencePath = process.env['BUN_NATIVE_EVIDENCE_LOG']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']

function record(event: WindowEvent): void {
  if (evidencePath && nonce)
    appendFileSync(
      evidencePath,
      `${JSON.stringify({ nonce, ...event, stage: 'bun-application' })}\n`
    )
}

let clicks = 0
let revision = 0
try {
  await host.send({
    type: 'open',
    window_id: 1,
    root_id: 1,
    title: 'Bun Native BN1',
    width: 560,
    height: 380,
  })
  const elements: Element[] = [
    { kind: 'text', text: 'Bun Native', style: { font_size: 28 } },
    { kind: 'text', text: 'Clicks: 0' },
    { kind: 'button', text: 'Increment', style: { width: 160, height: 44 } },
    { kind: 'text', text: 'Native editable input' },
    {
      kind: 'input',
      value: '',
      placeholder: 'Type here…',
      style: { width: 'fill', font_size: 24 },
    },
  ]
  const operations: Operation[] = [
    {
      type: 'set',
      node_id: 1,
      element: {
        kind: 'box',
        style: { direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 },
      },
    },
  ]
  elements.forEach((element, index) =>
    operations.push(
      { type: 'create', node_id: index + 2, element },
      { type: 'insert', parent_id: 1, child_id: index + 2, index }
    )
  )
  revision = (await host.send({ type: 'batch', window_id: 1, base_revision: 0, operations }))
    .tree_revision
  for await (const event of host) {
    record(event)
    if (event.type === 'closed') break
    if (event.type === 'click') {
      clicks += 1
      revision = (
        await host.send({
          type: 'batch',
          window_id: 1,
          base_revision: revision,
          operations: [
            { type: 'set', node_id: 3, element: { kind: 'text', text: `Clicks: ${clicks}` } },
          ],
        })
      ).tree_revision
    }
  }
} finally {
  await host.shutdown()
}
