/**
 * @param {Uint8Array} publicKey
 * @param {Uint8Array} bytes
 * @param {Uint8Array} compactRawBytes
 * @returns {Promise.<boolean>}
 */
export function verifySignature(publicKey: Uint8Array, bytes: Uint8Array, compactRawBytes: Uint8Array): Promise<boolean>;
/**
 * Signs stream content using secp256k1.
 * Each stream name gets its own deterministic key pair derived from
 * the user's username and password.
 */
export class Signer {
    /**
     * @param {string} username
     * @param {string} password
     * @param {number} [iterations=100000]
     */
    constructor(username: string, password: string, iterations?: number);
    username: string;
    /**
     * @param {string} streamName
     * @returns {Promise.<{privateKey: string, publicKey: Uint8Array}>}
     */
    keysFor(streamName: string): Promise<{
        privateKey: string;
        publicKey: Uint8Array;
    }>;
    /**
     * @param {string} streamName
     * @param {Uint8Array} bytes
     * @returns {Promise.<Uint8Array>} 64-byte compact signature
     */
    sign(streamName: string, bytes: Uint8Array): Promise<Uint8Array>;
    #private;
}
