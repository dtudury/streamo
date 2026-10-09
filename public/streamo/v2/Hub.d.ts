export class Hub {
    /** @param {{ recaller: import('../utils/Recaller.js').Recaller }} options */
    constructor({ recaller }: {
        recaller: import("../utils/Recaller.js").Recaller;
    });
    recaller: import("../utils/Recaller.js").Recaller;
    keys(): Generator<any, void, unknown>;
    hasMirror(key: any): boolean;
    getMirror(key: any): any;
    /**
     * A read-only window on the draft, or null. Shares the draft's chunk store,
     * so it tracks every edit without being able to make one — the writable
     * handle exists once and `checkout` is the only thing that hands it out.
     * Cached, because a fresh object per call would break identity for anything
     * comparing against what it last saw.
     */
    getDraft(key: any): any;
    getCurrent(key: any): any;
    checkout(key: any, signer: any, signerName: any): any;
    #private;
}
