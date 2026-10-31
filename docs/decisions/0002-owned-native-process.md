# ADR 0002 — Own a separate GPUI process

Status: accepted for BN0; extension and performance audit in BN1

Date: October 31, 2026

Related: #225, #230, #227, #228, #229, #232, #252

## Context

Application code must execute in Bun during development and in the actual Bun machine-code AOT executable for production. GPUI must own its native UI thread. Ordinary application edits must use a prebuilt native artifact without invoking a Rust compiler. The host must remain shared by future Solid and React adapters.

The pinned Bun compiler successfully executes real `bun:ffi` calls, a synchronous JavaScript callback and an owned subprocess round-trip in both development and AOT modes. Those experiments do not prove that a GPUI event loop can safely share Bun's main thread, or that arbitrary-thread asynchronous FFI callbacks have the required lifetime semantics. No Node-API integration has been qualified.

## Decision

Launch one versioned Rust GPUI executable as an owned child of each runtime session. Use its stdin/stdout exclusively for validated JSON-lines commands and events; use stderr for bounded diagnostics. There is no listening network endpoint or shared global host. GPUI runs on the child's main thread, with separate bounded reader/writer queues. The TypeScript process owns application state, request deadlines and child shutdown.

The initial protocol negotiates version 1, caps each UTF-8 JSON payload at 65,536 bytes, and rejects unknown fields, invalid IDs, malformed UTF-8, oversized frames and truncated EOF. The runtime bounds pending requests and unconsumed events at 128 each. Native reader and writer queues hold at most 64 and 256 messages respectively. These counts are upper bounds, not zero-copy guarantees; BN1 must measure queued bytes and retention under load.

The native UI thread uses nonblocking output enqueue. Saturation terminates the failed session instead of blocking input indefinitely. Command acknowledgement means the mutation was accepted on the UI thread; it does not mean a frame was presented. Tests distinguish an application's input event, the native paint callback and a captured screenshot.

GPUI uses explicit quit mode. Closing the final window emits `closed` but leaves the session available for an orderly shutdown or another window. Bun sends `shutdown`, waits for its acknowledgement and process exit, and kills/reaps its own child if the bounded deadline expires. Unexpected exit, malformed output, invalid acknowledgement, queue overflow and startup timeout reject outstanding work and clean up ownership.

## Consequences and alternatives

- A second process, JSON encoding and a native event loop have real memory and crossing costs. They provide clear thread ownership and a useful crash boundary; they do not make application code sandboxed. Startup/RSS observations are recorded in the integration report, with comparable per-call and batch measurements required in BN1.
- An in-process FFI or Node-API host could reduce serialization and process overhead. It would require demonstrated main-thread scheduling, callback disposal and compatible AOT lifetime behavior. Keep the small FFI interoperability probe; do not maintain a second public renderer implementation without measured justification.
- The host artifact and application binary are separate files. Build manifests record exact hashes, target, compiler revision and the caller-declared host profile. The manifest alone does not prove native provenance or successful GUI execution; CI must match the artifact hashes to its actual native build and input reports.
- Native input owns in-progress edits. A real typing test found that echoing every asynchronous input snapshot back into the widget loses newer keystrokes. The fixture now sends only intentional counter-label changes. BN1 must add input revisions before claiming controlled inputs are safe under event backlog.
- The fixture exposes only its window, button and editable input. It is not an OS capability broker. Bun application code already has ordinary process/filesystem authority; no untrusted script is executed in the native host. Clipboard shortcuts are native user actions. Untrusted content, grants, revocation and future OS services require the BN1 security contract.

## Validation and remaining scope

Real Linux X11 tests use GPUI with Mesa llvmpipe, XTest-delivered pointer/keyboard input, correlated event and paint records, screenshots and owned-process teardown checks. The same source runs in Bun development and the inspected machine-code AOT executable. Headless protocol tests separately cover malformed frames and runtime failure behavior.

See [the integration record](../bn0-integration.md) for exact versions, artifacts, commands and observed failures. This decision does not qualify a physical GPU, Wayland, macOS/Windows GUI, IME, accessibility, a reusable component tree, signed packages or an ABI compatibility promise. Those remain explicit implementation work.
