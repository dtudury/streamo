import { getPublicKey, signAsync, verify } from './utils/noble-secp256k1.js'

const cryptoSubtle = typeof crypto !== 'undefined' ? crypto.subtle : (await import('crypto')).webcrypto.subtle

/**
 * Derive a deterministic 256-bit private key from (name, password) using PBKDF2-SHA256.
 *
 * Uses deriveBits with an explicit length rather than deriveKey + exportKey: the
 * key length is named in the call rather than relying on a WebCrypto default,
 * so the output is invariant across runtimes. RFC 2898 PBKDF2 with named
 * parameters is the only thing this function depends on.
 *
 * @param {string} name      passed as PBKDF2 salt
 * @param {string} password  passed as PBKDF2 password
 * @param {number} [iterations=100000]
 * @returns {Promise.<string>} hex-encoded 32 bytes
 */
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
