'use strict';
/* Étape 6.2a : sauvegarde des parcours GPS. Encodage sans perte, taille, arrêts prolongés
   (distincts des coupures), validation à l'import, lien avec la séance, et aucun effet sur
   le calcul de la distance. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const T0 = 1_800_000_000_000, SEC = 1000, MIN = 60 * SEC;
const LAT0 = 48.8566, LON0 = 2.3522, M = 1 / 111195;
const K = Math.cos(LAT0 * Math.PI / 180);
const fix = (ms, north, east = 0, acc = 5) => ({ t: T0 + ms, lat: LAT0 + north * M, lon: LON0 + east * M / K, acc });
let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const noise = a => (rnd() - 0.5) * 2 * a;

// Marche réaliste : 1 position/s, bruit ±1 m, virages
function walk(tr, fromSec, toSec, speed, start = [0, 0], win) {
  let [n, e] = start, dir = 0;
  for (let s = fromSec; s <= toSec; s++) {
    if (s % 30 === 0) dir += noise(0.6);
    n += Math.cos(dir) * speed; e += Math.sin(dir) * speed;
    C.trackAddFix(tr, fix(s * SEC, n + noise(1), e + noise(1), 4), win);
  }
  return [n, e];
}
function still(tr, fromSec, toSec, at, every = 1) {
  for (let s = fromSec; s <= toSec; s += every) C.trackAddFix(tr, fix(s * SEC, at[0] + noise(0.8), at[1] + noise(0.8), 4));
}
const distOf = segments => segments.reduce((a, sg) => a + sg.slice(1).reduce((b, p, i) => b + C.haversine({ lat: sg[i][1], lon: sg[i][2] }, { lat: p[1], lon: p[2] }), 0), 0);

// ===================== ENCODAGE =====================
test('encodage des entiers : aller-retour exact (négatifs, grands nombres)', () => {
  const nums = [0, 1, -1, 31, -32, 1000, -1000, 48856600, 2352200, -180000000, 180000000, 172800000, 0x3fffffff, -0x3fffffff];
  for (let i = 0; i < 2000; i++) nums.push(Math.round(noise(2e8)));
  assert.deepEqual(C.decodeInts(C.encodeInts(nums)), nums);
  assert.throws(() => C.encodeInts([2 ** 31]));
  assert.throws(() => C.decodeInts('\u0001abc'), /illisible/);
  assert.throws(() => C.decodeInts('_'), /illisible/, 'texte tronqué');
});

test('parcours : positions retrouvées à l\'identique (heure à la ms, coordonnées au millionième)', () => {
  const tr = C.createTrack('walk');
  walk(tr, 0, 1800, 1.3);
  const t = C.createFreeTimer('walk', T0);
  const route = C.buildRoute(tr, t, T0 + 1800 * SEC, { id: 'rabc', sessionId: 'sabc' });
  const back = C.decodeRoute(JSON.parse(JSON.stringify(route)));
  assert.deepEqual(back.segments, tr.segments, 'aucune perte : mêmes points que ceux du calcul');
  // Distance recalculée depuis le parcours : celle de la séance, à l'arrondi des points près
  // (positions gardées au millionième de degré depuis la 6.1, soit 11 cm) : moins de 10 cm par km
  assert.ok(Math.abs(distOf(back.segments) - tr.meters) < tr.meters / 1000 * 0.1, `${distOf(back.segments)} / ${tr.meters}`);
  assert.equal(route.points, tr.segments.reduce((a, s) => a + s.length, 0));
  assert.equal(route.km, C.trackSummary(tr, t, T0 + 1800 * SEC).km);
});

test('taille : environ 10 à 16 octets par position, moins de 60 Ko pour 1 h de course', () => {
  const tr = C.createTrack('run');
  walk(tr, 0, 3600, 2.8);
  const t = C.createFreeTimer('run', T0);
  const route = C.buildRoute(tr, t, T0 + 3600 * SEC, { id: 'r1', sessionId: 's1' });
  const bytes = C.routeBytes(route), perPoint = route.segs.join('').length / route.points;
  assert.ok(route.points > 1500, `${route.points} positions retenues sur 3 601 reçues`);
  assert.ok(perPoint <= 16, `${perPoint.toFixed(1)} octets par position`);
  assert.ok(bytes < 60 * 1024, `${Math.round(bytes / 1024)} Ko`);
});

// ===================== ARRÊTS PROLONGÉS =====================
test('arrêt de 3 min avec signal : un arrêt prolongé, ni coupure ni distance ajoutée', () => {
  const tr = C.createTrack('walk');
  const at = walk(tr, 0, 300, 1.3);
  const before = tr.meters;
  still(tr, 301, 480, at);                       // 3 min immobile, une position par seconde
  walk(tr, 481, 700, 1.3, at);
  const stops = C.trackStops(tr);
  assert.equal(stops.length, 1);
  // De la dernière position retenue avant l'arrêt à la dernière position immobile : 3 min et quelques s
  assert.ok(stops[0].to - stops[0].from >= 178 * SEC && stops[0].to - stops[0].from <= 190 * SEC, `${(stops[0].to - stops[0].from) / SEC} s`);
  assert.equal(tr.gaps.length, 0, 'un arrêt n\'est pas une coupure GPS');
  assert.ok(tr.meters - before > 200, 'la marche reprend normalement');
  assert.ok(Math.abs(stops[0].lat - (LAT0 + at[0] * M)) < 5 * M);
});

test('arrêt de 90 s : pas d\'arrêt prolongé (seuil de 2 min)', () => {
  const tr = C.createTrack('walk');
  const at = walk(tr, 0, 120, 1.3);
  still(tr, 121, 210, at);
  walk(tr, 211, 300, 1.3, at);
  assert.deepEqual(C.trackStops(tr), []);
});

test('immobile mais sans signal : c\'est une coupure, jamais un arrêt prolongé', () => {
  const tr = C.createTrack('walk');
  const at = walk(tr, 0, 120, 1.3);
  still(tr, 121, 160, at);                       // 40 s immobile avec signal
  // 3 min sans aucune position (écran verrouillé), puis reprise au même endroit
  still(tr, 341, 400, at);
  walk(tr, 401, 500, 1.3, at);
  assert.equal(tr.gaps.length, 1, 'coupure détectée');
  assert.deepEqual(C.trackStops(tr), [], 'aucun arrêt : 40 s puis 60 s, séparés par une coupure');
  for (const s of C.trackStops(tr)) for (const g of tr.gaps) assert.ok(s.to <= g.from || s.from >= g.to);
});

test('arrêt avec positions espacées de 15 s (signal présent) : arrêt prolongé', () => {
  const tr = C.createTrack('walk');
  const at = walk(tr, 0, 60, 1.3);
  still(tr, 75, 270, at, 15);
  walk(tr, 271, 400, 1.3, at);
  assert.equal(C.trackStops(tr).length, 1);
  assert.equal(tr.gaps.length, 0);
});

test('arrêt interrompu par une pause volontaire : clos à la pause, pas compté pendant la pause', () => {
  const tr = C.createTrack('walk');
  const at = walk(tr, 0, 60, 1.3);
  still(tr, 61, 200, at);                        // 2 min 20 immobile
  C.trackPause(tr);
  still(tr, 201, 500, at);                       // pendant la pause : ignoré
  C.trackResume(tr);
  walk(tr, 501, 600, 1.3, at);
  const stops = C.trackStops(tr);
  assert.equal(stops.length, 1);
  assert.ok(stops[0].to <= T0 + 200 * SEC);
});

test('arrêt en cours à la fin de la séance : inclus dans le parcours, sans modifier le suivi', () => {
  const tr = C.createTrack('walk');
  const at = walk(tr, 0, 60, 1.3);
  still(tr, 61, 300, at);
  const snapshot = JSON.stringify(tr);
  assert.equal(C.trackStops(tr).length, 1);
  assert.equal(JSON.stringify(tr), snapshot, 'lecture seule');
  const route = C.buildRoute(tr, C.createFreeTimer('walk', T0), T0 + 300 * SEC, { id: 'r2', sessionId: 's2' });
  assert.equal(route.stops.length, 1);
});

// ===================== DISTANCE INCHANGÉE =====================
test('le suivi des arrêts ne change aucune décision du filtre ni la distance', () => {
  // Même flux de positions, décisions comparées au calcul « nu » (sans état d'arrêt)
  for (let n = 0; n < 30; n++) {
    const a = C.createTrack(n % 2 ? 'run' : 'walk');
    const fixes = [];
    let north = 0, t = 0;
    for (let i = 0; i < 500; i++) {
      t += rnd() < 0.03 ? 30000 + rnd() * 90000 : 500 + rnd() * 3000;
      north += rnd() < 0.3 ? 0 : rnd() * 4;
      fixes.push({ t: T0 + Math.round(t), lat: LAT0 + (north + noise(3) + (rnd() < 0.02 ? 300 : 0)) * M, lon: LON0 + noise(3) * M, acc: rnd() < 0.1 ? 40 : 2 + rnd() * 15 });
    }
    const res = fixes.map(f => C.trackAddFix(a, f));
    // Rejoue en retirant l'état des arrêts à chaque étape : mêmes décisions attendues
    const b = C.createTrack(a.kind);
    const res2 = fixes.map(f => { delete b.stopRun; delete b.stops; return C.trackAddFix(b, f); });
    assert.deepEqual(res2, res);
    assert.equal(b.meters, a.meters);
    assert.deepEqual(b.segments, a.segments);
    assert.deepEqual(b.covered, a.covered);
    assert.deepEqual(b.gaps, a.gaps);
  }
});

// ===================== IMPORT / EXPORT =====================
test('import : un parcours valide est restauré tel quel ; un parcours abîmé est refusé', () => {
  const tr = C.createTrack('walk');
  const at = walk(tr, 0, 600, 1.3);
  still(tr, 601, 800, at);
  const t = C.createFreeTimer('walk', T0);
  C.timerPause(t, T0 + 810 * SEC); C.timerResume(t, T0 + 840 * SEC);
  const route = C.buildRoute(tr, t, T0 + 900 * SEC, { id: 'rs1', sessionId: 's1' });
  const exported = JSON.parse(JSON.stringify({ app: 'levelup', schemaVersion: 3, data: {}, routes: [route] }));
  const back = C.normRoute(exported.routes[0]);
  assert.deepEqual(back, route);
  assert.deepEqual(C.decodeRoute(back).segments, tr.segments);
  assert.deepEqual(back.pauses, [[T0 + 810 * SEC, T0 + 840 * SEC]]);
  assert.equal(back.stops.length, 1);
  // Abîmés : refusés un par un
  assert.equal(C.normRoute({ ...route, segs: ['§§§'] }), null);
  assert.equal(C.normRoute({ ...route, v: 99 }), null);
  assert.equal(C.normRoute({ ...route, id: '../hack' }), null);
  assert.equal(C.normRoute({ ...route, kind: 'bike' }), null);
  assert.equal(C.normRoute({ ...route, endAt: route.t0 - 1 }), null);
  assert.equal(C.normRoute(null), null);
  assert.equal(C.normRoute({ ...route, segs: [C.encodeSegment([[T0, 95, 2, 5]], T0)] }), null, 'latitude impossible');
});

test('séance : le lien vers le parcours est conservé à l\'export et à l\'import', () => {
  const t = C.createFreeTimer('run', T0);
  const e = C.freeSessionEntry(t, T0 + 20 * MIN, { km: 3 });
  const { data } = C.normalizeData({ profile: { name: 'A', weightTracking: false }, onboarded: true, sessions: [{ id: 'sx1', ...e, routeId: 'rsx1' }], weights: [] });
  const back = C.normalizeData(JSON.parse(C.serialize(data))).data;
  assert.equal(back.sessions[0].routeId, 'rsx1');
  const xp = C.deriveGame(back, '2027-01-01').xp;
  const without = C.deriveGame(C.normalizeData({ ...data, sessions: data.sessions.map(({ routeId, ...s }) => s) }).data, '2027-01-01').xp;
  assert.equal(xp, without, 'le parcours ne change pas l\'XP');
});

test('ancien suivi (avant 2.10.0, sans arrêts enregistrés) : toujours valide et convertible', () => {
  const tr = C.createTrack('walk');
  walk(tr, 0, 300, 1.3);
  const old = JSON.parse(JSON.stringify(tr)); delete old.stops; delete old.stopRun;
  assert.ok(C.isValidTrack(old));
  const r = C.buildRoute(old, C.createFreeTimer('walk', T0), T0 + 300 * SEC, { id: 'rold', sessionId: 'sold' });
  assert.deepEqual(r.stops, []);
  assert.deepEqual(C.decodeRoute(r).segments, old.segments);
});
