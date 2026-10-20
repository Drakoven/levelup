'use strict';
/* Étape 6.2b : préparation de la carte d'un parcours. Tracé enregistré, liaisons indicatives
   (coupure GPS / pause volontaire / reprise du filtre) avec cause et durée, marqueurs de
   départ, d'arrivée, de pause et d'arrêt, cadrage. Aucune incidence sur la distance. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const T0 = 1_800_000_000_000, SEC = 1000;
const LAT0 = 48.8566, LON0 = 2.3522, M = 1 / 111195;
const fix = (sec, north, acc = 4) => ({ t: T0 + sec * SEC, lat: LAT0 + north * M, lon: LON0, acc });
// Marche en ligne droite, une position par seconde ; renvoie la position atteinte (m)
function walk(tr, from, to, speed, start = 0) {
  let n = start;
  for (let s = from; s <= to; s++) { n += speed; C.trackAddFix(tr, fix(s, n)); }
  return n;
}
const build = (tr, t, endSec) => C.buildRoute(tr, t, T0 + endSec * SEC, { id: 'rtest', sessionId: 'stest' });

test('parcours continu : un seul tracé, départ et arrivée, aucune liaison', () => {
  const tr = C.createTrack('walk'), t = C.createFreeTimer('walk', T0);
  walk(tr, 0, 600, 1.3);
  const m = C.routeMapModel(build(tr, t, 600));
  assert.equal(m.track.length, 1);
  assert.equal(m.links.length, 0);
  assert.deepEqual([m.start.lat, m.start.lon], [tr.segments[0][0][1], tr.segments[0][0][2]]);
  const last = tr.segments[0][tr.segments[0].length - 1];
  assert.deepEqual([m.end.lat, m.end.lon], [last[1], last[2]]);
  assert.ok(m.bounds[0][0] <= m.start.lat && m.bounds[1][0] >= m.end.lat);
});

test('coupure GPS de 3 min : liaison rouge « gap » avec sa durée exacte', () => {
  const tr = C.createTrack('walk'), t = C.createFreeTimer('walk', T0);
  const n = walk(tr, 0, 300, 1.3);
  walk(tr, 480, 700, 1.3, n + 234);             // 3 min sans position, la marche a continué
  const m = C.routeMapModel(build(tr, t, 700));
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].type, 'gap');
  assert.equal(m.links[0].ms, 180 * SEC);
  assert.equal(m.links[0].t2, T0 + 480 * SEC);
  assert.equal(m.track.length, 2);
});

test('pause volontaire : liaison grise « pause » avec la durée de la pause, marqueur ⏸', () => {
  const tr = C.createTrack('walk'), t = C.createFreeTimer('walk', T0);
  const n = walk(tr, 0, 300, 1.3);
  C.timerPause(t, T0 + 301 * SEC); C.trackPause(tr);
  for (let s = 302; s <= 420; s++) C.trackAddFix(tr, fix(s, n + (s - 301) * 1.2)); // marche pendant la pause : ignorée
  C.timerResume(t, T0 + 421 * SEC); C.trackResume(tr);
  walk(tr, 422, 600, 1.3, n + 144);
  const m = C.routeMapModel(build(tr, t, 600));
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].type, 'pause');
  assert.equal(m.links[0].ms, 120 * SEC);
  assert.equal(m.pauses.length, 1);
  assert.equal(m.pauses[0].ms, 120 * SEC);
  const lastBefore = tr.segments[0][tr.segments[0].length - 1];
  assert.deepEqual([m.pauses[0].lat, m.pauses[0].lon], [lastBefore[1], lastBefore[2]], 'à la dernière position avant la pause');
});

test('reprise du filtre après 3 positions aberrantes : liaison grise « filtre », pas une coupure', () => {
  const tr = C.createTrack('walk'), t = C.createFreeTimer('walk', T0);
  const n = walk(tr, 0, 120, 1.3);
  // Le point de référence était faux : 3 positions « impossibles » d'affilée, puis le filtre repart
  for (let s = 121; s <= 123; s++) C.trackAddFix(tr, fix(s, n + 80 + (s - 121) * 1.3));
  walk(tr, 124, 300, 1.3, n + 84);
  const m = C.routeMapModel(build(tr, t, 300));
  assert.equal(tr.gaps.length, 0, 'aucune coupure de signal');
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].type, 'filtre');
  assert.ok(m.links[0].ms > 0 && m.links[0].ms <= 3 * SEC);
});

test('arrêt prolongé : marqueur avec sa durée, distinct des coupures', () => {
  const tr = C.createTrack('walk'), t = C.createFreeTimer('walk', T0);
  const n = walk(tr, 0, 200, 1.3);
  for (let s = 201; s <= 380; s++) C.trackAddFix(tr, fix(s, n + (s % 2 ? 0.4 : -0.4)));
  walk(tr, 381, 500, 1.3, n);
  const m = C.routeMapModel(build(tr, t, 500));
  assert.equal(m.stops.length, 1);
  assert.ok(m.stops[0].ms >= 178 * SEC);
  assert.equal(m.links.length, 0, 'un arrêt ne crée aucune liaison');
});

test('séance mixte : coupure, pause et arrêt correctement distingués, dans l\'ordre', () => {
  const tr = C.createTrack('walk'), t = C.createFreeTimer('walk', T0);
  let n = walk(tr, 0, 200, 1.3);
  for (let s = 201; s <= 340; s++) C.trackAddFix(tr, fix(s, n + (s % 2 ? 0.3 : -0.3)));   // arrêt 2 min 20
  n = walk(tr, 341, 500, 1.3, n);
  n = walk(tr, 620, 800, 1.3, n + 156);                                                  // coupure de 2 min
  C.timerPause(t, T0 + 801 * SEC); C.trackPause(tr);
  C.timerResume(t, T0 + 861 * SEC); C.trackResume(tr);                                   // pause d'1 min
  walk(tr, 862, 1000, 1.3, n);
  const m = C.routeMapModel(build(tr, t, 1000));
  assert.deepEqual(m.links.map(l => l.type), ['gap', 'pause']);
  assert.deepEqual(m.links.map(l => l.ms), [120 * SEC, 60 * SEC]);
  assert.equal(m.stops.length, 1);
  assert.equal(m.pauses.length, 1);
  assert.equal(m.track.length, 3);
});

test('carte préparée depuis un parcours enregistré puis relu (export / import)', () => {
  const tr = C.createTrack('run'), t = C.createFreeTimer('run', T0);
  const n = walk(tr, 0, 300, 3);
  walk(tr, 400, 600, 3, n + 300);
  const route = C.normRoute(JSON.parse(JSON.stringify(build(tr, t, 600))));
  const m = C.routeMapModel(route);
  assert.equal(m.points, route.points);
  assert.equal(m.links[0].type, 'gap');
});

test('parcours vide : aucun point, aucune carte à afficher', () => {
  const tr = C.createTrack('walk'), t = C.createFreeTimer('walk', T0);
  const m = C.routeMapModel(build(tr, t, 60));
  assert.equal(m.points, 0);
  assert.equal(m.start, null);
  assert.equal(m.bounds, null);
});

test('préparer la carte ne modifie ni le parcours ni la distance', () => {
  const tr = C.createTrack('walk'), t = C.createFreeTimer('walk', T0);
  const n = walk(tr, 0, 300, 1.3);
  walk(tr, 480, 700, 1.3, n + 234);
  const route = build(tr, t, 700), before = JSON.stringify(route), meters = tr.meters;
  C.routeMapModel(route); C.routeMapModel(C.decodeRoute(route));
  assert.equal(JSON.stringify(route), before);
  assert.equal(tr.meters, meters);
});
