# BN0 native integration record

This records the implemented Bun-to-GPUI path, the executed checks and the remaining acceptance work. The clean workspace and compiler probes are merged in [#264](https://github.com/0xPlayerOne/bun-native/pull/264) and [#265](https://github.com/0xPlayerOne/bun-native/pull/265). [#266](https://github.com/0xPlayerOne/bun-native/pull/266) contains the real native host, Bun runtime, fixture and required native CI.

## Implemented behavior

`examples/native-window/main.ts` launches a prebuilt Rust GPUI executable through `@bun-native/runtime`. GPUI creates a real window containing text, an Increment button and an editable input. A native click travels to Bun; Bun increments its counter and sends the new label to GPUI. Keyboard edits travel through GPUI's input handler to Bun. The same TypeScript entry point compiles with the pinned machine-code `bun compile` command and drives the same native host.

The child owns the GPUI main thread. Commands and events use private, bounded and validated stdin/stdout pipes. The application owns request deadlines and process teardown. No browser renderer, embedded web server, CEF dependency or WebView fallback exists in this path. [ADR 0002](decisions/0002-owned-native-process.md) explains the choice and the unresolved public API work.

## Exact first verified environment

| Item                         | Value                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| OS/CPU target                | Linux x86_64, kernel 6.18.57, glibc 2.39                                                              |
| Display and input            | Isolated Xvfb X11, Openbox, XTest pointer/keyboard injection                                          |
| Actual GPUI adapter          | llvmpipe, LLVM 20.1.2, Mesa 25.2.8-0ubuntu0.24.04.4; software emulation reported by the native window |
| Bun                          | `1.4.4-canary.1+da867c60b`                                                                            |
| Full Bun source              | `da867c60bf0bcbf9d6d36994f8ca0efa42075115`                                                            |
| Rust                         | 1.98.1                                                                                                |
| GPUI                         | 0.2.2, Zed revision `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d`                                        |
| First host build             | Rust development profile, debug information disabled                                                  |
| Exact tested source snapshot | `ba5fd63d1677ad6a87da798bb930e3ed4c8917da`                                                            |

The build ran before that source commit was created, so the original manifest accurately reports a dirty checkout based on `bc5fa40527308a6ed76bf923e103567b2a5555a3`. Every source hash in that manifest was subsequently compared with the Git blobs at `ba5fd63d1677ad6a87da798bb930e3ed4c8917da`; all matched. The later root Cargo unification changes the workspace layout, not this historical record.

## Executed checks

| Check                            | Result and scope                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source/protocol foundation       | 57 TypeScript tests and 9 Rust protocol tests; hosted Linux/macOS/Windows protocol jobs passed in #264                                                                               |
| Bun native-process runtime       | 12 additional real-process, headless tests: handshake, correlated requests, errors, timeouts, invalid output, event overflow and disposal; these are not renderer tests              |
| Compiler/native interoperability | Development and actual AOT shared-library call, synchronous callback, disposal and Unicode subprocess round-trip passed; explicit JIT control and negative compile/load cases passed |
| Actual native build              | GPUI host build, Rust formatting and full-workspace Clippy with warnings denied passed locally                                                                                       |
| Development native input         | Real X11 click changed the Bun counter and GPUI label; full nonce text entry reached Bun and native paint; screenshot inspection passed                                              |
| AOT native input                 | Same source compiled to machine code; the emitted executable passed both real click and text scenarios with the same native host                                                     |
| OS close and fresh launch        | All four development/AOT scenarios exited with code 0, without forced termination or observed remaining/unreaped application processes                                               |
| Reopen within one process        | Five native create/update/close/reopen cycles, invalid-state rejection and idempotent shutdown passed through `tests/native/lifecycle.ts`                                            |
| Release-profile host             | Required hosted native CI builds this profile and repeats both application modes; consult the current #266 run for its result                                                        |

Screenshots are captured from the owned native window, not generated imagery. The harness correlates fresh nonce-tagged application and paint reports with OS input. It does not perform automatic text recognition, and a paint callback is not a display-presentation timestamp. Compilation-only, headless protocol, software-rendered GUI and physical-device verification remain separate evidence levels.

## AOT and artifact inspection

The compiler recipe is `experiments/aot-gpui/build-window.ts`. It requires the exact Bun revision, records the source hashes and compile command, compiles the real fixture, copies an explicitly provided native executable and captures both artifacts' sizes, hashes and dynamic linkage. It never silently invokes Cargo.

The first working AOT application is 70,712,360 bytes, SHA-256 `e18c83bf2466a6c78665f708a3c8b2289da3961d74e630b408a9c5527b7fea9c`. Its development-profile native host is 109,334,544 bytes, SHA-256 `70f3ff32af786f2776fa9a58785795b4435df9124d7c3b28923013371a168c66`. These are two experimental executables, not a signed installer or a release-size claim. The observed AOT compile took 1,480.65 ms in that environment; this is one diagnostic sample.

The executable inspector parses the pinned Bun standalone module graph and requires `HAS_COMPILED_PROGRAM` (`0x4000`). This application has flags `0x417c`; the deliberately JIT-compiled control has `0x017c`. A separate AOT runtime behavior witness also differs from development/JIT. The `.bun_aot` ELF section exists in both runtime forms and is explicitly insufficient evidence by itself.

The separate [runtime-feature inspection](aot-inspection.md) parses the named ELF `.bun_features` section using the pinned compiler's layout. It records the JIT as removed in this actual AOT application, and present in the explicit non-AOT control. The interpreter remains present. The section parser, source links, complete raw feature records and 25 metadata tests are retained; compilation does not imply that arbitrary runtime-generated strings are machine compiled. This check currently qualifies Linux ELF64 only.

## Initial observations

The [committed raw smoke record](../benchmarks/bn0/native-smoke-linux-x64.json) includes pinned artifacts, source hashes, actual adapter details, process-tree RSS samples, input/paint records, screenshot hashes and cleanup outcomes.

| Mode and scenario  | Time until owned window observed | Sampled peak process-tree RSS |
| ------------------ | -------------------------------: | ----------------------------: |
| Development, click |                        334.09 ms |             171,057,152 bytes |
| Development, text  |                        332.56 ms |             174,342,144 bytes |
| AOT, click         |                        324.82 ms |             169,570,304 bytes |
| AOT, text          |                        326.64 ms |             171,712,512 bytes |

These are fresh-process smoke observations with an unoptimized native host and software GPU. Page-cache and power state were uncontrolled; RSS sums may double-count shared pages and sampling may miss the true peak. The two scenarios per mode do not establish a speedup, regression threshold, idle baseline or startup-to-interactive distribution. The harness records observation timestamps rather than GPU presentation. Repeated matched measurements and idle sampling extend this record under #258; release/hardware results must remain separately labeled.

## Failures found and resolved

| Finding                                                               | Resolution and remaining work                                                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Stable Bun 1.4.4 lacks the machine-code compile command               | Pin and checksum the actual official AOT-enabled canary; never substitute an ordinary standalone JIT build                       |
| Restricted execution denied a native process pipe operation           | Reproduced the environment restriction and ran the identical native fixture in authorized execution/hosted CI; no simulated pass |
| `.bun_aot` section also appears in the JIT control                    | Added actual compiled-program metadata validation, malformed metadata tests and an execution witness                             |
| GPUI quit on final window close before Bun's shutdown acknowledgement | Use explicit GPUI quit mode; real OS-close and five in-process reopen cycles passed                                              |
| Echoed input snapshots lost newer keystrokes                          | Stop unversioned echo in the fixture; BN1 #228 must introduce controlled-input revisions before exposing that behavior           |
| Long input does not scroll to the caret                               | Open limitation recorded under BN4 #241; complete text values/events are preserved                                               |
| Upstream Apache license path was raw symlink content                  | Replaced it with the full pinned upstream license and retained source attribution before the native source commit                |
| Foundation Actionlint installer looked for a Cargo crate              | Fetch and checksum the real Go binary archive; required validation then passed without disabling the check                       |

## Reproduce and continue

Install the pinned tools using [getting started](getting-started.md), build the native host explicitly and use the real commands in [testing](testing.md). The required Native Linux CI job retains build logs, manifests, native input reports and screenshots, including evidence on failure. Its declared host profile must match its actual Cargo command and binary hash.

BN1 now has a demonstrated native calling path to extend into a common tree, owned handles, atomic batches, capabilities, cancellation and safe controlled input. It must retain real lifecycle/AOT tests. Solid and React must consume that same host; no framework-specific native implementation is needed.

macOS/Windows GUI, Wayland, physical GPU performance, IME, screen readers, production signing, clean-machine installation and cross-platform release packages remain unverified here and are owned by #241, #246 and #256. Node-API and arbitrary-thread asynchronous FFI callbacks are unqualified alternatives, not hidden requirements for the selected subprocess architecture. BN0 remains open until the release-profile execution, final integration report and measured baseline checks pass.
