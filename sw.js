// Service worker: deja la app y el motor de voz guardados para usarla sin internet.
const CACHE = 'te-escucho-v3';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'core.js', 'cloud.js', 'worker.js', 'worklet.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'lib/transformers.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('te-escucho-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // los modelos (Hugging Face) los guarda transformers.js
  const isLib = url.pathname.includes('/lib/');
  e.respondWith((async () => {
    if (isLib) { // motor pesado: caché primero
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
    }
    try { // el resto: red primero (así se actualiza solo); sin red, lo guardado
      const res = await fetch(req);
      if (res.ok && res.status === 200) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
});
