export class Recaller {
    constructor(name: any);
    loopLimit: number;
    name: any;
    /**
     * Reactive watchers currently registered on this Recaller. The base
     * leak-detection signal: a sequence of operations (subscribe + unsubscribe,
     * `when` + resolve, etc.) should leave this stable. Growing-without-bound
     * across canonical operations indicates a watcher being registered without
     * a matching `unwatch` somewhere.
     *
     * Read-only. Don't mutate from outside.
     */
    get watchCount(): number;
    /**
     * Names of currently-registered watchers, in registration order, with
     * duplicates preserved (multiple watchers can share a name — that's
     * conventional, e.g. `fileSync:await-ready-to-author` could be active
     * once per fileSync invocation). Useful for diagnosing *which* watcher
     * isn't being cleaned up when `watchCount` is growing unexpectedly.
     *
     * Read-only snapshot. Don't mutate from outside.
     *
     * @returns {string[]}
     */
    get watcherNames(): string[];
    /**
     * Call f immediately while tracking any reportKeyAccess calls made during
     * execution. Re-runs f whenever reportKeyMutation is called on a key that
     * was accessed. Each re-run establishes a fresh set of tracked dependencies.
     * @param {string} name
     * @param {function} f
     */
    watch(name: string, f: Function): void;
    unwatch(f: any): void;
    /**
     * Promise-shaped wait for a reactive predicate to become truthy.
     *
     * Returns a promise that resolves once `predicate()` returns a truthy
     * value (immediately if already truthy; otherwise on the first
     * reactive re-run that sees it flip). Cancellation via standard
     * `AbortSignal` — abort and the watcher is torn down + the promise
     * rejects with the signal's reason.
     *
     * The hydroplane move on top of the watch+predicate+gate boilerplate
     * (a 25-line dance of watcher setup, fire-on-flip, cleanup, optional
     * timeout). Caller writes intent — *"await readiness"* — and composes
     * with `Promise.race` / `AbortSignal` for timeout / cancellation.
     *
     * @param {(r: Recaller) => any} predicate  reactive predicate function
     *   (any reportKeyAccess inside subscribes the wait to that key)
     * @param {{ signal?: AbortSignal, name?: string }} [options]
     * @returns {Promise<void>}
     */
    when(predicate: (r: Recaller) => any, { signal, name }?: {
        signal?: AbortSignal;
        name?: string;
    }): Promise<void>;
    reportKeyAccess(target: any, key: any): void;
    reportKeyMutation(target: any, key: any): void;
    #private;
}
