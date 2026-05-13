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
 * ── Read paths ─────────────────────────────────────────────────────
 *
 *   get(key)                       reads window.location[key]
 *   get('hashParts', N)            Nth segment of the hash split on '/'
 *                                  (e.g. '#/a/b/c' → ['', 'a', 'b', 'c'])
 *   get('hashQuery', K)            query param K, parsing the hash as a
 *                                  '?'-style query string (a=b&c=3)
 *   get('searchParams', K)         query param K of the URL search string
 *
 * ── Write paths ────────────────────────────────────────────────────
 *
 *   set('hash', v)                 sets the URL hash (browser fires
 *                                  hashchange → liveLocation fires)
 *   set('search', v)               replaces the query-string via pushState
 *   set('pathname', v)             replaces the pathname via pushState
 *   set('hashParts', N, v)         replaces segment N in the hash path
 *   set('hashQuery', K, v)         sets/deletes query param K in the hash
 *   set('searchParams', K, v)      sets/deletes query param K in the URL
 *   set(href)                      navigates to the URL via pushState
 *
 * ── Granularity ────────────────────────────────────────────────────
 *
 * On every URL change, liveLocation diffs the old vs. new parsed
 * values and fires ONLY the indices/keys that actually changed.
 * Slots reading `get('hashParts', 2)` re-run only when segment 2
 * changes; slots reading `get('hash')` (the full string) re-run on
 * any hash change. That granularity is what lets multi-segment
 * routes recover per-field reactivity without a shadow-state layer.
 *
 * @see public/apps/location/ — worked example demo
 * @see public/streamo/LiveSource.js — the interface this implements
 */

import { Recaller } from './utils/Recaller.js'

// URL-shaped string keys we fire wholesale on any change.
const URL_KEYS = ['hash', 'href', 'pathname', 'search', 'host', 'hostname', 'origin', 'protocol', 'port']

// Split the hash on '/' after stripping the leading '#'. Empty string
// before the first '/' counts as index 0 — so '#/a/b' yields ['', 'a',
// 'b'] and `hashParts(2)` is 'b'.
function parseHashParts (hash) {
  return (hash || '').replace(/^#/, '').split('/')
}

// Parse the hash as a '?'-style query string (a=b&c=3). Tolerates a
// leading '?' if present right after the '#'. Returns URLSearchParams.
function parseHashQuery (hash) {
  return new URLSearchParams((hash || '').replace(/^#\??/, ''))
}

export function liveLocation ({ recaller, name = 'location' } = {}) {
  recaller ??= new Recaller(name)

  // Cached parses, kept in sync via syncAndFire on every URL change.
  // Diffing against these is what gives per-index / per-key
  // granularity — we fire ONLY the changed slots.
  let cachedHashParts = parseHashParts(window.location.hash)
  let cachedHashQuery = parseHashQuery(window.location.hash)
  let cachedSearchParams = new URLSearchParams(window.location.search)
  let cachedTopLevel = readTopLevel()

  function readTopLevel () {
    const out = {}
    for (const k of URL_KEYS) out[k] = window.location[k]
    return out
  }

  function fireKey (key) {
    recaller.reportKeyMutation(window.location, key)
  }

  // Diff the cached parses against the live URL, fire only what
  // actually changed. Called from hashchange / popstate listeners
  // and after every pushState-based write.
  function syncAndFire () {
    // Top-level string keys (hash, href, pathname, …)
    const nextTopLevel = readTopLevel()
    for (const k of URL_KEYS) {
      if (cachedTopLevel[k] !== nextTopLevel[k]) fireKey(k)
    }
    cachedTopLevel = nextTopLevel

    // hashParts — per-index granularity
    const nextHashParts = parseHashParts(window.location.hash)
    const maxParts = Math.max(cachedHashParts.length, nextHashParts.length)
    for (let i = 0; i < maxParts; i++) {
      if (cachedHashParts[i] !== nextHashParts[i]) fireKey(`hashParts.${i}`)
    }
    cachedHashParts = nextHashParts

    // hashQuery — per-key granularity
    const nextHashQuery = parseHashQuery(window.location.hash)
    diffParams(cachedHashQuery, nextHashQuery, k => fireKey(`hashQuery.${k}`))
    cachedHashQuery = nextHashQuery

    // searchParams — per-key granularity
    const nextSearchParams = new URLSearchParams(window.location.search)
    diffParams(cachedSearchParams, nextSearchParams, k => fireKey(`searchParams.${k}`))
    cachedSearchParams = nextSearchParams
  }

  window.addEventListener('hashchange', syncAndFire)
  window.addEventListener('popstate', syncAndFire)

  function get (...path) {
    if (path.length === 0) {
      recaller.reportKeyAccess(window.location, 'href')
      return window.location.href
    }
    const [key, ...rest] = path
    if (key === 'hashParts') {
      const index = rest[0]
      recaller.reportKeyAccess(window.location, `hashParts.${index}`)
      return cachedHashParts[index]
    }
    if (key === 'hashQuery') {
      const k = rest[0]
      recaller.reportKeyAccess(window.location, `hashQuery.${k}`)
      return cachedHashQuery.get(k)
    }
    if (key === 'searchParams') {
      const k = rest[0]
      recaller.reportKeyAccess(window.location, `searchParams.${k}`)
      return cachedSearchParams.get(k)
    }
    recaller.reportKeyAccess(window.location, key)
    return window.location[key]
  }

  function set (...args) {
    const value = args.pop()
    const path = args
    if (path.length === 0) {
      // No path → navigate to the URL.
      history.pushState(null, '', value)
      syncAndFire()
      return
    }
    const [key, ...rest] = path
    if (key === 'hash') {
      // Browser fires hashchange → syncAndFire runs automatically.
      window.location.hash = value
      return
    }
    if (key === 'hashParts') {
      const index = rest[0]
      const parts = parseHashParts(window.location.hash)
      while (parts.length <= index) parts.push('')
      parts[index] = String(value)
      window.location.hash = '#' + parts.join('/')
      return
    }
    if (key === 'hashQuery') {
      const k = rest[0]
      const q = parseHashQuery(window.location.hash)
      if (value === '' || value == null) q.delete(k)
      else q.set(k, value)
      window.location.hash = '#' + q.toString()
      return
    }
    if (key === 'searchParams') {
      const k = rest[0]
      const url = new URL(window.location.href)
      if (value === '' || value == null) url.searchParams.delete(k)
      else url.searchParams.set(k, value)
      history.pushState(null, '', url.toString())
      syncAndFire()
      return
    }
    if (key === 'search' || key === 'pathname') {
      const url = new URL(window.location.href)
      url[key] = value
      history.pushState(null, '', url.toString())
      syncAndFire()
      return
    }
    throw new Error(`liveLocation.set: cannot write '${key}' — pick one of hash, hashParts, hashQuery, search, pathname, searchParams`)
  }

  // Optional sugar: a Proxy over window.location for ergonomic reads.
  // `loc.proxy.hash` is the equivalent of `loc.get('hash')` — same
  // recaller-access reporting under the hood. (hashParts / hashQuery /
  // searchParams aren't reflected here — use get() for those.)
  const proxy = new Proxy(window.location, {
    get (t, key) {
      recaller.reportKeyAccess(t, key)
      const v = t[key]
      return typeof v === 'function' ? v.bind(t) : v
    }
  })

  return { recaller, get, set, proxy }
}

// Diff two URLSearchParams instances by key. Fires onChange(key) for
// each key whose value differs between `before` and `after`.
function diffParams (before, after, onChange) {
  const seen = new Set()
  for (const [k, v] of after) {
    seen.add(k)
    if (before.get(k) !== v) onChange(k)
  }
  for (const [k] of before) {
    if (!seen.has(k)) onChange(k)
  }
}
