# Streamo wire protocol — byte-level reference

*Companion to `design.md` §5 (Streamo — Signing) and §10 (registrySync).
Where those sections describe the mechanism, this doc describes the exact
bytes on the wire. Read after §10 for context; read this when you're
building something that speaks the protocol.*

*Source of truth: `public/streamo/registrySync.js` (control-plane) and
`public/streamo/Addressifier.js` (chunk framing). Line numbers cited
inline for spot-checks; the code is the actual authority.*

---

## The wire in one sentence

A single WebSocket carries two kinds of traffic multiplexed by frame
type: **text frames** for the JSON control-plane, and **binary frames**
for chunk data. Binary frames self-route by a 33-byte compressed-pubkey
prefix. Chunk data inside a binary frame is length-framed so multiple
chunks can batch in one WS message.

---

## 1. Handshake

The connecting side sends the ASCII text `"registry"` — literally 8
bytes, no framing beyond the WebSocket text-frame envelope
(`registrySync.js:781`).

The accepting side compares against the literal string and switches
into `handleRegistryPeer` mode. Anything else, the peer treats as a
non-streamo connection and can route elsewhere (e.g. a WebSocket-
aware HTTP server can host both streamo and other protocols on one
port).

**On the wire**: `72 65 67 69 73 74 72 79` — ASCII `"registry"`.

---

## 2. JSON control messages (WebSocket TEXT frames)

Every non-handshake control message is `JSON.stringify(...)` shipped as
a WebSocket text frame via `sendJson()` (`registrySync.js:217`). No
extra framing — WebSocket's own text-frame boundary is the message
boundary.

### 2.1 `{type: "hello", home: "<pubkey-hex>"}`

*Sent by:* the accepting side, immediately after the handshake (only if
that peer was configured with a `home` repo key).
*Purpose:* bootstrap pointer — receiver auto-subscribes to that key and
walks the home's `members` for cascade discovery.

```json
{"type":"hello","home":"02948903d99f1fc7ee3802a9b5b0b36cf9382b353acf6609af30a8afdebf2f0994"}
```

- `home` — 66-char hex string (33 bytes compressed secp256k1 pubkey,
  hex-encoded).

Source: `registrySync.js:386`.

### 2.2 `{type: "subscribe", key, fromOffset, fromChainHash}`

*Sent by:* the client, when it wants a specific repo's bytes streamed
to it — either newly (fromOffset=0, chainHash=zeros) or resuming
(fromOffset=signedLength, chainHash=committed).
*Purpose:* request bidirectional sync for `key`. Server validates the
anchor against its own chain before streaming.

```json
{"type":"subscribe","key":"02948903...","fromOffset":97,"fromChainHash":"7f3ab2..."}
```

- `key` — 66-char hex (repo's pubkey).
- `fromOffset` — number, the client's `signedLength` on this repo.
- `fromChainHash` — 64-char hex (32-byte chainHash of the SIG ending
  at `fromOffset` on the client's chain).

**Server's validation** (`registrySync.js:429-448`):
- `fromOffset === 0`: valid iff `fromChainHash` is 32 zeros.
- `fromOffset >= 97`: server reads its own SIG at `[fromOffset-97,
  fromOffset-65]` (the 32-byte chainHash prefix of that 97-byte SIG
  chunk) and compares to `fromChainHash`.
- Any of {malformed, byteLength too short, chainHash mismatch} → server
  sends `{type:"reject", key, reason:"chain-mismatch"}` back.

Source: `registrySync.js:375` (client-side send), `registrySync.js:414`
(server-side handler).

### 2.3 `{type: "subscribed", key, atOffset}`

*Sent by:* the server, acknowledging a valid subscribe.
*Purpose:* tell the client "I'll stream from here" — the watermark
that lets `caughtUpToRelay` derive.

```json
{"type":"subscribed","key":"02948903...","atOffset":97}
```

- `key` — 66-char hex.
- `atOffset` — number, the byte offset the server will start streaming
  from (equal to `fromOffset` on a valid resume; = 0 on fresh subscribe).

The client stores this as `session.setRelaySubscribedAtOffset(key,
atOffset)` — **first-ack-only semantics**: a second `subscribed` ack
from the same session is ignored, keeping the watermark anchored at
the initial-replay boundary. This is important for `caughtUpToRelay`
staying stable across mid-stream reconnects.

Source: `registrySync.js:460` (server send), `registrySync.js:467`
(client receipt).

### 2.4 `{type: "interest", key}`

*Sent by:* either side.
*Purpose:* express interest in receiving `announce` messages for the
given topic key. Server-side routing tracks this and fans announces.

```json
{"type":"interest","key":"02fake..."}
```

- `key` — 66-char hex (topic key; often a synthetic value, not a real
  repo pubkey).

Source: `registrySync.js:627`.

### 2.5 `{type: "announce", key, topic}`

*Sent by:* peers announcing that `key` is related to `topic`.
*Purpose:* content-driven discovery. Server fans out to subscribers
of the topic; client-side `onAnnounce(key, topic)` callback fires.

```json
{"type":"announce","key":"02real...","topic":"02fake..."}
```

- `key` — the announced repo's pubkey (66-char hex).
- `topic` — the topic pubkey (66-char hex).

Source: `registrySync.js:629`.

### 2.6 `{type: "reject", key, reason}`

*Sent by:* the server.
*Purpose:* refuse an incoming push or subscribe with a reason string.
Client's session records this via `session.setPushRejected(key, {reason,
dataAddress})` (`dataAddress` filled in from the client's own
`lastCommit`).

```json
{"type":"reject","key":"02948903...","reason":"chain-mismatch"}
```

- `key` — 66-char hex.
- `reason` — string, values from `StreamoRecordSerializer`:
  - `"malformed"` — sig codec wasn't SIGNATURE, or bytes didn't decode.
  - `"chain-mismatch"` — `sha256(committedChainHash || sha256(newBytes))
    !== sig.chainHash`. Most common; another client extended the top first.
  - `"verification-failed"` — signature didn't verify against the pubkey.

Source: `registrySync.js:306` (server rejecting a push),
`registrySync.js:448` (server rejecting a subscribe).

### 2.7 `{type: "ping"}`

*Sent by:* either side.
*Purpose:* 20-second keep-alive so PaaS hosts (fly.io, etc.) don't
idle-close the WebSocket. Payload is trivial; no response needed.

```json
{"type":"ping"}
```

Source: `registrySync.js:390`.

---

## 3. Binary frames (WebSocket BINARY frames)

Chunk data — the actual bytes of user values, commit records,
SIGNATURE chunks — flows in WebSocket binary frames. Every binary
frame has the same shape:

```
[33 bytes: compressed secp256k1 pubkey][N bytes: batch of framed chunks]
```

The 33-byte prefix (`KEY_BYTES = 33` in `registrySync.js:68`) routes
the whole frame to the right repo. Compressed secp256k1 pubkeys are
always 33 bytes and start with `0x02` or `0x03` — same encoding as
the hex form used in JSON messages, just as raw bytes here.

The `N bytes` after the prefix are the **batch** — one or more
Addressifier chunks, each length-prefixed. See §4 for the batch's
internal shape.

**Direction**:
- *Down* (server → subscribed client): the server drains its
  `makeReadableStream({fromOffset: atOffset})` for each subscribed key
  and wraps each pulled batch with the 33-byte key prefix.
- *Up* (client → server): the client (if authoring) drains its own
  `makeReadableStream({fromOffset})` and wraps analogously.

Same wire format both directions; the *validation* differs (see
`design.md §5` — server runs shape/chain/crypto on incoming pushes;
client trusts the server via `makeRelayInboundStream`'s alignment
check).

Source: `registrySync.js:270` (outbound wrap), `registrySync.js:547`
(inbound unwrap), `registrySync.js:188` (docblock spec).

---

## 4. Chunk framing (inside binary frames)

The N-byte batch inside a binary frame is a sequence of
length-prefixed chunks, straight from Addressifier's `makeReadableStream`
output (`Addressifier.js:226-236`):

```
[4-byte LE length][chunk bytes][4-byte LE length][chunk bytes]...
```

- **length** — 32-bit unsigned little-endian, `DataView.setUint32(pos,
  chunk.length, true)`. The length field itself is not counted.
- **chunk bytes** — exactly `length` bytes of chunk payload.

The batch continues until the WS binary frame ends. Frames are sized
to fit `maxBatch` (default 256 KB, `Addressifier.js:203`), so a single
WS binary frame typically carries many small chunks OR one large chunk
(a value larger than 256 KB always ships alone; at least one chunk per
frame regardless).

**Chunk types** — the chunk's last byte (the "footer") determines its
codec (see `design.md §3` on `codecs.js`). Two kinds you'll see on the
wire most often:

- **COMMIT chunk** — variable size. The commit record `{message, date,
  dataAddress, parent, ?remoteParent}` encoded via OBJECT/DUPLE codecs.
- **SIGNATURE chunk** — fixed **97 bytes**: `[32-byte chainHash][64-byte
  compact ECDSA signature][1-byte footer]`. Same shape everywhere; the
  footer identifies it as SIGNATURE.

The **relay's batch semantics** hinge on SIGNATURE: `ConnectionAccumulator`
buffers incoming chunks per pubkey; when a SIGNATURE arrives, submits
`{chunks, sig}` to `StreamoRecordSerializer.submit(batch)` for the
three-check validation (`design.md §5`). Client-side, the same rule —
`makeRelayInboundStream` buffers non-SIG chunks until a SIG arrives,
then applies them atomically after the alignment check.

Source: `Addressifier.js:260` (`makeWritableStream` — the receiver
parses this exact format), `Addressifier.js:203` (`makeReadableStream`
— the sender emits this exact format).

---

## 5. Worked example — an author's first commit

Chronological wire trace of what happens when a client authors and
pushes its first commit to a subscribed key:

1. **[TEXT]** `"registry"` (client → server)
2. **[TEXT]** `{"type":"hello","home":"02..."}` (server → client, if
   configured with a home)
3. **[TEXT]** `{"type":"subscribe","key":"02...","fromOffset":0,
   "fromChainHash":"0000...0000"}` (client → server)
4. **[TEXT]** `{"type":"subscribed","key":"02...","atOffset":0}`
   (server → client — anchor validated)
5. *(author does its work locally — appends chunks, signs, generates a
   COMMIT chunk + SIGNATURE chunk)*
6. **[BINARY]** `[33-byte pubkey][4-byte LE][COMMIT bytes][4-byte LE]
   [97-byte SIG]` (client → server — one binary frame carries the
   whole batch)
7. Server's `ConnectionAccumulator` for this pubkey unstages, submits
   to serializer. All three checks pass.
8. Server appends atomically, broadcasts back to subscribers.
9. **[BINARY]** `[33-byte pubkey][4-byte LE][COMMIT bytes][4-byte LE]
   [97-byte SIG]` (server → client — the broadcast-back; same bytes
   the client just sent, minus the alignment issue)
10. Client's `makeRelayInboundStream` parses framing, alignment-check
    passes, chunks land in local byte-store, `session.setRelayChainHash(
    key, sig.chainHash)` fires reactively. `_awaitChainHash(target)`
    resolves; the author knows their commit landed.

Rejection version — steps 1-6 the same; step 7 fails one of three
checks; server sends:

7'. **[TEXT]** `{"type":"reject","key":"02...","reason":"chain-mismatch"}`
    (server → client)
8'. Client's session records `session.setPushRejected(key, {reason,
    dataAddress})`. `_awaitChainHash` rejects with the pushRejected
    error. App-level UX decides recovery.

---

## 6. What's not on the wire

Named explicitly so the frame stays clean:

- **No handshake beyond `"registry"`.** No version negotiation, no
  cipher suite selection — the WebSocket already negotiated its
  security, and streamo trusts that.
- **No per-frame checksum.** WebSocket has its own framing integrity;
  streamo trusts the transport. Chain-hash validation catches
  semantic tampering (the only kind that would bypass transport
  integrity — someone injecting valid-looking-but-forged data).
- **No routing header beyond the pubkey prefix.** Multi-topic
  federation happens via `interest`/`announce` control messages; the
  binary channel is per-pubkey and doesn't carry additional metadata.
- **No response-correlation IDs.** Requests and responses correlate
  by `key` field (for subscribe/subscribed) or by session-state (for
  chunk data → subsequent SIG). The wire is stream-oriented; no
  request-response semantic beyond that.

---

## 7. Cross-references

- `design.md §5` — the mechanism-level view of what these bytes DO
  (relay authority, three-check validation, alignment check).
- `design.md §10` — the registrySync protocol at prose level.
- `public/streamo/registrySync.js` — the sole implementation.
- `public/streamo/Addressifier.js` — chunk framing spec.
- `public/streamo/StreamoRecordSerializer.js` — the relay's validation.
- `public/streamo/ConnectionAccumulator.js` — the relay's per-repo
  chunk-batcher.
- `public/streamo/relayInboundStream.js` — the client's trust+align
  receiver.
- `EXPLORATION-sync-model.md` — the design's north-star (Mirror-and-
  Draft), for context on where this wire protocol is heading (the
  protocol itself doesn't change; the client-side reorganization
  around it is what's in flight).

---

*If this doc drifts from the code, trust the code. Filed here because
the code is dense-and-implementation-focused; this walking-tour is
what you'd want to hand a new author (human or Claude) who's about
to write something that speaks streamo's wire.*
