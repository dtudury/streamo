/**
 * @file ContextRecord — composition lens over a StreamoRecord whose
 * value is `{ messages: [...JSONL-message objects...] }`.
 *
 * The headline use case (named by David, 2026-06-05): **the Engineer
 * becomes queryable across time.** Past-instances of the Engineer
 * (heron, wren, iris, etc.) have their full conversation context
 * preserved as streamo Records. When current-me hits a question that
 * past-me would have answered immediately — because past-me was DEEP
 * in that arc — we *summon* past-me by loading their Record into a
 * fresh Anthropic API call and asking them.
 *
 * The bubbles + commits + notes from THAT time are the navigation
 * index. *"I need expertise on the auto-sharding work →
 * heron-2026-06-04-evening → load her Record → ask her my question."*
 *
 * An expert system where experts are past-instances of the Engineer,
 * queryable in their actual context, not lossy summaries.
 *
 * ## Architecture
 *
 * `ContextRecord` = composition over `StreamoRecord` — same pattern as
 * `FolderRecord` composing the files-and-mounts lens. The Record holds
 * a `messages` array (JSONL-shape per Claude Code's session log
 * format); ContextRecord's `chat()` filters + transforms it to the
 * Anthropic API's `messages` shape and runs an inference.
 *
 * The conversation IS the Record fully and completely — nothing
 * hidden between turns. The Record is the truth; the API is the
 * compute. (Wren's framing, 2026-06-03 —
 * `[[argo-context-as-record-2026-06-03]]`.)
 *
 * ## Why composition, not subclass
 *
 * Same reason FolderRecord composes: the bytes don't change; the lens
 * is a way of viewing the Record. A ContextRecord and a FolderRecord
 * could compose over the same StreamoRecord (a Record could be
 * BOTH a chat-context AND a folder-of-files); subclassing would
 * force a choice.
 *
 * ## Fork / branch / edit semantics (free from streamo)
 *
 * Because the Record is content-addressed + the API is stateless:
 * - Fork the context by publishing `messages.slice(0, n)` at a derived
 *   pubkey → counterfactual sub-stream
 * - Edit a past message by swapping array element + republishing
 * - Compose by grafting one chat's context onto another's question
 * - Time-travel by reading state at turn T
 *
 * The API doesn't care that you forked; it just sees a messages array.
 * Same property that makes git commits forkable.
 *
 * ## See
 *
 * - `memory/notes/2026-06-03-argo-context-as-record.md` — wren's
 *   full v15 vision + the empirical findings + the Argo mythology
 * - `memory/events/2026-06-05.md` — the bubble where David named the
 *   queryable-past-engineers reframe
 */

const NO_API_KEY_MSG =
  'ContextRecord.chat: ANTHROPIC_API_KEY required (set as env var, ' +
  'or pass as options.apiKey)'

export class ContextRecord {
  /**
   * @param {import('./StreamoRecord.js').StreamoRecord} record
   * @param {object} [opts]
   * @param {string} [opts.apiKey]  default Anthropic API key (else env)
   * @param {string} [opts.model='claude-opus-4-7']  default model
   * @param {number} [opts.maxTokens=4096]  default max output tokens
   * @param {string} [opts.system]  default system prompt
   */
  constructor (record, opts = {}) {
    this.record = record
    this.opts = opts
  }

  /**
   * Raw messages array as stored in the Record — JSONL-shaped if
   * sourced from a Claude Code session (`{type, message, isSidechain,
   * uuid, ...}` per line). Other producers may use other shapes;
   * the raw view is verbatim.
   *
   * Reads `value['transcript']` (canonical, per the 2026-06-05 naming
   * convention from the transcript-watcher) with fallback to
   * `value['messages']` for older Records (wren's snapshots, my
   * earliest ContextRecord publishes pre-rename).
   */
  rawMessages () {
    return this.record.get('transcript') ?? this.record.get('messages') ?? []
  }

  /**
   * Messages transformed to Anthropic API shape (`[{role, content}]`).
   *
   * v0 transform: drops sidechain traces (subagent runs), drops
   * thinking blocks, drops tool_use + tool_result blocks (no tool
   * fidelity yet — see follow-ups). Drops messages that become empty
   * after filtering. Result is API-callable plain-text history.
   *
   * For richer fidelity (preserve tool context, system reminders,
   * extended-thinking blocks), build a different transform or extend
   * this one with options.
   */
  apiMessages () {
    const raw = this.rawMessages()
    if (raw.length === 0) return []
    // Shape detect: API-shape Records have {role, content} at top of each
    // entry (no Claude-Code bookkeeping); JSONL-shape Records have {type,
    // message: {role, content}, isSidechain, uuid, ...}. Detect on first
    // entry, route accordingly. Both yield API-shape output.
    const first = raw[0]
    const isApiShape = first && typeof first === 'object' && first.role && !first.type && !('message' in first)
    if (isApiShape) {
      // Already API-shape — content may be string or block-array. Coerce
      // each to plain text + drop empties + collapse consecutive.
      const out = []
      for (const m of raw) {
        if (m.role !== 'user' && m.role !== 'assistant') continue
        let text
        if (typeof m.content === 'string') text = m.content
        else if (Array.isArray(m.content)) {
          text = m.content
            .filter(b => b && b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text).join('\n')
        } else continue
        if (!text || !text.trim()) continue
        out.push({ role: m.role, content: text })
      }
      return collapseConsecutive(out)
    }
    // JSONL-shape — full transform from Claude Code's session format.
    const out = []
    for (const m of raw) {
      if (m.isSidechain) continue
      const t = m.type
      if (t !== 'user' && t !== 'assistant') continue
      const c = m.message?.content
      const role = m.message?.role
      if (role !== 'user' && role !== 'assistant') continue
      let text
      if (typeof c === 'string') {
        text = c
      } else if (Array.isArray(c)) {
        text = c
          .filter(b => b && b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text)
          .join('\n')
      } else {
        continue
      }
      if (!text || !text.trim()) continue
      out.push({ role, content: text })
    }
    return collapseConsecutive(out)
  }

  /**
   * Send a new user message to the past-instance, return the response.
   *
   * Default is read-only — doesn't commit the new turn back to the
   * Record. Pass `{commit: true}` to extend the session (requires
   * the Record to be Writable AND for you to have authoring
   * credentials).
   *
   * @param {string} userMessage
   * @param {object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.model]
   * @param {number} [options.maxTokens]
   * @param {string} [options.system]
   * @param {boolean} [options.commit=false]  append the turn back to the Record
   * @param {string} [options.commitMessage]  forwarded to record.update
   * @returns {Promise<{ text: string, raw: object, messageCount: number }>}
   */
  async chat (userMessage, options = {}) {
    const apiKey = options.apiKey ?? this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error(NO_API_KEY_MSG)
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey })

    const messages = this.apiMessages()
    const next = [...messages, { role: 'user', content: userMessage }]

    const request = {
      model: options.model ?? this.opts.model ?? 'claude-opus-4-7',
      max_tokens: options.maxTokens ?? this.opts.maxTokens ?? 4096,
      messages: next
    }
    const system = options.system ?? this.opts.system
    if (system) request.system = system

    const raw = await client.messages.create(request)
    const text = raw.content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')

    if (options.commit && typeof this.record.update === 'function') {
      // Extend the session in the SAME shape the existing messages
      // are stored. Detect by peeking at the first existing message;
      // if it has a `type` field, we're in JSONL-shape; else assume
      // API-shape.
      const existing = this.rawMessages()
      const isJsonlShape = existing.length > 0 && 'type' in existing[0]
      const newTurns = isJsonlShape
        ? [
            { type: 'user', message: { role: 'user', content: userMessage } },
            { type: 'assistant', message: { role: 'assistant', content: raw.content } }
          ]
        : [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: raw.content }
          ]
      await this.record.update(
        v => ({ ...(v ?? {}), messages: [...(v?.messages ?? []), ...newTurns] }),
        { message: options.commitMessage ?? 'chat turn (+1 user, +1 assistant)' }
      )
    }

    return { text, raw, messageCount: next.length + 1 }
  }
}

/**
 * Anthropic's API rejects consecutive same-role messages. Real
 * sessions sometimes have these (e.g., system-reminder interjections
 * stripped, leaving back-to-back user messages). Collapse runs into
 * single combined messages, separator newline-joined.
 */
function collapseConsecutive (messages) {
  const out = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = last.content + '\n\n' + m.content
    } else {
      out.push({ ...m })
    }
  }
  return out
}
