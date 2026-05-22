/**
 * @file push — the relay's Web Push side: a subscription store and the
 * HTTP routes that let chat clients register for OS notifications.
 *
 * Subscriptions live in a plain JSON file in the data dir — deliberately
 * NOT a streamo Repo: a Repo in the registry is servable at
 * `/streams/<key>`, and push subscriptions (endpoint URLs, keys) must
 * stay private. So this is a private file, off the registry.
 *
 * The crypto is in webpush.js; this module is storage + plumbing. The
 * relay-fires-a-push-when-a-message-lands half comes next.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { sendWebPush } from './webpush.js'

/**
 * A persistent set of Web Push subscriptions, keyed by endpoint (so a
 * client re-subscribing just refreshes its entry). Each entry pairs the
 * raw PushSubscription with the subscriber's chat pubkey — the key lets
 * the sender skip notifying an author of their own message.
 */
export class PushStore {
  #path
  #subs   // Map<endpoint, { subscription, key }>

  constructor (path) {
    this.#path = path
    this.#subs = new Map()
    if (existsSync(path)) {
      try {
        for (const entry of JSON.parse(readFileSync(path, 'utf8'))) {
          this.#subs.set(entry.subscription.endpoint, entry)
        }
      } catch { /* corrupt or unreadable store — start empty */ }
    }
  }

  /** Record (or refresh) a subscription. `key` is the subscriber's chat pubkey. */
  add (subscription, key) {
    this.#subs.set(subscription.endpoint, { subscription, key })
    this.#flush()
  }

  /** Drop a subscription by endpoint — used when a push comes back 404/410. */
  remove (endpoint) {
    if (this.#subs.delete(endpoint)) this.#flush()
  }

  /** Every stored `{ subscription, key }` entry. */
  all () {
    return [...this.#subs.values()]
  }

  #flush () {
    mkdirSync(dirname(this.#path), { recursive: true })
    writeFileSync(this.#path, JSON.stringify([...this.#subs.values()], null, 2))
  }
}

/**
 * Build the `routes` hook for webSync — registers the relay's push
 * endpoints on the Express app:
 *
 *   GET  /api/push/key        → the VAPID public key (clients subscribe with it)
 *   POST /api/push/subscribe  → store a { subscription, key } from a client
 *
 * @param {PushStore} store
 * @param {string} vapidPublicKey  base64url VAPID application-server key
 */
export function pushRoutes (store, vapidPublicKey) {
  return app => {
    app.get('/api/push/key', (req, res) => res.json({ key: vapidPublicKey }))

    app.post('/api/push/subscribe', (req, res) => {
      const { subscription, key } = req.body ?? {}
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return res.status(400).json({ error: 'malformed subscription' })
      }
      store.add(subscription, typeof key === 'string' ? key : null)
      res.json({ ok: true })
    })
  }
}

// A chat message older than this is history — archive load on startup, a
// client's backlog syncing up later — not news. We decide freshness by the
// message's own timestamp, never by a counter, so none of that ever pages
// anyone: only a message sent within this window counts.
const NOTIFY_WINDOW_MS = 120000

/**
 * Watch every chat repo in the registry; when a genuinely fresh message
 * lands, Web Push it to every subscriber except the message's own author.
 *
 * Freshness is the message's timestamp, not a delta count — so a burst of
 * messages streaming in from the archive at startup, or a peer's history
 * syncing up after they connect, never notifies: that content is stamped
 * in the past. The author is skipped via the chat pubkey stored alongside
 * each subscription.
 *
 * @param {import('../../streamo/RepoRegistry.js').RepoRegistry} registry
 * @param {PushStore} store
 * @param {{ publicKey: string, privateKey: string, subject: string }} vapid
 * @param {{ send?: typeof sendWebPush }} [opts]  `send` is injectable for tests
 */
export function notifyOnMessages (registry, store, vapid, { send = sendWebPush } = {}) {
  const counts = new Map()   // keyHex → messages.length last seen

  registry.recaller.watch('push-notify', () => {
    for (const [keyHex, repo] of registry) {
      repo.byteLength                          // dep: re-run when this repo grows
      const messages = repo.get?.('messages')
      if (!Array.isArray(messages)) continue    // not a chat repo
      const prev = counts.get(keyHex) ?? 0
      counts.set(keyHex, messages.length)
      if (messages.length <= prev) continue     // nothing new on this repo

      // The newest message — and only if it's genuinely recent.
      const last = messages[messages.length - 1]
      if (Date.now() - +(last?.at ?? 0) > NOTIFY_WINDOW_MS) continue

      const text = typeof last === 'string' ? last : (last?.text ?? '')
      const payload = {
        title: `${repo.get('name') || 'someone'} · streamo chat`,
        body: text.length > 140 ? text.slice(0, 140).trim() + '…' : text,
        url: '/apps/chat/',
        tag: 'streamo-chat'
      }
      for (const { subscription, key } of store.all()) {
        if (key === keyHex) continue            // don't notify an author of their own message
        send(subscription, payload, vapid)
          .then(status => {
            if (status === 404 || status === 410) store.remove(subscription.endpoint)
            else if (status >= 400) console.error(`[push] push service rejected the send (${status})`)
          })
          .catch(err => console.error(`[push] send failed: ${err.message}`))
      }
    }
  })
}
