// location — a streamo-style reactive app with no Streamo at all.
//
// The point of this demo: h + mount + Recaller compose independently
// of any data layer. Here the only reactive data source is the URL
// itself, wrapped in a "live source" — a Proxy over window.location
// paired with a Recaller. The proxy reports reads to the recaller;
// hashchange and popstate events fire the recaller; setter helpers
// perform mutations and fire too. Anywhere h's slot pulls from the
// proxy, the slot re-runs when the URL changes.
//
// Generalize: liveSource(target) wraps any object the same way.
// LiveData, ReactiveSource, RecallingSource, SignalSource — all
// reasonable names for this pattern. The shape is:
//
//   { recaller, proxy, …mutators }
//
// and h/mount only know about the recaller. The data shape is
// interchangeable; this app proves it by being entirely useful
// without Streamo's content-addressed machinery.

import { h }        from '../../streamo/h.js'
import { mount }    from '../../streamo/mount.js'
import { Recaller } from '../../streamo/utils/Recaller.js'

// ── liveSource ───────────────────────────────────────────────────────
//
// Generic factory: wrap any object as a reactive source. The proxy
// reports `reportKeyAccess` on every property read; the returned
// recaller is what watchers register on. Callers are responsible
// for firing `reportKeyMutation` when the underlying object changes
// — for window.location that means wiring hashchange and popstate.

function liveSource (target, name = 'source') {
  const recaller = new Recaller(name)
  const proxy = new Proxy(target, {
    get (t, key) {
      recaller.reportKeyAccess(t, key)
      const v = t[key]
      // bind methods so `proxy.method()` doesn't crash on `this` checks
      return typeof v === 'function' ? v.bind(t) : v
    }
  })
  return { recaller, proxy, target }
}

// Specific to window.location — wires the browser's change events to
// the recaller so popstate / hashchange / pushState-via-mutator all
// reactively update consumers.

function liveLocation () {
  const src = liveSource(window.location, 'location')
  // Fire every URL-related key on any change. We don't know which
  // specific key changed, so we fire all of them — cheap, since
  // consumers only re-run if they actually read one of these.
  const fireAll = () => {
    for (const k of ['hash', 'href', 'pathname', 'search', 'host', 'hostname', 'origin', 'protocol', 'port']) {
      src.recaller.reportKeyMutation(window.location, k)
    }
  }
  window.addEventListener('hashchange', fireAll)
  window.addEventListener('popstate', fireAll)
  return {
    ...src,
    // Setter helpers. Browser-initiated changes fire events
    // automatically; pushState does not, so we fire manually.
    setHash (hash) {
      // Assigning location.hash fires hashchange → fireAll runs.
      window.location.hash = hash
    },
    setSearchParam (key, value) {
      const url = new URL(window.location.href)
      if (value === '' || value == null) url.searchParams.delete(key)
      else url.searchParams.set(key, value)
      history.pushState(null, '', url.toString())
      fireAll()
    },
    go (url) {
      history.pushState(null, '', url)
      fireAll()
    }
  }
}

// ── app ──────────────────────────────────────────────────────────────

const loc = liveLocation()

function setHashHandler (e) {
  e.preventDefault()
  const input = e.target.elements.hash
  loc.setHash(input.value.trim())
  input.value = ''
}

function setParamHandler (e) {
  e.preventDefault()
  const f = e.target
  const key = f.elements.key.value.trim()
  if (!key) return
  loc.setSearchParam(key, f.elements.value.value.trim())
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
    <button class="link" onclick=${() => () => loc.go('?demo=on&color=blue#welcome')}>?demo=on&amp;color=blue#welcome</button>
  </p>
`, document.body, loc.recaller)
