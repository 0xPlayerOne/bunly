# Private native protocol 2

This crate defines the shared host wire contract and atomic tree model. Public
application APIs live in TypeScript packages; applications and framework
adapters do not depend on Rust, GPUI types or raw JSON commands. Protocol 2
replaces the BN0 fixed-window protocol outright.

## Framing and errors

Each direction is UTF-8 JSON followed by one LF. A payload is at most 65,536
bytes excluding LF; CRLF is accepted as JSON trailing whitespace. Invalid UTF-8,
BOMs, empty lines, truncated EOF, invalid JSON, unknown fields and malformed
commands poison the channel. The host emits a terminal `invalid_command` error
when possible and exits. EOF is terminal even if a caller supplies a new reader.
Decoding first builds a bounded JSON value, then validates its typed shape.
Duplicate keys use the last value, matching JavaScript `JSON.parse`. Integral
number spellings such as `1.0` and `1e0` follow JavaScript safe-integer semantics.

Structurally valid requests that fail a lifecycle, ownership, revision or
resource rule receive `error` with the request ID and a finite code:
`invalid_command`, `version_mismatch`, `invalid_state`, `invalid_handle`,
`stale_revision`, `limit_exceeded` or `native_failure`. Such errors do not
partially mutate a window. The session may continue with a newer request ID.
Unexpected native window creation/update failures never become successful
responses.

## Session and identifiers

The first successful request is `hello` with `protocol: 2`. It returns `ready`
with capabilities `tree` and `input_revisions` plus the limits below, then `ack`.
Another hello after success is invalid. `open` requires a new `window_id`, new
`root_id`, a nonempty title, and width/height in pixels. It returns `opened` with
those IDs and tree revision 0. The initial root is an empty box.

IDs are positive safe integers, at most 9,007,199,254,740,991. Request IDs increase
for every structurally valid request, including rejected requests. Window IDs
increase across successful opens. Node IDs increase across successful opens and
batch creates **across every window in the session**. Allocate node IDs at
serialized commit time; creating detached adapter objects must not reserve wire
IDs in an order that can later be submitted out of sequence. Failed batches do
not advance the node high-water mark. Deleted/closed IDs cannot be reused, so
stale-handle protection needs no unbounded tombstone set.

`close` names a window and returns `ack`. `closed` comes from actual native
window destruction. A new window can be opened with fresh IDs afterward.
`shutdown` revokes all windows and flushes `ack` before the process exits.

| Resource                                      |            Limit |
| --------------------------------------------- | ---------------: |
| Active windows per session                    |               16 |
| Nodes per window, including root              |            4,096 |
| Operations in one batch                       |              256 |
| Tree depth, edges from root                   |               64 |
| Title UTF-8 bytes                             |              256 |
| Each text/label/value/placeholder UTF-8 bytes |           16,384 |
| Aggregate text UTF-8 bytes per window         |        4,194,304 |
| Window width or height                        | 64–16,384 pixels |

Titles reject control characters. Text rejects NUL. The aggregate budget counts
text nodes, button labels, input values and placeholders, and is released on
replacement/deletion. Sixteen windows therefore retain at most 64 MiB of model
text; native shaping, renderer and GPU allocations are separate costs. Native
edits are additionally rejected before mutation if JSON escaping would make the
resulting input event exceed its frame budget. Native limits and GPU availability
can reject a window even when its requested size is within the wire bounds.

## Atomic tree batches

`batch` provides `window_id`, `base_revision` and 1–256 operations. It succeeds
only if the base matches the current tree revision. The host validates a
candidate tree and applies it synchronously on the UI thread, then returns
`applied` with the next revision. Every successful batch advances the revision
exactly once, including an explicit update whose properties are unchanged.

| Operation | Fields and behavior                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `create`  | `node_id`, `element`; creates a detached node within this transaction                                     |
| `set`     | `node_id`, `element`, input-only `expected_input_revision`; replaces all properties without changing kind |
| `insert`  | `parent_id`, `child_id`, `index`; reparents/reorders, with index measured after detaching the child       |
| `delete`  | `node_id`; removes the node and its complete subtree                                                      |

Only boxes own children. A committed tree has no orphans, cycles, duplicate
ownership or cross-window references. The root cannot be deleted or reparented;
close its window instead. Intermediate detached nodes are allowed while a batch
is being assembled, but the final graph must connect every retained node to its
window root. Node/text limits also bound intermediate candidate state; at
capacity, delete old content before creating its replacement in the same batch.

Elements use `kind`:

| Kind     | Properties                                                |
| -------- | --------------------------------------------------------- |
| `box`    | optional `style`                                          |
| `text`   | `text`, optional `style`                                  |
| `button` | `text`, optional `disabled` (false), optional `style`     |
| `input`  | `value`, optional `placeholder` (empty), optional `style` |

Style is one shared explicit contract: `direction` is `row` or `column`;
`gap`/`padding` are 0–4,096 pixels; `width`/`height` are 0–16,384 pixels or
`fill`; `flex_grow` is 0–1,000; `background`/`color` are unsigned 24-bit RGB;
`font_size` is 1–512 pixels. Numbers must be finite. Omitted properties use host
defaults; null values and unknown properties are rejected. Validation retains
f64 precision and converts to renderer pixels afterward. `set` replaces the
entire property object; it is not a partial merge.

## Input and event ordering

New inputs start at input revision 0. An accepted native content edit advances
that input revision and emits `input` with `window_id`, `node_id`, `value` and
`input_revision`. Unchanged content and selection-only changes do not advance
it. Typing does not advance the tree revision. An explicit input `set` requires
the current `expected_input_revision` and advances it once, even if the value
is equal. A stale controlled value replacement rejects the whole batch.

`click`, `input` and `closed` carry a monotonically increasing `sequence` shared
by all windows. Responses (`ready`, `ack`, `opened`, `applied`, `error`) do not.
Consumers use IDs and sequence to discard late work after disposal. Native input
callbacks independently verify active ownership, so retaining an old callback
cannot recreate a node. Callbacks and executable scripts never cross this wire.

## Verification

`cargo test --locked -p bun-native-protocol` checks framing, strict schema,
resource bounds, atomic rollback, stale/cross-window IDs, reparenting, disposal,
input revision races, and the shared adversarial fixture corpus. The crate has
no renderer dependency. These are headless tests; actual GPUI rendering, OS input,
native resource cleanup and Bun AOT need the separate native integration lane.
