/**
 * Tagged template literal — parses the template into a virtual tree.
 * @param {TemplateStringsArray} strings
 * @param {...any} values
 * @returns {Array} array of HElement / HText / slot values
 */
export function h(strings: TemplateStringsArray, ...values: any[]): any[];
/**
 * Memoize a function-component so it returns a cached output when invoked
 * with shallowly-equal props. Use sparingly and carefully:
 *
 *   const Header = memo(({ title }) => h`<h1>${title}</h1>`)
 *
 * **Safety contract:** the wrapped function's body must NOT read reactive
 * state (no `.get()` on a Recaller-backed source, no `liveValue.get()`,
 * no `StreamoRecord.get(...)`). If it does, memoizing by props alone returns a
 * stale tree when reactive state changes without props changing — there's
 * no per-component subscription tracking to invalidate the cache. It IS
 * safe to compose a memoized component with non-memoized children: inner
 * function-components are still invoked fresh on each render even when
 * the outer is memoized.
 *
 * **Scope:** this is single-instance memoization. The wrapper closes
 * over one `lastProps`/`lastOutput` pair, so it thrashes when used as
 * the function-component for items in a list (each invocation with
 * different props overwrites the slot). Per-instance memoization
 * across a list needs a per-key cache that's coupled to mount's
 * identity tracking — out of scope for this helper today.
 *
 * Comparison is shallow (`Object.is`-style on each own key); add an
 * extra layer if you need deeper equality.
 *
 * @param {Function} fn function-component
 * @returns {Function} memoized wrapper
 */
export function memo(fn: Function): Function;
export class HElement {
    constructor(tag: any, attrs: any, children: any);
    tag: any;
    attrs: any;
    children: any;
}
export class HText {
    constructor(value: any);
    value: any;
}
export function handle(fn: (event: Event, element: Element) => any): (element: Element) => (event: Event) => void;
