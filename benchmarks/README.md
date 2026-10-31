# Native performance evidence

BN0 first establishes a correct interactive GPUI fixture. Measurements must
identify the exact source revision, Bun/compiler/native revision, OS/architecture,
GPU/display environment, execution mode, command and raw samples.

Development (`bun run`), ordinary bundled JIT executables (`bun build --compile`)
and machine-code AOT (`bun compile`) are different measurement modes. A failed
or unavailable AOT run has no AOT performance result.

Capture cold launch, time to interactive, process-tree idle/peak RSS, CPU/GPU,
input-to-paint/frame latency, bridge traffic, artifact bytes and native build
duration. Repeat matched trials and retain distributions. Baselines and budgets
are established from the first correct native implementation, never invented.

The old CEF comparison harness and its results have been removed. Native
measurement harness implementation is tracked in [#258](https://github.com/0xPlayerOne/bun-native/issues/258).

## First real native record

[BN0 Linux smoke observations](bn0/native-smoke-linux-x64.json) retain the actual
four development/AOT click and text runs, process-tree RSS samples, compiler and
artifact hashes, renderer metadata and cleanup results. Every build source hash
was matched against the recorded Git snapshot. These runs use a development
profile GPUI host and llvmpipe software rendering. They do not establish a speedup,
idle baseline, hardware result or release-size budget.

The [integration report](../docs/bn0-integration.md) explains those measurements.
The native harness accepts bounded idle sampling and reports observation times
for window discovery, native paint, OS input and teardown. They are sampled
process observations, not hardware frame-presentation timestamps. Repeated
matched development/AOT trials and release-host measurements extend this baseline
without rewriting the original record.
