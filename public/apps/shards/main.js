// shards — iteration 0: open a Record by URL pubkey, report its shape.
//
// Deliberately starting with a big Record (streamo-history, ~2MB / 286
// commits) — the perf invariant is "still opens fast on this." Each future
// feature earns its way in by passing that gate.
//
// URL shape: #/<66-hex-pubkey>
//
//   /apps/shards/#/<streamo-history-pubkey>  → reports its shape
//
// No login flow yet; read-only. Future iterations: navigation, mount
// traversal, value preview, edit affordances. Each one a small diff
// behind the "still fast on 2MB" gate.

import { h }                    from '../../streamo/h.js'
import { mount }                from '../../streamo/mount.js'
import { Recaller }             from '../../streamo/utils/Recaller.js'
import { StreamoRecord }        from '../../streamo/StreamoRecord.js'
import { StreamoRecordRegistry } from '../../streamo/StreamoRecordRegistry.js'
import { registrySync }         from '../../streamo/registrySync.js'
import { liveLocation }         from '../../streamo/liveLocation.js'

const recaller = new Recaller('shards')

const registry = new StreamoRecordRegistry({
  recaller,
  name: 'shards',
  factory: () => new StreamoRecord({ recaller })
})
const session = await registrySync(registry, location.host)

const loc = liveLocation({ recaller, name: 'location' })
const urlKey = () => {
  const k = loc.get('hashParts', 1)
  return (k && /^[0-9a-f]{66}$/.test(k)) ? k : null
}

// Auto-subscribe to the URL-named key when it isn't already in the
// registry. Same pattern as todomvc + explorer cold-link.
recaller.watch('shards-url-subscribe', () => {
  const k = urlKey()
  if (!k) return
  if (registry.get(k)) return
  session.subscribe(k)
})

const viewedRepo = () => {
  const k = urlKey()
  return k ? (registry.get(k) || null) : null
}

// Walk the commit chain newest-to-oldest, counting. Registers
// dependencies on every decoded commit's address — so re-runs only
// when the chain actually changes, not on every render. Cost is one
// chain walk per head movement.
const countCommits = (repo) => {
  let n = 0
  for (const _ of repo.history()) n++
  return n
}

const formatBytes = (n) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

mount(h`
  <main>
    <h1>shards · iteration 0</h1>
    ${() => {
      const k = urlKey()
      if (!k) return h`
        <p class="hint">
          paste a Record pubkey in the URL —
          <code>#/&lt;66-hex&gt;</code>
        </p>
        <p class="hint">
          this view reports a Record's shape (size, commits, head).
          deliberately spare; each future feature earns its place.
        </p>
      `

      const repo = viewedRepo()
      if (!repo) return h`
        <p class="status pending">
          opening <code>${k.slice(0, 16)}…</code>
        </p>
      `

      const head = repo.lastCommit
      if (!head) return h`
        <p class="status pending">
          subscribed to <code>${k.slice(0, 16)}…</code>,
          waiting for bytes…
        </p>
      `

      // byteLength, head info, and commitCount all register reactive
      // deps — re-renders only on chain growth.
      const bytes = repo.byteLength
      const commits = countCommits(repo)

      return h`
        <dl class="shape">
          <dt>pubkey</dt>
          <dd><code>${k}</code></dd>

          <dt>size</dt>
          <dd>${formatBytes(bytes)} <span class="status">(${bytes} bytes)</span></dd>

          <dt>commits</dt>
          <dd>${commits}</dd>

          <dt>head address</dt>
          <dd><code>${head.dataAddress}</code></dd>

          <dt>head message</dt>
          <dd>${head.message}</dd>

          <dt>head date</dt>
          <dd>${head.date.toISOString()}</dd>
        </dl>
      `
    }}
  </main>
`, document.body, recaller)
