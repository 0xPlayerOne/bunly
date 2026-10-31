import { NativeHost } from '@bun-native/runtime'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

// Explicit native integration entry point. Default unit tests never substitute
// a fake process for this target: CI supplies the host it just built.
const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the built native host')
const host = await NativeHost.launch({ executable: resolve(executable) })
const events = host[Symbol.asyncIterator]()
const cycles = 5

try {
  await assert.rejects(host.send({ type: 'close', window_id: 1 }), /invalid_handle/)
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const window_id = cycle + 1
    const root_id = cycle * 3 + 1
    const text_id = root_id + 1
    const input_id = root_id + 2
    await host.send({
      type: 'open',
      window_id,
      root_id,
      title: 'Bun Native lifecycle',
      width: 560,
      height: 380,
    })
    await assert.rejects(
      host.send({ type: 'open', window_id, root_id, title: 'Duplicate', width: 560, height: 380 }),
      /invalid_handle/
    )
    await host.send({
      type: 'batch',
      window_id,
      base_revision: 0,
      operations: [
        { type: 'create', node_id: text_id, element: { kind: 'text', text: `Cycle ${cycle}` } },
        { type: 'create', node_id: input_id, element: { kind: 'input', value: '' } },
        { type: 'insert', parent_id: root_id, child_id: text_id, index: 0 },
        { type: 'insert', parent_id: root_id, child_id: input_id, index: 1 },
      ],
    })
    await assert.rejects(
      host.send({
        type: 'batch',
        window_id,
        base_revision: 0,
        operations: [{ type: 'delete', node_id: text_id }],
      }),
      /stale_revision/
    )
    await host.send({
      type: 'batch',
      window_id,
      base_revision: 1,
      operations: [
        { type: 'set', node_id: text_id, element: { kind: 'text', text: `Updated ${cycle}` } },
        {
          type: 'set',
          node_id: input_id,
          element: { kind: 'input', value: 'é🙂漢' },
          expected_input_revision: 0,
        },
      ],
    })
    await host.send({ type: 'close', window_id })
    assert.deepEqual(await events.next(), {
      done: false,
      value: { type: 'closed', sequence: cycle + 1, window_id },
    })
    await assert.rejects(host.send({ type: 'close', window_id }), /invalid_handle/)
  }
} finally {
  await host.shutdown()
}

await host.shutdown()
assert.equal(await host.exited, 0)
console.log(JSON.stringify({ status: 'passed', nativeWindowCycles: cycles, nativeExitCode: 0 }))
