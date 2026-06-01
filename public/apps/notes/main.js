/**
 * streamo notes — currently-warm-context editor (v0)
 *
 * Phase 1: bare <textarea>. No framework, no CDN imports, no build step.
 * The architectural payoff is in the surfaces we add NEXT, not in the
 * editor itself:
 *
 *   - bracket-bracket autocomplete with fuzzy Record search (popup near cursor)
 *   - hover-preview that lands in the empty quadrant near a link
 *   - pin-to-side panel for persistent comparison
 *   - the currently-warm-context Record tree underneath, computed-at-read-time
 *
 * Initial v0 was CodeMirror 6 — broke immediately on multiple-state-instances
 * AND violated the smart-surfaces-not-fancy-editor lens we'd just named.
 * The lens caught the framework-reflex; reverted to plain textarea. The
 * smart surfaces are the product; the editor is just where bytes go in.
 */

const SEED = `# notes

a v0 editor. plain textarea, no smart surfaces yet.

what comes next:

- bracket-bracket-autocomplete popups when you type the brackets
- hover-preview that picks the empty viewport quadrant
- pin-to-side panel for two-Record comparison
- the currently-warm-context Record tree underneath

the point isn't this editor; it's the surfaces around it. write here to
test the input flow; everything else is upcoming phases.
`

const editor = document.createElement('textarea')
editor.value = SEED
editor.spellcheck = false
editor.autocapitalize = 'off'
editor.autocomplete = 'off'

const parent = document.getElementById('editor')
parent.appendChild(editor)

document.getElementById('loading').remove()
