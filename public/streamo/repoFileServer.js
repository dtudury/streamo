/**
 * @file repoFileServer — Express middleware that serves files from a StreamoRecord.
 *
 * The inverse of fileSync's read pass: where fileSync turns a folder into a
 * flat { relPath: value } map and commits it to a StreamoRecord, this middleware
 * reads that same shape back out and responds to HTTP requests.
 *
 * StreamoRecord shape is `{ files: { ...flatMap } }` — a `files` key inside the
 * value, leaving room for other metadata (`mounts`, `title`, `members`,
 * etc.) alongside it.
 *
 * HTML responses optionally get an importmap injected that resolves
 * `@dtudury/streamo` and `@dtudury/streamo/*` to URLs the host can serve
 * the library from. This is the seam that lets a homepage StreamoRecord's HTML stay
 * truly host-agnostic — the page writes bare specifiers, the relay binds
 * them at serve time.
 *
 * ETag is strong, derived from `lastCommit.dataAddress + path` — content-
 * addressed identity. Browsers cache forever and re-fetch only when the
 * StreamoRecord's value actually changes.
 */
import { extname } from 'path'

// The structured-record shape: files live under `value.files`. Hardcoded
// since 9.0.0 — the legacy "value IS files" mode is gone (see fileSync.js).
const FILES_KEY = 'files'

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.htm':   'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.mjs':   'text/javascript; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.webp':  'image/webp',
  '.ico':   'image/x-icon',
  '.txt':   'text/plain; charset=utf-8',
  '.md':    'text/markdown; charset=utf-8',
  '.xml':   'application/xml; charset=utf-8',
  '.wasm':  'application/wasm',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.map':   'application/json; charset=utf-8'
}

/**
 * Normalize an HTTP request path to a StreamoRecord files-map key.
 * - leading `/` stripped, trailing `/` → `index.html`
 * - reject `..` and `.` segments (path traversal)
 * - reject null bytes
 * @returns {string|null} normalized key, or null if the path is rejected
 */
function normalize (urlPath) {
  let p = urlPath
  if (p.endsWith('/')) p += 'index.html'
  if (p.startsWith('/')) p = p.slice(1)
  if (p === '') p = 'index.html'
  if (p.includes('\0')) return null
  for (const part of p.split('/')) {
    if (part === '..' || part === '.') return null
  }
  return p
}

/**
 * Read the files-map out of a StreamoRecord — `repo.value.files`.
 * @param {import('./StreamoRecord.js').StreamoRecord} repo
 */
function readFilesMap (repo) {
  if (!repo.lastCommit) return undefined
  return repo.get(FILES_KEY)
}

/**
 * Read the mounts table out of a StreamoRecord. Lives in
 * `value.files['mounts.json']` (a regular file in the Record's files
 * map, parsed as JSON). The file's top-level shape is
 * `{ "mounts": { "<prefix>": { "key": "<pubkey>", ... }, ... } }`.
 *
 * Returns undefined when the repo has no mounts.json or the parsed
 * structure isn't an object.
 *
 * A mount entry is `{ key: <pubkeyHex>, dataAddress?: number }`. The
 * `key` is the pubkey of the record to mount; `dataAddress`, when
 * present, pins to a specific commit (otherwise we serve the mounted
 * record's latest content).
 *
 * @param {import('./StreamoRecord.js').StreamoRecord} repo
 * @param {number} [atDataAddress]  if set, read mounts from this
 *   specific commit's data instead of HEAD (for pinned-mount chains).
 */
function readMounts (repo, atDataAddress) {
  if (!repo.lastCommit) return undefined
  let mountsFile
  if (atDataAddress != null) {
    try {
      const value = repo.decode(atDataAddress)
      const files = value && typeof value === 'object' ? value[FILES_KEY] : undefined
      mountsFile = files && typeof files === 'object' && !(files instanceof Uint8Array) ? files['mounts.json'] : undefined
    } catch { return undefined }
  } else {
    mountsFile = repo.get(FILES_KEY, 'mounts.json')
  }
  if (!mountsFile || typeof mountsFile !== 'object' || mountsFile instanceof Uint8Array) return undefined
  const m = mountsFile.mounts
  return (m && typeof m === 'object' && !(m instanceof Uint8Array)) ? m : undefined
}

/**
 * Read a single file's bytes from a repo's files map — honoring an
 * optional pinned `dataAddress` so the pinned-mount path can read the
 * record's content as it was at a specific commit. Returns undefined
 * when the file isn't in the map.
 *
 * @param {import('./StreamoRecord.js').StreamoRecord} repo
 * @param {string} path
 * @param {number} [atDataAddress]
 */
function readFile (repo, path, atDataAddress) {
  if (atDataAddress != null) {
    try {
      const value = repo.decode(atDataAddress)
      if (!value || typeof value !== 'object') return undefined
      const map = value[FILES_KEY]
      return (map && typeof map === 'object') ? map[path] : undefined
    } catch { return undefined }
  }
  // Two-arg get → lazy descent through the files map; only the leaf chunk
  // (the requested file's bytes) gets fully decoded. Previously this called
  // `readFilesMap(repo)[path]`, which forced a full decode of every file
  // in the map on every request — the actual cause of streamo.dev's
  // ~200ms-per-asset waterfall before 10.2.1. The codec already has the
  // chunk-graph references; just had to ask for the path we wanted.
  return repo.get(FILES_KEY, path)
}

/**
 * Resolve a request `path` to a `{ repo, leafPath, leafDataAddress, value }`
 * tuple by walking the record's `files` first and then its `mounts`
 * table, recursing into mounted records when the local lookup misses.
 *
 * - **Files-first:** if the path hits `files[path]` on the current
 *   record, that wins (David's "top-to-bottom, first match wins").
 * - **Longest-prefix match** when walking mounts — if both
 *   `mounts["lib/"]` and `mounts["lib/v1/"]` could match, the more
 *   specific one wins.
 * - **Cycle detection** by pubkeyHex set: each record can appear at
 *   most once on the resolution chain. Per-request — the relay's
 *   "answer each request independently" model means we don't try to
 *   materialize the whole mount graph, just walk the path the URL
 *   asked for.
 * - **Pin-aware:** when a mount entry carries a `dataAddress`, the
 *   recursion reads the mounted record's content at that specific
 *   commit instead of HEAD. The pinned dataAddress propagates only
 *   to its own subtree.
 *
 * Returns null if the path can't be resolved (no matching file, no
 * matching mount, mount target not in registry, or cycle detected).
 *
 * @param {import('./StreamoRecord.js').StreamoRecord} repo
 * @param {string} pubkeyHex
 * @param {string} path
 * @param {number|undefined} atDataAddress
 * @param {import('./StreamoRecordRegistry.js').StreamoRecordRegistry} registry
 * @param {Set<string>} visited
 */
async function resolveInRecord (repo, pubkeyHex, path, atDataAddress, registry, visited) {
  if (visited.has(pubkeyHex)) return null
  visited.add(pubkeyHex)

  // Files-first lookup on the current record.
  const value = readFile(repo, path, atDataAddress)
  if (value !== undefined) {
    return { repo, leafPath: path, leafDataAddress: atDataAddress, value }
  }

  // Then walk the mounts table looking for the longest matching prefix.
  const mounts = readMounts(repo, atDataAddress)
  if (!mounts || typeof mounts !== 'object') return null

  let bestPrefix = null
  for (const prefix of Object.keys(mounts)) {
    // Mount keys conventionally end in `/`. Match either when the path
    // starts with the (with-slash) prefix, or when the path exactly
    // equals the without-trailing-slash version (rare — a request for
    // the mount's bare root, which would normalize to <prefix>index.html
    // anyway, but be defensive).
    const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    if (path === bare || path.startsWith(prefix)) {
      if (!bestPrefix || prefix.length > bestPrefix.length) bestPrefix = prefix
    }
  }
  if (!bestPrefix) return null

  const mount = mounts[bestPrefix]
  if (!mount || typeof mount !== 'object' || typeof mount.key !== 'string') return null
  if (!/^[0-9a-f]{66}$/.test(mount.key)) return null

  const innerPath = path.startsWith(bestPrefix) ? path.slice(bestPrefix.length) : ''
  // `registry._materialize` is the substrate's local-materialize verb.
  // archiveSync-backed factories awaited inside it replay the on-disk
  // `.bin` into the StreamoRecord before resolving, so the await below means
  // "the bytes for this mount target are loaded by the time we
  // recurse." For mount targets the relay has no archive for,
  // `_materialize` returns an empty StreamoRecord and the recursion falls
  // through to a missing-file 404 — same end state as before,
  // without the "did we pre-subscribe?" race.
  const mountedRepo = await registry._materialize(mount.key)

  return resolveInRecord(
    mountedRepo,
    mount.key,
    innerPath || 'index.html',
    typeof mount.dataAddress === 'number' ? mount.dataAddress : undefined,
    registry,
    visited
  )
}

/**
 * Turn a value at a path into bytes for the HTTP response. Inverse of
 * fileSync's encodeFile: JSON files stored as objects are re-serialized,
 * strings are UTF-8 encoded, Uint8Arrays pass through. Anything else
 * yields null (caller falls through).
 */
function encodeForResponse (rel, value) {
  if (rel.endsWith('.json') && value != null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n')
  }
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof Uint8Array) return value
  return null
}

/**
 * Inject an importmap into an HTML document. Skip if one already exists.
 * Insert before </head>, else before <body>, else at document top.
 */
function injectImportMap (html, importMap) {
  if (/<script\s+type=["']importmap["']/i.test(html)) return html
  const tag = `<script type="importmap">${JSON.stringify(importMap)}</script>`
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, tag + '</head>')
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, m => tag + m)
  return tag + html
}

/**
 * Express middleware factory: serve files from a StreamoRecord.
 *
 * @param {import('./StreamoRecord.js').StreamoRecord} repo
 * @param {object} [options]
 * @param {boolean} [options.injectImportMap=true]  inject an importmap into
 *   HTML responses so bare specifiers like `@dtudury/streamo` resolve
 * @param {string} [options.libraryPath='/streamo/']  URL prefix the
 *   importmap binds `@dtudury/streamo/` to
 * @param {string} [options.libraryPackageName='@dtudury/streamo']  the bare
 *   specifier the importmap binds
 * @param {(req) => string} [options.pathFromReq]  override how the lookup
 *   path is derived from the request — defaults to `req.path`. Used by
 *   `serveFromRegistry` to feed in the wildcard tail instead of the full
 *   URL path.
 * @param {import('./StreamoRecordRegistry.js').StreamoRecordRegistry} [options.registry]
 *   optional registry — when provided, the middleware resolves through
 *   the repo's `mounts` table to other records the registry holds.
 *   Without a registry, mounts are ignored (files-only).
 * @param {string} [options.pubkeyHex]  the pubkey of the served repo,
 *   used as the starting point for cycle detection when mount
 *   resolution is enabled. Defaults to a sentinel that's never a real
 *   pubkey — fine for single-repo serving where no record will mount
 *   back to the served repo.
 * @returns {(req, res, next) => void} Express middleware
 */
export function serveFromRepo (repo, options = {}) {
  const {
    injectImportMap: doInject = true,
    libraryPath = '/streamo/',
    libraryPackageName = '@dtudury/streamo',
    pathFromReq = req => req.path,
    registry = null,
    pubkeyHex = '__root__'
  } = options

  return async function repoFileMiddleware (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()

    const path = normalize(pathFromReq(req))
    if (!path) return next()

    // Two resolution modes:
    //   - registry provided → walk files + mounts recursively, with
    //     cycle detection. Mount targets are materialized lazily via
    //     `registry._materialize` inside the resolver (archiveSync-
    //     backed factories load the on-disk .bin during the
    //     materialize's await), so no startup pre-subscription is needed.
    //   - no registry → files-only on the served repo, as before.
    let resolved
    try {
      if (registry) {
        resolved = await resolveInRecord(repo, pubkeyHex, path, undefined, registry, new Set())
        if (!resolved) return next()
      } else {
        const files = readFilesMap(repo)
        if (!files || typeof files !== 'object' || files instanceof Uint8Array) return next()
        const value = files[path]
        if (value === undefined) return next()
        resolved = { repo, leafPath: path, leafDataAddress: undefined, value }
      }
    } catch (e) {
      return next(e)
    }

    let bytes = encodeForResponse(resolved.leafPath, resolved.value)
    if (bytes === null) return next()

    const ext = extname(resolved.leafPath).toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'

    // ETag derives from the LEAF record's commit (the actual content
    // source), pinned dataAddress if any, and the path. So a mount
    // refresh upstream invalidates the ETag downstream; a pinned-
    // address mount is stable across the mounted record's later
    // commits (since the leaf address doesn't change).
    const leafDataAddress = resolved.leafDataAddress ?? resolved.repo.lastCommit?.dataAddress
    const etag = leafDataAddress !== undefined ? `"${leafDataAddress}-${encodeURIComponent(resolved.leafPath)}"` : null

    if (etag && req.headers && req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      res.end()
      return
    }

    if (ext === '.html' && doInject) {
      const html = new TextDecoder().decode(bytes)
      const importMap = {
        imports: {
          [libraryPackageName]: libraryPath + 'index.js',
          [libraryPackageName + '/']: libraryPath
        }
      }
      bytes = new TextEncoder().encode(injectImportMap(html, importMap))
    }

    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Length', bytes.byteLength)
    if (etag) res.setHeader('ETag', etag)

    if (req.method === 'HEAD') {
      res.end()
    } else {
      res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    }
  }
}

/**
 * Multi-home Express middleware: serve files from any repo in a registry,
 * addressed by hex pubkey in the URL.
 *
 * Mount via a prefix so Express strips it from req.url before delegating:
 *
 *   app.use('/streams/:keyhex', serveFromRegistry(registry))
 *
 * Then `/streams/<66-hex>/index.html` serves `repo.get('files', 'index.html')`,
 * `/streams/<66-hex>/foo.css` serves `repo.get('files', 'foo.css')`, etc.
 * Missing repos and missing files fall through to `next()` — so sibling
 * routes like `/streams/:key/raw` (raw bytes) and `/streams/:key` (JSON view)
 * remain reachable when the requested file isn't in the repo.
 *
 * Behavior at the bare path (`'/'` — i.e. `/streams/<keyhex>` and
 * `/streams/<keyhex>/`) is HOMEPAGE-style: serves `files/index.html` if the
 * repo has it, else falls through to the legacy JSON view. So repos that
 * opt into having a homepage (by putting an `index.html` under their
 * `files` key) get one for free; repos that don't keep their JSON-view
 * default. The path `'/raw'` is skipped unconditionally so the raw-bytes
 * endpoint wins — a real-but-rare collision for repos that have a file
 * literally named `raw`.
 *
 * Any pubkey the registry already holds becomes addressable as a public
 * URL. The relay didn't have to be configured for it; the author just
 * needed to push their bytes via origin sync.
 *
 * @param {import('./StreamoRecordRegistry.js').StreamoRecordRegistry} registry
 * @param {object} [options]  same shape as serveFromRepo's options
 *   (injectImportMap, libraryPath, libraryPackageName)
 * @returns {(req, res, next) => Promise<void>} Express middleware
 */
export function serveFromRegistry (registry, options = {}) {
  return async function multiHomeMiddleware (req, res, next) {
    if (req.url === '/raw') return next()
    const { keyhex } = req.params
    if (!/^[0-9a-f]{66}$/.test(keyhex)) return next()
    let repo
    try {
      repo = await registry._materialize(keyhex)
    } catch {
      return next()
    }
    // Thread the registry + the served repo's pubkey through so
    // serveFromRepo's mount resolver can walk the mounts table and
    // cycle-detect by pubkey from this starting point.
    return serveFromRepo(repo, { ...options, registry, pubkeyHex: keyhex })(req, res, next)
  }
}
