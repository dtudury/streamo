import { describe } from './utils/testing.js'
import { Repo } from './Repo.js'
import { serveFromRepo } from './repoFileServer.js'

/**
 * Build a Repo seeded with a single commit of the given value.
 */
function makeRepo (value) {
  const repo = new Repo()
  const working = repo.checkout()
  working.set(value)
  repo.commit(working, 'seed')
  return repo
}

/**
 * Invoke an Express middleware with a stub req/res and report what
 * happened: response captured fully, or next() called.
 */
function callMiddleware (mw, { method = 'GET', path = '/', headers = {} } = {}) {
  const state = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    nextCalled: false
  }
  const req = { method, path, headers }
  const res = {
    setHeader (k, v) { state.headers[k.toLowerCase()] = v },
    end (body) {
      if (body !== undefined) state.body = body
      state.ended = true
    },
    get statusCode () { return state.statusCode },
    set statusCode (v) { state.statusCode = v }
  }
  mw(req, res, () => { state.nextCalled = true })
  return state
}

const bodyAsString = body => body == null ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : String(body)

describe(import.meta.url, ({ test }) => {
  // ── namespaced shape (default: filesKey='files') ─────────────────────────

  test('serves index.html for / (namespaced shape)', ({ assert }) => {
    const repo = makeRepo({ files: { 'index.html': '<!doctype html><html></html>' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/' })
    assert.equal(r.ended, true)
    assert.equal(r.statusCode, 200)
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
    assert.ok(bodyAsString(r.body).includes('<!doctype html>'))
  })

  test('serves named file', ({ assert }) => {
    const repo = makeRepo({ files: { 'about.html': '<h1>about</h1>' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/about.html' })
    assert.equal(r.statusCode, 200)
    assert.equal(bodyAsString(r.body), '<h1>about</h1>')
  })

  test('serves nested files', ({ assert }) => {
    const repo = makeRepo({ files: { 'css/main.css': 'body { color: red }' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/css/main.css' })
    assert.equal(r.statusCode, 200)
    assert.equal(r.headers['content-type'], 'text/css; charset=utf-8')
    assert.equal(bodyAsString(r.body), 'body { color: red }')
  })

  test('treats subdir trailing slash as index.html', ({ assert }) => {
    const repo = makeRepo({ files: { 'docs/index.html': '<p>docs</p>' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/docs/' })
    assert.equal(r.statusCode, 200)
    assert.equal(bodyAsString(r.body), '<p>docs</p>')
  })

  // ── root shape (filesKey: null) ──────────────────────────────────────────

  test('serves from root-shape Repo when filesKey is null', ({ assert }) => {
    const repo = makeRepo({ 'index.html': '<h1>root</h1>' })
    const mw = serveFromRepo(repo, { filesKey: null, injectImportMap: false })
    const r = callMiddleware(mw, { path: '/' })
    assert.equal(r.statusCode, 200)
    assert.equal(bodyAsString(r.body), '<h1>root</h1>')
  })

  test('root-shape ignores non-file siblings naturally', ({ assert }) => {
    // In root mode, a key like `title` is just another path lookup;
    // since req.path normalize() never produces `title`, it's untouched.
    const repo = makeRepo({ 'index.html': '<h1>hi</h1>' })
    const mw = serveFromRepo(repo, { filesKey: null, injectImportMap: false })
    const r = callMiddleware(mw, { path: '/' })
    assert.equal(r.statusCode, 200)
  })

  // ── fallthrough ──────────────────────────────────────────────────────────

  test('falls through (next) when path not in files map', ({ assert }) => {
    const repo = makeRepo({ files: { 'index.html': '<p>here</p>' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/missing.html' })
    assert.equal(r.nextCalled, true)
    assert.equal(r.ended, false)
  })

  test('falls through when repo has no commit', ({ assert }) => {
    const repo = new Repo()
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/' })
    assert.equal(r.nextCalled, true)
  })

  test('falls through when filesKey missing from value', ({ assert }) => {
    const repo = makeRepo({ members: [] })  // no `files` key
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/' })
    assert.equal(r.nextCalled, true)
  })

  test('falls through for non-GET/HEAD methods', ({ assert }) => {
    const repo = makeRepo({ files: { 'index.html': 'x' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { method: 'POST', path: '/' })
    assert.equal(r.nextCalled, true)
  })

  test('rejects path traversal', ({ assert }) => {
    const repo = makeRepo({ files: { 'index.html': 'x', '../secret.html': 'y' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/../secret.html' })
    assert.equal(r.nextCalled, true)
  })

  // ── content types ────────────────────────────────────────────────────────

  test('JS files served as text/javascript', ({ assert }) => {
    const repo = makeRepo({ files: { 'app.js': 'console.log("hi")' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/app.js' })
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8')
  })

  test('SVG served as image/svg+xml', ({ assert }) => {
    const repo = makeRepo({ files: { 'icon.svg': '<svg/>' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/icon.svg' })
    assert.equal(r.headers['content-type'], 'image/svg+xml')
  })

  test('unknown extension served as octet-stream', ({ assert }) => {
    const repo = makeRepo({ files: { 'thing.bin': new Uint8Array([1, 2, 3]) } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/thing.bin' })
    assert.equal(r.headers['content-type'], 'application/octet-stream')
  })

  test('binary Uint8Array passed through unchanged', ({ assert }) => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])  // PNG magic
    const repo = makeRepo({ files: { 'logo.png': bytes } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/logo.png' })
    assert.equal(r.headers['content-type'], 'image/png')
    assert.equal(r.body[0], 0x89)
    assert.equal(r.body[1], 0x50)
  })

  test('JSON objects re-serialized to pretty JSON', ({ assert }) => {
    // fileSync decodes .json files to parsed objects; round-trip must restore JSON text
    const repo = makeRepo({ files: { 'config.json': { a: 1, b: 'two' } } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/config.json' })
    assert.equal(r.statusCode, 200)
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8')
    const parsed = JSON.parse(bodyAsString(r.body))
    assert.deepEqual(parsed, { a: 1, b: 'two' })
  })

  // ── ETag ─────────────────────────────────────────────────────────────────

  test('sets a strong ETag derived from content', ({ assert }) => {
    const repo = makeRepo({ files: { 'index.html': '<p>x</p>' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/' })
    assert.ok(r.headers.etag)
    assert.ok(r.headers.etag.startsWith('"'))
    assert.ok(r.headers.etag.endsWith('"'))
  })

  test('returns 304 when If-None-Match matches', ({ assert }) => {
    const repo = makeRepo({ files: { 'index.html': '<p>x</p>' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const first = callMiddleware(mw, { path: '/' })
    const etag = first.headers.etag
    const second = callMiddleware(mw, { path: '/', headers: { 'if-none-match': etag } })
    assert.equal(second.statusCode, 304)
    assert.equal(second.body, null)
  })

  test('ETag changes when repo content changes', ({ assert }) => {
    const repo = makeRepo({ files: { 'index.html': '<p>v1</p>' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const before = callMiddleware(mw, { path: '/' }).headers.etag
    const working = repo.checkout()
    working.set({ files: { 'index.html': '<p>v2</p>' } })
    repo.commit(working, 'update')
    const after = callMiddleware(mw, { path: '/' }).headers.etag
    assert.notEqual(before, after)
  })

  // ── importmap injection ─────────────────────────────────────────────────

  test('injects importmap into HTML <head>', ({ assert }) => {
    const repo = makeRepo({
      files: { 'index.html': '<!doctype html><html><head><title>t</title></head><body></body></html>' }
    })
    const mw = serveFromRepo(repo)
    const r = callMiddleware(mw, { path: '/' })
    const body = bodyAsString(r.body)
    assert.ok(body.includes('<script type="importmap">'))
    assert.ok(body.includes('@dtudury/streamo'))
    assert.ok(body.includes('/streamo/'))
    // Inserted before </head>
    const importIdx = body.indexOf('importmap')
    const headEndIdx = body.indexOf('</head>')
    assert.ok(importIdx < headEndIdx && importIdx > -1)
  })

  test('skips importmap injection on non-HTML responses', ({ assert }) => {
    const repo = makeRepo({ files: { 'app.js': 'const x = 1' } })
    const mw = serveFromRepo(repo)
    const r = callMiddleware(mw, { path: '/app.js' })
    assert.equal(bodyAsString(r.body), 'const x = 1')
  })

  test('respects existing importmap in document', ({ assert }) => {
    const html = '<html><head><script type="importmap">{"imports":{"a":"/a.js"}}</script></head></html>'
    const repo = makeRepo({ files: { 'index.html': html } })
    const mw = serveFromRepo(repo)
    const r = callMiddleware(mw, { path: '/' })
    const body = bodyAsString(r.body)
    // Should not have two importmap script tags
    const matches = body.match(/<script\s+type=["']importmap["']/gi) ?? []
    assert.equal(matches.length, 1)
  })

  test('importmap can be disabled', ({ assert }) => {
    const repo = makeRepo({
      files: { 'index.html': '<!doctype html><html><head></head><body></body></html>' }
    })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { path: '/' })
    assert.ok(!bodyAsString(r.body).includes('importmap'))
  })

  test('importmap libraryPath is configurable', ({ assert }) => {
    const repo = makeRepo({ files: { 'index.html': '<html><head></head></html>' } })
    const mw = serveFromRepo(repo, { libraryPath: '/lib/streamo/' })
    const r = callMiddleware(mw, { path: '/' })
    const body = bodyAsString(r.body)
    assert.ok(body.includes('/lib/streamo/'))
    assert.ok(!body.includes('"/streamo/"'))
  })

  // ── HEAD ─────────────────────────────────────────────────────────────────

  test('HEAD returns headers only', ({ assert }) => {
    const repo = makeRepo({ files: { 'index.html': '<h1>x</h1>' } })
    const mw = serveFromRepo(repo, { injectImportMap: false })
    const r = callMiddleware(mw, { method: 'HEAD', path: '/' })
    assert.equal(r.statusCode, 200)
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(r.body, null)
  })

  // ── mounts ───────────────────────────────────────────────────────────────
  // The `mounts` key declares "another record's files appear at this
  // path-prefix." Resolution walks files-first (longest match wins on
  // mounts), recurses into mounted records, cycle-detects per request,
  // and supports pinning a mount to a specific dataAddress.

  /**
   * A minimal in-memory registry stub: a Map from pubkeyHex → Repo,
   * with a `get(key)` accessor that mirrors the real RepoRegistry's
   * synchronous-get shape. Sufficient for the resolver, which only
   * uses .get(key) and the Repo's value-read API.
   */
  function makeStubRegistry (entries) {
    const map = new Map(entries)
    return { get: k => map.get(k) }
  }

  // The 66-hex shape is just a plausible-looking pubkey for testing
  // (the resolver only cares about the regex shape, not real signing).
  const KEY_A = 'a'.repeat(66)
  const KEY_B = 'b'.repeat(66)
  const KEY_C = 'c'.repeat(66)

  test('mounts: resolves files-first on the served repo', ({ assert }) => {
    // If `files` has the requested path, the mount shouldn't be
    // consulted at all — even though a mount entry could otherwise
    // claim the same prefix.
    const a = makeRepo({ files: { 'index.html': 'A-root' }, mounts: { 'index.html/': { key: KEY_B } } })
    const b = makeRepo({ files: { 'index.html': 'B-content' } })
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
      pubkeyHex: KEY_A
    })
    const r = callMiddleware(mw, { path: '/' })
    assert.equal(r.statusCode, 200)
    assert.equal(bodyAsString(r.body), 'A-root')
  })

  test('mounts: serves through a single mount to another record', ({ assert }) => {
    const a = makeRepo({ files: { 'index.html': 'A' }, mounts: { 'lib/': { key: KEY_B } } })
    const b = makeRepo({ files: { 'foo.js': 'console.log("from B")' } })
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
      pubkeyHex: KEY_A
    })
    const r = callMiddleware(mw, { path: '/lib/foo.js' })
    assert.equal(r.statusCode, 200)
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal(bodyAsString(r.body), 'console.log("from B")')
  })

  test('mounts: longest matching prefix wins', ({ assert }) => {
    const a = makeRepo({
      files: {},
      mounts: { 'lib/': { key: KEY_B }, 'lib/v2/': { key: KEY_C } }
    })
    const b = makeRepo({ files: { 'x.js': 'B-version' } })
    const c = makeRepo({ files: { 'x.js': 'C-version' } })
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a], [KEY_B, b], [KEY_C, c]]),
      pubkeyHex: KEY_A
    })
    // /lib/x.js matches `lib/` prefix → B
    const r1 = callMiddleware(mw, { path: '/lib/x.js' })
    assert.equal(bodyAsString(r1.body), 'B-version')
    // /lib/v2/x.js matches BOTH `lib/` and `lib/v2/` — the longer one wins
    const r2 = callMiddleware(mw, { path: '/lib/v2/x.js' })
    assert.equal(bodyAsString(r2.body), 'C-version')
  })

  test('mounts: missing file in mounted record falls through (404)', ({ assert }) => {
    const a = makeRepo({ files: {}, mounts: { 'lib/': { key: KEY_B } } })
    const b = makeRepo({ files: { 'x.js': 'exists' } })
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
      pubkeyHex: KEY_A
    })
    const r = callMiddleware(mw, { path: '/lib/missing.js' })
    assert.ok(r.nextCalled, 'expected next() — missing file in mount falls through')
  })

  test('mounts: missing mount target (not in registry) falls through', ({ assert }) => {
    const a = makeRepo({ files: {}, mounts: { 'lib/': { key: KEY_B } } })
    // KEY_B is referenced but not in the registry
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a]]),
      pubkeyHex: KEY_A
    })
    const r = callMiddleware(mw, { path: '/lib/anything' })
    assert.ok(r.nextCalled)
  })

  test('mounts: cycle (A → B → A) returns 404, not infinite recursion', ({ assert }) => {
    const a = makeRepo({ files: {}, mounts: { 'b/': { key: KEY_B } } })
    const b = makeRepo({ files: {}, mounts: { 'a/': { key: KEY_A } } })
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
      pubkeyHex: KEY_A
    })
    // Walk: A → b/ mount → B → a/ mount → A (already visited) → null
    const r = callMiddleware(mw, { path: '/b/a/anything' })
    assert.ok(r.nextCalled)
  })

  test('mounts: self-mount (A → A) returns 404 on the would-loop path', ({ assert }) => {
    const a = makeRepo({ files: { 'top.js': 'self' }, mounts: { 'me/': { key: KEY_A } } })
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a]]),
      pubkeyHex: KEY_A
    })
    // A's own top.js still resolves
    const r1 = callMiddleware(mw, { path: '/top.js' })
    assert.equal(bodyAsString(r1.body), 'self')
    // But /me/top.js attempts to recurse into A again → cycle → 404
    const r2 = callMiddleware(mw, { path: '/me/top.js' })
    assert.ok(r2.nextCalled)
  })

  test('mounts: nested mount-through-mount works (A → B → C)', ({ assert }) => {
    const a = makeRepo({ files: {}, mounts: { 'b/': { key: KEY_B } } })
    const b = makeRepo({ files: {}, mounts: { 'c/': { key: KEY_C } } })
    const c = makeRepo({ files: { 'deep.txt': 'three levels' } })
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a], [KEY_B, b], [KEY_C, c]]),
      pubkeyHex: KEY_A
    })
    const r = callMiddleware(mw, { path: '/b/c/deep.txt' })
    assert.equal(r.statusCode, 200)
    assert.equal(bodyAsString(r.body), 'three levels')
  })

  test('mounts: pinned dataAddress reads the record at that specific commit', ({ assert }) => {
    // Build a record that goes through two commits; pin the mount to
    // the first commit's dataAddress and confirm the served content
    // matches the pinned commit, not HEAD.
    const b = new Repo()
    let w = b.checkout()
    w.set({ files: { 'x.txt': 'v1' } })
    b.commit(w, 'v1')
    const v1DataAddress = b.lastCommit.dataAddress
    w = b.checkout()
    w.set({ files: { 'x.txt': 'v2' } })
    b.commit(w, 'v2')

    const a = makeRepo({ files: {}, mounts: { 'lib/': { key: KEY_B, dataAddress: v1DataAddress } } })
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a], [KEY_B, b]]),
      pubkeyHex: KEY_A
    })
    const r = callMiddleware(mw, { path: '/lib/x.txt' })
    assert.equal(bodyAsString(r.body), 'v1', 'pinned mount should serve v1, not v2')
  })

  test('mounts: are ignored when registry is not provided (files-only)', ({ assert }) => {
    const a = makeRepo({ files: { 'top.txt': 'A' }, mounts: { 'lib/': { key: KEY_B } } })
    const mw = serveFromRepo(a, { injectImportMap: false })  // no registry
    const r1 = callMiddleware(mw, { path: '/top.txt' })
    assert.equal(bodyAsString(r1.body), 'A')
    const r2 = callMiddleware(mw, { path: '/lib/anything' })
    assert.ok(r2.nextCalled, 'mounts ignored without registry — anything via lib/ is 404')
  })

  test('mounts: invalid ref shape (not hex) falls through safely', ({ assert }) => {
    const a = makeRepo({ files: {}, mounts: { 'lib/': { key: 'not-a-key' } } })
    const mw = serveFromRepo(a, {
      injectImportMap: false,
      registry: makeStubRegistry([[KEY_A, a]]),
      pubkeyHex: KEY_A
    })
    const r = callMiddleware(mw, { path: '/lib/anything' })
    assert.ok(r.nextCalled)
  })
})
