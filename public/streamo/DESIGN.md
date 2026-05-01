# Stream — Design Notes (rebuild-1)

## The goal

A personal signed stream of thoughts and information. After signing in, you make
changes to your data and anyone subscribed to your stream gets live updates. Viewers
see the same thing you see but with non-interactive controls. The stream is
cryptographically yours — signed with your key, verifiable by anyone.

## What the previous implementation got right

- **Append-only, content-addressable storage.** Same value always lands at the same
  address. This makes diffing trivial (compare addresses), deduplication free, and
  sync simple (just send new bytes).

- **Negative addresses for primitives.** `undefined`, `null`, `false`, `true`, and
  small integers (UINT7) are fully described by a single footer byte. Using
  `-(footer + 1)` as their address means every value is addressable without
  appending to the store. This arrived late in the previous version; it belongs
  at the foundation.

- **Footer-based self-describing codec.** The last byte of any code identifies its
  type. Multi-part values pack which storage option was chosen for each part into
  the footer as a mixed-radix offset. Compact and self-contained.

- **Recaller.** Fine-grained reactive dependency tracking with path-level
  granularity. Worth keeping essentially as-is.

- **The class hierarchy.** Addressifier → codec layer → reactive layer → signed
  layer is a clean separation of concerns.

## What I'd do differently

- **Hide Duple.** The balanced binary tree encoding of arrays and objects is an
  implementation detail. Exposing `Duple` in the public API (users can encode and
  decode `Duple` instances directly) leaks the internal representation. I'll keep
  the binary tree structure but make it invisible outside the codec layer.

- **Codecs as separate objects, not one monolithic class.** The current
  `TurtleCodecRegistry` inlines all codecs as private class fields. I'd rather
  have each codec be a small, named, independently readable object registered into
  a registry. The codec for dates shouldn't be physically entangled with the codec
  for signatures.

- **The address space as a first-class concept.** Rather than `getCode` being a
  method that happens to handle negative addresses, I'd make the address space
  explicit: a thin object that knows how to resolve any address (negative or
  positive) to bytes.

- **Stream as the primary concept, not storage.** The previous version built upward
  from bytes. This version builds downward from the goal: a Stream is the thing,
  and the layers beneath it exist to serve it.

## Build order

1. Addressifier — append-only byte store with content addressing
2. Codecs — encode/decode for all value types, with the address space baked in
3. Recaller — reactive dependency tracking
4. Stream — reactive + signed, the primary user-facing class
5. Sync — WebSocket-based append-only replication
6. Rendering — hx template engine
