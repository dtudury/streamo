import { describe } from '../../streamo/utils/testing.js'
import { createPublicKey, verify } from 'crypto'
import { encryptContent, generateVapidKeys, vapidAuthorization } from './webpush.js'

describe(import.meta.url, ({ test }) => {
  // RFC 8291 Appendix A — the spec's own worked example. If encryptContent
  // reproduces this byte for byte, the hand-rolled crypto is correct: it
  // derives the same keys and emits the same aes128gcm body a browser
  // will decrypt. This is the known-answer test the whole module rests on.
  test('encryptContent matches the RFC 8291 Appendix A test vector', ({ assert }) => {
    const b = s => Buffer.from(s, 'base64url')
    const plaintext  = b('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24')
    const uaPublic   = b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4')
    const authSecret = b('BTBZMqHH6r4Tts7J_aSIgg')
    const salt       = b('DGv6ra1nlYgDCS1FRnbzlw')
    const asPrivate  = b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw')
    const expected   = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'

    const body = encryptContent(plaintext, uaPublic, authSecret, { salt, asPrivate })
    assert.equal(body.toString('base64url'), expected)
  })

  test('generateVapidKeys produces a P-256 keypair', ({ assert }) => {
    const { publicKey, privateKey } = generateVapidKeys()
    const pub = Buffer.from(publicKey, 'base64url')
    assert.equal(pub.length, 65)
    assert.equal(pub[0], 0x04, 'uncompressed-point prefix')
    assert.equal(Buffer.from(privateKey, 'base64url').length, 32)
  })

  test('vapidAuthorization signs a JWT that verifies against the public key', ({ assert }) => {
    const keys = generateVapidKeys()
    const auth = vapidAuthorization('https://push.example.com/abc123', { ...keys, subject: 'mailto:streamo@streamo.dev' })

    const m = auth.match(/^vapid t=(.+), k=(.+)$/)
    assert.ok(m, 'header is "vapid t=<jwt>, k=<pubkey>"')
    const [, jwt, k] = m
    assert.equal(k, keys.publicKey, 'k carries the VAPID public key')

    const [h, c, s] = jwt.split('.')
    assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'ES256')
    const claims = JSON.parse(Buffer.from(c, 'base64url'))
    assert.equal(claims.aud, 'https://push.example.com', 'aud is the endpoint origin')
    assert.ok(claims.exp > Math.floor(Date.now() / 1000), 'not already expired')

    // The signature must verify against the keypair's public key.
    const pub = Buffer.from(keys.publicKey, 'base64url')
    const pubKey = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC', crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33, 65).toString('base64url')
      }
    })
    const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
    assert.ok(ok, 'JWT signature verifies')
  })
})
