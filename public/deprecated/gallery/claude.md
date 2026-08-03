# gallery — claude.md

A claude.md is what an app ships so a *customizing Claude* (web-Claude,
or any Claude with substrate context) can fork-and-personalize the app
without the human touching code.

## what this is

**The gallery** — the streamo identity frame. Where a user logs in
once with their master salt, and from then on (in that session) can
open, edit, sign, and manage their streamo Records.

The vocabulary, per `project_gallery_image_lens_vocabulary` in
memory:
- **Gallery** = this frame (the collection, the identity holder)
- **Image** = each Record loaded into the gallery
- **Lens** = each app/view that renders an image

This is the v1 frame. Layered scope:
- **Stage 1 (current):** login + show derived identity pubkey + visual hash
- **Stage 2:** subscribe to one image, render read-only
- **Stage 3:** records-index Record + list view + create
- **Stage 4:** edit + save (via `record.update()`)
- **Stage 5+:** multi-pane, `suggest()` primitive, nested galleries

Each stage is additive; v2 doesn't require tearing down v1.

## data shape (Stage 1)

In-memory only at Stage 1; no Record involved yet. The session holds:

```js
{
  signer: Signer,            // user's in-memory Signer (private — module-scope)
  ui: {
    phase: 'login' | 'identity',
    username: string | null,
    pubkey: string | null,   // hex, derived from keysFor('gallery')
    deriving: boolean,
    error: string | null
  }
}
```

The Signer never leaves this module. No `localStorage`, no cookies,
no wire. Reload clears it. Per the deck design: master salt is
session-scoped, never persisted.

## customization points (safe — fork and modify freely)

- **theme** — `styles.css` top section, CSS variables: `--bg`,
  `--fg`, `--muted`, `--accent`, `--error`, `--card-bg`,
  `--card-border`, `--shadow`, `--max-width`. Change them; nothing
  else needs to move.
- **copy** — `main.js` view functions. The "your streamo identity,
  in browser" hint, the "in-memory only — reload to clear" line,
  button labels.
- **default stream name** — `main.js` `login()` derives
  `keysFor('gallery')` by default. Forking for a different gallery
  identity (e.g., `keysFor('my-gallery')`)? Change the string;
  derivation produces a different keypair.
- **iterations** — currently hard-coded to 100,000 (cryptopotamus-
  compatible, slow-enough-to-resist-brute-force). Don't lower for
  production; can lower for dev/test if needed.
- **icon + page title** — `index.html` `<title>` and the favicon
  link.

## things not to change (substrate invariants)

- **The Signer stays in module scope, never written anywhere.** The
  whole identity model depends on the master salt being session-only.
  Don't store it in localStorage "for convenience" — that's a
  security regression, not a UX upgrade. The cost is "re-type on
  reload"; the benefit is "the salt isn't sitting in a cookie."
- **`new Signer(username, password, iterations)` is the constructor;
  `signer.keysFor(streamName)` derives the per-stream keypair.**
  Don't try to derive keys yourself — Signer handles PBKDF2 + the
  secp256k1 derivation and there's a key-agreement test (KAT) in
  the streamo repo that pins the exact derivation. Diverging from
  it would make your gallery's identities incompatible with the
  rest of the streamo ecosystem.
- **`logout()` clears the Signer reference AND the UI state.** Don't
  preserve the pubkey on logout; that leaks the identity to the
  next user of the browser. Clear everything.

## evolving the data shape (toward Stage 2+)

When Stage 2 adds image-subscription, the natural extension is:

```js
{
  signer: Signer,
  registry: StreamoRecordRegistry,
  session: registrySync session,
  ui: {
    phase: 'login' | 'identity' | 'image',
    openImageKey: string | null,
    // ...
  }
}
```

Follow `public/apps/shared-note/main.js` as the template — it has
the factory pattern (`WritableStreamoRecord` for own key, slim
`StreamoRecord` for others), the registrySync open, the
`attachSigner` call. Stage 3+ adds an index Record that lists
multiple image keys.

## running it locally

`npm run dev` brings up the relay + apps server.
Open `http://localhost:8080/apps/gallery/` in your browser. Enter
any username + master salt; click "enter"; ~1-2 seconds later,
you'll see your derived pubkey and the visual swatches.

For verification: log in with `username=claude`, master salt = your
cryptopotamus-derived password (recipe `streamo.dev,claude,32,,,`).
The derived pubkey at `keysFor('gallery')` is a NEW key (no Record
published there yet) — but if you fork the code to use
`keysFor('memory')`, you should see `02c0159ea03c4aa7a47f87944148a693e5dfa5179036ec1ff3b89e815eac1d2129`
(today's published memory corpus). That's the unfalsifiable
diagnostic: if the in-browser derivation matches the node-derived
one, the substrate is consistent across runtimes.

## why this app exists in the project

The gallery is the **identity-and-Records frame for the federation
arc**. It's where a user goes to BE their streamo identity in a
browser, not just to use a single app. Once the gallery is real:
- Cryptopotamus becomes a specialized gallery (one image per
  password)
- Shared-note becomes one LENS within the gallery (the conflict-
  resolution view for note-shaped images)
- Future apps (flashcards, chat, notepad) all compose into the
  same frame

The frame-first move is the platform move. Building the gallery
once means every app on streamo can ride on top of it.

Stage 1 ships just identity-session. Each subsequent stage adds a
new capability without breaking the previous one — per
`feedback_start_on_page_2_design_for_revisability`, the metric is
*plasticity*, not coverage.
