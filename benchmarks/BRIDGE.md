# Native bridge benchmark

`bridge.ts` exercises the real Bun process, bounded native pipes, Rust transaction
model and GPUI host. It requires an explicit **prebuilt** native executable and
a working native display. It never builds Rust or substitutes a protocol peer.

The measured interval starts immediately before `NativeHost.send` and ends when
the host's UI-thread `applied` response reaches Bun. It includes command
validation/serialization, pipe transport, native preflight, synchronous model
and entity updates, output transport and response validation. Rendering can
delay the main thread between requests. An acknowledgement is not a frame
presentation timestamp or a guarantee that the user has seen the new pixels.

## Workload

Each invocation performs a bounded sequence:

1. Create three real windows over one session. Check cross-window handles,
   rejected cycles/orphans, failed transaction revision and ID rollback, stale
   input revisions, subtree disposal, closed-window ID reuse and ordered native
   close events. A remaining window must keep accepting updates after another
   closes.
2. Create 1,000 text nodes, keep all of them alive, and warm up 20 requests.
3. Measure 1,000 individual property updates, then the same number of updates in
   ten batches of 100. Build each operation payload before starting its timer.
4. Delete all 1,000 text nodes. Create, explicitly update and delete 1,000 native
   input entities in separate acknowledged transactions, exercising real GPUI
   entity and focus cleanup.
5. Close the remaining native window, flush shutdown and require native exit 0.

The runner keeps raw per-request durations and reports nearest-rank p50/p95/p99.
The ten batch samples have limited statistical value; their p95/p99 are the
maximum sample. Compare total time for the same 1,000 updates and repeat matched
trials before claiming a speedup or setting a budget. The workload has a
120-second deadline in addition to the transport's bounded request timeout.

The input lifecycle loop creates real entities; it does not inject OS keyboard
events or wait for every intermediate entity to be painted. Use the native
OS-input harness for click, typing, focus, stale-input races and visual evidence.
This benchmark also does not establish leak freedom, cold startup, CPU/GPU
utilization, native RSS or physical-GPU frame latency. Those need their own
measurement tools and controlled workloads.

## Development execution

Build the host deliberately as a contributor, or use a native artifact whose
build provenance and hash are already recorded:

```sh
cargo build --locked -p bun-native-host --release
bun benchmarks/bridge.ts \
  --mode development \
  --host "$PWD/target/release/bun-native-host" \
  --host-profile release \
  --source "$PWD" \
  --output /tmp/bun-native-bridge-development-01
```

The output directory must not already exist. On a Linux hosted runner with the
documented native dependencies, run that Bun command inside an isolated
`dbus-run-session -- xvfb-run -a -s '-screen 0 1024x768x24'` session. Select the
installed Mesa lavapipe ICD explicitly through `VK_DRIVER_FILES` when a software
comparison is intended. `LIBGL_ALWAYS_SOFTWARE=1` and
`GPUI_X11_SCALE_FACTOR=1` make that test environment reproducible. An environment
request alone does not establish which GPU adapter GPUI actually used.

`--host-profile dev` records an unoptimized contributor build. A development
profile result must not be presented as a production host baseline. Normal
application edits rerun Bun and reuse the host; this runner never invokes Cargo.

## AOT execution

Use the shared artifact recipe to compile this exact entry, inspect it and write
its manifest:

```sh
bun experiments/aot-gpui/build-window.ts \
  --entry bridge \
  --host "$PWD/target/release/bun-native-host" \
  --host-profile release \
  --source "$PWD" \
  --outdir /tmp/bun-native-bridge-aot
```

The recipe invokes `bun compile --no-script --production --explain=json` and
uses the pinned `inspectBunExecutable` and `inspectBunRuntime` helpers. The bridge
entry references the existing host rather than copying another native binary.
Do not reuse a native-window manifest or infer AOT from an ELF section name,
filename or mode flag. Custom build jobs must produce the same artifact-bound
manifest, with these fields:

- `application.bytes`, `application.sha256` and
  `application.inspection.hasCompiledProgram: true` for the benchmark executable.
- On Linux, `application.runtimeFeatures` with a non-present JIT feature and
  positive validated JIT removed-code ranges. `trimmedProgramFeatures` describes
  optional program-feature trimming and is not used as proof of JIT omission.
- `host.bytes`, `host.sha256` and `host.profile` for the supplied prebuilt host.
- `source.files` containing byte counts and SHA-256 values for every source and
  configuration file enumerated by `bridge.ts`, captured consistently with the
  build. Changes to package exports, dependency locks or compiler configuration
  are source changes too.

Then run the resulting executable with the same native display environment:

```sh
/tmp/bun-native-bridge-aot/bridge \
  --mode aot \
  --aot-manifest /tmp/bun-native-bridge-aot/manifest.json \
  --host "$PWD/target/release/bun-native-host" \
  --host-profile release \
  --source "$PWD" \
  --output /tmp/bun-native-bridge-aot-01
```

Before starting the workload, the runner streams hashes of `process.execPath`
and the host, verifies them against the build manifest, checks source hashes,
and exercises the pinned AOT runtime's read-only built-in behavior as a
corroborating witness. These checks are excluded from acknowledgement samples.
The inspection metadata is external build evidence bound to the exact executable
hash; the runner does not scan a full executable buffer during measurement.
No result claims that the interpreter is physically absent.

## Instrumentation and artifacts

Add `--instrument` for a separate diagnostic run. The runner supplies a fresh
nonce and `native-events.jsonl` path to its own child. The host records actual
window GPU specs and `batch_applied` records containing `preflight_nanos`,
operation count, node count and retained text bytes. Preflight includes schema
semantics, candidate graph cloning and graph validation; it excludes GPUI apply,
layout, painting and display presentation.

Paint snapshots are bounded. A tree snapshot exceeding the record limit emits
`status: "omitted"` and a reason rather than partial assertion state. Model
preflight metrics remain available for large trees. The host performs this
opt-in serialization/file I/O on the UI thread, so instrumentation can materially
change throughput. Compare it separately from normal runs.

`result.json` contains the pinned runtime/toolchain, exact source and binary
hashes, source commit and dirty flag, declared native profile, display request,
execution mode evidence, semantic check results, every acknowledgement timing,
and native exit status. `totalWorkloadMs` includes setup, stabilization waits and
teardown; the per-request distributions do not. A failed workload writes a
failed result where possible and still attempts bounded shutdown. Preflight
argument/provenance errors occur before a host is launched.

Keep the raw results with the build artifacts. A performance comparison needs
the same source, host artifact/profile, target, adapter, window size, workload,
instrumentation setting and environment, with repeated trials and controlled
power/load conditions. Hosted software rendering and a physical GPU are separate
baselines.

## Initial diagnostic findings

The [small diagnostic record](bn1/initial-bridge-diagnostic-linux-x64.json) retains
the original summary measurements and hashes of the source reports and native
instrumentation log.

The first Linux x64 diagnostic used Bun
`1.4.4-canary.1+da867c60b`, the development-profile native host with SHA-256
`8a221ff318aa0a3ee0bfff95bc243dc0091d3c0a2af97347ab3bc550cc3ad40e`,
and GPUI on X11/Xvfb. Separate native-input runs reported the actual adapter as
Mesa llvmpipe 25.2.8 with LLVM 20.1.2. The prototype benchmark used the same host
and explicit lavapipe environment. These are single diagnostic runs, not
controlled release comparisons.

| Diagnostic               | Individual updates: p50 / p95 / p99 | Total for 1,000 individual updates | Total for ten 100-operation batches |
| ------------------------ | ----------------------------------- | ---------------------------------: | ----------------------------------: |
| Instrumentation disabled | 0.999 / 58.047 / 64.994 ms          |                       8,360.759 ms |                          230.318 ms |
| Instrumentation enabled  | 1.068 / 68.198 / 84.072 ms          |                      10,609.382 ms |                          298.388 ms |

With 1,001 retained nodes, 1,020 instrumented single-operation preflights measured
p50 0.624 ms, p95 0.929 ms and p99 1.390 ms. The roughly 60–80 ms acknowledgement
tail was therefore outside most model preflight samples. Renderer/main-thread
profiling with an optimized host is needed before attributing that tail more
precisely or replacing the graph-clone strategy.

Both runs passed all three window lifecycles, 1,000 text-node disposal operations
and 1,000 native input-entity lifecycles with native exit 0. Optional evidence
produced 4,223 records totaling 765,396 bytes; 149 large paint snapshots were
explicitly omitted. The prototype kept summary latency statistics rather than
every individual duration; the committed runner now retains raw timings. These
observations motivate batching and the BN1 performance audit; they do not define
a production latency budget.
