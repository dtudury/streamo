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
})
