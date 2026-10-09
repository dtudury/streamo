/** Creates 33/65-byte public key from 32-byte private key. */
export function getPublicKey(privKey: any, isCompressed?: boolean): Uint8Array<any>;
/**
 * Sign a msg hash using secp256k1.
 * It is advised to use `extraEntropy: true` (from RFC6979 3.6) to prevent fault attacks.
 * Worst case: if randomness source for extraEntropy is bad, it would be as secure as if
 * the option has not been used.
 * @param msgh - message HASH, not message itself e.g. sha256(message)
 * @param priv - private key
 * @param opts - `lowS: true` to prevent malleability (s >= CURVE.n/2), `extraEntropy: boolean | Hex` to improve sig security.
 * @example
 * const sig = sign(sha256('hello'), privKey, { extraEntropy: true }).toCompactRawBytes();
 */
export function sign(msgh: any, priv: any, opts?: {
    lowS: boolean;
}): any;
/** ECDSA signature generation. via secg.org/sec1-v2.pdf 4.1.2 + RFC6979 deterministic k. */
/**
 * Sign a msg hash using secp256k1. Async.
 * It is advised to use `extraEntropy: true` (from RFC6979 3.6) to prevent fault attacks.
 * Worst case: if randomness source for extraEntropy is bad, it would be as secure as if
 * the option has not been used.
 * @param msgh - message HASH, not message itself e.g. sha256(message)
 * @param priv - private key
 * @param opts - `lowS: true` to prevent malleability (s >= CURVE.n/2), `extraEntropy: boolean | Hex` to improve sig security.
 */
export function signAsync(msgh: any, priv: any, opts?: {
    lowS: boolean;
}): Promise<any>;
/**
 * Verify a signature using secp256k1.
 * @param sig - signature, 64-byte or Signature instance
 * @param msgh - message HASH, not message itself e.g. sha256(message)
 * @param pub - public key
 * @param opts - { lowS: true } is default, prohibits s >= CURVE.n/2 to prevent malleability
 */
export function verify(sig: any, msgh: any, pub: any, opts?: {
    lowS: boolean;
}): boolean;
export namespace CURVE {
    export { P as p };
    export { N as n };
    export let a: bigint;
    export let b: bigint;
    export { Gx };
    export { Gy };
}
/**
 * Elliptic Curve Diffie-Hellman (ECDH) on secp256k1.
 * Result is **NOT hashed**. Use hash on it if you need.
 * @param privA private key A
 * @param pubB public key B
 * @param isCompressed 33-byte or 65-byte output
 * @returns public key C
 */
export function getSharedSecret(privA: any, pubB: any, isCompressed?: boolean): Uint8Array<any>;
export namespace etc {
    export { h2b as hexToBytes };
    export { b2h as bytesToHex };
    export { concatB as concatBytes };
    export { b2n as bytesToNumberBE };
    export { n2b as numberToBytesBE };
    export { M as mod };
    export { inv as invert };
    export function hmacSha256Async(key: any, ...msgs: any[]): Promise<Uint8Array<any>>;
    export { _hmacSync as hmacSha256Sync };
    export { hashToPrivateKey };
    export function randomBytes(len?: number): Uint8Array<any>;
}
export namespace utils {
    export { toPriv as normPrivateKeyToScalar };
    export function isValidPrivateKey(key: any): boolean;
    export function randomPrivateKey(): Uint8Array<any>;
    export function precompute(w?: number, p?: Point): Point;
}
/** Point in 3d xyz projective coordinates. 3d takes less inversions than 2d. */
declare class Point {
    /** Create 3d xyz point from 2d xy. (0, 0) => (0, 1, 0), not (0, 0, 1) */
    static fromAffine(p: any): Point;
    /** Convert Uint8Array or hex string to Point. */
    static fromHex(hex: any): Point;
    /** Create point from a private key. */
    static fromPrivateKey(k: any): Point;
    constructor(px: any, py: any, pz: any);
    px: any;
    py: any;
    pz: any;
    get x(): any;
    get y(): any;
    /** Equality check: compare points P&Q. */
    equals(other: any): boolean;
    /** Flip point over y coordinate. */
    negate(): Point;
    /** Point doubling: P+P, complete formula. */
    double(): Point;
    /**
     * Point addition: P+Q, complete, exception-free formula
     * (Renes-Costello-Batina, algo 1 of [2015/1060](https://eprint.iacr.org/2015/1060)).
     * Cost: 12M + 0S + 3*a + 3*b3 + 23add.
     */
    add(other: any): Point;
    mul(n: any, safe?: boolean): Point;
    mulAddQUns(R: any, u1: any, u2: any): Point;
    /** Convert point to 2d xy affine point. (x, y, z) ∋ (x=x/z, y=y/z) */
    toAffine(): {
        x: any;
        y: any;
    };
    /** Checks if the point is valid and on-curve. */
    assertValidity(): this;
    multiply(n: any): Point;
    aff(): {
        x: any;
        y: any;
    };
    ok(): this;
    toHex(isCompressed?: boolean): string;
    toRawBytes(isCompressed?: boolean): Uint8Array<any>;
}
declare namespace Point {
    let BASE: Point;
    let ZERO: Point;
}
/** ECDSA Signature class. Supports only compact 64-byte representation, not DER. */
export class Signature {
    /** Create signature from 64b compact (r || s) representation. */
    static fromCompact(hex: any): Signature;
    constructor(r: any, s: any, recovery: any);
    r: any;
    s: any;
    recovery: any;
    assertValidity(): this;
    /** Create new signature, with added recovery bit. */
    addRecoveryBit(rec: any): Signature;
    hasHighS(): boolean;
    normalizeS(): Signature;
    /** ECDSA public key recovery. Requires msg hash and recovery id. */
    recoverPublicKey(msgh: any): Point;
    /** Uint8Array 64b compact (r || s) representation. */
    toCompactRawBytes(): Uint8Array<any>;
    /** Hex string 64b compact (r || s) representation. */
    toCompactHex(): string;
}
declare const P: bigint;
declare const N: bigint;
declare const Gx: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
declare const Gy: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
declare function h2b(hex: any): Uint8Array<any>;
declare function b2h(b: any): string;
declare function concatB(...arrs: any[]): Uint8Array<any>;
declare function b2n(b: any): bigint;
declare function n2b(num: any): Uint8Array<any>;
declare function M(a: any, b?: bigint): bigint;
declare function inv(num: any, md: any): bigint;
declare let _hmacSync: any;
declare function hashToPrivateKey(hash: any): Uint8Array<any>;
declare function toPriv(p: any): any;
export { Point as ProjectivePoint };
