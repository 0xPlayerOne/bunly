# Bun AOT and native toolchain

The toolchain is pinned in [`toolchain.json`](../toolchain.json). Bun's published stable `1.4.4` has the built-in checker and formatter, but `bun compile --help` on that exact release exits with `Script not found "compile"`. The native workspace therefore uses a specific **experimental canary with actual machine-code AOT**, rather than relabeling a JIT executable.

## Exact pins

| Tool       | Pin                                                              | Verified scope                                                                                       |
| ---------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Bun        | `1.4.4-canary.1+da867c60b`                                       | Linux x64 compiler, checker, formatter, FFI, native callback, subprocess and AOT executable verified |
| Bun source | `da867c60bf0bcbf9d6d36994f8ca0efa42075115`                       | Official canary release asset digests and source documentation                                       |
| Rust       | `1.98.1` (`48a229cea`, 2026-09-01)                               | Matches the pinned Zed toolchain; Linux compiler installed and checked                               |
| GPUI       | `0.2.2`, Zed revision `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d` | Exact source/dependency pin; actual window acceptance belongs to #230                                |

The manifest records six official Bun archives for Linux x64/arm64, macOS x64/arm64 and Windows x64/arm64, each with its immutable GitHub asset ID and SHA-256. **A pinned archive is not a verified platform.** The initial native/AOT interop record covers Linux x64 only. The full compiler revision is checked at runtime; the shorter `.bun-version` is informational for tooling that reads it.

## Install reproducibly

Use Node 22 or newer to bootstrap Bun without first installing a different Bun release:

```sh
node scripts/install-bun.mjs --destination /absolute/path/to/bun-native-tools
export PATH="/absolute/path/to/bun-native-tools:$PATH"
bun --revision
rustup toolchain install 1.98.1 --profile minimal --component rustfmt,clippy
```

On Windows, pass an absolute Windows path and add it to `PATH`; PowerShell expands the archive. Linux/macOS require `unzip`. GitHub Actions receives the installed directory through `GITHUB_PATH`. Environments requiring an HTTP proxy can use a Node version that supports `--use-env-proxy`; this does not disable TLS or checksum verification.

The installer downloads the exact asset ID, verifies SHA-256 **before extracting or executing**, then verifies `bun --revision`. It never follows the mutable `canary` tag to a replacement build. If upstream removes an asset or changes the build, installation fails explicitly; select and qualify a new exact revision instead of silently accepting a newer compiler. Existing installations must report the matching revision. No signing credential or access token is required.

`rust-toolchain.toml` pins the same Rust release with Clippy and rustfmt. GPUI's native libraries vary by OS; follow the exact [pinned source's build instructions](https://github.com/zed-industries/zed/tree/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/docs/src/development) and the native-host CI recipe. GPUI uses Metal on macOS, a supported GPU/display backend on Linux, and its Windows native backend. Compilation alone does not prove a working window or GPU. Host CI and native tests own the precise backend/prerequisite evidence.

## Built-in Bun commands

```sh
bun check --no-script
bun fmt --no-script --check
bun test
bun compile --no-script --production ./application.ts --outfile ./application
```

`--no-script` prevents a same-named package script from impersonating the built-in checker, formatter or compiler. TypeScript declarations currently match Bun's stable `1.4.4` API; the actual compiler is the pinned canary. Bun checks types during AOT compilation and rejects invalid source before emitting an executable. AOT targets the platform performing the build; use target-native hosted runners.

| Mode                                            | Purpose                     | Runtime behavior                                   |
| ----------------------------------------------- | --------------------------- | -------------------------------------------------- |
| `bun run`                                       | Development                 | Normal Bun runtime/JIT                             |
| `bun build --compile` or `bun compile --no-aot` | Explicit comparison control | Bundled JavaScript plus JIT runtime                |
| `bun compile`                                   | Production target           | Machine-code application logic and the AOT runtime |

## Native interop evidence and chosen boundary

Run the checked-in [compiler/native probe](../experiments/aot-gpui/README.md). The initial Linux x64 result proves that the actual AOT output can load an OS shared library through `bun:ffi`, call native code, receive a synchronous native callback, and use `Bun.spawn` with piped stdin/stdout and process exit. It also verifies compiler type-error rejection, missing-library failure, an AOT runtime semantic witness, and the actual standalone module graph's `HAS_COMPILED_PROGRAM` flag. The deliberately JIT-compiled control must lack that flag and permit the mutation rejected by AOT. ELF sections and linkage are retained as supporting evidence; `.bun_aot` also exists in the JIT runtime and cannot establish AOT by itself. Raw logs and artifact hashes are generated by the harness.

The shared native host initially uses a separate GPUI process with bounded command/event messages. GPUI retains its own UI main thread, and Bun controls it through the shared typed protocol. The probe establishes that this transport also works from an AOT executable. This is an integration choice, not proof that in-process FFI is impossible. Async FFI callbacks, calls from arbitrary native threads and Node-API are **not yet qualified**. Public adapter APIs must not expose unvalidated pointers or duplicate the native host.

The headless probe does not satisfy the real-window acceptance in #230 or the same-window AOT acceptance in #227. Native rendering, OS input, GPU behavior, per-platform lifecycle, startup/RSS and interactive latency remain separate evidence. An AOT file's name or a successful compilation alone does not qualify it.

Linux artifact inspection additionally checks the compiler's named runtime-feature record: the actual application and AOT interop probe record JIT removal, while the deliberately non-AOT control retains it. The interpreter remains present. See [the source-backed artifact inspection](aot-inspection.md) for raw records, exact source references and unsupported-format limits.

## AOT constraints and optimization

The pinned compiler's own [compatibility documentation](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/compiler/compatibility.mdx) specifies read-only existing built-ins, compile-time module resolution and interpreted runtime-generated strings. These differences affect dependencies and must be tested in the shipped executable. Bun AOT keeps runtime services and garbage collection; GPUI performs native rendering. AOT does not translate JSX/CSS into native widgets or remove the need for adapters.

Use `bun compile --explain=json` to retain slow-path diagnostics. Keep native boundary types narrow and validate runtime input. Evaluate `--trim` and `--disallow-code-generation-from-strings` only with complete executable tests; FFI/native addons can prevent some runtime trimming. Measure process-tree startup, memory and artifact sizes on matched workloads before claiming improvements.

Primary references at the exact compiler revision: [AOT compiler](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/compiler/aot.mdx), [internals](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/compiler/internals.mdx), [compatibility](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/compiler/compatibility.mdx), and [size/trimming](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/compiler/size.mdx).
