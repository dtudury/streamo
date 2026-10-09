/**
 * Read a chunk's parts. The footer names the codec and, as a mixed-radix
 * offset from its baseFooter, which reader each part uses. A part is either
 * an address (a reference to another chunk) or literal data embedded in this
 * chunk. Exported 2026-10-07 because CodecRegistry.copyFrom needs the same
 * walk — it had its own copy of this loop, line for line.
 * @param {any} r
 * @param {Uint8Array} code
 * @returns {Array<{ type: string, width: number, address?: number, getCode?: function, getDecoded: function }>}
 */
export function decodeParts(r: any, code: Uint8Array): Array<{
    type: string;
    width: number;
    address?: number;
    getCode?: Function;
    getDecoded: Function;
}>;
export function makeCodecs(): {
    UNDEFINED: {
        encode: (r: any, v: any) => Uint8Array<ArrayBuffer>;
        decode: () => any;
    };
    NULL: {
        encode: (r: any, v: any) => Uint8Array<ArrayBuffer>;
        decode: () => any;
    };
    FALSE: {
        encode: (r: any, v: any) => Uint8Array<ArrayBuffer>;
        decode: () => boolean;
    };
    TRUE: {
        encode: (r: any, v: any) => Uint8Array<ArrayBuffer>;
        decode: () => boolean;
    };
    WORD: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            getDecoded: () => any;
        })[][];
        encode(r: any, v: any): Uint8Array<any>;
        decode(r: any, code: any): any;
    };
    UINT8ARRAY: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            address: number;
            getCode: () => any;
            getDecoded: (asRefs: any) => any;
        })[][];
        encode(r: any, v: any): Uint8Array<any>;
        decode(r: any, code: any): Uint8Array<any>;
    };
    EMPTY_STRING: {
        encode: (r: any, v: any) => Uint8Array<ArrayBuffer>;
        decode: () => string;
    };
    STRING: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            address: number;
            getCode: () => any;
            getDecoded: (asRefs: any) => any;
        })[][];
        encode(r: any, v: any): Uint8Array<any>;
        decode(r: any, code: any): string;
    };
    UINT7: {
        partReaders: (() => {
            type: string;
            width: number;
            getDecoded: () => Uint8Array<ArrayBuffer>;
        })[][];
        encode(r: any, v: any): Uint8Array<ArrayBuffer>;
        decode(r: any, code: any): any;
    };
    FLOAT64: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            address: number;
            getCode: () => any;
            getDecoded: (asRefs: any) => any;
        })[][];
        encode(r: any, v: any): Uint8Array<any>;
        decode(r: any, code: any): number;
    };
    DATE: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            address: number;
            getCode: () => any;
            getDecoded: (asRefs: any) => any;
        })[][];
        encode(r: any, v: any): Uint8Array<any>;
        decode(r: any, code: any): Date;
    };
    SIGNATURE: {
        getWidth: () => number;
        encode(r: any, v: any): Uint8Array<any>;
        decode(r: any, code: any): Signature;
    };
    DUPLE: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            address: number;
            getCode: () => any;
            getDecoded: (asRefs: any) => any;
        })[][];
        encode(r: any, v: any, asRefs: any): Uint8Array<any>;
        decode(r: any, code: any, asRefs: any): Duple;
    };
    EMPTY_ARRAY: {
        encode: (r: any, v: any) => Uint8Array<ArrayBuffer>;
        decode: () => any[];
    };
    ARRAY: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            address: number;
            getCode: () => any;
            getDecoded: (asRefs: any) => any;
        })[][];
        encode(r: any, v: any, asRefs: any): Uint8Array<any>;
        decode(r: any, code: any, asRefs: any): any;
    };
    EMPTY_OBJECT: {
        encode(r: any, v: any): Uint8Array<ArrayBuffer>;
        decode: () => {};
    };
    OBJECT: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            address: number;
            getCode: () => any;
            getDecoded: (asRefs: any) => any;
        })[][];
        encode(r: any, v: any, asRefs: any): Uint8Array<any>;
        decode(r: any, code: any, asRefs: any): {
            [k: string]: any;
        };
    };
    EMPTY_UINT8ARRAY: {
        encode: (r: any, v: any) => Uint8Array<ArrayBuffer>;
        decode: () => Uint8Array<ArrayBuffer>;
    };
    OPAQUE: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            getDecoded: () => Uint8Array<any>;
        })[][];
        encode(r: any, v: any): Uint8Array<any>;
        decode(r: any, code: any): Opaque;
    };
    SINGLE_ARRAY: {
        partReaders: ((r: any, code: any) => {
            type: string;
            width: number;
            address: number;
            getCode: () => any;
            getDecoded: (asRefs: any) => any;
        })[][];
        encode(r: any, v: any, asRefs: any): Uint8Array<any>;
        decode(r: any, code: any, asRefs: any): any[];
    };
};
export function isPlainObject(value: any): any;
import { Signature } from './Signature.js';
/**
 * Balanced binary tree node — internal to this file.
 * Arrays and objects are encoded as trees of these nodes.
 * Not exported; callers always work with plain arrays and objects.
 */
declare class Duple {
    constructor(items: any);
    v: any;
    flat(): any;
    flatDuples(): any[];
}
import { Opaque } from './Opaque.js';
export {};
