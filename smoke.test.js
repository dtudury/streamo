import { describe } from './public/streamo/utils/testing.js'
import { Streamo } from './public/streamo/Streamo.js'
import { Repo } from './public/streamo/Repo.js'
import { RepoRegistry } from './public/streamo/RepoRegistry.js'
import { archiveSync } from './public/streamo/archiveSync.js'
import { webSync } from './public/streamo/webSync.js'
import { Signer } from './public/streamo/Signer.js'
import WebSocket from 'ws'
import { rm, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// 1 iteration keeps key derivation fast without compromising what we're testing
const KEY_ITERATIONS = 1
const toHex = bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')

async function makeKey (name = 'smoke') {
  const signer = new Signer('test', 'test', KEY_ITERATIONS)
  const { publicKey } = await signer.keysFor(name)
  return { signer, publicKey, publicKeyHex: toHex(publicKey) }
}

async function startServer (publicKeyHex, streamOrFactory, peerOptions = {}) {
  const factory = typeof streamOrFactory === 'function'
    ? streamOrFactory
    : () => streamOrFactory
  const registry = new RepoRegistry(factory)
  const server = await webSync(registry, publicKeyHex, 0, 'smoke-test', KEY_ITERATIONS, peerOptions)
  const { port } = server.address()
  const close = () => new Promise(resolve => server.close(resolve))
  return { port, close, registry }
}

describe(import.meta.url, ({ test }) => {
  test('GET /api/info returns primaryKeyHex and name', async ({ assert }) => {
    const { publicKeyHex } = await makeKey()
    const { port, close } = await startServer(publicKeyHex, new Streamo())
    try {
      const info = await fetch(`http://localhost:${port}/api/info`).then(r => r.json())
      assert.equal(info.primaryKeyHex, publicKeyHex)
      assert.equal(info.name, 'smoke-test')
    } finally {
      await close()
    }
  })

  test('GET /streams/:key/raw loads into a fresh Streamo', async ({ assert }) => {
    const { publicKeyHex } = await makeKey()
    const stream = new Streamo()
    stream.set({ hello: 'world' })
    const { port, close } = await startServer(publicKeyHex, stream)
    try {
      const buf = await fetch(`http://localhost:${port}/streams/${publicKeyHex}/raw`)
        .then(r => r.arrayBuffer())
      const fresh = new Streamo()
      await fresh.makeWritableStream().getWriter().write(new Uint8Array(buf))
      assert.deepEqual(fresh.get(), { hello: 'world' })
    } finally {
      await close()
    }
  })

  test('WebSocket syncs existing chunks to a connecting client', async ({ assert }) => {
    const { publicKeyHex } = await makeKey()
    // Server-side stream needs Repo because outletSync's verified writer
    // (which gates incoming peer chunks) now lives on Repo, not Streamo.
    const stream = new Repo()
    stream.set({ synced: true })
    const { port, close } = await startServer(publicKeyHex, stream)
    try {
      // Client is also a Repo so .get() returns the committed value rather
      // than the raw top chunk (the server-side stream auto-commits, so the
      // top chunk on the wire is now a COMMIT record wrapping {synced:true}).
      const client = new Repo()
      const writer = client.makeWritableStream().getWriter()
      const ws = new WebSocket(`ws://localhost:${port}`)

      await new Promise((resolve, reject) => {
        ws.on('open', () => ws.send(publicKeyHex))
        ws.on('message', async data => {
          await writer.write(new Uint8Array(data))
          if (client.byteLength >= stream.byteLength) resolve()
        })
        ws.on('error', reject)
        setTimeout(() => reject(new Error('WS sync timed out')), 2000)
      })

      ws.close()
      assert.deepEqual(client.get(), { synced: true })
    } finally {
      await close()
    }
  })

  test('set() with a path works when root is VARIABLE-encoded (old server data)', ({ assert }) => {
    // Old server archives encoded the root value as VARIABLE (a boxed address).
    // asRefs() previously returned the VARIABLE address number rather than the
    // inner object's refs, causing refs['toggle'] === undefined → crash.
    const stream = new Streamo()
    // encodeVariable to simulate old-style encoded root
    const rootCode = stream.encodeVariable({ toggle: { value: false, label: 'enabled' }, counter: { value: 0 } })
    stream.append(rootCode)
    // get() should see through VARIABLE
    assert.equal(stream.get('toggle', 'value'), false)
    // set() with a 2-level path must not crash
    stream.set('toggle', 'value', true)
    assert.equal(stream.get('toggle', 'value'), true)
    assert.equal(stream.get('counter', 'value'), 0)
  })

  test('set() after sign() reads/writes user data, not the signature chunk', async ({ assert }) => {
    const { signer } = await makeKey()
    const stream = new Repo()
    stream.set({ count: 0 })
    await stream.sign(signer, 'smoke')
    // Before the fix, set() with a path would crash here because byteLength - 1
    // pointed to the signature chunk instead of the data chunk.
    stream.set('count', stream.get('count') + 1)
    assert.equal(stream.get('count'), 1)
    // get() must also skip past the signature
    assert.deepEqual(stream.get(), { count: 1 })
  })

  test('serveRepoFiles middleware serves homepage Repo bytes via HTTP', async ({ assert }) => {
    const { publicKeyHex } = await makeKey('serveRepo-smoke')
    const homepage = new Repo()
    const working = homepage.checkout()
    working.set({ files: { 'index.html': '<!doctype html><html><head><title>x</title></head><body>hi</body></html>' } })
    homepage.commit(working, 'seed homepage')

    const { port, close } = await startServer(publicKeyHex, new Streamo(), {
      serveRepoFiles: { repo: homepage }
    })
    try {
      const res = await fetch(`http://localhost:${port}/`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
      const body = await res.text()
      assert.ok(body.includes('<title>x</title>'))
      // importmap was injected
      assert.ok(body.includes('<script type="importmap">'))
      assert.ok(body.includes('@dtudury/streamo'))
      // ETag set
      const etag = res.headers.get('etag')
      assert.ok(etag && etag.startsWith('"'))
      // If-None-Match returns 304
      const cached = await fetch(`http://localhost:${port}/`, { headers: { 'If-None-Match': etag } })
      assert.equal(cached.status, 304)
    } finally {
      await close()
    }
  })

  test('multi-home: /streams/:key/<path> serves files from that repo', async ({ assert }) => {
    // The relay holds the primary streamo (whatever it is) plus a fork
    // repo with its own homepage. Hitting /streams/<fork-key>/index.html
    // should serve the fork's bytes, even though the fork isn't the
    // primary. This is the multi-tenant property: any repo the relay
    // holds is addressable as a public URL.
    const { publicKeyHex: primaryKey } = await makeKey('multi-home-primary')
    const { signer: forkSigner, publicKeyHex: forkKey } = await makeKey('multi-home-fork')

    const fork = new Repo()
    fork.attachSigner(forkSigner, 'multi-home-fork')
    const working = fork.checkout()
    working.set({ files: { 'index.html': '<!doctype html><title>fork</title><p>forked site</p>' } })
    fork.commit(working, 'seed fork homepage')

    // Key-aware factory: primary key gets a fresh Streamo (so the JSON view
    // route still works); fork key gets the prepared fork Repo.
    const { port, close } = await startServer(primaryKey, (key) => {
      if (key === forkKey) return fork
      return new Streamo()
    })
    try {
      const html = await fetch(`http://localhost:${port}/streams/${forkKey}/index.html`)
      assert.equal(html.status, 200)
      assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8')
      const body = await html.text()
      assert.ok(body.includes('forked site'), 'served the fork\'s bytes')

      // Trailing slash → index.html
      const root = await fetch(`http://localhost:${port}/streams/${forkKey}/`)
      assert.equal(root.status, 200)
      assert.ok((await root.text()).includes('forked site'))

      // The /raw endpoint still serves raw bytes, not a file named 'raw'
      const raw = await fetch(`http://localhost:${port}/streams/${forkKey}/raw`)
      assert.equal(raw.status, 200)
      assert.equal(raw.headers.get('content-type'), 'application/octet-stream')

      // Missing file in fork → 404 (no fallback to static)
      const missing = await fetch(`http://localhost:${port}/streams/${forkKey}/no-such-file.html`)
      assert.equal(missing.status, 404)
    } finally {
      await close()
    }
  })

  test('serveRepoFiles falls through to express.static when path not in Repo', async ({ assert }) => {
    const { publicKeyHex } = await makeKey('fallthrough-smoke')
    const homepage = new Repo()
    const working = homepage.checkout()
    working.set({ files: { 'something-else.html': 'not the request' } })
    homepage.commit(working, 'seed')

    const { port, close } = await startServer(publicKeyHex, new Streamo(), {
      serveRepoFiles: { repo: homepage }
    })
    try {
      // /api/info is served by the express route AFTER static; falling through
      // here means the middleware did not match `/api/info` (which is correct)
      const info = await fetch(`http://localhost:${port}/api/info`).then(r => r.json())
      assert.equal(info.primaryKeyHex, publicKeyHex)
    } finally {
      await close()
    }
  })

  test('Repo.merge accepts a full URL source and auto-fills remoteParent', async ({ assert }) => {
    const { publicKeyHex } = await makeKey('merge-url')
    const sourceRepo = new Repo()
    const sw = sourceRepo.checkout()
    sw.set({ files: { 'index.html': '<from-url>' }, members: ['ignored'] })
    sourceRepo.commit(sw, 'seed')

    const { port, close } = await startServer(publicKeyHex, sourceRepo)
    try {
      const target = new Repo()
      await target.merge(`http://localhost:${port}/streams/${publicKeyHex}`, { from: 'files' })

      assert.deepEqual(target.get(), { files: { 'index.html': '<from-url>' } })
      const c = target.lastCommit
      assert.equal(c.parent, undefined)                                   // pure-copy fork
      assert.equal(c.remoteParent.host, `localhost:${port}`)              // auto-filled from URL
      assert.equal(c.remoteParent.repo, publicKeyHex)                     // auto-filled from URL path
      assert.equal(c.remoteParent.dataAddress, sourceRepo.lastCommit.dataAddress)
    } finally {
      await close()
    }
  })

  test('Repo.merge with host shorthand discovers primary key via /api/info', async ({ assert }) => {
    const { publicKeyHex } = await makeKey('merge-host')
    const sourceRepo = new Repo()
    const sw = sourceRepo.checkout()
    sw.set({ files: { 'p.html': '<host-mode>' } })
    sourceRepo.commit(sw, 'seed')

    const { port, close } = await startServer(publicKeyHex, sourceRepo)
    try {
      const target = new Repo()
      // host shorthand — no path; merge fetches /api/info to find the key
      await target.merge(`localhost:${port}`, { from: 'files' })

      assert.equal(target.get('files', 'p.html'), '<host-mode>')
      assert.equal(target.lastCommit.remoteParent.repo, publicKeyHex)
    } finally {
      await close()
    }
  })

  test('archiveSync persists data and reloads it on a fresh Streamo', async ({ assert }) => {
    const { publicKeyHex } = await makeKey('archive')
    const dir = await mkdtemp(join(tmpdir(), 'smoke-'))
    try {
      const stream1 = new Streamo()
      await archiveSync(stream1, dir, publicKeyHex)
      stream1.set({ persisted: true })
      await new Promise(r => setTimeout(r, 100))  // let write loop flush

      const stream2 = new Streamo()
      await archiveSync(stream2, dir, publicKeyHex)
      assert.deepEqual(stream2.get(), { persisted: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
