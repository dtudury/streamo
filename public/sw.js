// TOMBSTONE. This is not the service-worker relay and never was.
//
// What was wanted, in David's words (2026-08-09), and it is specified in
// ROADMAP.md under "Service-worker relay (in-browser streamo node)":
//
//   "it should serve files from the Records and pretend to be the web server,
//    it shouldn't use the web server."
//
// What was here instead: network-first caching of what the web server returned,
// plus the receive end of Web Push. The caching half made the WEB SERVER
// authoritative, which is backwards for this project — the Records are. It was
// never a partial relay; it pointed the wrong way.
//
// This file exists only to remove itself from browsers that already installed
// the old one. A 404 does NOT unregister a service worker: without this, every
// browser that ever loaded streamo.dev keeps running the cached copy forever.
//
// It also ends Web Push, which was hand-rolled against RFC 8291 and verified on
// a real device on 2026-05-22. A `push` event can only be delivered to a service
// worker, so there was nowhere else for those handlers to go. That arc is not
// deleted from the record — see CHANGELOG 8.6.0 and memory/birth-stories.md.
//
// REMOVE THIS FILE, and the register() calls in public/index.html and
// public/demo-homepage/index.html, once installed clients have had time to
// update. Deleting it before then strands them on the old worker.

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key)
    await self.registration.unregister()
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url).catch(() => {})
    }
  })())
})
