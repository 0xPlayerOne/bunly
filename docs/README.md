# Bun Native documentation

This directory documents the **new native Bun + AOT desktop framework**, not the retired Bunly/CEF implementation.

**Current state:** the clean workspace, native-process runtime and GPUI window are implemented. The same application has passed Linux X11 input and teardown checks under Bun development and machine-code AOT, using a software GPU. Release-profile CI, measured baselines and the framework/platform roadmap retain their own acceptance. The [BN0 integration record](bn0-integration.md) lists exact evidence and current limits.

## Product and architecture

1. [Product vision](bun-native-vision.md) — user promise, differentiators and non-goals
2. [System architecture](architecture.md) — packages, native host, event lifecycle, renderers and security boundaries
3. [AOT and toolchain](toolchain.md) — Bun compilation, native artifacts and compatibility
4. [Compatibility](compatibility.md) — native UI features, Solid/React, web APIs and platform status
5. [Architecture decisions](decisions/README.md) — decisions, alternatives and recorded tradeoffs

The [BN0 implementation handoff](bun-native-handoff.md) records source removal, current checks and next actions.

## Build and operate

6. [Getting started](getting-started.md) — first contributor steps and what does not work yet
7. [Development workflow](development.md) — intended project CLI, edit loop and implementation responsibilities
8. [Testing and validation](testing.md) — hosted CI, connected Mac native checks and evidence
9. [Benchmark design](../benchmarks/README.md) — performance fixtures, comparators and raw measurements
10. [Releasing](releasing.md) — native AOT targets, installers, signing, updates and rollback

## Code quality and project operations

- [Engineering quality and optimization](engineering-quality.md) — required audits every PR, every phase and before release
- [Provenance](provenance.md) — licensing, copied code and attribution
- [Agent contract](../AGENTS.md) and [Contributing](../.github/CONTRIBUTING.md)
- [Roadmap issue #1](https://github.com/0xPlayerOne/bun-native/issues/1) and [BN0–BN7 epics](https://github.com/0xPlayerOne/bun-native/milestones)

## Historical Bunly material

The previous CEF/WebView architecture, benchmark reports, M1–M12 qualification records and experimental APIs are **superseded**. They are available in [Git history](https://github.com/0xPlayerOne/bun-native/commits/main/) and historical tags, but do not belong to the active Bun Native docs. Prior results do not qualify the new native runtime.

Please link new implementation evidence to its BN issue/PR with exact compiler version, OS/CPU, build mode, source SHA, commands, failures and unsupported paths. Never describe a planned capability as shipped.
