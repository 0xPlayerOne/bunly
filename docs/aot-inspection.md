# Inspecting the Bun AOT executable

The Linux BN0 application contains a compiled-program record and records the JIT compiler as removed. Its JavaScript interpreter remains present. These are separate properties: an AOT flag alone does not establish JIT omission, and JIT omission does not establish that every possible runtime-generated string is rejected.

## Source-backed interpretation

All source references below use Bun revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`, matching `toolchain.json`.

- [`engine.def`](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/trim/features/engine.def#L1-L11) declares JIT, interpreter, built-in source text and image compiler in that order. The [feature generator](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/scripts/build/trim/features.ts#L253-L277) numbers engine features from zero.
- [`all_outside_compiled_programs`](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/trim/removable_features/lib.rs#L137-L142) includes the JIT and command-line compiler tools. The [default retention decision](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/trim/decide.rs#L163-L178) excludes these even without `--trim`, unless a used feature requires them. Therefore inspection must check the emitted executable, not assume all AOT programs have the same retained runtime.
- The [removal-state layout](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/trim/removable_features/state.rs#L8-L35) is a 536-byte record in the named `.bun_features` ELF section. Its 512 feature bytes start at offset 24. The [state enum](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/trim/removable_features/lib.rs#L30-L36) defines zero as present, one as unused and two as explicitly requested removal.
- The [image rewrite](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/trim/apply.rs#L33-L80) removes relocations, fills uncut removed regions with traps or zeroes, cuts removable file ranges, and records the decision. The [state-writing code](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/trim/apply.rs#L347-L369) writes each feature's removal value. The general trim flag can remain zero when only compiler tools and the JIT are removed; it is not a substitute for reading the feature bytes.

## Actual artifact records

The checked [Linux records](../experiments/aot-gpui/evidence/linux-runtime-features.json) retain each full feature-state record as hex, executable hashes, section locations, module-graph inspection, source links and raw linkage/section output. The application is the same `examples/native-window/main.ts` used for native interaction qualification; its source manifest records the exact files and the dirty development checkout that produced this initial artifact.

| Artifact                          |       Bytes | Compiled program | JIT               | Interpreter | Image compiler    |
| --------------------------------- | ----------: | ---------------- | ----------------- | ----------- | ----------------- |
| Native-window AOT application     |  70,712,360 | Yes              | Removed as unused | Present     | Removed as unused |
| AOT FFI/subprocess probe          |  70,646,824 | Yes              | Removed as unused | Present     | Removed as unused |
| Explicit `--no-aot` probe control | 140,356,264 | No               | Present           | Present     | Present           |

The application hash is `e18c83bf2466a6c78665f708a3c8b2289da3961d74e630b408a9c5527b7fea9c`. Its feature record identifies 27 removed JIT ranges totaling 14,297,303 virtual-address bytes. These are compiler-recorded address ranges, not a measurement of physical memory, executable size savings, or startup improvement. The control contains no removed-range records.

The application package contains the AOT application and an explicitly supplied GPUI host executable. The initial host has hash `70f3ff32af786f2776fa9a58785795b4435df9124d7c3b28923013371a168c66` and was built with the Cargo development profile. A release-profile host is qualified separately; this record must not be presented as a release performance baseline. The retained ELF linkage output identifies the system dynamic loader and libraries for each executable. The application embeds Bun's runtime and compiled program; it does not rely on a separately installed Bun executable at launch.

## Reproducible checks and limits

`experiments/aot-gpui/run.ts` compiles and executes the same interop source in development, AOT and deliberately non-AOT modes. On Linux it requires JIT removal records in AOT and a present JIT in the control. `build-window.ts` applies the same removal check to the actual application and records the result in its manifest. Both retain the interpreter state explicitly.

`inspect-runtime.ts` locates the section through the ELF64 section table, rather than searching for a magic string anywhere in the file. It rejects missing or duplicate feature sections, truncated and overflowing ranges, unknown removal states, invalid record sizes, and missing or ambiguous removed-range tables. Synthetic tests exercise malformed metadata; separately compiled real executables establish the AOT/control result. This is a decoder for the pinned compiler's artifact contract, not a general-purpose executable security validator.

The runtime-feature decoder currently qualifies little-endian Linux ELF64 only. Mach-O and PE builds report the JIT check as unimplemented. An interpreter retained for dynamic code is not a JIT fallback; Bun's [compatibility contract](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/compiler/compatibility.mdx) describes runtime-generated strings as interpreted. The evidence here does not claim arbitrary unseen JavaScript is AOT-compiled, that interpreter entry is impossible, or that hardware GPU, macOS, Windows, signing and installation have been qualified.
