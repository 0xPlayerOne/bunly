import { parseElement, type Element } from './elements.ts'
import { MAX_FRAME_BYTES, ProtocolError } from './framing.ts'
import {
  id,
  integer,
  keys,
  MAX_TEXT_BYTES,
  MAX_TITLE_BYTES,
  number,
  object,
  string,
} from './values.ts'

export const PROTOCOL_VERSION = 2
export const MAX_OPERATIONS = 256
export const MAX_NODES_PER_WINDOW = 4_096
export const MAX_WINDOWS = 16
export const MAX_DEPTH = 64
export const MAX_TEXT_BYTES_PER_WINDOW = 4_194_304

export interface Limits {
  max_frame_bytes: number
  max_operations: number
  max_nodes_per_window: number
  max_windows: number
  max_depth: number
  max_text_bytes: number
  max_text_bytes_per_window: number
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  max_frame_bytes: MAX_FRAME_BYTES,
  max_operations: MAX_OPERATIONS,
  max_nodes_per_window: MAX_NODES_PER_WINDOW,
  max_windows: MAX_WINDOWS,
  max_depth: MAX_DEPTH,
  max_text_bytes: MAX_TEXT_BYTES,
  max_text_bytes_per_window: MAX_TEXT_BYTES_PER_WINDOW,
})

export type Operation =
  | { type: 'create'; node_id: number; element: Element }
  | { type: 'set'; node_id: number; element: Exclude<Element, { kind: 'input' }> }
  | {
      type: 'set'
      node_id: number
      element: Extract<Element, { kind: 'input' }>
      expected_input_revision: number
    }
  | { type: 'insert'; parent_id: number; child_id: number; index: number }
  | { type: 'delete'; node_id: number }

export type Command =
  | { id: number; type: 'hello'; protocol: typeof PROTOCOL_VERSION }
  | {
      id: number
      type: 'open'
      window_id: number
      root_id: number
      title: string
      width: number
      height: number
    }
  | {
      id: number
      type: 'batch'
      window_id: number
      base_revision: number
      operations: readonly Operation[]
    }
  | { id: number; type: 'close'; window_id: number }
  | { id: number; type: 'shutdown' }

export const ERROR_CODES = [
  'invalid_command',
  'version_mismatch',
  'invalid_state',
  'invalid_handle',
  'stale_revision',
  'limit_exceeded',
  'native_failure',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]
export type Capability = 'tree' | 'input_revisions'

export type NativeEvent =
  | { type: 'ready'; protocol: typeof PROTOCOL_VERSION; capabilities: Capability[]; limits: Limits }
  | { type: 'ack'; id: number }
  | { type: 'opened'; id: number; window_id: number; root_id: number; tree_revision: number }
  | { type: 'applied'; id: number; window_id: number; tree_revision: number }
  | { type: 'click'; sequence: number; window_id: number; node_id: number }
  | {
      type: 'input'
      sequence: number
      window_id: number
      node_id: number
      value: string
      input_revision: number
    }
  | { type: 'closed'; sequence: number; window_id: number }
  | { type: 'error'; id?: number; code: ErrorCode; message: string }

function version(value: unknown): typeof PROTOCOL_VERSION {
  if (value !== PROTOCOL_VERSION) throw new ProtocolError('Native protocol version mismatch')
  return PROTOCOL_VERSION
}

function operation(value: unknown): Operation {
  const data = object(value)
  switch (data['type']) {
    case 'create':
      keys(data, ['type', 'node_id', 'element'])
      return {
        type: 'create',
        node_id: id(data['node_id']),
        element: parseElement(data['element']),
      }
    case 'set': {
      keys(data, ['type', 'node_id', 'element', 'expected_input_revision'])
      const node_id = id(data['node_id'])
      const element = parseElement(data['element'])
      if (element.kind === 'input')
        return {
          type: 'set',
          node_id,
          element,
          expected_input_revision: integer(data['expected_input_revision'], 'input revision'),
        }
      if ('expected_input_revision' in data)
        throw new ProtocolError('Only input elements accept an input revision')
      return { type: 'set', node_id, element }
    }
    case 'insert':
      keys(data, ['type', 'parent_id', 'child_id', 'index'])
      return {
        type: 'insert',
        parent_id: id(data['parent_id']),
        child_id: id(data['child_id']),
        index: integer(data['index'], 'index', 0, MAX_NODES_PER_WINDOW),
      }
    case 'delete':
      keys(data, ['type', 'node_id'])
      return { type: 'delete', node_id: id(data['node_id']) }
    default:
      throw new ProtocolError('Unknown native operation')
  }
}

/** Validate before crossing the native boundary, including JavaScript callers. */
export function parseCommand(value: unknown): Command {
  const message = object(value)
  const request = id(message['id'])
  switch (message['type']) {
    case 'hello':
      keys(message, ['id', 'type', 'protocol'])
      return { id: request, type: 'hello', protocol: version(message['protocol']) }
    case 'open': {
      keys(message, ['id', 'type', 'window_id', 'root_id', 'title', 'width', 'height'])
      const title = string(message['title'], 'title', MAX_TITLE_BYTES)
      if (!title || /\p{Cc}/u.test(title))
        throw new ProtocolError('Window title must be nonempty and contain no control characters')
      return {
        id: request,
        type: 'open',
        window_id: id(message['window_id']),
        root_id: id(message['root_id']),
        title,
        width: number(message['width'], 'width', 64, 16_384),
        height: number(message['height'], 'height', 64, 16_384),
      }
    }
    case 'batch': {
      keys(message, ['id', 'type', 'window_id', 'base_revision', 'operations'])
      const operations = message['operations']
      if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS)
        throw new ProtocolError(
          'Batch must contain between 1 and ' + MAX_OPERATIONS + ' operations'
        )
      return {
        id: request,
        type: 'batch',
        window_id: id(message['window_id']),
        base_revision: integer(message['base_revision'], 'tree revision'),
        operations: operations.map(operation),
      }
    }
    case 'close':
      keys(message, ['id', 'type', 'window_id'])
      return { id: request, type: 'close', window_id: id(message['window_id']) }
    case 'shutdown':
      keys(message, ['id', 'type'])
      return { id: request, type: 'shutdown' }
    default:
      throw new ProtocolError('Unknown native command')
  }
}

function limits(value: unknown): Limits {
  const data = object(value)
  keys(data, Object.keys(DEFAULT_LIMITS))
  const parse = (key: keyof Limits) => integer(data[key], key, 1, DEFAULT_LIMITS[key])
  return {
    max_frame_bytes: parse('max_frame_bytes'),
    max_operations: parse('max_operations'),
    max_nodes_per_window: parse('max_nodes_per_window'),
    max_windows: parse('max_windows'),
    max_depth: parse('max_depth'),
    max_text_bytes: parse('max_text_bytes'),
    max_text_bytes_per_window: parse('max_text_bytes_per_window'),
  }
}

/** Native stdout is untrusted until its message shape and limits are checked. */
export function parseEvent(value: unknown): NativeEvent {
  const message = object(value)
  switch (message['type']) {
    case 'ready': {
      keys(message, ['type', 'protocol', 'capabilities', 'limits'])
      const capabilities = message['capabilities']
      if (!Array.isArray(capabilities) || capabilities.length > 2)
        throw new ProtocolError('Invalid native capabilities')
      const parsed: Capability[] = []
      for (const value of capabilities) {
        if ((value !== 'tree' && value !== 'input_revisions') || parsed.includes(value))
          throw new ProtocolError('Unknown or duplicate native capability')
        parsed.push(value)
      }
      return {
        type: 'ready',
        protocol: version(message['protocol']),
        capabilities: parsed,
        limits: limits(message['limits']),
      }
    }
    case 'ack':
      keys(message, ['type', 'id'])
      return { type: 'ack', id: id(message['id']) }
    case 'opened':
      keys(message, ['type', 'id', 'window_id', 'root_id', 'tree_revision'])
      return {
        type: 'opened',
        id: id(message['id']),
        window_id: id(message['window_id']),
        root_id: id(message['root_id']),
        tree_revision: integer(message['tree_revision'], 'tree revision'),
      }
    case 'applied':
      keys(message, ['type', 'id', 'window_id', 'tree_revision'])
      return {
        type: 'applied',
        id: id(message['id']),
        window_id: id(message['window_id']),
        tree_revision: integer(message['tree_revision'], 'tree revision'),
      }
    case 'click':
      keys(message, ['type', 'sequence', 'window_id', 'node_id'])
      return {
        type: 'click',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        node_id: id(message['node_id']),
      }
    case 'closed':
      keys(message, ['type', 'sequence', 'window_id'])
      return {
        type: 'closed',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
      }
    case 'input':
      keys(message, ['type', 'sequence', 'window_id', 'node_id', 'value', 'input_revision'])
      return {
        type: 'input',
        sequence: id(message['sequence']),
        window_id: id(message['window_id']),
        node_id: id(message['node_id']),
        value: string(message['value'], 'value'),
        input_revision: integer(message['input_revision'], 'input revision'),
      }
    case 'error': {
      keys(message, ['type', 'id', 'code', 'message'])
      const code = ERROR_CODES.find((code) => code === message['code'])
      if (!code) throw new ProtocolError('Invalid native error code')
      return {
        type: 'error',
        code,
        message: string(message['message'], 'message'),
        ...('id' in message ? { id: id(message['id']) } : {}),
      }
    }
    default:
      throw new ProtocolError('Unknown native event')
  }
}
