# Third-party inventory

The root package manifest and `bun.lock` record development dependencies. They
are not application runtime dependencies. Their license notices remain with
their distributions. Code Foundry's retained maintenance templates and managed
policy blocks carry the attribution in [NOTICE](NOTICE).

Native dependencies and exact versions belong in the root `Cargo.lock`. The
native editable-input implementation adapts the pinned GPUI example and retains
its Apache-2.0 source headers, `native/gpui-host/NOTICE` and full license text.
The native host's pinned source inventory is maintained in
[docs/provenance.md](docs/provenance.md).

The removed Bunly code, CEF integrations, Electron/Electrobun comparison apps,
xterm fixtures and historical notices remain recoverable in Git history before
the BN0 workspace rewrite. None is shipped by this workspace.

Before distributing Bun or native host binaries, include the notices required
by their actual dependency and asset inventories. A development build does not
constitute a completed redistribution, signing or security review.
