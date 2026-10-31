import { createApplication } from '@bun-native/core'
import { render, type JSX, type RenderRoot } from '@bun-native/solid'
import { batch, createEffect, createSignal, For, onCleanup } from 'solid-js'
import { resolve } from 'node:path'
import { recordEvidence } from '../native-window/content.ts'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to an existing prebuilt native host')
const application = await createApplication({ executable: resolve(executable) })
const items = [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }]
let rowsCreated = 0
let rowsDisposed = 0
let effects = 0
let ownerDisposed = false
let view: RenderRoot | undefined

function App(): JSX.Element {
  const [clicks, setClicks] = createSignal(0)
  const [rows, setRows] = createSignal(items)
  const [input, setInput] = createSignal('')
  createEffect(() => {
    effects += 1
    recordEvidence({ type: 'solid-effect', clicks: clicks(), effects })
  })
  onCleanup(() => {
    ownerDisposed = true
  })
  return (
    <box style={{ direction: 'column', gap: 12, padding: 24, background: 0xf4f5f7 }}>
      <text style={{ font_size: 28 }}>Bun Native Solid</text>
      <text text={`Clicks: ${clicks()}`} />
      <button
        text="Increment"
        style={{ width: 160, height: 44 }}
        onClick={async (event) => {
          const before = view!.diagnostics
          batch(() => {
            setClicks((value) => value + 1)
            setRows(clicks() % 2 ? [items[2]!, items[0]!] : items)
          })
          await view!.flush()
          recordEvidence({ type: 'click', sequence: event.sequence, target: 'increment' })
          recordEvidence({
            type: 'solid-keyed-update',
            names: rows().map((row) => row.name),
            rowsCreated,
            rowsDisposed,
            mutationsBefore: before.mutations,
            mutationsAfter: view!.diagnostics.mutations,
          })
        }}
      />
      <text text="Native editable input" />
      <input
        value=""
        placeholder="Type here…"
        style={{ width: 'fill', font_size: 24 }}
        onInput={(event) => {
          // Observe the native edit; this fixture never writes an unversioned echo.
          setInput(event.value)
          recordEvidence({
            type: 'input',
            sequence: event.sequence,
            value: event.value,
            input_revision: event.revision,
          })
        }}
      />
      <text text={`Input: ${input()}`} />
      <box style={{ direction: 'row', gap: 16 }}>
        <For each={rows()}>
          {(row) => {
            rowsCreated += 1
            onCleanup(() => rowsDisposed++)
            return <text text={row.name} />
          }}
        </For>
      </box>
    </box>
  )
}

try {
  const window = await application.openWindow({
    title: 'Bun Native Solid',
    width: 640,
    height: 520,
  })
  view = render(App, window)
  await view.ready
  recordEvidence({ type: 'solid-mounted', diagnostics: view.diagnostics, rowsCreated, effects })
  await window.closed
  await view.dispose()
  recordEvidence({
    type: 'solid-disposed',
    diagnostics: view.diagnostics,
    rowsCreated,
    rowsDisposed,
    ownerDisposed,
  })
  if (!ownerDisposed || rowsCreated !== rowsDisposed || view.diagnostics.nodes !== 0)
    throw new Error('Solid owner or keyed row resources survived window close')
  recordEvidence({ type: 'closed' })
} finally {
  await view?.dispose()
  await application.shutdown()
  await application.closed
}
