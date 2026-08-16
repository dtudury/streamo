/**
 * @file fileSync2.js — a second attempt, grown rather than refactored.
 *
 * Step 1: two watchers, both logging, neither writing anything.
 *
 * The design this is heading for (David, 2026-08-13/14), stated here because
 * it is the whole reason for a second file rather than a refactor:
 *
 *   **Two mechanisms reacting to two events, with no decision between them.**
 *
 *     disk changed   -> read the folder -> put it in a Draft -> commit
 *     commit arrived -> write the Mirror's contents to disk
 *
 * There is no `diskMtime <= commitTime` and no winner. The old file picks a
 * side by comparing a filesystem timestamp against a commit date, and the
 * losing side gets deleted — which is the branch that removed 115 files,
 * twice. Here, a draft that loses a race is *superseded* and lands in a
 * conflicts store; nothing is decided by comparison and nothing is inferred.
 *
 * Four things that are load-bearing and easy to lose:
 *
 * 1. **The mirror-side trigger is "a commit arrived", not "the mirror has a
 *    value".** `session.subscribe()` resolves *before* the Record syncs, so a
 *    Mirror briefly exists holding nothing. Trigger on the value and the first
 *    thing this does on startup is delete the folder. Trigger on `lastCommit`
 *    and silence produces no event at all — which is what makes "never
 *    reported" and "reported empty" different without needing a guard.
 *
 * 2. **They are not independent — they share the disk.** Mechanism 2 writes
 *    what mechanism 1 watches. What breaks the cycle is idempotence, not
 *    isolation: a write whose bytes already match produces no change. That
 *    means every file type this handles must satisfy `encode(decode(x)) === x`,
 *    or it becomes a permanent commit generator. (This is why `.jsonl` falls
 *    back to a string when it can't prove the round trip, and why markdown as
 *    an h-tree does *not* belong on this path — there is no printer, so there
 *    is no idempotence.)
 *
 * 3. **Read everything before watching the mirror.** A complete read of the
 *    folder has to finish before the first commit event can be processed,
 *    otherwise disk content that was never edited can be overwritten before
 *    anything captured it. The ordering is what upgrades the conflicts store
 *    from "protects your edits" to "protects everything you had".
 *
 * 4. **Complete-read and complete-write are atomic against each other.** Both
 *    mechanisms go through one shared disk gate. If the folder is thrashing and
 *    the read never settles, the mirror write *waits* rather than racing it —
 *    a stall, which is recoverable, instead of a fight, which destroys the
 *    edits it is trying to capture. A gate that never opens should say so out
 *    loud; nothing outside will notice silence.
 *
 * None of that is implemented yet. This file currently only watches and logs,
 * so we can see the two event streams before deciding what to do with them.
 */
import { readFileSync } from 'fs'
import { mkdir, realpath } from 'fs/promises'
import { join, relative } from 'path'

import { compile } from '@gerhobbelt/gitignore-parser'
import { subscribe } from '@parcel/watcher'

const ALWAYS_IGNORE = '*.env\n.DS_Store\n.git\nnode_modules'

const stamp = () => new Date().toISOString().slice(11, 23)
const log = (channel, msg) => console.error(`[fs2 ${stamp()}] ${channel.padEnd(6)} ${msg}`)

/**
 * @param {any} repo    a Mirror (or anything with `lastCommit` + `recaller`)
 * @param {string} folder
 * @param {string|false} [dataDir]  archive dir to exclude, or false for none
 * @param {object} [options]
 * @returns {Promise<{ unsubscribe: () => Promise<void> }>}
 */
export async function fileSync2 (repo, folder = '.', dataDir = '.streamo', options = {}) {
  // Create, then resolve. The old file does `try { realpath } catch {}`, and
  // the catch is reachable — a folder that doesn't exist yet throws ENOENT,
  // fileSync then creates it, and from that point the watcher reports
  // `/private/var/...` while `folder` still says `/var/...`, so every
  // `relative()` yields `../../../private/...` and the accepts filter silently
  // matches nothing. Observed on the first smoke run of this file.
  // mkdir first and there is nothing left to catch.
  await mkdir(folder, { recursive: true })
  folder = await realpath(folder)

  let content = ALWAYS_IGNORE
  try {
    content = readFileSync(join(folder, '.gitignore'), 'utf8') + '\n' + content
  } catch {
    log('setup', `no .gitignore in ${folder} — filtering on ALWAYS_IGNORE alone`)
  }
  const gitignore = compile(content)
  const dataDirRel = dataDir ? relative(folder, dataDir) : null
  const accepts = rel => {
    if (dataDirRel && (rel === dataDirRel || rel.startsWith(dataDirRel + '/'))) return false
    return gitignore.accepts(rel)
  }

  log('setup', `folder=${folder} dataDir=${dataDir ?? '(none)'}`)

  // ── mechanism 2's trigger: a commit arrived ────────────────────────────
  // `lastCommit`, deliberately, not `get()`. See note 1 above.
  // `if (!commit)` is load-bearing and measured: `recaller.watch` runs its
  // callback once at registration, before anything has synced. Locally that was
  // fire 1 of 4; against a live relay Record it was fire 1 of 2. This is the
  // line that makes "never reported" and "reported empty" different without a
  // guard — trigger on the *value* instead and startup deletes the folder.
  //
  // There was a `if (id === lastSeen) return` here too. Measured: zero repeats
  // in either path. It saved a comparison, not a correctness property — a
  // duplicate write is already a no-op downstream on content-equality — so it
  // was a false statement about the code in exchange for nothing. Deleted
  // rather than kept, because a guard nobody can observe firing is how the old
  // file carried `if (!targetRepo) return null // never heard from` for months.
  const onCommit = () => {
    const commit = repo.lastCommit
    if (!commit) return
    const hash = commit.chainHash ?? commit.hash ?? null
    const id = hash ? String(hash).slice(0, 12) : String(commit.date?.getTime?.() ?? '?')
    log('mirror', `commit ${id}  date=${commit.date?.toISOString?.() ?? '?'}  msg=${JSON.stringify(commit.message ?? '')}`)
  }
  repo.recaller.watch('fileSync2:commit-arrived', onCommit)

  // ── mechanism 1's trigger: the folder changed ──────────────────────────
  const subscription = await subscribe(folder, (err, events) => {
    if (err) { log('disk', `watcher error: ${err.message}`); return }
    for (const event of events) {
      const rel = relative(folder, event.path)
      const ok = accepts(rel)
      log('disk', `${event.type.padEnd(6)} ${ok ? ' ' : '·'} ${rel}`)
    }
  })

  log('setup', 'both watchers armed — logging only, nothing is written')

  return {
    async unsubscribe () {
      repo.recaller.unwatch(onCommit)
      await subscription.unsubscribe()
      log('setup', 'stopped')
    }
  }
}
