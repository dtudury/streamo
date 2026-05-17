import { describe } from './utils/testing.js'
import { parseOrigin } from './StreamoServer.js'

describe(import.meta.url, ({ test }) => {
  // ── URL-shape (explicit protocol) ──────────────────────────────────────

  test('ws:// URL with port', ({ assert }) => {
    assert.deepEqual(parseOrigin('ws://localhost:8080'),
      { host: 'localhost', port: 8080, protocol: 'ws' })
  })

  test('wss:// URL with port', ({ assert }) => {
    assert.deepEqual(parseOrigin('wss://streamo.dev:8443'),
      { host: 'streamo.dev', port: 8443, protocol: 'wss' })
  })

  test('wss:// URL without port → defaults to 443', ({ assert }) => {
    assert.deepEqual(parseOrigin('wss://streamo.dev'),
      { host: 'streamo.dev', port: 443, protocol: 'wss' })
  })

  test('ws:// URL without port → defaults to 80', ({ assert }) => {
    assert.deepEqual(parseOrigin('ws://example.test'),
      { host: 'example.test', port: 80, protocol: 'ws' })
  })

  // ── shorthand (no protocol) ────────────────────────────────────────────

  test('shorthand host:port (non-443) → ws', ({ assert }) => {
    assert.deepEqual(parseOrigin('localhost:8080'),
      { host: 'localhost', port: 8080, protocol: 'ws' })
  })

  test('shorthand host:443 → wss (TLS conventional port)', ({ assert }) => {
    assert.deepEqual(parseOrigin('streamo.dev:443'),
      { host: 'streamo.dev', port: 443, protocol: 'wss' })
  })

  test('shorthand bare host (no port) → wss + 443 (production default)', ({ assert }) => {
    assert.deepEqual(parseOrigin('streamo.dev'),
      { host: 'streamo.dev', port: 443, protocol: 'wss' })
  })
})
