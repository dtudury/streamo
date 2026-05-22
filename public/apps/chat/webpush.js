/**
 * @file webpush — hand-rolled Web Push. No dependencies.
 *
 * Web Push needs two pieces of crypto, both done here with Node's
 * built-in `crypto`:
 *
 *   - VAPID (RFC 8292): an ES256-signed JWT that identifies this
 *     application server to the browser's push service, so the service
 *     will accept the push.
 *   - Message encryption (RFC 8291): the payload is encrypted so the
 *     push service relays ciphertext it can't read — ECDH to a shared
 *     secret, HKDF-SHA256 to a content key + nonce, AES-128-GCM, framed
 *     as the `aes128gcm` content encoding (RFC 8188).
 *
 * `encryptContent` is pinned byte-for-byte to RFC 8291's Appendix A
 * worked example in webpush.test.js — that known-answer test is the
 * proof the reinvented wheel is round.
 */
import { createECDH, hkdfSync, createCipheriv, createPrivateKey, sign, generateKeyPairSync, randomBytes } from 'crypto'

const b64uDec = s => Buffer.from(s, 'base64url')
const b64uEnc = b => Buffer.from(b).toString('base64url')

// Buffer.concat, but strings → utf8 and number arrays → bytes inline.
const concat = (...parts) => Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)))

// HKDF-SHA256 → Buffer. Node's hkdfSync hands back an ArrayBuffer.
const hkdf = (ikm, salt, info, len) => Buffer.from(hkdfSync('sha256', ikm, salt, info, len))

/**
 * Encrypt `plaintext` (a Buffer) for a subscription's keys, producing
 * the `aes128gcm` body (RFC 8291 + RFC 8188). `uaPublic` is the
 * browser's P-256 public key (65-byte uncompressed point), `authSecret`
 * its 16-byte auth secret — both straight from the PushSubscription.
 *
 * `salt` and `asPrivate` are normally random / ephemeral; the test
 * injects RFC 8291's fixed values to reproduce the published vector.
 *
 * @returns {Buffer} the encrypted body to POST to the push endpoint
 */
export function encryptContent (plaintext, uaPublic, authSecret, { salt, asPrivate } = {}) {
  salt ??= randomBytes(16)

  // Ephemeral application-server ECDH keypair, and the ECDH shared
  // secret with the browser (the 32-byte shared X coordinate).
  const as = createECDH('prime256v1')
  if (asPrivate) as.setPrivateKey(asPrivate)
  else as.generateKeys()
  const asPublic = as.getPublicKey()              // 65-byte uncompressed
  const ecdhSecret = as.computeSecret(uaPublic)   // 32 bytes

  // First HKDF: fold the auth secret into the ECDH secret → 32-byte IKM.
  const ikm = hkdf(ecdhSecret, authSecret, concat('WebPush: info', [0], uaPublic, asPublic), 32)

  // Second HKDF round (RFC 8188): the content key and the nonce, both
  // salted with the random salt that travels in the header below.
  const cek = hkdf(ikm, salt, concat('Content-Encoding: aes128gcm', [0]), 16)
  const nonce = hkdf(ikm, salt, concat('Content-Encoding: nonce', [0]), 12)

  // One record: the message, then 0x02 — the "last record" delimiter.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const sealed = concat(cipher.update(concat(plaintext, [0x02])), cipher.final(), cipher.getAuthTag())

  // aes128gcm header: salt(16) ‖ recordSize(4, big-endian) ‖ idLen(1) ‖
  // keyid. The keyid is our public key — how the browser finds it.
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(asPublic.length, 20)
  return concat(header, asPublic, sealed)
}

/**
 * Generate a fresh VAPID keypair — a P-256 key, returned as the
 * base64url strings to store in env: `publicKey` is the
 * `applicationServerKey` the browser subscribes with; `privateKey`
 * signs the JWTs.
 */
export function generateVapidKeys () {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const { d, x, y } = privateKey.export({ format: 'jwk' })
  return {
    publicKey: concat([0x04], b64uDec(x), b64uDec(y)).toString('base64url'),
    privateKey: d
  }
}

/**
 * Build the `Authorization` header for a push to `endpoint`. The VAPID
 * JWT (RFC 8292) is an ES256-signed token whose `aud` is the push
 * service's origin — it proves to that service the push is from us.
 *
 * @param {string} endpoint  the subscription's push endpoint URL
 * @param {{ publicKey: string, privateKey: string, subject: string }} vapid
 */
export function vapidAuthorization (endpoint, { publicKey, privateKey, subject }) {
  const signingInput =
    b64uEnc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' +
    b64uEnc(JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: subject
    }))

  // Rebuild a signing key from the raw 32-byte private scalar: recover
  // the public point via ECDH, assemble the JWK, sign ES256 (raw r‖s).
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(b64uDec(privateKey))
  const pub = ecdh.getPublicKey()
  const key = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256', d: privateKey,
      x: b64uEnc(pub.subarray(1, 33)),
      y: b64uEnc(pub.subarray(33, 65))
    }
  })
  const jwtSig = b64uEnc(sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }))
  return `vapid t=${signingInput}.${jwtSig}, k=${publicKey}`
}

/**
 * Send one push to `subscription` — encrypt `payload` (any JSON value)
 * for the subscription's keys, attach the VAPID authorization, POST it
 * to the push endpoint. Resolves to the HTTP status: 201 is success;
 * 404 / 410 mean the subscription is dead and should be dropped.
 *
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {*} payload  JSON-serializable notification data
 * @param {{ publicKey: string, privateKey: string, subject: string }} vapid
 */
export async function sendWebPush (subscription, payload, vapid) {
  const body = encryptContent(
    Buffer.from(JSON.stringify(payload)),
    b64uDec(subscription.keys.p256dh),
    b64uDec(subscription.keys.auth)
  )
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400'
    },
    body
  })
  return res.status
}
