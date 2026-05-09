/**
 * @file bridgeRegistry — connect a multi-repo registry to an app Recaller.
 *
 * Each Repo has its own Recaller so it can track fine-grained dependencies
 * on its own internal keys. An app that uses many Repos has its own
 * different Recaller for its mount() slots. Reading repo.byteLength inside
 * a slot registers a dep on the *repo's* recaller, not the app's, so
 * without an explicit bridge the slot would never re-run when chunks
 * arrive at the repo.
 *
 * bridgeRegistry sets up that bridge once: it watches every repo in the
 * registry (existing and future) for chunk arrivals and forwards them as
 * a single signal on the app recaller. The returned `dep` function is
 * what slots call to register on that signal — call it inside any
 * reactive cell that should re-run on any-repo-changed.
 *
 *   const recaller = new Recaller('app')
 *   const { dep, fire } = bridgeRegistry(registry, recaller)
 *
 *   mount(h`${() => {
 *     dep()
 *     for (const [k, r] of registry) ...   // freely read any repo's state
 *   }}`, appEl, recaller)
 *
 *   // Non-repo state changes (route, async results, etc.) — call fire()
 *   // to force a re-render; the slot re-runs at next tick.
 *   window.addEventListener('hashchange', fire)
 *
 * Mutation is synchronous so multiple mutations in a tick coalesce via the
 * Recaller's own nextTick flush — one slot re-run per tick regardless of
 * how many chunks arrive. Don't wrap fire() in requestAnimationFrame:
 * when the tab loses focus, queued rAFs throttle and the display freezes
 * (we learned this the hard way; see the design.md cross-recaller note).
 *
 * @param {import('./RepoRegistry.js').RepoRegistry} registry
 * @param {import('./utils/Recaller.js').Recaller} recaller
 * @param {string} [name='bridge']  used in watch names for debugging
 * @returns {{dep: () => void, fire: () => void}}
 *   `dep()` registers the calling reactive cell as depending on bridge state.
 *   `fire()` forces the slot to re-run at next tick — useful for app-level
 *   state changes (route, async results, tab switches) that aren't repo
 *   mutations the bridge already forwards.
 */
export function bridgeRegistry (registry, recaller, name = 'bridge') {
  const signal = {}
  const watched = new Set()

  const fire = () => recaller.reportKeyMutation(signal, 'data')
  const dep  = () => recaller.reportKeyAccess(signal, 'data')

  function watchRepo (keyHex, repo) {
    if (watched.has(keyHex)) return
    watched.add(keyHex)
    repo.watch(`${name}:${keyHex}`, () => {
      repo.byteLength  // register 'length' dep — fires on every chunk
      fire()
    })
  }

  for (const [k, r] of registry) watchRepo(k, r)
  registry.onOpen((k, r) => { watchRepo(k, r); fire() })

  return { dep, fire }
}
