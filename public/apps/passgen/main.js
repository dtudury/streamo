/**
 * streamo passgen — deterministic password generator for streamo identities.
 *
 * One master password + a recipe → one 32-char derived password.
 * Same inputs → same output, always. PBKDF2-HMAC-SHA256 / 100k iterations.
 * Client-side only; nothing leaves the browser.
 *
 * Pair with `Signer` + `keysFor(streamName)` (see design.md §7) to compose
 * derived passwords into a tree of identities for streamo Records.
 *
 * Built on streamo, not in streamo: passgen is just a procedure that
 * produces inputs streamo's Signer happens to consume.
 */
import { h, handle } from '../../streamo/h.js'
import { mount }     from '../../streamo/mount.js'
import { Recaller }  from '../../streamo/utils/Recaller.js'

// 94 printable ASCII chars (excludes space and DEL).
const ALPHA = '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'
const ITERATIONS = 100000  // matches streamo's Signer; ~1s/recipe in browser.

const recaller = new Recaller('passgen')
const state = {
  master: '',
  recipes: [
    // Pre-filled with streamo project defaults; users edit / add as needed.
    'streamo.dev,streamo-relay,32,,,',
    'streamo.dev,claude,32,,,',
    'streamo.dev,streamo-library,32,,,',
    'streamo.dev,streamo-chat,32,,,',
    'streamo.dev,streamo-flashcards,32,,,',
    'streamo.dev,streamo-explorer,32,,,',
    'streamo.dev,streamo-todomvc,32,,,',
    'streamo.dev,streamo-styles,32,,,',
    'streamo.dev,streamo-shared-note,32,,,',
    'streamo.dev,streamo-gallery,32,,,'
  ],
  results: [],   // [{ recipe, password, art, username }]
  generating: false,
  status: ''
}
const signal = {}
const dep   = () => recaller.reportKeyAccess(signal, 'data')
const fire  = () => recaller.reportKeyMutation(signal, 'data')

// ── derivation ─────────────────────────────────────────────────────────────

async function pbkdf2Bits (password, salt, iterations, bits) {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
    keyMaterial, bits))
}

async function sha256 (str) {
  const enc = new TextEncoder()
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str)))
}

function bytesToPassword (bytes, length) {
  // Each byte indexes into the printable alphabet (mod 94). Loses ~1 bit per
  // byte vs raw entropy, but a 32-char output still carries ~245 bits.
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHA[bytes[i] % ALPHA.length]
  return out
}

// Parse recipe → { website, username, length }.
// Format: `website,username,length,,,` (extra commas are padding).
function parseRecipe (recipe) {
  const parts = recipe.split(',')
  return {
    website:  parts[0]?.trim() || '',
    username: parts[1]?.trim() || '',
    length:   Math.max(1, Math.min(64, parseInt(parts[2]?.trim()) || 32))
  }
}

async function generateOne (recipe, master) {
  const { length, username } = parseRecipe(recipe)
  // Use the recipe string itself as the salt — same property cryptopotamus
  // has: change any field → different password.
  const bytes = await pbkdf2Bits(master, recipe, ITERATIONS, length * 8)
  const password = bytesToPassword(bytes, length)
  const artBytes = await sha256(recipe + ':' + password)
  return { recipe, username, password, art: artBytes }
}

async function generateAll () {
  if (!state.master) {
    state.status = 'enter a master password first'
    fire(); return
  }
  state.generating = true
  state.results = []
  state.status = `deriving ${state.recipes.length} passwords (PBKDF2 ×${ITERATIONS}/each)…`
  fire()
  try {
    for (let i = 0; i < state.recipes.length; i++) {
      const recipe = state.recipes[i].trim()
      if (!recipe) continue
      state.status = `${i+1}/${state.recipes.length}: ${recipe}`
      fire()
      const result = await generateOne(recipe, state.master)
      state.results.push(result)
      fire()
    }
    state.status = `done — ${state.results.length} passwords ready`
  } catch (e) {
    state.status = `error: ${e.message}`
  }
  state.generating = false
  fire()
}

// ── hash art ───────────────────────────────────────────────────────────────

// 8×8 grid of color blocks, deterministic from the hash bytes. Different
// passwords produce visibly different art; identical passwords produce
// identical art (so "I typed the same master twice by mistake" is visible).
function renderArt (bytes, size = 64) {
  const cell = size / 8
  const cells = []
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const idx = (i * 8 + j) % bytes.length
      const r = bytes[idx]
      const g = bytes[(idx + 1) % bytes.length]
      const b = bytes[(idx + 2) % bytes.length]
      cells.push(h`<rect x=${j*cell} y=${i*cell} width=${cell} height=${cell}
        fill=${`rgb(${r},${g},${b})`}/>`)
    }
  }
  return h`<svg width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`}
    style="border: 1px solid #ddd; display: block;">${cells}</svg>`
}

// ── download ───────────────────────────────────────────────────────────────

function envFileContent () {
  const lines = [
    '# streamo passgen-generated credentials',
    '# Regenerable via the passgen at /apps/passgen/ with the same recipes:'
  ]
  for (const r of state.results) lines.push(`#   ${r.recipe}`)
  lines.push('')
  for (const r of state.results) {
    // Slug: streamo-relay → RELAY; claude → CLAUDE
    const slug = r.username.replace(/^streamo-/, '').toUpperCase().replace(/-/g, '_')
    // Single-quote with bash-safe escape
    const safe = r.password.includes("'")
      ? r.password.replace(/'/g, "'\\''")
      : r.password
    lines.push(`STREAMO_${slug}_USERNAME='${r.username}'`)
    lines.push(`STREAMO_${slug}_PASSWORD='${safe}'`)
    lines.push('')
  }
  return lines.join('\n')
}

function downloadEnv () {
  const content = envFileContent()
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '.streamo-creds.env'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── recipe row helpers ─────────────────────────────────────────────────────

function updateRecipe (idx, value) {
  state.recipes[idx] = value
  fire()
}
function removeRecipe (idx) {
  state.recipes.splice(idx, 1)
  fire()
}
function addRecipe () {
  state.recipes.push('streamo.dev,newkey,32,,,')
  fire()
}

// ── view ───────────────────────────────────────────────────────────────────

const css = `
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto;
         padding: 0 1rem; color: #222; line-height: 1.5; }
  h1 { font-weight: 600; }
  .subtitle { color: #666; margin-top: -0.5rem; }
  .section { margin: 2rem 0; }
  .master-input { width: 100%; font-size: 1rem; padding: 0.6rem; box-sizing: border-box;
                  font-family: ui-monospace, monospace; }
  .recipes { display: flex; flex-direction: column; gap: 0.4rem; }
  .recipe-row { display: flex; gap: 0.4rem; align-items: center; }
  .recipe-row input { flex: 1; font-family: ui-monospace, monospace;
                       padding: 0.4rem; font-size: 0.9rem; }
  .recipe-row button { padding: 0.4rem 0.6rem; cursor: pointer; }
  .actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
  button.primary { background: #1d4ed8; color: white; border: none;
                   padding: 0.7rem 1.2rem; font-size: 1rem; cursor: pointer;
                   border-radius: 4px; }
  button.primary:disabled { background: #aaa; cursor: not-allowed; }
  .status { padding: 0.5rem 0; color: #555; font-family: ui-monospace, monospace;
            font-size: 0.9rem; min-height: 1.2rem; }
  .results { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 1rem; }
  .result-row { display: grid; grid-template-columns: 80px 1fr 200px;
                gap: 1rem; align-items: center; padding: 0.6rem;
                border: 1px solid #eee; border-radius: 4px; }
  .result-row .label { font-family: ui-monospace, monospace; font-size: 0.85rem;
                       color: #666; word-break: break-all; }
  .result-row .password { font-family: ui-monospace, monospace; font-size: 0.95rem;
                          padding: 0.4rem; background: #f7f7f7; border-radius: 3px;
                          word-break: break-all; user-select: all; }
  .note { background: #fff8dc; border-left: 3px solid #d4a017; padding: 0.8rem;
          margin: 1.5rem 0; font-size: 0.9rem; }
`

const masterInput = () => h`
  <input type="password" class="master-input"
    placeholder="master password — never leaves this browser"
    oninput=${handle(e => { state.master = e.target.value; fire() })}/>
`

const recipeRow = (recipe, idx) => h`
  <div class="recipe-row" data-key=${`recipe-${idx}`}>
    <input type="text" value=${recipe}
      oninput=${handle(e => updateRecipe(idx, e.target.value))}/>
    <button onclick=${handle(() => removeRecipe(idx))}>×</button>
  </div>
`

const recipeList = () => {
  dep()
  return h`
    <div class="recipes">
      ${state.recipes.map((r, i) => recipeRow(r, i))}
    </div>
    <div class="actions">
      <button onclick=${handle(addRecipe)}>+ add recipe</button>
    </div>
  `
}

const resultRow = (result) => h`
  <div class="result-row">
    ${renderArt(result.art)}
    <div>
      <div class="label">${result.recipe}</div>
      <div class="password">${result.password}</div>
    </div>
  </div>
`

const resultsView = () => {
  dep()
  if (!state.results.length) return h``
  return h`
    <div class="results">
      ${state.results.map(resultRow)}
    </div>
    <div class="actions">
      <button class="primary" onclick=${handle(downloadEnv)}>
        download .streamo-creds.env
      </button>
    </div>
  `
}

const generateButton = () => {
  dep()
  return h`
    <button class="primary"
      onclick=${handle(generateAll)}
      disabled=${state.generating ? '' : null}>
      ${state.generating ? 'generating…' : 'generate'}
    </button>
  `
}

const statusLine = () => {
  dep()
  return h`<div class="status">${state.status}</div>`
}

mount(h`
  <style>${css}</style>

  <h1>🌊 streamo passgen</h1>
  <p class="subtitle">deterministic password derivation, client-side</p>

  <div class="note">
    <strong>How it works:</strong> one master password + one recipe →
    one 32-char derived password, via PBKDF2-HMAC-SHA256 (100k iterations).
    Same inputs always produce the same output. Nothing leaves this browser.
    Pair each output with streamo's <code>Signer</code> + <code>keysFor(name)</code>
    to compose a tree of identities (see <code>design.md §7</code>).
  </div>

  <div class="section">
    <label><strong>master password</strong></label>
    ${masterInput}
  </div>

  <div class="section">
    <label><strong>recipes</strong> — one identity per row</label>
    ${recipeList}
  </div>

  <div class="section">
    ${generateButton}
    ${statusLine}
  </div>

  ${resultsView}
`, document.body, recaller)
