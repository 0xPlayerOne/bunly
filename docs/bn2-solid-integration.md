# BN2 initial Solid integration

This is an implementation-in-progress record for [#231](https://github.com/0xPlayerOne/bun-native/issues/231), depending on [BN1 #271](https://github.com/0xPlayerOne/bun-native/pull/271). It does not close BN2 or claim framework-wide/platform release support.

## Implemented route

`examples/solid-counter/main.tsx` uses ordinary Solid signals, an effect, `<For>` keyed rows, cleanup hooks, native button events and native input observations. The pinned official Solid universal JSX transform targets `@bun-native/solid`. The adapter stages synchronous framework mutations and commits them through the existing public core's asynchronous atomic batches. The unchanged GPUI host owns native widgets and the main UI thread.

The initial renderer API and lifecycle/error semantics are documented in [the package README](../packages/solid/README.md). Native transaction planning is separate from Solid owner/effect wiring so an actual React consumer can reuse common behavior when its requirements are established. This change adds no alternative Rust host or framework-specific widget implementation.

## Exact initial environment

| Item               | Value                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Source base        | `cc27ec705c1f90db35ed5f7182c41abc5e68f821`; first observations ran from a dirty isolated `feat/bn2-solid` worktree |
| Solid              | `1.9.18`; official `babel-preset-solid` `1.9.16`, Babel `7.29.7`                                                   |
| Bun                | `1.4.4-canary.1+da867c60b`, full revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`                               |
| Rust / GPUI        | Existing Rust `1.98.1` development-profile host; GPUI `0.2.2`, Zed `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d`      |
| Native host        | 110,849,576 bytes; SHA-256 `8a221ff318aa0a3ee0bfff95bc243dc0091d3c0a2af97347ab3bc550cc3ad40e`                      |
| Display/input      | Linux x86_64, isolated Xvfb X11/Openbox and actual XTest pointer/text input                                        |
| Actual GPU adapter | Software llvmpipe LLVM 20.1.2; Mesa `25.2.8-0ubuntu0.24.04.4`                                                      |
| AOT executable     | 71,253,032 bytes; SHA-256 `3759597a3c9d15d3de9439745652bd52038b2c2fff5cd385d6930fcf44761038`                       |
| AOT inspection     | Valid compiled-program flag (`0x417c`), JIT unused with 27 removed JIT ranges; interpreter present                 |

No Rust rebuild or native-binary copy was needed. The development host remains an explicitly unoptimized diagnostic host; these bytes are not a release-size baseline. The AOT build used `bun compile --no-script --production --explain=json` on the same generated JavaScript module run in development, followed by the existing compiled-program and runtime-feature inspectors.

## Executed evidence

| Check                                              | Actual result                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict source checks                               | 42 TypeScript/TSX files pass; workspace lint, package boundaries and JS package build pass                                                                |
| Focused headless adapter/transform/boundary checks | 21 tests, 61 assertions passed; no GUI claim from these tests                                                                                             |
| Development native pointer                         | Real Increment click changed `Clicks: 0` to `Clicks: 1`, reordered/deleted keyed rows, painted the new state and closed with exit 0                       |
| AOT native pointer                                 | Same actual input and independent full-tree paint expectations passed; retained Alpha/Gamma native IDs, deleted Beta                                      |
| AOT native typing                                  | All 38 nonce-tagged ASCII input characters reached Solid state and both the native input and derived text paint; independent full-tree expectation passed |
| Solid cleanup                                      | Every tested native launch disposed all three keyed row owners and the application owner; adapter nodes/listeners returned to zero                        |
| Process cleanup                                    | All tested native launches exited 0 without forced termination or observed remaining/unreaped application processes                                       |

The actual keyed update required **one native text set, one insert/move and one delete**, with zero newly created nodes. The native host independently reported the same three-operation batch. This is a mutation-count observation, not a performance speedup claim. The development screenshot was visually inspected; the driver captures real native screenshots and native paint reports rather than generated imagery.

These initial runs are fresh-process software-GPU diagnostics. They do not establish a repeated performance distribution, physical input/frame latency, hardware GPU results, long-term leaks or a release-profile comparison against the direct core fixture. The established driver uses nominal 100 ms observation polling; its observed input times are not GPU presentation timestamps.

## Problems found and next work

Bun's default package conditions select Solid's inert server runtime. The application build explicitly selects reactive client exports, and mounting with an inert runtime fails. Applying a global browser condition to all unit tests also selected Oxc's browser/WASM implementation. The narrow test loader therefore selects only the exact installed Solid reactive source while preserving Node resolution for other packages. Neither adjustment introduces DOM rendering.

A synchronous Solid tree must stage work until the asynchronous public core accepts a batch. Snapshots prevent later signal changes from rewriting an in-flight transaction; keyed identities survive reordering. Native validation failures dispose the Solid root and clean its prior committed subtree, with the error observable by callers.

Controlled input replacement is temporarily explicit unsupported behavior: changing `value` after initial creation fails. [#234](https://github.com/0xPlayerOne/bun-native/issues/234) will carry value and expected input revision from submission through commit, and must prove that a plain native event echo cannot overwrite a newer edit. The current fixture observes input and updates a separate text label.

Before #231 is complete, retain repeatable dev/AOT keyed/reactive measurements, compare the same workload against direct core operations, exercise repeated mount/unmount and allocation/retention behavior, and integrate native acceptance into the required hosted lane. macOS/Windows GUI, IME, selection/caret, complete scrolling and accessibility retain their explicit platform/BN4 requirements. The five Adea component compatibility fixtures remain #233 work.
