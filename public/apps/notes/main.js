/**
 * streamo notes — currently-warm-context editor (v0)
 *
 * Phase 1: bare CodeMirror 6 with markdown. No smart surfaces yet — just
 * an editor inside a streamo app. The architectural payoff is in the
 * surfaces we add NEXT, not in the editor itself:
 *
 *   - `[[` autocomplete with fuzzy Record search (popup near cursor)
 *   - hover-preview that lands in the empty quadrant near a link
 *   - pin-to-side panel for persistent comparison
 *   - the currently-warm-context Record tree underneath, computed-at-read-time
 *
 * Built on streamo, not in streamo (yet) — for now the editor edits a
 * single in-memory document; persistence-to-streamo lands when the tree
 * shape settles.
 */
import { EditorView, basicSetup } from 'https://esm.sh/codemirror@6.0.1'
import { markdown }               from 'https://esm.sh/@codemirror/lang-markdown@6.3.1'
import { EditorState }            from 'https://esm.sh/@codemirror/state@6.4.1'

const SEED = `# notes

a v0 editor. plain markdown, no smart surfaces yet.

what comes next:

- \`[[autocomplete]]\` popups when you type double-bracket
- hover-preview that picks the empty viewport quadrant
- pin-to-side panel for two-Record comparison
- the currently-warm-context Record tree underneath

the point isn't this editor; it's the surfaces around it. write here to
test the markdown rendering; everything else is upcoming phases.
`

const parent = document.getElementById('editor')
const loading = document.getElementById('loading')

const state = EditorState.create({
  doc: SEED,
  extensions: [basicSetup, markdown()]
})

new EditorView({ state, parent })

loading.remove()
