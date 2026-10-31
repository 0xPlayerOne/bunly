# Getting started with Bun Native

**Bun Native currently provides a working native integration fixture, not an installable general-purpose framework.** Contributors can run the real GPUI window and compile its Bun application with AOT. Solid/React adapters, a public app CLI and supported release packages are still being implemented.

## Start with the current implementation task

1. Read the [vision](bun-native-vision.md), [architecture](architecture.md), [engineering-quality policy](engineering-quality.md) and [roadmap](https://github.com/0xPlayerOne/bun-native/issues/1).
2. Read the [implementation handoff](bun-native-handoff.md) and inspect [BN0 #217](https://github.com/0xPlayerOne/bun-native/issues/217). Source migration #251 and toolchain #225 are merged; the current task is the earliest uncompleted dependency, not another rewrite of those foundations.
3. Inspect the current checkout/branch and any existing PRs. Do not assume obsolete Bun 1.4.4 versions, M1 tests or CEF run commands apply to the new framework.
4. Open a draft PR with the first useful change, push continuously, run focused tests and enable auto-merge when repository checks permit. No routine human design checkpoint is required.

## Toolchains

You need the exact pinned Bun, a matching target OS/architecture, Rust/native prerequisites for **framework contributors**, and GitHub-hosted CI or a native desktop for verification. `toolchain.json` and `rust-toolchain.toml` are the implemented pins. Linux X11 with Mesa software Vulkan is the first verified GUI environment; other platforms must be qualified explicitly.

The **new** developer command contract (create/dev/build/test/doctor) is designed in [BN5 #242](https://github.com/0xPlayerOne/bun-native/issues/242) and **does not exist yet**. Avoid showing fictional install commands or framework imports as runnable examples.

To learn the compiler interface, see the official [Bun compiler documentation](https://bun.com/docs/compiler) and [AOT compatibility](https://bun.com/docs/compiler/compatibility). `bun compile` differs from `bun build --compile`: the latter is an ordinary bundled JIT executable and is not accepted as a Bun Native production AOT proof.

## Run the implemented foundation checks

The exact compiler source, artifact checksums and Rust/GPUI versions are in
`toolchain.json`. Install the pinned Bun without relying on a rolling canary:

```sh
node scripts/install-bun.mjs --destination "$PWD/.bun-native/toolchain"
export PATH="$PWD/.bun-native/toolchain:$PATH"
bun install --frozen-lockfile
bun run check
cargo test --locked --manifest-path Cargo.toml -p bun-native-protocol
```

The destination must be an absolute path. On Windows use an absolute Windows
path and prepend it to that shell's PATH. The installer verifies the platform
archive SHA-256 and the executable revision. Rust contributors use the exact
`rust-toolchain.toml` pin. These checks cover protocol, source and architecture;
the [integration record](bn0-integration.md) distinguishes GUI/AOT evidence from remaining gaps.

## Run the real native window

Install the platform prerequisites from [the native host README](../native/gpui-host/README.md). The exact Ubuntu build/display package list is in `.github/workflows/native-linux.yml`. Framework contributors build the host explicitly:

```sh
cargo build --locked -p bun-native-host
BUN_NATIVE_HOST="$PWD/target/debug/bun-native-host" \
  bun examples/native-window/main.ts
```

Run this in a desktop session, or use the isolated X11 command in [testing](testing.md). Click Increment, type in the input and close through the window manager. Ordinary TypeScript edits rerun the example with the same prebuilt host; they do not compile Rust.

## Compile that application with AOT

Build an optimized native host once, then compile the application separately:

```sh
cargo build --locked --release -p bun-native-host
bun experiments/aot-gpui/build-window.ts \
  --host "$PWD/target/release/bun-native-host" \
  --host-profile release --outdir "$PWD/.bun-native/app"
BUN_NATIVE_HOST="$PWD/.bun-native/app/bun-native-host" \
  .bun-native/app/native-window
```

The output directory must be empty. The recipe checks the exact compiler, inspects the compiled-program metadata and records both executable hashes, source hashes and linkage in `manifest.json`. On Windows native executable filenames use `.exe`; Windows GUI/AOT packaging is not qualified by the Linux record. This recipe creates experimental executables, not a signed installer. GUI verification remains an explicit run against the produced artifacts.

## First actual app acceptance

The first example, owned by #230 and #227, must:

- Launch a **real native GPU/OS window**, with text, a button and editable input, controlled by Bun-authored TypeScript.
- Send click/keyboard/focus events through the native bridge, update visible UI, close cleanly and repeat without leaked callbacks.
- Run under normal Bun development mode and a separately verified machine-code AOT executable built from the same source.
- Record OS/CPU/GPU, Bun and native renderer revisions, source commit, exact command, artifact bytes, memory/startup measurements and failures.
- Contain no Chromium, CEF or system WebView UI fallback.

Do not wait for a human feasibility vote if interop fails. Reproduce, fix or take another genuinely native implementation route and keep building.

## Test locations

Use GitHub Actions Linux/Windows/macOS runners first. For actual macOS GUI, keyboard, text/IME or accessibility testing that hosted runners cannot prove, discover the owner's connected Mac through Remote Desktop Commander. Keep temporary work bounded and avoid persistent Docker/VM disks on the Mac. Label unavailable physical tests **unsupported**, never passed.

## After BN0

- [BN1](https://github.com/0xPlayerOne/bun-native/issues/219): typed native bridge and public API.
- [BN2](https://github.com/0xPlayerOne/bun-native/issues/218): SolidJS renderer.
- [BN3](https://github.com/0xPlayerOne/bun-native/issues/221): React renderer.
- [BN4](https://github.com/0xPlayerOne/bun-native/issues/222): shared native primitives, OS capabilities and accessibility.
- [BN5](https://github.com/0xPlayerOne/bun-native/issues/220): supported app authoring CLI, fast reload, CI.
- [BN6](https://github.com/0xPlayerOne/bun-native/issues/223): native packages, updates, rollback.
- [BN7](https://github.com/0xPlayerOne/bun-native/issues/224): real app compatibility, performance and public documentation.

An agent assigned any later milestone should verify prerequisites and implement missing dependencies itself rather than ask the owner for a checkpoint.
