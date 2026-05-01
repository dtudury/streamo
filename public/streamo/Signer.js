import { getPublicKey, signAsync, verify } from './utils/noble-secp256k1.js'

const cryptoSubtle = typeof crypto !== 'undefined' ? crypto.subtle : (await import('crypto')).webcrypto.subtle

/**
 * Derive a deterministic private key from (name, password) using PBKDF2.
 * @param {string} name
 * @param {string} password
 * @param {number} [iterations=100000]
 * @returns {Promise.<string>} hex-encoded key
 */
async function deriveKey (name, password, iterations = 100000) {
  const enc = new TextEncoder()
  const base = await cryptoSubtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey'])
  const key = await cryptoSubtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(name), iterations, hash: 'SHA-256' },
    base,
    { name: 'HMAC', hash: 'SHA-256' },
    true,
    ['sign']
  )
  const raw = new Uint8Array(await cryptoSubtle.exportKey('raw', key))
  return Array.from(raw.slice(32)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256 (uint8Array) {
  return new Uint8Array(await cryptoSubtle.digest('SHA-256', uint8Array))
}

/**
 * Signs stream content using secp256k1.
 * Each stream name gets its own deterministic key pair derived from
 * the user's username and password.
 */
export class Signer {
  #keysByName = {}
  #hashwordPromise
  #iterations

  /**
   * @param {string} username
   * @param {string} password
   * @param {number} [iterations=100000]
   */
  constructor (username, password, iterations = 100000) {
    this.username = username
    this.#iterations = iterations
    this.#hashwordPromise = deriveKey(username, password, iterations)
  }

  /**
   * @param {string} streamName
   * @returns {Promise.<{privateKey: string, publicKey: Uint8Array}>}
   */
  async keysFor (streamName) {
    if (!this.#keysByName[streamName]) {
      const hashword = await this.#hashwordPromise
      const privateKey = await deriveKey(streamName, hashword, this.#iterations)
      const publicKey = getPublicKey(privateKey)
      this.#keysByName[streamName] = { privateKey, publicKey }
    }
    return this.#keysByName[streamName]
  }

  /**
   * @param {string} streamName
   * @param {Uint8Array} bytes
   * @returns {Promise.<Uint8Array>} 64-byte compact signature
   */
  async sign (streamName, bytes) {
    const { privateKey } = await this.keysFor(streamName)
    const hash = await sha256(bytes)
    const sig = await signAsync(hash, privateKey)
    return sig.toCompactRawBytes()
  }
}

/**
 * @param {Uint8Array} publicKey
 * @param {Uint8Array} bytes
 * @param {Uint8Array} compactRawBytes
 * @returns {Promise.<boolean>}
 */
export async function verifySignature (publicKey, bytes, compactRawBytes) {
  try {
    const hash = await sha256(bytes)
    return verify(compactRawBytes, hash, publicKey)
  } catch {
    return false
  }
}
