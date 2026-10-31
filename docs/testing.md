# Testing and validation

Bun Native validates the implementation that exists at the tested revision. A passing protocol test is **headless evidence**. Compiling a Rust binary is **compile evidence**. A rendered, interactive native window and a machine-code AOT application require their own execution evidence.

## Reproduce the foundation checks

Install Bun through the checksum- and revision-checking installer; `.bun-version` is only the display version of the pinned canary. Rustup reads `rust-toolchain.toml`; no globally installed compiler version is assumed. From a clean checkout:

```sh
node scripts/install-bun.mjs --destination "$PWD/.bun-native/bun"
export PATH="$PWD/.bun-native/bun:$PATH"
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run check:boundaries
bun test tests --coverage
bun run build
cargo fmt --manifest-path Cargo.toml --all -- --check
cargo clippy --locked --manifest-path Cargo.toml -p bun-native-protocol --all-targets -- -D warnings
cargo test --locked --manifest-path Cargo.toml -p bun-native-protocol
```

`build` checks the TypeScript package build. It is not an AOT release build and must not silently compile Rust for ordinary application edits. The Rust commands explicitly select the portable protocol crate. GPUI compilation, GPU initialization, window interaction and production AOT acceptance have separate commands and evidence as those integration tasks land.

`bunfig.toml` retains the minimum line-coverage gate. Coverage is useful for the implemented source; it does not establish native UI or platform support.

## Hosted workflows

| Workflow/job                          | What it proves                                                                                                                                                                              | What it does not prove                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `bun-native.yml` / Source quality     | Formatting, linting, type checking, package boundaries, dependency use, package build, Bun unit coverage, Python harness safety and workflow syntax                                         | Native rendering or production AOT                                   |
| `bun-native.yml` / Protocol matrix    | TypeScript behavior and Rust protocol fmt/Clippy/tests on Ubuntu 24.04, macOS 15 and Windows Server 2022                                                                                    | GPU/window interaction or physical input                             |
| `bun-native.yml` / AOT native interop | Actual machine-code execution, native FFI/callback/subprocess behavior, explicit JIT control and compiler metadata checks on Linux                                                          | GPUI rendering or other OS AOT support                               |
| `native-linux.yml`                    | Release GPUI host compilation/tests and actual development/AOT applications: X11 button/text events, native paint reports, screenshots, clean OS close and fresh launch with a software GPU | Physical input, hardware GPU performance or macOS/Windows GUI        |
| `security.yml`                        | Dependency review and Bun/Rust advisory audits against the committed lockfiles                                                                                                              | A complete threat model or sandbox                                   |
| `codeql.yml`                          | Source analysis through the pinned Code Foundry workflow                                                                                                                                    | Runtime correctness                                                  |
| `Validation / Gate`                   | Every required source, protocol, AOT interop, native Linux and dependency-audit job succeeded                                                                                               | Completion of all platform, physical-device and packaging acceptance |

The required check keeps its existing name so protected-main rules do not become stale. The aggregate fails if any required job fails, is cancelled or is skipped. No main-branch or administrator bypass is part of the workflow. Ordinary pull requests start as drafts; expensive validation runs after the explicit ready transition. The existing `CI_BILLING_PAUSED` control is preserved.

Workflow actions, Bun, Rust and lockfiles are pinned. Cache entries contain dependency downloads only and are keyed by OS, architecture and toolchain/lockfile hashes; build outputs, dependency installations and credentials are not cached. Main-branch runs queue rather than cancel a previous run. Source checks target five minutes; the three portable protocol jobs allow ten minutes for a clean compiler/dependency setup. The separate native Linux lane allows sixty minutes for a clean release GPUI build and AOT compilation; it records build time and binary size and avoids a second debug host build. Cross-platform GUI and long-running soak coverage continue under [#256](https://github.com/0xPlayerOne/bun-native/issues/256).

Each protocol job records the source SHA, Bun revision, verbose Rust version, OS/architecture and explicit development/headless scope in a retained Actions artifact. Passing foundation CI must never be presented as a native-window or no-JIT release result.

The repository owns the native validation, dependency-security and CodeQL callers. Code Foundry still owns draft/release policy; its generated generic validation feature is disabled to prevent a later sync from replacing the native checks. `custom_workflows: preserve` retains these callers. The obsolete browser qualification workflows and their success contexts are removed.

## Real Linux native input

The Linux lane builds the release profile of `bun-native-host` from the root Cargo workspace. It creates a private Xvfb display and DBus session, starts Openbox, selects the installed Mesa lavapipe ICD, and launches the actual Bun application with its prebuilt GPUI host. It then compiles that same workspace entry point with `experiments/aot-gpui/build-window.ts`, verifies the Bun compiled-program metadata, and repeats the native interaction against the emitted AOT application and copied release host. No browser, mock renderer or synthetic application callback substitutes for the native path. Input is injected through the X server's XTest extension; this is real OS-delivered input, not a physical keyboard or mouse test.

The development session first runs `tests/native/lifecycle.ts` under a 45-second process-group deadline. It checks five create/update/close/reopen cycles within one actual GPUI host, rejects invalid-state commands and verifies idempotent shutdown and exit zero. This is native lifecycle evidence; it does not assert visible pixels or OS input.

The two input scenarios then launch independent application processes. The first clicks the native Increment button and requires a Bun-observed `click` plus the GPUI paint report for `Clicks: 1`. The second launches after the first has closed, types a fresh session value into the focused input, and requires the matching Bun `input` event and native painted text. Both capture the actual owned window before and after input, then close through the window manager and require an exit code of zero and no observed remaining application processes. The same two input scenarios also run against the inspected AOT application.

Reproduce after installing the Linux packages listed in `.github/workflows/native-linux.yml`:

```sh
cargo build --locked --release -p bun-native-host
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/native.XXXXXX")
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" BUN_NATIVE_HOST_PROFILE=release \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/interaction" development bun examples/native-window/main.ts
```

`scripts/quality/native-input-linux.py` also accepts an explicit app command after `--` for targeted runs. It verifies the exact window title and process ownership before focusing or sending input. A random nonce and the log offset immediately before injection prevent previous-session or startup records from satisfying input expectations. Application logs and event evidence are bounded to 4 MiB each. Input actions, subprocess calls and the test run have deadlines; cleanup targets only the process session it launched and identity-checked observed descendants. Environments where `/proc` and child-process IDs use different namespaces are reported unsupported before launch.

Each scenario writes `result.json`, actual stdout/stderr, nonce-tagged JSONL events and `before.png`/`after.png`. The report separates OS input injection, application-observed input, native paint traversal, OS close and cleanup. Screenshots are retained for visual inspection; the harness does not claim automatic pixel or text recognition. Renderer metadata comes from `Window::gpu_specs()` in the actual GPUI window, and the hosted scenario requires it to identify a software adapter. System package versions and exact Bun/Rust/source versions are recorded alongside the evidence.

The driver records time from app launch until the owned window is observed, the first native paint report is observed, input injection starts/ends, the matching Bun event and painted state are observed, and OS close/exiting are observed. Paint/event observations are polled at nominal 100 ms intervals and are not display-presentation timestamps. Text input timing includes the entire injected text sequence rather than measuring individual keystroke latency. Sampled process-tree RSS can count shared pages more than once, sampling can miss the true peak, and cache state is uncontrolled. These are fresh-process smoke observations, not controlled cold-cache, time-to-interactive or physical-GPU performance baselines.

For a baseline trial, pass `--idle-seconds 2` directly to the Python driver. The option defaults to zero and accepts at most ten seconds; it samples after the first observed paint and before any input. The report retains raw samples with an `idle` phase plus the actual sampling duration, sample count, median and maximum process-tree RSS. Shared-page double counting still applies. The harness never flushes operating-system caches or changes machine power settings.

`--mode aot` declares how the caller launched the app; the input driver never verifies machine-code compilation by itself. The CI lane separately invokes the pinned compiler, validates the emitted compiled-program metadata, hashes the source and both binaries, and retains `package/manifest.json` and build/inspection logs. The actual host build profile is declared in every scenario report and substantiated by the recorded Cargo release command and binary hash. Routine evidence artifacts omit the large executable files while retaining their hashes, sizes, linkage, compiler metadata and actual execution results. A missing or invalid AOT metadata check fails the job before the AOT GUI run.

The harness uses Python's standard library. Ruff is the sole Python development dependency, pinned by version and wheel hashes in `scripts/quality/requirements.txt`; it is absent from application runtime dependencies. Its six headless safety tests check evidence freshness/nonce validation, incomplete records, bounded logs, unavailable-display behavior and real child-process cleanup. Each test has a ten-second deadline. These tests exercise the harness and do not qualify a native GUI:

```sh
python3 -m venv .bun-native/quality-env
.bun-native/quality-env/bin/pip install --no-deps --only-binary=:all: --require-hashes -r scripts/quality/requirements.txt
.bun-native/quality-env/bin/ruff format --check scripts/quality/native-input-linux.py tests/quality/test_native_input_linux.py
.bun-native/quality-env/bin/ruff check scripts/quality/native-input-linux.py tests/quality/test_native_input_linux.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/quality -p 'test_*.py' -v
bash -n scripts/quality/native-linux-session.sh
```

The process-tree safety case is explicitly skipped if the local PID namespace cannot be reconciled with `/proc`. Hosted Ubuntu runs it in the real namespace. The native GUI lane fails, rather than reporting a pass, when the actual display/input/paint/cleanup requirements are unavailable or unfulfilled.

## Architecture and negative checks

The current source dependency graph is deliberately small:

| Package                | Allowed runtime dependencies             | Platform modules |
| ---------------------- | ---------------------------------------- | ---------------- |
| `@bun-native/protocol` | None                                     | Forbidden        |
| `@bun-native/runtime`  | Public exports of `@bun-native/protocol` | Allowed          |

`scripts/quality/boundaries.ts` parses actual TypeScript/JavaScript syntax. It checks type-only imports, exports, dynamic imports, CommonJS loads and TypeScript import types, rather than matching code with regular expressions. Cross-package relative paths, undeclared dependencies, nonpublic subpaths, uninspectable dynamic imports and unused runtime dependencies fail. New packages need an explicit policy addition. This is a scoped dependency audit; it does not claim complete whole-program dead-code detection.

Run the deliberate failure fixtures with:

```sh
bun test tests/quality
```

The suite proves that reversed dependency edges, private imports, undeclared/unused dependencies and platform imports in portable contracts are rejected. Strings and comments containing import-like text remain valid. The CI gate consumes the same implementation used by those tests.

## Native and AOT acceptance

[Native window #230](https://github.com/0xPlayerOne/bun-native/issues/230) must demonstrate a real GPUI window driven by Bun TypeScript, OS mouse/keyboard input, visible state updates and clean teardown. [AOT executable #227](https://github.com/0xPlayerOne/bun-native/issues/227) must build and run that same fixture with the pinned Bun machine-code compiler and retain compiler/provenance evidence. `bun build --compile` packaging is not sufficient evidence for that requirement.

For every native experiment, record:

- Exact source commit, Bun compiler/revision, Rust compiler, GPUI revision and command.
- OS, CPU architecture, GPU/display backend and relevant runner limitations.
- Build mode: Bun development, conventional bundled executable, or verified machine-code AOT.
- Separate compile, host integration, visible window, OS input and teardown outcomes.
- Logs and screenshots or recordings when available, with actual process exit status.
- Explicit **passed**, **failed**, **skipped** or **unsupported** status and a linked issue for an unresolved gap.

A skipped test is never passed. A simulated event proves only the event-handling code it exercises. A screenshot alone does not prove keyboard or mouse input. No browser fallback qualifies as native rendering.

## Environments

1. Use GitHub-hosted Linux, Windows and macOS runners first for builds, tests and real native fixtures where available.
2. Use the connected Mac via Remote Desktop Commander for actual GUI, keyboard/focus, text/IME and OS-specific checks that hosted runners cannot establish. Discover the online device at runtime, use a bounded temporary directory and leave personal files/settings untouched.
3. Use containers only for a specific missing capability, preferably on hosted infrastructure. Missing physical hardware or assistive-technology coverage remains unsupported and has a follow-up issue.

Verification is agent-owned engineering work. It does not require an additional human approval checkpoint.

## Performance evidence

[#258](https://github.com/0xPlayerOne/bun-native/issues/258) remains open until a genuine native baseline exists. Do not populate native metrics with mocked or protocol-only measurements. Capture cold startup, startup-to-interactive, process-tree idle/peak RSS, executable/install size, build duration and real input latency after the corresponding native/AOT fixture works.

A baseline record includes source and toolchain revisions, complete commands, OS/CPU/GPU/power mode, fixture correctness assertions, sample count, warm-up procedure, cold/warm distinction, raw samples, units, medians and tail latency. Preserve original logs alongside summaries. Comparisons require matched fixture behavior and environment; unsupported metrics have a reason instead of a zero. A reproducible unexplained regression around ten percent triggers investigation, with absolute impact and noise considered. Budgets follow measured correct behavior, not an assumed performance advantage.

Every PR also reviews removed/stale exports, dependencies, duplicate implementations, lifecycle ownership, security boundaries and documentation accuracy. Follow [engineering-quality.md](engineering-quality.md); [#259](https://github.com/0xPlayerOne/bun-native/issues/259) expands regression and hygiene automation as the real application grows. A milestone closes only when its native acceptance and audit evidence are complete.
