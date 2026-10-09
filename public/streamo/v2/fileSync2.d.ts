/**
 * @param {object} options
 * @param {import('./Hub.js').Hub} options.hub
 * @param {string} options.rootKey
 * @param {string} [options.folder]
 * @param {(rel: string) => boolean} [options.ignore]
 * @param {import('../Signer.js').Signer|null} [options.signer]
 * @param {string|null} [options.signerName]
 * @param {boolean} [options.upstream]  this folder is where canon comes from
 */
export function fileSync2({ hub, rootKey, folder: folderPath, ignore, signer, signerName, upstream }: {
    hub: import("./Hub.js").Hub;
    rootKey: string;
    folder?: string;
    ignore?: (rel: string) => boolean;
    signer?: import("../Signer.js").Signer | null;
    signerName?: string | null;
    upstream?: boolean;
}): Promise<{
    folder: string;
    settled: () => Promise<void>;
    unsubscribe: () => Promise<void>;
}>;
