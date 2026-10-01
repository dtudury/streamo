#!/usr/bin/env node
// A REPL with a server Hub and a client Hub wired together, for playing with
// Upstream/Downstream.
//
//   node scripts/repl2.mjs
//
// The point is the reload. ESM imports are cached by URL, so a plain
// `await import('./Upstream.js')` after you edit the file hands you the OLD
// module. Every call to pair() imports with a fresh `?v=` query string, which
// Node treats as a different URL — so edit Upstream.js, call pair() again, and
// you are running the new code without leaving the repl.
//
//   > const p = await pair()
//   > author(p, { 'readme.md': 'hello\n' })     // client authors; the wire carries it
//   > await settle()
//   > show(p)
//   > p.client.getMirror(p.key).get()
//
//   ...edit public/streamo/v2/Upstream.js...
//
//   > const q = await pair()                      // fresh Upstream, old one untouched
//
import repl from 'node:repl'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const V2 = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'streamo', 'v2') + '/'
const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'streamo') + '/'

const { Recaller } = await import(CORE + 'utils/Recaller.js')
const { Signer } = await import(CORE + 'Signer.js')
const { bytesToHex } = await import(CORE + 'utils.js')

const signer = new Signer('user', 'pass', 1000)
const keys = await signer.keysFor('home')
const key = bytesToHex(keys.publicKey)

/** Resolve pending recaller work plus a macrotask, which is enough for loopback. */
export const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Two Hubs wired server <-> client. Reloads Hub/Upstream/Downstream/loopback
 * from disk on every call, so edits land without restarting.
 *
 * @param {{ fresh?: boolean }} [options]  fresh:false reuses the module cache
 */
export async function pair ({ fresh = true } = {}) {
  const v = fresh ? `?v=${Date.now()}` : ''
  const { Hub } = await import(V2 + 'Hub.js' + v)
  const { Upstream } = await import(V2 + 'Upstream.js' + v)
  const { Downstream } = await import(V2 + 'Downstream.js' + v)
  const { loopback } = await import(V2 + 'loopback.js' + v)

  const [serverEnd, clientEnd] = loopback()
  const serverRecaller = new Recaller('server')
  const server = new Hub({ recaller: serverRecaller })
  const downstream = new Downstream({ hub: server, connection: serverEnd })
  const upstream = new Upstream({ recaller: new Recaller('client'), connection: clientEnd })

  return { server, client: upstream.hub, downstream, upstream, key, signer, serverRecaller }
}

/**
 * Author from the CLIENT, which is the likely direction — the client has the
 * logged-in user making edits; the server holds canon.
 *
 * Note what it does NOT do. No signature wait, no serializer, no batches: the
 * client commits to a draft and Upstream's watch carries it up, Downstream
 * receives it as a proposal, and the verified writer refuses to accept a batch
 * with no SIG yet — so sending early is harmless and it lands when the
 * signature arrives. A server-side version of this needs six more lines —
 * wait for the SIG, build a serializer, submit each batch — precisely because
 * it skips the wire and has to promote the draft itself. That promotion is
 * landIntoCanon in v2/fileSync2.js, and it is the only copy that should exist.
 */
export function author (p, value, message = 'from the client') {
  const draft = p.client.checkout(key, signer, 'home')
  const working = draft.checkout()
  working.set({ ...(draft.get() ?? {}), ...value })
  draft.commit(working, message)
  return draft
}

/**
 * Express client interest in a key. This is the whole upward half of the
 * protocol today: Upstream watches its own hub's keys and sends a want for
 * each new one, so a client that has not touched getMirror has asked for
 * nothing and will be sent nothing. Deliberately not folded into pair() —
 * it is the thing worth watching.
 */
export function want (p, k = key) {
  return p.client.getMirror(k)
}

/** Compact both sides, so you can see what crossed and what didn't. */
export function show (p) {
  const side = (label, hub) => {
    const held = [...hub.keys()]
    const lines = held.map(k => {
      const m = hub.getMirror(k)
      const d = hub.getDraft(k)
      return `    ${k.slice(0, 8)}…  canon ${String(m.byteLength).padStart(5)}B  ` +
             `lastCommit ${m.lastCommit ? 'yes' : 'null'}  draft ${d ? `${d.byteLength}B` : '—'}`
    })
    return `  ${label}: ${held.length} key(s)\n` + (lines.join('\n') || '    (none)')
  }
  console.log(side('server', p.server))
  console.log(side('client', p.client))
}

// Started only when run directly: importing this file for a test must not
// block on stdin, which is exactly what it did the first time I tried.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = repl.start({ prompt: 'streamo2 > ' })
  // Persisted across restarts, and deliberately outside the repo so it never
  // shows up in git status. Override with STREAMO2_REPL_HISTORY.
  const historyPath = process.env.STREAMO2_REPL_HISTORY ?? join(homedir(), '.streamo2_repl_history')
  r.setupHistory(historyPath, error => {
    if (error) console.error('repl history unavailable:', error.message)
  })
  Object.assign(r.context, { pair, author, want, show, settle, key, signer, keys, Recaller, Signer })
  console.log(`
    pair()  -> { server, client, upstream, downstream, key, signer }   reloads v2 on every call
    want(p)                          client asks for the key — nothing crosses until it does
    author(p, { 'a.md': 'hi' })      client authors; the wire carries it up
    settle()  show(p)                                 key is pre-derived
    history: ${historyPath}
  `)
}
