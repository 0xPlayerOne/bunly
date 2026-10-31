// Deterministic headless process peer for callback-lifecycle regressions. It
// exercises real pipes and event ordering; it does not render or validate GPUI.
import {
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  parseCommand,
  type Element,
  type NativeEvent,
} from '@bun-native/protocol'

type Node = { element: Element; inputRevision: number }
const windows = new Map<number, Map<number, Node>>()
const decoder = new FrameDecoder()
const output = Bun.stdout.writer()
let sequence = 0

async function emit(event: NativeEvent): Promise<void> {
  output.write(encodeFrame(event))
  await output.flush()
}

function buttons(nodes: Map<number, Node>): number[] {
  return [...nodes].filter(([, node]) => node.element.kind === 'button').map(([id]) => id)
}

async function click(window_id: number, node_id: number): Promise<void> {
  await emit({ type: 'click', window_id, node_id, sequence: ++sequence })
}

async function marker(window_id: number, value: string, nodes: Map<number, Node>): Promise<void> {
  const ids = buttons(nodes)
  if (value === 'edge:click') {
    if (ids[0] === undefined) throw new Error('Test marker requires a button')
    await click(window_id, ids[0])
  } else if (value === 'edge:second-button') {
    if (ids[1] === undefined) throw new Error('Test marker requires two buttons')
    await click(window_id, ids[1])
  } else if (value.startsWith('edge:burst:')) {
    const count = Number(value.slice('edge:burst:'.length))
    if (![2, 4, 63, 64].includes(count) || ids[0] === undefined)
      throw new Error('Invalid bounded test burst')
    for (let index = 0; index < count; index++) await click(window_id, ids[0])
  } else if (value === 'edge:input') {
    const entry = [...nodes].find(([, node]) => node.element.kind === 'input')
    if (!entry || entry[1].element.kind !== 'input')
      throw new Error('Test marker requires an input')
    const [node_id, node] = entry
    node.inputRevision += 1
    node.element = { ...node.element, kind: 'input', value: 'sibling native edit' }
    await emit({
      type: 'input',
      window_id,
      node_id,
      sequence: ++sequence,
      value: 'sibling native edit',
      input_revision: node.inputRevision,
    })
  } else if (value === 'edge:os-close') {
    windows.delete(window_id)
    await emit({ type: 'closed', window_id, sequence: ++sequence })
    // A previously buffered frame may outlive native window revocation.
    if (ids[0] !== undefined) await click(window_id, ids[0])
  }
}

for await (const chunk of Bun.stdin.stream()) {
  for (const raw of decoder.push(chunk)) {
    const command = parseCommand(raw)
    if (command.type === 'hello') {
      await emit({
        type: 'ready',
        protocol: 2,
        capabilities: ['tree', 'input_revisions'],
        limits: { ...DEFAULT_LIMITS },
      })
      await emit({ type: 'ack', id: command.id })
    } else if (command.type === 'open') {
      windows.set(
        command.window_id,
        new Map([[command.root_id, { element: { kind: 'box' }, inputRevision: 0 }]])
      )
      await emit({
        type: 'opened',
        id: command.id,
        window_id: command.window_id,
        root_id: command.root_id,
        tree_revision: 0,
      })
    } else if (command.type === 'batch') {
      const nodes = windows.get(command.window_id)
      if (!nodes) {
        await emit({
          type: 'error',
          id: command.id,
          code: 'invalid_handle',
          message: 'Test window already closed',
        })
        continue
      }
      const markers: string[] = []
      const lateButtons: number[] = []
      for (const operation of command.operations) {
        if (operation.type === 'create')
          nodes.set(operation.node_id, { element: operation.element, inputRevision: 0 })
        else if (operation.type === 'set') {
          const node = nodes.get(operation.node_id)
          if (!node) throw new Error('Test set requires an owned node')
          node.element = operation.element
          if (operation.element.kind === 'input') node.inputRevision += 1
          if (operation.element.kind === 'text' && operation.element.text.startsWith('edge:'))
            markers.push(operation.element.text)
        } else if (operation.type === 'delete') {
          if (nodes.get(operation.node_id)?.element.kind === 'button')
            lateButtons.push(operation.node_id)
          nodes.delete(operation.node_id)
        }
      }
      await emit({
        type: 'applied',
        id: command.id,
        window_id: command.window_id,
        tree_revision: command.base_revision + 1,
      })
      for (const value of markers) await marker(command.window_id, value, nodes)
      for (const node_id of lateButtons) await click(command.window_id, node_id)
    } else if (command.type === 'close') {
      const nodes = windows.get(command.window_id)
      if (!nodes) {
        await emit({
          type: 'error',
          id: command.id,
          code: 'invalid_handle',
          message: 'Test window already closed',
        })
        continue
      }
      windows.delete(command.window_id)
      // Enough to distinguish synchronous revocation from acknowledgement-time
      // cleanup without relying on a test guessing when a native reply arrived.
      await Bun.sleep(25)
      await emit({ type: 'closed', window_id: command.window_id, sequence: ++sequence })
      const first = buttons(nodes)[0]
      if (first !== undefined) await click(command.window_id, first)
      await emit({ type: 'ack', id: command.id })
    } else {
      await emit({ type: 'ack', id: command.id })
      process.exit(0)
    }
  }
}
decoder.finish()
