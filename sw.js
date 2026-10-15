/* =========================================================
   LEVEL UP — Service worker (fonctionnement hors connexion)

   - Les fichiers de l'app sont mis en cache à l'installation.
   - Page principale : réseau d'abord (3 s maximum), sinon cache.
     L'app démarre donc même avec une connexion très faible.
   - Autres fichiers : réponse immédiate depuis le cache, puis
     mise à jour en arrière-plan (« stale-while-revalidate »).
   - Seules les réponses valides sont mises en cache (jamais une
     page d'erreur 404 ou 500).
   - Nouvelle version : elle attend que l'utilisateur clique sur
     « Mettre à jour » (message SKIP_WAITING envoyé par app.js).

   ⚠️ Changer VERSION à chaque modification des fichiers de l'app.
   ========================================================= */
const VERSION = '2.5.2';
const APP_CACHE = `levelup-app-${VERSION}`;
const FONT_CACHE = 'levelup-fonts';
const APP_FILES = [
  './', './index.html', './style.css', './core.js', './app.js', './manifest.json', './icon.svg',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' : on redemande chaque fichier au serveur, sans réutiliser la copie
  // gardée par le navigateur (sinon une mise à jour pourrait installer l'ancienne version)
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_FILES.map(u => new Request(u, { cache: 'reload' })))));
  // Pas de skipWaiting automatique : l'utilisateur choisit le moment de la mise à jour
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('levelup-') && k !== APP_CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

const isFont = url => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)); }

async function putIfOk(cacheName, req, res) {
  // opaque = réponse d'un autre site (polices Google) : on ne peut pas lire son statut
  if (res && (res.ok || res.type === 'opaque')) {
    const c = await caches.open(cacheName);
    await c.put(req, res.clone());
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Polices : cache d'abord (elles ne changent jamais)
  if (isFont(url)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => putIfOk(FONT_CACHE, req, res))));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Page principale : réseau (3 s max) puis cache, en ignorant ?…
  if (req.mode === 'navigate') {
    e.respondWith(
      // (une requête de navigation ne peut pas recevoir d'options : on la reconstruit à partir de son adresse)
      Promise.race([fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => putIfOk(APP_CACHE, './index.html', res)), timeout(3000)])
        .catch(() => caches.match('./index.html', { ignoreSearch: true }))
        .then(res => res || caches.match('./', { ignoreSearch: true }))
    );
    return;
  }

  // Fichiers de l'app : cache immédiat + rafraîchissement en arrière-plan
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      // no-cache : le navigateur revérifie auprès du serveur avant de réutiliser sa copie
      const network = fetch(req, { cache: 'no-cache' }).then(res => putIfOk(APP_CACHE, req, res)).catch(() => null);
      return hit || network.then(res => res || new Response('Hors connexion', { status: 503 }));
    })
  );
});
