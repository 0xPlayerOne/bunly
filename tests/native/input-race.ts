import { NativeHost, NativeCommandError } from '@bun-native/runtime'
import type { Operation } from '@bun-native/protocol'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  INITIAL_ELEMENTS,
  ROOT_ELEMENT,
  recordEvidence,
} from '../../examples/native-window/content.ts'

// Deliberately exercise the native stale-revision guard through the lower-level
// transport. The public core also rejects revisions it already knows are stale.
const executable = process.env['BUN_NATIVE_HOST']
const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
if (!executable || !nonce)
  throw new Error('Native input race requires an explicit host and evidence nonce')
const host = await NativeHost.launch({ executable: resolve(executable) })
let proved = false
try {
  await host.send({
    type: 'open',
    window_id: 1,
    root_id: 1,
    title: 'Bun Native BN1',
    width: 560,
    height: 380,
  })
  const operations: Operation[] = [{ type: 'set', node_id: 1, element: ROOT_ELEMENT }]
  INITIAL_ELEMENTS.forEach((element, index) =>
    operations.push(
      { type: 'create', node_id: index + 2, element },
      { type: 'insert', parent_id: 1, child_id: index + 2, index }
    )
  )
  await host.send({ type: 'batch', window_id: 1, base_revision: 0, operations })
  for await (const event of host) {
    recordEvidence({ ...event })
    if (event.type === 'closed') break
    if (event.type === 'input' && event.value === `Bun Native ${nonce}`) {
      assert.equal(event.input_revision, 43)
      await assert.rejects(
        host.send({
          type: 'batch',
          window_id: 1,
          base_revision: 1,
          operations: [
            {
              type: 'set',
              node_id: 6,
              element: { kind: 'input', value: 'stale application value' },
              expected_input_revision: 0,
            },
          ],
        }),
        (error) => error instanceof NativeCommandError && error.code === 'stale_revision'
      )
      await host.send({
        type: 'batch',
        window_id: 1,
        base_revision: 1,
        operations: [
          {
            type: 'set',
            node_id: 3,
            element: { kind: 'text', text: 'Input preserved after stale rejection' },
          },
        ],
      })
      proved = true
    }
  }
  assert.equal(proved, true, 'The actual native stale-input rejection must run before close')
} finally {
  await host.shutdown()
}
