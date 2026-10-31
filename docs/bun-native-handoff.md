# Bun Native implementation handoff

## Current branch state

The BN0 workspace replacement removes the Bunly runtime and browser renderer.
The source includes matching portable TypeScript and Rust native-pipe protocol
packages, an owned native-process runtime, an interactive GPUI host, strict
package-boundary checks, and a pinned Bun AOT/Rust bootstrap.
No old CEF result qualifies this implementation.

Source replacement [#264](https://github.com/0xPlayerOne/bun-native/pull/264) and
compiler interoperability [#265](https://github.com/0xPlayerOne/bun-native/pull/265)
are merged. Native window/AOT integration is in
[#266](https://github.com/0xPlayerOne/bun-native/pull/266). Both application modes
have passed real Linux X11 software-GPU click/input/paint/close tests, and five
close/reopen cycles passed within one native process. The complete evidence,
known defects and reproduction are in [the integration record](bn0-integration.md).

## Removal inventory (#251)

The baseline is `202e2d79299c1ed6e40627aa2ec81a9865bafe1f`.

| Area                                                  | Decision         | Reason                                                                           |
| ----------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `packages/{artifacts,cli,client,contracts,runtime}`   | Replace          | Browser runtime APIs, CEF distribution and obsolete Bunly contracts              |
| `native/{cef,cef-host,host-probe}` and old Cargo lock | Replace          | CEF implementation and legacy N-API experiments do not implement GPUI            |
| `examples/*`                                          | Replace          | Browser/HTML, terminal and old host fixtures                                     |
| `tests/*`, old `scripts/*`                            | Replace          | Assertions and qualification tied to removed runtime                             |
| `benchmarks/*`, `evidence/*`                          | Replace          | Historical CEF/competitor workloads and measurements                             |
| `provenance/*`                                        | Retire           | Removed source/dependency inventory; current attribution remains in root notices |
| Python manifests, browser TS config, old Cargo flags  | Delete           | No active consumer in the new implementation                                     |
| CEF/M1–M6/benchmark Actions                           | Replace          | Native validation must execute new code                                          |
| Code Foundry draft/release policy and root license    | Reuse            | Repository workflow and attribution remain useful                                |
| Bun Native architecture/quality/vision docs           | Reuse and update | Current product and engineering contract                                         |

Removed implementation remains in Git history. No compatibility API or browser
fallback remains in the active packages.

## Current implementation sequence

1. Finish the required release-profile native CI and artifact inspection in
   #266; source and compiler setup are already merged.
2. Complete #227/#258 with repeated, explicitly scoped startup/idle RSS/size
   observations and preserve failures as well as successful results.
3. Keep #226 and this handoff current. BN0 closes only after actual acceptance
   and the engineering-quality checkpoint pass.
4. Extend the proven integration into BN1's reusable tree, handles, ownership,
   batching, capabilities and controlled-input revisions. Reuse the same host
   for Solid and React; do not introduce parallel native backends.

## Validation meaning

`bun install --frozen-lockfile`, `bun run check`, and Rust protocol checks test
source, framing and dependency boundaries. `bun run build` emits JS modules and
is explicitly not an AOT executable. Initial unit tests are headless; they do
not prove GPUI rendering, input, GPU acceleration or AOT compatibility.

The native window and same-window AOT have real Linux software-renderer evidence.
Release-profile hosted validation, stable framework APIs, framework adapters,
packaged releases and other platform GUI support have separate acceptance.
Headless protocol success on macOS/Windows does not qualify their native GUI.

See [testing](testing.md), [toolchain](toolchain.md), and the issue/PR logs for
exact command results. Keep this document current as each implementation lands.
