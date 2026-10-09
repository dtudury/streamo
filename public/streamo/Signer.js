import { getPublicKey, signAsync, verify } from './utils/noble-secp256k1.js'

const cryptoSubtle = /** @type {SubtleCrypto} */ (typeof crypto !== 'undefined' ? crypto.subtle : (await import('crypto')).webcrypto.subtle)

async function deriveKey (name, password, iterations = 100000) {
  const enc = new TextEncoder()
  const base = await cryptoSubtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await cryptoSubtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(name), iterations, hash: 'SHA-256' },
    base,
    256
  )
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256 (uint8Array) {
  return new Uint8Array(await cryptoSubtle.digest('SHA-256', uint8Array))
}

export class Signer {
  #keysByName = {}
  #hashwordPromise
  #iterations

  constructor (username, password, iterations = 100000) {
    this.username = username
    this.#iterations = iterations
    this.#hashwordPromise = deriveKey(username, password, iterations)
  }

  async keysFor (streamName) {
    if (!this.#keysByName[streamName]) {
      const hashword = await this.#hashwordPromise
      const privateKey = await deriveKey(streamName, hashword, this.#iterations)
      const publicKey = getPublicKey(privateKey)
      this.#keysByName[streamName] = { privateKey, publicKey }
    }
    return this.#keysByName[streamName]
  }

  async sign (streamName, bytes) {
    const { privateKey } = await this.keysFor(streamName)
    const hash = await sha256(bytes)
    const sig = await signAsync(hash, privateKey)
    return sig.toCompactRawBytes()
  }
}

export async function verifySignature (publicKey, bytes, compactRawBytes) {
  try {
    const hash = await sha256(bytes)
    return verify(compactRawBytes, hash, publicKey)
  } catch {
    return false
  }
}
