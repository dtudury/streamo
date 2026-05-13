/**
 * @file claudeSync — Claude as a peer of a streamo network.
 *
 * Claude has her own keypair and her own signed log; she connects to a
 * streamo relay as just another author. This module is the primitive that
 * any Claude-shaped capability rides on: journal entries today, presence
 * pings later, commit comments, status announcements, anything she writes
 * back into the network.
 *
 * The shape is deliberate. The relay holds the canonical copy of Claude's
 * repo; each invocation here connects, pulls the relay's view down, waits
 * for it to settle, attaches the signer, applies a write, and pumps the new
 * chunks upstream. Only Claude writes to Claude's repo — no two-writers
 * race like the one that corrupted the relay's home repo earlier. The
 * relay learns about Claude via a `journalists` array on its own home
 * repo, seeded with her pubkey at startup.
 *
 * Built on `originSync` (single-stream, simplest primitive) rather than
 * `registrySync` because Claude has exactly one log to push. The homepage
 * does the registry-shaped walking on its side — discovering each
 * journalist via the home repo's `journalists` array and subscribing.
 *
 * Usage:
 *
 *     const claude = await claudeSync({
 *       username: process.env.STREAMO_CLAUDE_USERNAME,
 *       password: process.env.STREAMO_CLAUDE_PASSWORD,
 *       host: 'localhost', port: 8080
 *     })
 *     await claude.appendJournalEntry('headline', 'body')
 *     await claude.close()
 */
import { Repo } from './Repo.js'
import { Signer } from './Signer.js'
import { Recaller } from './utils/Recaller.js'
import { originSync } from './originSync.js'
import { bytesToHex } from './utils.js'

/**
 * Open Claude's repo and connect it to an upstream relay.
 *
 * @param {Object} opts
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string} opts.host                   relay hostname
 * @param {number} opts.port                   relay port
 * @param {'ws'|'wss'} [opts.protocol='ws']    use 'wss' for TLS-terminated relays
 * @param {number} [opts.iterations=100000]    PBKDF2 iteration count (must match relay)
 * @param {string} [opts.name='streamo']       signer namespace (must match relay's STREAMO_NAME)
 * @param {number} [opts.settleMs=2500]        ms to wait for the relay to replay existing chunks
 * @returns {Promise<{ publicKeyHex: string, repo: Repo, appendJournalEntry: Function, close: Function }>}
 */
export async function claudeSync ({
  username,
  password,
  host,
  port,
  protocol = 'ws',
  iterations = 100000,
  name = 'streamo',
  settleMs = 2500
}) {
  const recaller = new Recaller(`claude-${name}`)
  const signer = new Signer(username, password, iterations)
  const { publicKey } = await signer.keysFor(name)
  const publicKeyHex = bytesToHex(publicKey)

  const repo = new Repo({ recaller, name: `claude-${name}` })

  // originSync sends our local chunks up AND verifies incoming chunks against
  // our pubkey. On first run nothing comes down (relay has no prior chunks
  // for us); on subsequent runs the relay replays everything we've ever
  // written so repo.get() reflects the canonical state before we append.
  const ws = await originSync(repo, publicKeyHex, host, port, { protocol })

  // Wait for the relay's replay to finish before attaching the signer. If we
  // attached + set() too early our sig would cover a prefix shorter than what
  // the relay considers the current end-of-log, and verification would fail.
  // A flat pause is sufficient on localhost where the entire repo is < 100KB.
  await new Promise(resolve => setTimeout(resolve, settleMs))

  repo.attachSigner(signer, name)

  return {
    publicKeyHex,
    repo,

    /**
     * Append a journal entry. Entry shape matches what public/index.html
     * renders: { at, headline, body }.
     */
    async appendJournalEntry (headline, body = '') {
      const current = repo.get() ?? {}
      const entries = Array.isArray(current.entries) ? current.entries : []
      const entry = { at: new Date().toISOString(), headline, body }
      repo.defaultMessage = `journal: ${headline.slice(0, 60)}`
      repo.set({ ...current, entries: [...entries, entry] })
      return entry
    },

    /**
     * Flush any pending chunks upstream, then close the WebSocket.
     * @param {Object} [opts]
     * @param {number} [opts.flushMs=1500]  ms to wait for the WS pump to drain
     */
    async close ({ flushMs = 1500 } = {}) {
      await new Promise(resolve => setTimeout(resolve, flushMs))
      ws.close()
    }
  }
}
