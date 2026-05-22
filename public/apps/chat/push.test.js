import { describe } from '../../streamo/utils/testing.js'
import { PushStore } from './push.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync, writeFileSync } from 'fs'

// A throwaway store path per test, cleaned up in a finally.
let counter = 0
const tempPath = () => join(tmpdir(), `streamo-push-${process.pid}-${counter++}.json`)

const sub = n => ({
  endpoint: `https://push.example.com/${n}`,
  keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` }
})

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
})
