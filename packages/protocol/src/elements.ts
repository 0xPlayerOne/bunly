import { ProtocolError } from './framing.ts'
import { integer, keys, number, object, string } from './values.ts'

export interface Style {
  direction?: 'row' | 'column'
  gap?: number
  padding?: number
  width?: number | 'fill'
  height?: number | 'fill'
  flex_grow?: number
  background?: number
  color?: number
  font_size?: number
}

export type Element =
  | { kind: 'box'; style?: Style }
  | { kind: 'text'; text: string; style?: Style }
  | { kind: 'button'; text: string; disabled?: boolean; style?: Style }
  | { kind: 'input'; value: string; placeholder?: string; style?: Style }

function parseStyle(value: unknown): Style {
  const data = object(value)
  keys(data, [
    'direction',
    'gap',
    'padding',
    'width',
    'height',
    'flex_grow',
    'background',
    'color',
    'font_size',
  ])
  const style: Style = {}
  for (const key of ['gap', 'padding'] as const)
    if (key in data) style[key] = number(data[key], key, 0, 4_096)
  for (const key of ['width', 'height'] as const)
    if (key in data) style[key] = data[key] === 'fill' ? 'fill' : number(data[key], key, 0, 16_384)
  for (const key of ['background', 'color'] as const)
    if (key in data) style[key] = integer(data[key], key, 0, 0xff_ffff)
  if ('direction' in data) {
    if (data['direction'] !== 'row' && data['direction'] !== 'column')
      throw new ProtocolError('direction must be row or column')
    style.direction = data['direction']
  }
  if ('flex_grow' in data) style.flex_grow = number(data['flex_grow'], 'flex_grow', 0, 1_000)
  if ('font_size' in data) style.font_size = number(data['font_size'], 'font_size', 1, 512)
  return style
}

/** Normalize and validate the entire property set, including JavaScript consumers. */
export function parseElement(value: unknown): Element {
  const element = object(value)
  const style = 'style' in element ? parseStyle(element['style']) : {}
  switch (element['kind']) {
    case 'box':
      keys(element, ['kind', 'style'])
      return { kind: 'box', style }
    case 'text':
      keys(element, ['kind', 'text', 'style'])
      return { kind: 'text', text: string(element['text'], 'text'), style }
    case 'button': {
      keys(element, ['kind', 'text', 'disabled', 'style'])
      if ('disabled' in element && typeof element['disabled'] !== 'boolean')
        throw new ProtocolError('disabled must be a boolean')
      return {
        kind: 'button',
        text: string(element['text'], 'text'),
        disabled: element['disabled'] === true,
        style,
      }
    }
    case 'input':
      keys(element, ['kind', 'value', 'placeholder', 'style'])
      return {
        kind: 'input',
        value: string(element['value'], 'value'),
        placeholder: 'placeholder' in element ? string(element['placeholder'], 'placeholder') : '',
        style,
      }
    default:
      throw new ProtocolError('Unknown native element kind')
  }
}
