# Bun Native provenance and third-party code

This file is the active provenance policy for the new Bun Native implementation. The prior Bunly/CEF source inventory and historical M1/M2 decisions are retained in Git history, not active architecture guidance.

## Rules

- Preserve upstream copyright notices, license requirements and attribution when copying or adapting GPUI, Zed, other native rendering source, framework adapters, dependencies, examples or benchmark fixtures.
- Inspect licensing and binary redistribution requirements before importing a crate, package, asset or prebuilt native library. Track exact upstream project, revision, license, copied files and local changes.
- Do not represent competitors' implementation or benchmarks as original Bun Native work. Comparable benchmark runs must be independently reproduced under the documented workload.
- Remove provenance entries for code **no longer shipped** from the active inventory when old Bunly/CEF code is deleted, while preserving historical evidence in Git history.
- Reconcile [LICENSE](../LICENSE), [NOTICE](../NOTICE) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) with actual native artifacts before distribution.
- Keep credentials, signing keys, personal machine paths and third-party private code out of the repository.

## New source inventory

| Component                | Upstream/revision                                                                                                                                                                                | License                                      | Files or binaries used                            | Changes                                                                                       | Shipped target               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| Native editable input    | [Zed GPUI input example](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/examples/input.rs), revision `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d` | Apache-2.0                                   | `native/gpui-host/src/input.rs`, `input/paint.rs` | Bounded text, native event transport, explicit command updates, source split and key bindings | Experimental GPUI host       |
| GPUI and platform crates | Same pinned Zed revision; resolved dependency graph in root `Cargo.lock`                                                                                                                         | Upstream crate licenses                      | Linked native renderer and platform dependencies  | Consumed as source dependencies; no vendored fork                                             | Experimental GPUI host       |
| Bun compiler/runtime     | `da867c60bf0bcbf9d6d36994f8ca0efa42075115`; exact asset IDs and hashes in `toolchain.json`                                                                                                       | Upstream Bun and bundled dependency licenses | Pinned compiler and emitted AOT runtime           | Application compilation and metadata inspection; no runtime source fork                       | Experimental AOT application |

The adapted input retains its source headers, [NOTICE](../native/gpui-host/NOTICE)
and full [Apache license](../native/gpui-host/LICENSE-APACHE). The native package
declares `MIT AND Apache-2.0` because it combines project source with that
adaptation. Cargo and Bun locks record exact dependencies; a complete
redistribution notice bundle for every linked crate/runtime remains part of
BN6 packaging. Do not describe the experimental two-executable fixture as a
completed licensed/signed public distribution.

See [architecture](architecture.md), [releasing](releasing.md) and [BN7 docs/provenance #254](https://github.com/0xPlayerOne/bun-native/issues/254).
