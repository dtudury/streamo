import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Signer } from './Signer.js'

// Known-answer test for Signer's deterministic identity derivation.
//
// streamo's central promise is "same credentials, same keypair, everywhere."
// This test pins the exact bytes Signer produces for fixed inputs, so any
// behavioral drift in WebCrypto, noble-secp256k1, or our derivation logic
// surfaces as a test failure rather than a silent identity change.
//
// The expected hex was computed independently with Node's crypto.pbkdf2Sync
// (RFC 2898 PBKDF2-HMAC-SHA256, 32-byte output) and noble-secp256k1's
// getPublicKey. Iterations = 1000 to keep the test fast; the algorithm
// is the same as the production 100k-iteration default.
//
// Inputs:  username='alice'  password='hunter2'  streamName='dataset'  iter=1000
test('Signer KAT: identity derivation is byte-stable', async () => {
  const signer = new Signer('alice', 'hunter2', 1000)
  const { privateKey, publicKey } = await signer.keysFor('dataset')

  assert.equal(
    privateKey,
    '92915ba778f63fbf3e53aaa315deb42ad27da825aef3d5adbf628715323ecc3d',
    'private key bytes must match the pinned KAT'
  )
  assert.equal(
    Array.from(publicKey).map(b => b.toString(16).padStart(2, '0')).join(''),
    '033509fdf1ec47f03c590ed78d50cfd135489fc5d52bd0f0451095aa8b16b98f48',
    'compressed public key must match the pinned KAT'
  )
})

test('Signer caches keys per streamName', async () => {
  const signer = new Signer('alice', 'hunter2', 1)
  const a = await signer.keysFor('dataset-a')
  const b = await signer.keysFor('dataset-a')
  assert.equal(a, b)
  const c = await signer.keysFor('dataset-b')
  assert.notEqual(a.privateKey, c.privateKey)
})

test('sign produces a 64-byte compact signature', async () => {
  const signer = new Signer('alice', 'hunter2', 1)
  const sig = await signer.sign('dataset', new Uint8Array([1, 2, 3, 4]))
  assert.equal(sig.byteLength, 64)
})
