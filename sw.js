/* Camera Watch AI — offline app-shell cache.
 * Caches only this app's own local files so the interface loads
 * without a connection. Camera streams and Hugging Face calls are
 * never cached: they always go to the network. */
var CACHE = "camera-watch-ai-v1";
var SHELL = ["index.html", "app.js", "logic.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { /* first load may be offline-capable later */ })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  var isShell = SHELL.some(function (f) { return url.pathname.endsWith("/" + f); });
  if (event.request.method === "GET" && url.origin === self.location.origin && isShell) {
    event.respondWith(
      caches.match(event.request).then(function (hit) {
        return hit || fetch(event.request);
      })
    );
  }
  // Everything else (camera streams, Hugging Face) passes through untouched.
});
