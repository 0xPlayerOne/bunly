# Real native integration fixtures

These entry points launch the actual prebuilt GPUI host. They are separate from
the default headless `bun test tests` suite. The required Linux native CI job
builds one release host and reuses that artifact for development Bun and five
inspected machine-code AOT entries.

## Session modes

Run `scripts/quality/native-linux-session.sh` inside a dedicated Xvfb/DBus session.
Its output directory must be new, and the application command is explicit.

| Mode                 | Application command                    | Required behavior                                                                                                                                                        |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `development`        | `bun examples/native-window/main.ts`   | Public API pointer, text and Enter events; full native tree paints; OS close/relaunch; five lower-level window lifecycle cycles and the development stale-input fixture. |
| `aot`                | Compiled `native-window`               | The same public API pointer, text, Enter and close scenarios.                                                                                                            |
| `aot-input-race`     | Compiled `input-race`                  | A real typed input rejects an outdated replacement revision and survives an unrelated tree update.                                                                       |
| `javascript`         | `bun tests/native/javascript.js`       | A strict-JSDoc JavaScript consumer creates and updates the native tree, handles click/input callbacks, observes input revisions and releases its resources.              |
| `aot-javascript`     | Compiled `javascript`                  | The same JavaScript consumer input and cleanup scenarios through Bun AOT.                                                                                                |
| `core-lifecycle`     | `bun tests/native/public-lifecycle.ts` | One real click starts 1,000 public subtree/listener lifecycle cycles. OS close must abort the still-active callback and clear public resource counts.                    |
| `aot-core-lifecycle` | Compiled `core-lifecycle`              | The same public lifecycle and cancellation scenario through Bun AOT.                                                                                                     |
| `--`                 | An explicit benchmark command          | Create the isolated display environment for the bridge or repeated baseline runner; the supplied runner defines its own checks.                                          |

The input driver verifies that the target window belongs to the launched
application, focuses it, injects XTest input and requires matching Bun events and
complete native paint snapshots. It waits for the mounted tree before injecting
input, so an earlier empty-root paint cannot qualify as a ready fixture. Each
scenario closes the window through the window manager and checks exit and
owned-process cleanup. Screenshots are retained for inspection; there is no
automated pixel/text assertion or physical-input measurement.

## Run development fixtures

Install the pinned toolchains and Linux prerequisites from
`.github/workflows/native-linux.yml`. Framework contributors deliberately build
the native artifact once; ordinary application changes reuse it.

```sh
cargo build --locked --release -p bun-native-host
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/native-suite.XXXXXX")
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_HOST_PROFILE=release

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/javascript-development" javascript bun tests/native/javascript.js

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/lifecycle-development" core-lifecycle bun tests/native/public-lifecycle.ts
```

The repository's strict TypeScript check enables `allowJs` and `checkJs` and
includes the JavaScript consumer. Type checking alone does not establish its
native runtime behavior; the session modes above exercise that separately.

## Compile and run AOT entries

The shared build helper accepts `native-window`, `input-race`, `bridge`,
`javascript` and `core-lifecycle`. It records source/configuration and executable
hashes, the exact compiler command, compiled-program metadata and Linux JIT
omission evidence. `native-window` bundles a copy of the native host for the
distribution/baseline package. The other entries reference the existing host by
path and hash.

```sh
bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$BUN_NATIVE_HOST" --host-profile release \
  --entry javascript --outdir "$run_dir/javascript-package"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/javascript-aot" aot-javascript "$run_dir/javascript-package/javascript"

bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$BUN_NATIVE_HOST" --host-profile release \
  --entry core-lifecycle --outdir "$run_dir/lifecycle-package"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/lifecycle-aot" aot-core-lifecycle "$run_dir/lifecycle-package/core-lifecycle"
```

Keep each build manifest beside its corresponding native evidence. The driver
records the requested execution mode and does not independently determine
whether an arbitrary supplied executable contains Bun AOT code.

## Evidence and limits

Each input scenario writes a `result.json`, bounded stdout/stderr and event logs,
before/after screenshots, renderer details and owned process-tree RSS samples.
The lifecycle fixture also writes `public-lifecycle.json` beside the event log,
with raw cycle timings, Bun memory checkpoints, weak-reference observations,
public resource counts and callback cancellation results. Weak-reference or
finite lifecycle observations alone do not establish long-term leak freedom.

The [bridge runner](../../benchmarks/BRIDGE.md) records actual native
acknowledgement timings and semantic checks. Required CI runs development and
AOT bridge measurements with instrumentation disabled; those timings are not
display-presentation measurements. The
[repeated baseline](../../benchmarks/NATIVE_BASELINE.md) compares the same
public API fixture and release host across modes, retains every trial and uses
no guessed performance budget.

The session selects Mesa software Vulkan and the input driver verifies the
adapter actually reported by GPUI. This evidence covers Linux X11/XTest and
software rendering. It does not qualify hardware-GPU performance, physical
input, display-presentation latency or macOS/Windows GUI behavior.
