# Bun AOT and native interoperability probe

This is an executable compiler/native-boundary experiment for [#225](https://github.com/0xPlayerOne/bun-native/issues/225). It does **not** render a window, simulate GPUI, or satisfy native UI acceptance in #230/#227.

## Reproduce

Install the checksum-pinned Bun build and exact Rust toolchain described in [the toolchain documentation](../../docs/toolchain.md). Install a C compiler: `cc` on Linux/macOS, or Clang on Windows. `CC` can select an explicit compiler executable. Linux binary inspection needs `readelf` and `ldd`; macOS uses `otool`.

```sh
bun install --frozen-lockfile
bun experiments/aot-gpui/run.ts /absolute/path/to/empty-evidence-directory
```

The runner requires the exact `Bun.revision` from `toolchain.json`, so a stable release or another canary cannot accidentally stand in for the pinned compiler. It records every command, exit code, duration, stdout/stderr, source hashes, compiler and OS versions, native library/executable hashes and executable sizes in the output directory. Outputs stay outside the source tree. Durations are diagnostic samples, not a native application performance baseline.

## Actual checks

1. Compile the C fixture into an OS shared library and a native echo executable. Both use warnings as errors. The echo process is an IPC fixture only.
2. In Bun development mode, load the library with `bun:ffi`, call native arithmetic, call back synchronously into JavaScript, close the callback and library, and round-trip a Unicode JSON line through `Bun.spawn` stdin/stdout. The native subprocess must exit successfully after stdin closes.
3. Compile the **same TypeScript source** with `bun compile --no-script --production --explain=json`, then run the emitted executable against the same native artifacts.
4. Compile a deliberately JIT-based control with `bun compile --no-aot`. A runtime mutation of a protected built-in is accepted in development/JIT and rejected with `TypeError` in AOT, as specified by the pinned compiler. This provides an execution witness alongside the explicit AOT build and binary inspection.
5. Require errors for a missing shared library and a TypeScript type mismatch. A rejected typecheck must emit no executable.
6. Inspect the standalone module graph using the pinned compiler's actual [`HAS_COMPILED_PROGRAM` flag](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/standalone_graph/StandaloneModuleGraph.rs). Require the flag in AOT and its absence in the JIT control. Reject malformed lengths, offsets, module records, entry points and unknown flags. This identifies a compiled program; it is not a general executable security validator.
7. On Linux, retain ELF sections and dynamic linkage. On macOS, retain Mach-O load commands/linkage. The `.bun_aot` section also exists in the JIT compiler runtime, so **that section alone does not prove AOT**. Windows footer inspection is implemented but remains unexecuted; native linkage inspection there is not yet implemented.
8. On Linux, decode the named `.bun_features` ELF section and its removed-range records. Require the JIT compiler to be removed in AOT and present in the actual `--no-aot` control. Preserve the interpreter's separate state. [Artifact inspection](../../docs/aot-inspection.md) documents the pinned source contract, raw records and scope; Mach-O/PE feature-state decoding is not implemented.

`Bun.spawn` uses a real native process. FFI uses a real shared library and real native function calls. These are **headless interoperability tests**, not GUI or OS input evidence. The synchronous callback test does not establish callbacks from arbitrary threads, asynchronous callback lifetime, Node-API support, crash isolation, GPUI main-thread correctness, or a safe public ABI. The production host initially uses the bounded subprocess transport implemented under #230/#228; FFI remains a measured alternative rather than a parallel public implementation.

## Initial evidence

See [the Linux record](evidence/linux-x64.json) for the checked source and exact outcomes. All successful checks used Bun `1.4.4-canary.1+da867c60b` / source `da867c60bf0bcbf9d6d36994f8ca0efa42075115`, Rust `1.98.1`, and Linux x64. A first restricted-sandbox attempt failed on a native pipe write with `EPERM`; the identical source passed in the authorized unrestricted execution environment. This was an environment restriction, not a compiler failure hidden by a mock.

The other archive targets are checksum-pinned, but their presence in the manifest does not assert successful AOT, GPUI or input testing. Cross-platform CI and actual-window evidence are tracked separately.

## Build the actual native window fixture

Once the native host and `examples/native-window/main.ts` are present, the release recipe compiles that same application, checks its compiled-program metadata, and copies an explicitly supplied prebuilt native host:

```sh
bun experiments/aot-gpui/build-window.ts \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --outdir /absolute/path/to/empty-package-directory
BUN_NATIVE_HOST=/absolute/path/to/empty-package-directory/bun-native-host \
  /absolute/path/to/empty-package-directory/native-window
```

Use `--host-profile dev` when qualifying a development host; omitting it records the profile as unverified. The helper does not invoke Cargo or claim that a supplied native binary was built from its current source. Match the recorded host SHA-256 to the native build and interaction evidence. `--source` selects another checked-out repository for coordinated development; ordinary use defaults to this repository. Windows output names end in `.exe`, and `BUN_NATIVE_HOST` must contain an absolute Windows path.

The package directory receives the AOT application, native host, compiler diagnostics, native linkage logs and a manifest with exact toolchain, source/lockfile hashes, dirty-worktree status, artifact hashes and sizes. Native rendering, OS input, teardown, installation and signing start as **not verified** in this build record; actual execution evidence is separate. The build itself cannot turn those checks into passes.

The same compiler and inspection pipeline supports three explicit entries:

| `--entry`                 | Source                           | Executable      | Native host placement                              |
| ------------------------- | -------------------------------- | --------------- | -------------------------------------------------- |
| `native-window` (default) | `examples/native-window/main.ts` | `native-window` | Copied into the package                            |
| `input-race`              | `tests/native/input-race.ts`     | `input-race`    | Existing prebuilt host referenced by absolute path |
| `bridge`                  | `benchmarks/bridge.ts`           | `bridge`        | Existing prebuilt host referenced by absolute path |

All executable names gain `.exe` on Windows. The two test entries avoid making another large host copy; their manifests record `host.placement: "external"` and the exact existing host path and hash. They are test artifacts, not standalone installation packages. `--entry bridge` requires an explicit `--host-profile dev` or `release`. Its [benchmark runner](../../benchmarks/BRIDGE.md) verifies the actual running executable, host and source hashes against the supplied AOT manifest before collecting samples.

```sh
bun experiments/aot-gpui/build-window.ts \
  --entry input-race \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --outdir /absolute/path/to/empty-input-race-directory

bun experiments/aot-gpui/build-window.ts \
  --entry bridge \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --outdir /absolute/path/to/empty-bridge-directory
```

The input-race fixture needs an actual native input session and a fresh evidence nonce; compiling it does not execute that regression. Each manifest identifies its selected entry and hashes the core, protocol and runtime sources, shared window content, native sources, package manifests and root build configuration. The helper checks those hashes before and after compilation and fails if the source changes during the build. Different entries cannot be substituted in a matched native-window baseline.

On Linux, the helper additionally requires the emitted application to record JIT compiler removal and includes its full runtime-feature record in the manifest. An interpreter may remain present; this check does not claim otherwise. Other executable formats report the JIT inspection as unimplemented.

`--trim` is an explicit comparison option for measuring Bun's additional unused-runtime removal. Default AOT already removes the JIT; the separate `trimmedProgramFeatures` metadata flag can remain false for a correctly inspected AOT executable. Run the same native input and teardown suite against the trimmed executable before choosing it for distribution. Build duration and artifact bytes in the manifest are single-build diagnostics, not cold-start, RSS or input-latency claims. A development-profile native host is not a release performance baseline.
