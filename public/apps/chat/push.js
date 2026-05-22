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
