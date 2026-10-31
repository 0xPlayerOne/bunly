import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LIMITS,
  MAX_OPERATIONS,
  MAX_TEXT_BYTES,
  parseCommand,
  parseElement,
  parseEvent,
  PROTOCOL_VERSION,
  ProtocolError,
  type Command,
  type NativeEvent,
} from '@bun-native/protocol'

const open = {
  id: 2,
  type: 'open',
  window_id: 1,
  root_id: 1,
  title: 'Bun Native',
  width: 560,
  height: 380,
} as const
const batch = { id: 3, type: 'batch', window_id: 1, base_revision: 0 } as const

describe('versioned native message validation', () => {
  test('round-trips every normalized command and operation', () => {
    for (const command of [
      { id: 1, type: 'hello', protocol: PROTOCOL_VERSION },
      open,
      {
        ...batch,
        operations: [
          { type: 'create', node_id: 2, element: { kind: 'text', text: 'Hello', style: {} } },
          { type: 'set', node_id: 2, element: { kind: 'text', text: 'Updated', style: {} } },
          {
            type: 'set',
            node_id: 3,
            element: { kind: 'input', value: '世界', placeholder: '', style: {} },
            expected_input_revision: 7,
          },
          { type: 'insert', parent_id: 1, child_id: 2, index: 0 },
          { type: 'delete', node_id: 2 },
        ],
      },
      { id: 4, type: 'close', window_id: 1 },
      { id: 5, type: 'shutdown' },
    ] satisfies Command[])
      expect(parseCommand(command)).toEqual(command)
  })

  test('round-trips every native event and negotiated limit', () => {
    for (const event of [
      {
        type: 'ready',
        protocol: PROTOCOL_VERSION,
        capabilities: ['tree', 'input_revisions'],
        limits: { ...DEFAULT_LIMITS },
      },
      { type: 'ack', id: 1 },
      { type: 'opened', id: 2, window_id: 1, root_id: 1, tree_revision: 0 },
      { type: 'applied', id: 3, window_id: 1, tree_revision: 1 },
      { type: 'click', sequence: 1, window_id: 1, node_id: 4 },
      { type: 'input', sequence: 2, window_id: 1, node_id: 5, value: '世界', input_revision: 1 },
      { type: 'closed', sequence: 3, window_id: 1 },
      { type: 'error', id: 3, code: 'stale_revision', message: 'Changed input' },
      { type: 'error', code: 'invalid_command', message: 'Bad JSON' },
    ] satisfies NativeEvent[])
      expect(parseEvent(event)).toEqual(event)
  })

  test('normalizes element defaults without mutating consumer objects', () => {
    const input = { kind: 'input', value: 'é🙂漢' } as const
    expect(parseElement(input)).toEqual({ ...input, placeholder: '', style: {} })
    expect(input).toEqual({ kind: 'input', value: 'é🙂漢' })
    expect(parseElement({ kind: 'button', text: 'Run' })).toEqual({
      kind: 'button',
      text: 'Run',
      disabled: false,
      style: {},
    })
    expect(parseElement({ kind: 'box' })).toEqual({ kind: 'box', style: {} })
  })

  test('accepts bounded flex layout and colors without browser types', () => {
    const style = {
      direction: 'row',
      gap: 4.5,
      padding: 12,
      width: 'fill',
      height: 48,
      flex_grow: 1,
      background: 0x123456,
      color: 0xffffff,
      font_size: 18,
    } as const
    expect(parseElement({ kind: 'box', style })).toEqual({ kind: 'box', style })
  })

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null])(
    'rejects invalid request or owner id %s',
    (id) => {
      expect(() => parseCommand({ ...open, id })).toThrow(ProtocolError)
      expect(() => parseCommand({ ...open, window_id: id })).toThrow(ProtocolError)
      expect(() => parseEvent({ type: 'ack', id })).toThrow(ProtocolError)
    }
  )

  test.each(
    [
      null,
      [],
      'hello',
      { id: 1, type: 'unknown' },
      { id: 1, type: 'hello', protocol: 1 },
      { id: 1, type: 'close', window_id: 1, unrelated: true },
      { ...open, title: '' },
      { ...open, title: 'title\n' },
      { ...open, title: 'a'.repeat(257) },
      { ...open, width: 63 },
      { ...open, height: Infinity },
      { ...batch, operations: [] },
      {
        ...batch,
        operations: Array.from({ length: MAX_OPERATIONS + 1 }, () => ({
          type: 'delete',
          node_id: 1,
        })),
      },
      { ...batch, base_revision: -1, operations: [{ type: 'delete', node_id: 2 }] },
      {
        ...batch,
        operations: [{ type: 'set', node_id: 2, element: { kind: 'input', value: '' } }],
      },
      {
        ...batch,
        operations: [
          {
            type: 'set',
            node_id: 2,
            element: { kind: 'text', text: '' },
            expected_input_revision: 0,
          },
        ],
      },
      { ...batch, operations: [{ type: 'insert', parent_id: 1, child_id: 2, index: -1 }] },
    ].map((value) => ({ value }))
  )('rejects invalid commands %#', ({ value }) => {
    expect(() => parseCommand(value)).toThrow(ProtocolError)
  })

  test.each(
    [
      { kind: 'webview' },
      { kind: 'box', html: '<script>' },
      { kind: 'text', text: '\ud800' },
      { kind: 'text', text: '\0' },
      { kind: 'text', text: '😀'.repeat(MAX_TEXT_BYTES / 4 + 1) },
      { kind: 'button', text: '', disabled: 'false' },
      { kind: 'input', value: '', placeholder: null },
      ...[
        { gap: -1 },
        { padding: Infinity },
        { width: '100%' },
        { background: -1 },
        { color: 0x1000000 },
        { flex_grow: 1001 },
        { font_size: 0 },
        { direction: 'grid' },
        { position: 'absolute' },
      ].map((style) => ({ kind: 'box', style })),
    ].map((value) => ({ value }))
  )('rejects unsafe or unsupported properties %#', ({ value }) => {
    expect(() => parseElement(value)).toThrow(ProtocolError)
  })

  test.each(
    [
      null,
      [],
      { type: 'unknown' },
      { type: 'click', sequence: 0, window_id: 1, node_id: 2 },
      { type: 'input', sequence: 1, window_id: 1, node_id: 2, value: 12, input_revision: 1 },
      { type: 'error', code: 'invalid code', message: 'Bad' },
      { type: 'error', code: 'invalid_command', message: null },
      { type: 'ready', protocol: 1, capabilities: [], limits: DEFAULT_LIMITS },
      { type: 'ready', protocol: 2, capabilities: ['tree', 'tree'], limits: DEFAULT_LIMITS },
      { type: 'ready', protocol: 2, capabilities: ['shell'], limits: DEFAULT_LIMITS },
      {
        type: 'ready',
        protocol: 2,
        capabilities: ['tree'],
        limits: { ...DEFAULT_LIMITS, max_frame_bytes: DEFAULT_LIMITS.max_frame_bytes + 1 },
      },
      {
        type: 'ready',
        protocol: 2,
        capabilities: ['tree'],
        limits: { ...DEFAULT_LIMITS, max_nodes_per_window: 0 },
      },
    ].map((value) => ({ value }))
  )('rejects invalid native events %#', ({ value }) => {
    expect(() => parseEvent(value)).toThrow(ProtocolError)
  })
})
