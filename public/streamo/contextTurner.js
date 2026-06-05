/**
 * @file contextTurner — the "ask a past instance of the Engineer a
 * question, get her answer" verb. Wraps ContextRecord + the Anthropic
 * API with consultation-history accumulation across REPL calls.
 *
 * Designed for REPL use (and CLI via dispatch). David's architecture
 * (2026-06-05): open a streamo session subscribed to a transcript
 * Record, drop into REPL with that record in scope, then:
 *
 *   > await context.turn("what were you working on?")
 *   "...past-instance's answer..."
 *
 *   > await context.turn("can you say more about the FolderRecord write?")
 *   "...follow-up reply, with the previous Q+A in context..."
 *
 * The consultation history accumulates across calls within the same
 * REPL session — second call ships past-instance's transcript + Q1 +
 * A1 + Q2 to Anthropic. Reset with `context.reset()`. Inspect with
 * `context.history()`.
 *
 * No persistence by default. The Q&A lives in module-scoped memory;
 * REPL exit loses it. For persistent consultation sessions (Record B
 * per David's two-Record architecture), explicit commit-back is the
 * v0.1 add.
 *
 * Bound to the REPL's globalThis as `context`. Works in --eval too
 * (it's in scope alongside `record`, `signer`, `dispatch`).
 *
 * Requires ANTHROPIC_API_KEY (env var or passed via opts).
 */
import { ContextRecord } from './ContextRecord.js'

const NO_API_KEY_MSG =
  'context.turn: ANTHROPIC_API_KEY required (set as env var, ' +
  'load via --env-file env/secrets/anthropic.env, or pass as opts.apiKey)'

// Module-scoped history — accumulates across calls within one Node process
// (i.e., one REPL session). Survives between context.turn() calls; not
// persisted to disk; reset() clears it.
let consultationHistory = []

export const context = {
  /**
   * Send a new question to the past instance whose context lives in
   * `record`. Returns the assistant's text response.
   *
   * @param {*} record  the streamo Record holding the past instance's
   *   transcript (its value should have either `transcript` or
   *   `messages` — both shapes supported by ContextRecord)
   * @param {string} userMessage  the question
   * @param {object} [opts]
   * @param {string} [opts.apiKey]
   * @param {string} [opts.model='claude-opus-4-7']
   * @param {number} [opts.maxTokens=4096]
   * @param {string} [opts.system]  system prompt — useful for framing
   *   ("you are past-finch, the engineer who lived this conversation")
   * @returns {Promise<string>}  the assistant's text
   */
  async turn (record, userMessage, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error(NO_API_KEY_MSG)
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey })

    const ctx = new ContextRecord(record)
    const transcript = ctx.apiMessages()
    const next = [
      ...transcript,
      ...consultationHistory,
      { role: 'user', content: userMessage }
    ]

    const request = {
      model: opts.model ?? 'claude-opus-4-7',
      max_tokens: opts.maxTokens ?? 4096,
      messages: next
    }
    if (opts.system) request.system = opts.system

    const response = await client.messages.create(request)
    const text = response.content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')

    // Accumulate Q+A so follow-ups inherit context within this REPL session.
    consultationHistory.push({ role: 'user', content: userMessage })
    consultationHistory.push({ role: 'assistant', content: text })

    return text
  },

  /**
   * Clear the in-flight consultation history. Past-instance's
   * transcript (Record A) stays; the Q&A pairs you've asked since
   * (Record B in-memory equivalent) are cleared. Next turn() starts
   * a fresh consultation.
   */
  reset () {
    const cleared = consultationHistory.length
    consultationHistory = []
    return { cleared: cleared / 2 + ' turns cleared' }
  },

  /**
   * Inspect the accumulated consultation history (Q&A pairs asked of
   * the past instance this REPL session). Read-only snapshot.
   */
  history () {
    return [...consultationHistory]
  }
}
