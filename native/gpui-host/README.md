# GPUI native host

This binary owns the native UI event loop and GPU renderer. The Bun application
owns application state and sends commands over its private child-process pipes.
The host has no browser, web server or second JavaScript engine.

## Build and run

Framework contributors build the pinned host explicitly:

```sh
cargo build --locked -p bun-native-host
BUN_NATIVE_HOST="$PWD/target/debug/bun-native-host" \
  bun examples/native-window/main.ts
```

Normal TypeScript edits rerun Bun and reuse this binary. They do not invoke Cargo.
Production application compilation is a separate `bun compile` step; a Rust host
build does not establish Bun AOT acceptance.

Rust is pinned in the repository toolchain file. GPUI and `gpui_platform` come
from Zed revision `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d`. One root Cargo
workspace and lockfile cover the protocol and renderer. The fast CI lane selects
`-p bun-native-protocol`; the native lane builds and tests the actual GPUI host.
For an optimized host, use `cargo build --locked -p bun-native-host --release`
and select `target/release/bun-native-host` explicitly.

Linux requires development libraries for fontconfig, FreeType, Wayland and
xkbcommon/X11, plus a working Vulkan device or software implementation. The
X11 acceptance harness additionally needs Xvfb, Openbox, xdotool, ImageMagick,
DBus and fonts. A software-rendered X11 window proves the native rendering/input
path; it does not qualify physical GPU performance or physical keyboard/IME.

## Ownership and protocol

All GPUI entities, windows and text mutation stay on the main thread. One input
worker parses bounded UTF-8 JSON lines; its 64-command queue applies backpressure
to the pipe. One output worker drains a 256-event queue, keeping stdout writes
off the UI thread. An unresponsive output consumer terminates the UI session
when the queue fills rather than allowing unlimited retained events.

`bun-native-protocol` owns the [private v2 contract](../protocol/README.md).
Protocol 2 replaces the fixed BN0 window fixture; there is no v1 decoder. The
session owns up to 16 windows, each with one box root and at most 4,096 nodes.
Atomic batches create, update, reparent, reorder and delete box, text, button
and input elements. All adapters use this same model and renderer. Neither
Solid nor React introduces a second native implementation.

Request, window and node IDs are positive JavaScript-safe integers and increase
across the session in separate namespaces. A deleted node or closed window ID
is never reused. Failed batches leave both the model and node allocation
high-water mark unchanged. Preflight validates the complete candidate tree
before a synchronous GPUI update; it does not yield between validation and
commit. Immutable property payloads share `Arc` storage while graph links are
cloned. Opt-in batch evidence records preflight time, operations, nodes and
retained text bytes so this strategy can be measured.

The native view retains input entities by node ID. Their callbacks hold weak
model references and check that the window is active and still owns the node.
Deletion removes the entity and clears its focus. Closing revokes its model
before entity destruction. Button callbacks also check current ownership and
disabled state, including callbacks retained from the previous rendered frame.
Pointer activation and focused Enter/Space use the same event path.

Native text changes advance only the affected input revision. Every explicit
input `set` must present its current revision, so a delayed app update cannot
overwrite newer native keystrokes. Tree revisions advance once per committed
batch; unrelated label updates are not invalidated by typing. All native UI
events share one monotonic session sequence. Text editing uses GPUI's native input-handler API,
UTF-16/UTF-8 range conversion, grapheme navigation, selection, clipboard and
composition state. The presence of those handlers is not a claim that every OS
IME, assistive technology or input method has passed testing.

GPUI uses explicit quit mode on every OS, so closing the final window cannot
race Bun's shutdown command. The actual window-close observer emits `closed`.
Shutdown revokes all models, flushes its final acknowledgement, then quits.
Malformed or oversized frames end the channel; valid commands that violate
ownership, revision, lifecycle or resource limits receive typed errors.

Input does not yet scroll horizontally when text exceeds its field.
Full input values are retained and delivered to Bun, while long visual content
clips at the window edge. Scrolling and complete text/IME/accessibility
qualification belong to BN4 #241. General Tab navigation, focus rings and
platform widget accessibility semantics are also still unqualified.

## Evidence

The OS-input harness supplies `BUN_NATIVE_EVIDENCE_LOG` and
`BUN_NATIVE_EVIDENCE_NONCE`. With both set, a GPUI paint callback appends changed
native state as nonce-tagged `rendered` events with `stage: "native-paint"`,
window/tree revisions and complete node snapshots. Unchanged tree/input revision
states are deduplicated. Evidence records are capped at 65,536 bytes; a larger
snapshot produces an explicit `status: "omitted"` record with the reason
`evidence_record_limit`, never a partial snapshot that could satisfy an assertion.
Batch timing and actual window GPU adapter metadata are separate records.
The Bun fixture separately records delivered native input and application state.
Paint traversal alone is not display presentation: the harness must also capture
the actual window and correlate OS input with the expected painted state.
Instrumentation performs bounded serialization and file I/O on the UI thread;
performance reports must distinguish instrumentation enabled from disabled.

Headless protocol tests, successful compilation, X11 software rendering and
physical native GUI verification are distinct evidence levels. Consult the PR
and repository testing documentation for the checks actually executed.

## Source attribution

The editable-input implementation is adapted from the pinned GPUI example and
retains its Apache-2.0 provenance in `NOTICE` and `LICENSE-APACHE`. Bun Native adds
bounded values, IPC events, command-driven state and separates painting from
editing. Other host code is covered by the repository MIT license.
