// location — a streamo-style reactive app with no Streamo at all.
//
// The point of this demo: h + mount + Recaller compose independently
// of any data layer. The only reactive data source here is the URL
// itself, wrapped as a LiveSource — `{recaller, get, set}` plus an
// optional `proxy` for ergonomic reads. The interface lives at
// `/streamo/LiveSource.js`; this app is its worked example for a
// domain that needs more than the generic `liveObject` adapter
// (browser event wiring, three different mutation paths).
//
// LiveSource interface:
//   recaller        — what mount() and h slots register on
//   get(...path)    — reactive read; reports access on the recaller
//   set(...path, v) — mutation; fires the recaller
//   proxy           — optional sugar (`loc.proxy.hash`)
//
// Streamo and Repo already implement this; here we implement it for
// window.location.

import { h }        from '../../streamo/h.js'
import { mount }    from '../../streamo/mount.js'
import { Recaller } from '../../streamo/utils/Recaller.js'

// ── liveLocation — a LiveSource over window.location ─────────────────
//
// get(key)         reads window.location[key]
// set('hash', v)   sets the URL hash (fires hashchange automatically)
// set('search', v) replaces the query-string via pushState
// set('pathname', v) replaces the pathname via pushState
// set('searchParams', key, v) sets/deletes one query param via pushState
// set(href)        navigates to the URL via pushState (no path = href)

function liveLocation () {
  const recaller = new Recaller('location')

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

// ── app ──────────────────────────────────────────────────────────────

const loc = liveLocation()

function setHashHandler (e) {
  e.preventDefault()
  const input = e.target.elements.hash
  loc.set('hash', input.value.trim())
  input.value = ''
}

function setParamHandler (e) {
  e.preventDefault()
  const f = e.target
  const key = f.elements.key.value.trim()
  if (!key) return
  loc.set('searchParams', key, f.elements.value.value.trim())
  f.elements.key.value = ''
  f.elements.value.value = ''
}

mount(h`
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    :root {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 15px;
      color: #1c1917;
    }
    body {
      max-width: 40rem;
      margin: 0 auto;
      padding: 2.5rem 1.25rem;
      line-height: 1.55;
    }

    .brand-lockup {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      color: inherit;
      text-decoration: none;
      font-weight: 600;
      font-size: 1.4rem;
    }
    .brand-lockup img {
      width: 1.6rem;
      height: 1.6rem;
    }
    .brand-lockup:hover {
      opacity: 0.85;
    }
    .page-title {
      font-weight: 400;
      color: #888;
      letter-spacing: .04em;
      font-size: 0.9rem;
      margin-left: 0.5rem;
    }
    .page-title::before {
      content: '· ';
      opacity: 0.5;
    }
    h1 {
      display: flex;
      align-items: baseline;
      margin-bottom: 0.4rem;
    }

    .tagline {
      color: #666;
      font-size: 0.92rem;
      margin-bottom: 0.4rem;
    }
    .tagline code {
      font-family: monospace;
      background: #f5f5f5;
      padding: 0 0.3rem;
      border-radius: 3px;
      font-size: 0.85em;
    }
    .note {
      color: #888;
      font-size: 0.78rem;
      margin-bottom: 2rem;
      line-height: 1.5;
    }

    h2 {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #888;
      margin: 1.75rem 0 0.65rem;
      font-weight: 500;
    }

    /* Live URL display — each definition is a reactive cell that
       reads from the proxy; updates whenever the recaller fires. */
    .props {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.3rem 0.9rem;
      align-items: baseline;
    }
    .props dt {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #888;
      font-weight: 500;
    }
    .props dd {
      font-family: monospace;
      font-size: 0.85rem;
      word-break: break-all;
      background: #f7f7f7;
      padding: 0.3rem 0.5rem;
      border-radius: 4px;
      color: #1c1917;
    }
    .props dd.empty {
      color: #999;
      font-style: italic;
    }

    .form {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 0.6rem;
    }
    .form label {
      font-size: 0.78rem;
      color: #666;
      min-width: 5rem;
    }
    .form input {
      padding: 0.45rem 0.7rem;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 0.95rem;
      font-family: inherit;
      min-width: 0;
      flex: 1 1 8rem;
    }
    .form input:focus {
      outline: none;
      border-color: #1d4ed8;
    }
    .form button {
      padding: 0.45rem 0.95rem;
      background: #1d4ed8;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 0.9rem;
      cursor: pointer;
      font-family: inherit;
    }
    .form button:hover {
      opacity: 0.88;
    }

    .nav-row {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.6rem;
    }
    .nav-row button {
      padding: 0.45rem 0.95rem;
      background: white;
      color: #1c1917;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 0.9rem;
      cursor: pointer;
      font-family: inherit;
    }
    .nav-row button:hover {
      border-color: #1c1917;
    }
    .example {
      font-size: 0.85rem;
      color: #666;
    }
    .example button.link {
      background: none;
      border: none;
      color: #1d4ed8;
      font-family: monospace;
      font-size: 0.85rem;
      cursor: pointer;
      padding: 0;
      text-decoration: underline dotted;
    }
    .example button.link:hover {
      text-decoration-style: solid;
    }
  </style>

  <h1>
    <a class="brand-lockup" href="../../" title="streamo home">
      <img src="../../streamo.svg" alt="">streamo
    </a>
    <span class="page-title">location</span>
  </h1>
  <p class="tagline">A reactive app with no Streamo, no signer, no peer sync. The only data source is <code>window.location</code>, wrapped in a <strong>live source</strong> — a Proxy + a Recaller.</p>
  <p class="note">Edit the URL with the controls below, or with your browser's back/forward buttons. The live URL section above re-renders automatically because the recaller fires on every <code>hashchange</code> and <code>popstate</code>. Same h + mount machinery the other apps use; nothing under it is streamo-specific.</p>

  <h2>live URL</h2>
  <dl class="props">
    <dt>href</dt>
    <dd>${() => loc.proxy.href}</dd>
    <dt>hash</dt>
    <dd class=${() => loc.proxy.hash ? '' : 'empty'}>${() => loc.proxy.hash || '(none)'}</dd>
    <dt>pathname</dt>
    <dd>${() => loc.proxy.pathname}</dd>
    <dt>search</dt>
    <dd class=${() => loc.proxy.search ? '' : 'empty'}>${() => loc.proxy.search || '(none)'}</dd>
    <dt>host</dt>
    <dd>${() => loc.proxy.host}</dd>
  </dl>

  <h2>edit</h2>
  <form class="form" onsubmit=${() => setHashHandler}>
    <label>set hash</label>
    <input name="hash" placeholder="section-name" autocomplete="off">
    <button>apply</button>
  </form>
  <form class="form" onsubmit=${() => setParamHandler}>
    <label>set ?key=val</label>
    <input name="key" placeholder="key" autocomplete="off">
    <input name="value" placeholder="value (empty to delete)" autocomplete="off">
    <button>apply</button>
  </form>

  <h2>navigate</h2>
  <div class="nav-row">
    <button onclick=${() => () => history.back()}>← back</button>
    <button onclick=${() => () => history.forward()}>forward →</button>
  </div>
  <p class="example">
    Or jump to an example URL:
    <button class="link" onclick=${() => () => loc.set('?demo=on&color=blue#welcome')}>?demo=on&amp;color=blue#welcome</button>
  </p>
`, document.body, loc.recaller)
