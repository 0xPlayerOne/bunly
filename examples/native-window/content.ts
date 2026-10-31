import type { Element, NativeWindow } from '@bun-native/core'
import { appendFileSync } from 'node:fs'

export const ROOT_ELEMENT = {
  kind: 'box',
  style: { direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 },
} as const satisfies Element
export const INITIAL_ELEMENTS = [
  { kind: 'text', text: 'Bun Native', style: { font_size: 28 } },
  { kind: 'text', text: 'Clicks: 0' },
  { kind: 'button', text: 'Increment', style: { width: 160, height: 44 } },
  { kind: 'text', text: 'Native editable input' },
  { kind: 'input', value: '', placeholder: 'Type here…', style: { width: 'fill', font_size: 24 } },
] as const satisfies readonly Element[]

export function mountContent(window: NativeWindow) {
  return window.batch((batch) => {
    batch.set(window.root, ROOT_ELEMENT)
    const heading = batch.create(INITIAL_ELEMENTS[0])
    const label = batch.create(INITIAL_ELEMENTS[1])
    const button = batch.create(INITIAL_ELEMENTS[2])
    const inputLabel = batch.create(INITIAL_ELEMENTS[3])
    const input = batch.create(INITIAL_ELEMENTS[4])
    for (const node of [heading, label, button, inputLabel, input]) batch.append(window.root, node)
    return { label, button, input }
  })
}

let evidenceBytes = 0
/** Opt-in, bounded fixture evidence. Ordinary launches do not record input. */
export function recordEvidence(event: Record<string, unknown>): void {
  const path = process.env['BUN_NATIVE_EVIDENCE_LOG']
  const nonce = process.env['BUN_NATIVE_EVIDENCE_NONCE']
  if (!path || !nonce) return
  const line = JSON.stringify({ nonce, ...event, stage: 'bun-application' }) + '\n'
  evidenceBytes += Buffer.byteLength(line)
  if (evidenceBytes > 1_048_576) throw new Error('Application evidence limit exceeded')
  appendFileSync(path, line)
}
