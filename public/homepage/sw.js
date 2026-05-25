// streamo service worker — step 1: the offline shell.
//
// The small, deliberately un-clever first version. It registers, claims
// open tabs, and serves a network-first cache: every successful fetch
// refreshes the cache, and the cache is consulted only when the network
// fails. Network-first (not cache-first) on purpose — online you always
// get the live bytes, so a stale cached asset can never trap you; the
// cache is purely the offline fallback.
//
// Later steps replace this with StreamoRecord-backed serving — the worker syncs
// the homepage StreamoRecord and serves files straight out of it. There,
// content-addressing makes cache-first safe (immutable bytes, the
// address IS the key). This step just proves the pipeline.

const CACHE = 'streamo-shell-v1'

// install: take over as soon as we're ready — don't wait for old tabs.
self.addEventListener('install', () => self.skipWaiting())

// activate: claim open tabs, and drop any cache that isn't the current one.
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) {
    if (name !== CACHE) await caches.delete(name)
  }
  await self.clients.claim()
})()))

// fetch: network-first. Try the network; on success refresh the cache and
// return the live response; on failure (offline) fall back to the cache.
// Same-origin GETs only — everything else passes straight through.
self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  if (new URL(request.url).origin !== self.location.origin) return
  event.respondWith((async () => {
    try {
      const response = await fetch(request)
      if (response.ok) {
        const cache = await caches.open(CACHE)
        // Cache in the background — a cache write must never delay or
        // break the response the page is waiting on.
        cache.put(request, response.clone()).catch(() => {})
      }
      return response
    } catch (offline) {
      const cached = await caches.match(request)
      if (cached) return cached
      throw offline
    }
  })())
})

// push: a message arrived for an attention that's elsewhere — no tab open,
// or this one not in focus. The relay sends a small JSON payload
// — { title, body, url, tag } — and we surface it as an OS notification.
// `tag` collapses repeats, so a busy room rings once, not once per message.
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data?.json() ?? {} } catch { /* non-JSON push — ignore */ }
  event.waitUntil(self.registration.showNotification(data.title ?? 'streamo', {
    body: data.body ?? '',
    icon: '/streamo.svg',
    badge: '/streamo.svg',
    tag: data.tag,
    data: { url: data.url ?? '/' }
  }))
})

// notificationclick: focus an already-open tab for that URL if there is one,
// otherwise open a fresh one — clicking the notification lands you in the room.
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin)
  event.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(client.url).pathname === target.pathname) return client.focus()
    }
    return self.clients.openWindow(target.href)
  })())
})
