/**
 * @file repoFileServer — Express middleware that serves files from a Repo.
 *
 * The inverse of fileSync's read pass: where fileSync turns a folder into a
 * flat { relPath: value } map and commits it to a Repo, this middleware
 * reads that same shape back out and responds to HTTP requests.
 *
 * Default Repo shape is `{ files: { ...flatMap } }` — a `files` key inside
 * the value, leaving room for other metadata (`title`, `members`, etc.)
 * alongside it. Pass `filesKey: null` to treat the whole value as the
 * flat map (the "value IS the file tree" shape — generic, anyone with a
 * directory-shaped Repo gets a server for free).
 *
 * HTML responses optionally get an importmap injected that resolves
 * `@dtudury/streamo` and `@dtudury/streamo/*` to URLs the host can serve
 * the library from. This is the seam that lets a homepage Repo's HTML stay
 * truly host-agnostic — the page writes bare specifiers, the relay binds
 * them at serve time.
 *
 * ETag is strong, derived from `lastCommit.dataAddress + path` — content-
 * addressed identity. Browsers cache forever and re-fetch only when the
 * Repo's value actually changes.
 */
import { extname } from 'path'

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
 * Normalize an HTTP request path to a Repo files-map key.
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
 * Read the files-map out of a Repo according to filesKey.
 * @param {import('./Repo.js').Repo} repo
 * @param {string|null} filesKey
 */
function readFilesMap (repo, filesKey) {
  if (!repo.lastCommit) return undefined
  if (filesKey === null) return repo.files
  return repo.get(filesKey)
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
 * Express middleware factory: serve files from a Repo.
 *
 * @param {import('./Repo.js').Repo} repo
 * @param {object} [options]
 * @param {string|null} [options.filesKey='files']  key under value to look up;
 *   null means value IS the files map
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
 * @returns {(req, res, next) => void} Express middleware
 */
export function serveFromRepo (repo, options = {}) {
  const {
    filesKey = 'files',
    injectImportMap: doInject = true,
    libraryPath = '/streamo/',
    libraryPackageName = '@dtudury/streamo',
    pathFromReq = req => req.path
  } = options

  return function repoFileMiddleware (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()

    const path = normalize(pathFromReq(req))
    if (!path) return next()

    const files = readFilesMap(repo, filesKey)
    if (!files || typeof files !== 'object' || files instanceof Uint8Array) return next()

    const value = files[path]
    if (value === undefined) return next()

    let bytes = encodeForResponse(path, value)
    if (bytes === null) return next()

    const ext = extname(path).toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'

    const dataAddress = repo.lastCommit?.dataAddress
    const etag = dataAddress !== undefined ? `"${dataAddress}-${encodeURIComponent(path)}"` : null

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
 *   app.use('/streams/:keyhex', serveFromRegistry(registry, { filesKey: 'files' }))
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
 * @param {import('./RepoRegistry.js').RepoRegistry} registry
 * @param {object} [options]  same shape as serveFromRepo's options
 *   (filesKey, injectImportMap, libraryPath, libraryPackageName)
 * @returns {(req, res, next) => Promise<void>} Express middleware
 */
export function serveFromRegistry (registry, options = {}) {
  return async function multiHomeMiddleware (req, res, next) {
    if (req.url === '/raw') return next()
    const { keyhex } = req.params
    if (!/^[0-9a-f]{66}$/.test(keyhex)) return next()
    let repo
    try {
      repo = await registry.open(keyhex)
    } catch {
      return next()
    }
    return serveFromRepo(repo, options)(req, res, next)
  }
}
