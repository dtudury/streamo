/**
 * @file liveLocation — a LiveSource over `window.location`.
 *
 * Browser-only (uses window.location, addEventListener). The URL is
 * itself a reactive data source: slots reading `loc.get('hash')` (or
 * `loc.proxy.hash`) register on the recaller; mutations via
 * `loc.set('hash', value)` fire it, the browser fires hashchange,
 * subscribers re-run. No separate hashchange listener needed in app
 * code — that wiring is bundled here.
 *
 *   get(key)                       reads window.location[key]
 *   set('hash', v)                 sets the URL hash
 *   set('search', v)               replaces the query-string via pushState
 *   set('pathname', v)             replaces the pathname via pushState
 *   set('searchParams', key, v)    sets/deletes one query param via pushState
 *   set(href)                      navigates to the URL via pushState (no path = href)
 *
 * @see public/apps/location/ — worked example demo
 * @see public/streamo/LiveSource.js — the interface this implements
 */

import { Recaller } from './utils/Recaller.js'

export function liveLocation ({ recaller, name = 'location' } = {}) {
  recaller ??= new Recaller(name)

  // Fire every URL-related key on any change. We don't know which
  // specific key changed, so we fire all — cheap, since consumers
  // only re-run if they actually read one of these.
  const URL_KEYS = ['hash', 'href', 'pathname', 'search', 'host', 'hostname', 'origin', 'protocol', 'port']
  const fireAll = () => {
    for (const k of URL_KEYS) recaller.reportKeyMutation(window.location, k)
  }
  window.addEventListener('hashchange', fireAll)
  window.addEventListener('popstate', fireAll)

  function get (...path) {
    if (path.length === 0) {
      recaller.reportKeyAccess(window.location, 'href')
      return window.location.href
    }
    const key = path[0]
    recaller.reportKeyAccess(window.location, key)
    return window.location[key]
  }

  function set (...args) {
    const value = args.pop()
    const path = args
    if (path.length === 0) {
      // No path → navigate to the URL.
      history.pushState(null, '', value)
      fireAll()
      return
    }
    const key = path[0]
    if (key === 'hash') {
      // Browser fires hashchange → fireAll runs automatically.
      window.location.hash = value
    } else if (key === 'searchParams') {
      const paramKey = path[1]
      const url = new URL(window.location.href)
      if (value === '' || value == null) url.searchParams.delete(paramKey)
      else url.searchParams.set(paramKey, value)
      history.pushState(null, '', url.toString())
      fireAll()
    } else if (key === 'search' || key === 'pathname') {
      const url = new URL(window.location.href)
      url[key] = value
      history.pushState(null, '', url.toString())
      fireAll()
    } else {
      throw new Error(`liveLocation.set: cannot write '${key}' — pick one of hash, search, pathname, or searchParams`)
    }
  }

  // Optional sugar: a Proxy over window.location for ergonomic reads.
  // `loc.proxy.hash` is the equivalent of `loc.get('hash')` — same
  // recaller-access reporting under the hood.
  const proxy = new Proxy(window.location, {
    get (t, key) {
      recaller.reportKeyAccess(t, key)
      const v = t[key]
      return typeof v === 'function' ? v.bind(t) : v
    }
  })

  return { recaller, get, set, proxy }
}
