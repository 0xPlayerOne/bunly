# Repeated BN1 native development/AOT baseline

`native-baseline.py` measures the actual Bun Native fixture through its Linux
OS-input driver. It runs development Bun and the inspected machine-code AOT
application through the public `@bun-native/core` API against **the identical
release GPUI host**. It does not substitute a
headless host or fabricated rendering results. Any failed native correctness or
cleanup check stops the baseline.

The initial measurements are fresh-process startup observations, idle and sampled
peak process-tree RSS, OS-injected click/event/paint observations, close/exit
timing, AOT compilation duration, and the two executable sizes. Display
presentation, startup-to-interactive without the deliberate idle interval,
hardware GPU performance, physical input, CPU/GPU utilization, controlled
cold-cache startup and long-duration leaks remain unsupported by this
runner.

## Reproduce

Install the pinned Bun/Rust toolchains and the Linux packages listed in
`.github/workflows/native-linux.yml`. The source checkout must match the sources
recorded by the AOT build helper; the runner checks every recorded application
and native-host source/configuration hash before and after the trials, including
package exports, Bun's lockfile and compiler configuration. The source set
includes `packages/core`, the protocol/runtime packages, and both the example
entry point and shared content. The baseline accepts only the `native-window`
entry with its bundled host; a bridge or input-race artifact cannot qualify as
the same workload. It also rejects an
incorrect Bun revision, a changed executable, an unverified host profile, missing
compiled-program/JIT-omission metadata, and a target architecture mismatch.

```sh
bun install --frozen-lockfile
cargo build --locked --release -p bun-native-host
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/baseline.XXXXXX")
bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$PWD/target/release/bun-native-host" \
  --entry native-window --host-profile release --outdir "$run_dir/package"
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/session" -- python3 benchmarks/native-baseline.py \
  --output "$run_dir/results" --package "$run_dir/package" \
  --bun "$(command -v bun)" --samples 5 --warmups 1 --idle-seconds 2
```

The shared session helper creates a private window manager and selects Mesa's
software renderer. No user desktop, host page cache or power setting is changed.
The baseline requires the actual GPUI adapter metadata to stay identical across
all trials. It uses a new application and host process for each sample, waits
for the complete initial native tree, samples idle memory, then clicks the same
native button at client coordinates `(100, 130)`. An empty-root paint before the
initial batch cannot satisfy this readiness condition. Both modes must produce
the public click event and the complete changed native tree at revision 2, close
through the OS window manager, exit zero and release their processes. The smoke
session and baseline share independent expected tree snapshots from the driver.

BN0's protocol-v1 fixture and BN1's public API fixture are different workloads.
Keep the qualified BN0 results with their original source and artifact hashes;
do not interpret changes between these fixtures as a matched performance result.

One warm-up per mode is the default. Those trials run the full correctness
scenario, retain evidence and are excluded from the reported distributions.
Measured trials alternate development/AOT order on every repetition. The default
is five measured samples per mode; `--samples` accepts three through thirty and
`--warmups` accepts zero through five. The selected values are part of the report.

## Read the results

`results/summary.json` contains the exact AOT manifest, artifact hashes/sizes,
toolchain/source metadata, driver/baseline/session hashes, sample counts, methodology, actual
renderer, and separate development/AOT distributions. Every trial retains its
full driver report, process/RSS samples, event log and before/after screenshots.
Warm-up trials remain clearly labeled. A failed run retains the trials completed
so far and reports its failure; it never generates a passing comparison by
discarding failed samples.

Machine metadata includes the OS/kernel, CPU architecture/model, logical and
available CPU counts, runner environment and UTC start time. Power mode remains
uncontrolled and unverified; the runner does not infer or change it.

| Metric                                                       | Meaning and limitation                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time_to_window_observed_ms`                                 | Time from process launch until the driver sees the owned X11 window. This is window discovery, not first display presentation.                                            |
| `time_to_first_paint_report_observed_ms`                     | Time until the driver observes GPUI's first paint-traversal record. Polling adds observation delay; the GPU may present later.                                            |
| `time_to_expected_initial_paint_report_observed_ms`          | Time until the complete mounted fixture tree matches its expected native paint snapshot. This may follow an earlier empty-root paint; it is not a presentation timestamp. |
| `idle_median_tree_rss_bytes` / `idle_maximum_tree_rss_bytes` | Median/maximum sampled process-tree RSS during the configured idle interval after the mounted-tree paint and before input. Shared pages may be counted more than once.    |
| `sampled_peak_tree_rss_bytes`                                | Maximum RSS sum observed across the scenario. Sampling can miss the true peak.                                                                                            |
| `input_start_to_matching_app_event_observed_ms`              | Time from starting the injected click until the driver observes the corresponding event delivered to Bun. Includes automation and polling delay.                          |
| `input_start_to_matching_paint_report_observed_ms`           | Time from starting the click until the expected changed native state is observed in the paint report. It is not input-to-display latency.                                 |
| `os_close_to_app_exit_observed_ms`                           | Time from requesting OS close until application exit is observed.                                                                                                         |
| `artifact_bytes`                                             | Bytes of the AOT application, release host, and their sum. System libraries, installer/archive overhead and assets are outside this payload measurement.                  |
| `aot_compile_wall_ms`                                        | Wall time recorded by the build helper for the Bun compilation command. Native release compilation is recorded by the separate CI build log.                              |

Distributions include minimum, median, maximum and a nearest-rank observed p95.
With five samples, that p95 is the maximum observation; it is not an estimate of
a stable population tail. Cache state is explicitly uncontrolled. The results
describe this fixture on this runner and do not establish statistical speedups,
physical-GPU behavior or performance across operating systems. There is no
guessed pass/fail performance budget. Comparable repeated measurements provide
the evidence for setting one later.

The host profile in the build manifest is supplied by its caller. Match its
binary hash to the recorded `cargo build --release` command and native CI
evidence when publishing results; a manifest field alone does not prove compiler
optimization settings.

The twelve safety tests in `tests/quality/test_native_baseline.py` exercise metadata
validation with inert fixtures, reject a missing display without launching an
artifact, and cancel a real supervised Python child. They never report those
fixtures as working AOT/native applications.

The baseline supervisor forwards termination to the running driver and waits
for bounded cleanup. The driver handles termination as a failed measurement.
Its Linux process-local child-subreaper setting lets it reap
observed native descendants even when their application parent exits first.
PID/start-time checks prevent an unrelated recycled PID from being treated as an
owned child. The setting applies only to the test driver process, not to machine
configuration or the application API.

## Separate compiled input-race check

The negative input-revision fixture is a separate correctness test and is not
included in the baseline distributions. Compile and inspect its own entry, then
run the explicit `aot-input-race` session mode:

```sh
bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$PWD/target/release/bun-native-host" \
  --entry input-race --host-profile release --outdir "$run_dir/input-race-package"
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" BUN_NATIVE_HOST_PROFILE=release \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/input-race-session" aot-input-race "$run_dir/input-race-package/input-race"
```

This mode runs the supplied executable, types into the real native input, and
requires the stale-revision rejection to preserve the native value after an
unrelated tree update. The build helper records the external host hash without
copying that large artifact. Keep the manifest beside the interaction reports:
the input driver records the declared execution mode but does not independently
prove that an arbitrary supplied executable was compiled with Bun AOT.
