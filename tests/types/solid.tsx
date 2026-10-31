import type { JSX } from '@bun-native/solid'
import { For, Show } from 'solid-js'

export function Supported(): JSX.Element {
  return (
    <box style={{ direction: 'column', gap: 8 }}>
      <text>Native text</text>
      <button onClick={(event) => void event.signal.aborted}>Increment</button>
      <input value="initial" onInput={(event) => void event.revision} />
      <For each={[1, 2]}>{(value) => <text text={String(value)} />}</For>
      <Show when={true}>
        <text text="Shown" />
      </Show>
    </box>
  )
}

// @ts-expect-error HTML/DOM tags are not native elements.
export const BrowserTag = <div />
// @ts-expect-error Native buttons require typed click callbacks.
export const BadHandler = <button onClick="run()" />
// @ts-expect-error Native styles are explicit numeric/shared contracts, not CSS text.
export const BrowserStyle = <box style="display:flex" />
// @ts-expect-error No browser event or generic HTML prop escapes the boundary.
export const BrowserProp = <input onChange={() => {}} />
