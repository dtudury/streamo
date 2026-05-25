import { describe } from '../../streamo/utils/testing.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync, writeFileSync } from 'fs'
import { Recaller } from '../../streamo/utils/Recaller.js'
import { StreamoRecordRegistry } from '../../streamo/StreamoRecordRegistry.js'
import { Signer } from '../../streamo/Signer.js'
import { bytesToHex } from '../../streamo/utils.js'
import { PushStore, notifyOnMessages } from './push.js'

// A throwaway store path per test, cleaned up in a finally.
let counter = 0
const tempPath = () => join(tmpdir(), `streamo-push-${process.pid}-${counter++}.json`)

const sub = n => ({
  endpoint: `https://push.example.com/${n}`,
  keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` }
})

/** Poll until fn() is truthy, or reject after `ms`. */
function waitFor (fn, ms = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const poll = () => {
      if (fn()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

// A signer + a helper to open a signed "chat" repo (one with a messages
// array) inside a registry, so notifyOnMessages has something to watch.
const SIGNER = new Signer('push-test', 'pw', 1)
async function chatRepo (registry, name) {
  const { publicKey } = await SIGNER.keysFor(name)
  const hex = bytesToHex(publicKey)
  const repo = await registry._materialize(hex)
  repo.attachSigner(SIGNER, name)
  return { repo, hex }
}

describe(import.meta.url, ({ test }) => {
  test('add then all returns the stored subscription', ({ assert }) => {
    const path = tempPath()
    try {
      const store = new PushStore(path)
      store.add(sub(1), 'alicekey')
      const all = store.all()
      assert.equal(all.length, 1)
      assert.equal(all[0].subscription.endpoint, 'https://push.example.com/1')
      assert.equal(all[0].key, 'alicekey')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('re-adding the same endpoint refreshes, does not duplicate', ({ assert }) => {
    const path = tempPath()
    try {
      const store = new PushStore(path)
      store.add(sub(1), 'oldkey')
      store.add(sub(1), 'newkey')
      assert.equal(store.all().length, 1)
      assert.equal(store.all()[0].key, 'newkey')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('remove drops a subscription by endpoint', ({ assert }) => {
    const path = tempPath()
    try {
      const store = new PushStore(path)
      store.add(sub(1), 'k1')
      store.add(sub(2), 'k2')
      store.remove('https://push.example.com/1')
      const all = store.all()
      assert.equal(all.length, 1)
      assert.equal(all[0].subscription.endpoint, 'https://push.example.com/2')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('subscriptions persist — a fresh store loads what was saved', ({ assert }) => {
    const path = tempPath()
    try {
      const a = new PushStore(path)
      a.add(sub(1), 'k1')
      a.add(sub(2), 'k2')
      const b = new PushStore(path)   // fresh instance, same file
      assert.equal(b.all().length, 2)
      const endpoints = b.all().map(e => e.subscription.endpoint).sort()
      assert.equal(endpoints[0], 'https://push.example.com/1')
      assert.equal(endpoints[1], 'https://push.example.com/2')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('a corrupt store file is tolerated — starts empty', ({ assert }) => {
    const path = tempPath()
    try {
      writeFileSync(path, 'this is not json {{{')
      const store = new PushStore(path)   // must not throw
      assert.equal(store.all().length, 0)
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('notifyOnMessages pushes when a fresh message lands', async ({ assert }) => {
    const path = tempPath()
    try {
      const registry = new StreamoRecordRegistry({ recaller: new Recaller("push-test") })
      const sent = []
      const send = async (subscription, payload) => { sent.push({ subscription, payload }); return 201 }

      const store = new PushStore(path)
      store.add(sub(1), 'a-subscriber')
      notifyOnMessages(registry, store, {}, { send })

      const { repo } = await chatRepo(registry, 'alice')
      repo.set({ name: 'alice', messages: [{ text: 'hello there', at: new Date() }] })

      await waitFor(() => sent.length === 1)
      assert.equal(sent[0].payload.body, 'hello there')
      assert.ok(sent[0].payload.title.includes('alice'), 'title names the sender')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('notifyOnMessages does not notify a message\'s own author', async ({ assert }) => {
    const path = tempPath()
    try {
      const registry = new StreamoRecordRegistry({ recaller: new Recaller("push-test") })
      const sent = []
      const send = async () => { sent.push(1); return 201 }

      const { repo, hex } = await chatRepo(registry, 'bob')
      const store = new PushStore(path)
      store.add(sub(1), hex)              // the only subscriber IS bob
      notifyOnMessages(registry, store, {}, { send })

      repo.set({ name: 'bob', messages: [{ text: 'my own message', at: new Date() }] })
      await new Promise(r => setTimeout(r, 200))
      assert.equal(sent.length, 0, 'an author is not pushed their own message')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('notifyOnMessages ignores an old message (history, not news)', async ({ assert }) => {
    const path = tempPath()
    try {
      const registry = new StreamoRecordRegistry({ recaller: new Recaller("push-test") })
      const sent = []
      const send = async () => { sent.push(1); return 201 }

      const store = new PushStore(path)
      store.add(sub(1), 'a-subscriber')
      notifyOnMessages(registry, store, {}, { send })

      const { repo } = await chatRepo(registry, 'carol')
      repo.set({ name: 'carol', messages: [{ text: 'ancient', at: new Date(Date.now() - 30 * 60000) }] })
      await new Promise(r => setTimeout(r, 200))
      assert.equal(sent.length, 0, 'a message older than the window does not notify')
    } finally {
      rmSync(path, { force: true })
    }
  })
})
