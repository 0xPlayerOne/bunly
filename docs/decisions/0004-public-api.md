# ADR 0004 — Owned TS/JS handles and one shared native API

Status: accepted for the experimental BN1 implementation

Date: October 31, 2026

Related: [#228](https://github.com/0xPlayerOne/bun-native/issues/228), [#229](https://github.com/0xPlayerOne/bun-native/issues/229), [#232](https://github.com/0xPlayerOne/bun-native/issues/232), [#253](https://github.com/0xPlayerOne/bun-native/issues/253)

## Context and constraints

The native tree now needs a consumer API for TypeScript, JavaScript and future framework adapters. The owned subprocess in [ADR 0002](0002-owned-native-process.md) keeps GPUI on its native main thread and provides the same transport under Bun development and machine-code AOT. The [security boundary](0003-bridge-security.md) requires independent validation, bounded resource use and explicit ownership. Applications must not manage wire identifiers or compile Rust when their TS/JS source changes.

A native edit can race an application update. An asynchronous application listener can also wait indefinitely while another window closes or receives input. A useful API must preserve those lifetimes and edits without an unbounded event queue, a global callback deadlock or separate native implementations for each framework.

## Options considered

| Option                                                             | Consequence                                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Expose the transport's numeric IDs and command objects directly    | Small initial wrapper, but every consumer must enforce ownership, allocation order, revisions, rollback and callback cleanup. |
| Emulate a browser DOM/CSS surface                                  | Introduces a large unsupported compatibility promise and obscures the actual native element and service boundaries.           |
| Give each framework its own native backend                         | Duplicates rendering, resource ownership and platform service implementations, making behavior and performance drift likely.  |
| Provide one owned native tree API with framework adapters above it | Keeps the transport internal to ordinary consumers and centralizes identity, transaction and callback semantics.              |

## Decision and rationale

Implement `@bun-native/core` as the shared public consumer contract. It depends on the public exports of `@bun-native/protocol` and `@bun-native/runtime`; it does not expose Rust, GPUI, process streams or raw node IDs. `createApplication` accepts an explicit prebuilt native executable, negotiates the protocol and owns one host session. Windows own their element trees.

Handles are immutable typed objects with private runtime identity. TypeScript's private brand prevents ordinary structural construction; a private weak identity map and owning-window lookup reject forged, copied, cross-window and disposed handles at runtime. JavaScript receives the same enforcement. Native IDs are monotonically allocated within the session and never reused, but are not a public authority mechanism.

Expose four initial element kinds: `box`, `text`, `button` and `input`. The typed `Style` contains only supported native layout and appearance properties. Element `set` replaces all properties of the same kind; it cannot convert a node to another kind. The element argument cannot widen the handle's inferred kind. Applications replace a kind by creating a new node and removing the old one. Browser DOM/CSS and privileged desktop services are outside this API.

Publish the negotiated mandatory rendering features through the immutable `app.capabilities` list: `tree` and `input_revisions`. These feature flags confer no OS-service authority. `NativeStateError`, `NativeCommandError` and `ProtocolError` distinguish local lifetime/limit failures, native semantic rejections and protocol validation failures. An unknown element kind raises `UnsupportedFeatureError` with an explicit `element:<kind>` feature name. Unsupported operations do not select another renderer or silently discard properties.

### Transactions and revisions

`window.batch` runs a synchronous candidate-tree callback and sends one bounded atomic batch. All application transactions share one ordered queue so IDs are allocated in the same order as native commits, including across windows. The callback's returned handles become usable after the promise succeeds. A failed callback or native preflight does not commit its candidate mutations, and escaped failed-batch handles do not acquire ownership. A batch object is invalid after its callback returns.

The native model remains authoritative. It rejects stale tree revisions, invalid ownership, cycles, orphaned nodes, root movement/deletion and resource-limit violations before mutation. Application transactions are capped at 128 pending operations, with bounded reserved capacity for close. Negotiated wire limits separately bound each batch and retained model. A successful acknowledgement means the native state committed, not that pixels were presented.

Each accepted tree batch advances its window's tree revision once. Native input edits advance only that input's revision. An explicit input replacement requires its current observed revision and advances it even when the replacement text is equal. This allows unrelated label changes during typing and rejects delayed input snapshots. Framework adapters must not echo an unchanged native edit as a controlled replacement; a stale replacement is a decision for the application, not an automatic retry with stale data.

### Event ingestion, application callbacks and cancellation

The transport validates a monotonic native event sequence for the session. Core ingests events independently of application callbacks: input state and OS-close revocation are applied before scheduling listeners. Asynchronous listener work therefore does not prevent another window's state or lifetime from being ingested.

Application callbacks execute globally in event order, one at a time. There are at most 128 pending callbacks plus one active callback. This preserves predictable ordering and bounds retention. A full queue or callback failure ends the failed session rather than hiding lost events or accumulating an unbounded backlog. CPU-heavy synchronous code still blocks Bun's event loop; this design only separates native ingestion from awaiting asynchronous listener completion.

Each listener registration owns an `AbortController`. A queued job stores the event, owner identities and that registration's signal; it does not retain the listener closure. Unsubscribe, replacement, subtree disposal, window close and shutdown abort the registration and purge its queued jobs. Dispatch races an asynchronous callback against revocation, then removes its abort subscription. Old unsubscribe functions are paired with their original registration and cannot remove newer listeners, including reentrant registration from an abort handler.

The signal is cooperative cancellation for application work. It cannot kill an arbitrary promise, reclaim references retained by user code or roll back external side effects. Consumers pass it to cancellable operations and check it before applying delayed results. The framework releases its dispatch ownership even if a revoked callback never resolves.

`window.close()` immediately revokes listeners and then requests native removal through the serialized queue. It is idempotent. `app.shutdown()` revokes the application and joins the owned native process; it may be awaited inside a callback. `app.closed` also joins ingestion and dispatch, so consumers await it outside that callback. Normal shutdown leaves all public ownership/queue diagnostics at zero.

## Shared adapters and versioning

SolidJS in BN2 and React in BN3 will translate their framework operations into this same owned tree, batching and listener contract. Neither adapter is implemented by this ADR. Native widgets, layout, text input, event sequencing and future platform services remain shared. Adapter-specific scheduling must not weaken ownership or input revision checks.

The core package is currently a private workspace package at `0.0.0`. Protocol 2 deliberately replaces the BN0 fixture protocol; no legacy compatibility layer is retained. Pin the packages, native host and toolchain to a tested revision during this phase. A protocol handshake rejects incompatible versions before an application opens a window. Stable release/API compatibility guarantees belong to later release readiness, with explicit migration documentation when that policy is established.

## Implementation consequences

- The public surface stays small: application/window ownership, opaque nodes, bounded batches, input snapshots, typed events and cleanup. The transport and native model continue validating independently.
- TypeScript and checked JavaScript consume identical package exports. Type fixtures prove allowed and disallowed calls without creating a display; real native fixtures establish separate runtime behavior.
- Candidate-tree copying and globally serialized callbacks are deliberate initial costs. [The bridge benchmark](../../benchmarks/BRIDGE.md) measures actual acknowledgement/preflight behavior and disposal; it does not assume these choices are optimal or equate acknowledgements with presentation.
- Element styling is a finite native contract. There are no HTML/CSS compatibility shims, implicit browser resources, service self-grants or framework-specific native backends.
- Long-lived work must cooperate with `AbortSignal`. Queue bounds and zero diagnostics do not prove absence of native allocator, driver or GPU leaks.

## Validation and remaining scope

[Core lifecycle tests](../../tests/core/lifecycle-edge.test.ts) use a real child process with an explicitly simulated protocol peer. They cover OS-close event ingestion while a listener waits, sibling state progression, global callback order, overflow, disposal, late events and reentrant listener replacement. Their scope is headless protocol/lifecycle behavior, not OS input or rendering.

[The TypeScript fixture](../../tests/types/public-api.ts) checks consumer types, including rejected kind changes, manufactured handles and missing input revisions. [The JavaScript fixture](../../tests/native/javascript.js) uses the public API to create a native tree, replace an input with its observed revision, react to native click/input events, and dispose the application. A successful type check alone does not qualify either native consumer. Its separate Linux X11 development runs passed actual pointer-driven updates, typing, full native paint assertions and OS close, with a software GPU and no remaining observed processes. This is a bounded interaction result, not a hardware, AOT or leak-free qualification.

The native suite separately records actual GPUI paint traversal, OS-delivered pointer/keyboard input, exact Bun/native artifact hashes and clean shutdown. Development and machine-code AOT runs are distinct. Consult [testing](../testing.md), the [native host limitations](../../native/gpui-host/README.md) and the implementation PR for executed platform evidence. Linux X11 with a software GPU does not establish Wayland, physical GPU, macOS/Windows interaction, complete IME or accessibility support. Those acceptance criteria remain explicit follow-up work; no unsupported feature silently falls back to a browser.
