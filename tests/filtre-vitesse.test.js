'use strict';
/* Filtre de vitesse GPS : compteurs de diagnostic et reproduction du défaut constaté au premier
   test réel (marche avec Bounty, 201 positions ignorées).

   Le défaut : quand une position est jugée « immobile », le point de référence garde sa position
   mais prend l'heure de la nouvelle position. Quand le marcheur dépasse enfin le seuil
   d'immobilité, toute la distance accumulée depuis plusieurs secondes est divisée par 1 seconde :
   la vitesse calculée est fausse (3,9 m/s au lieu de 1,3 m/s) et la position est rejetée comme
   « vitesse aberrante ».

   Les tests marqués « todo » décrivent le comportement attendu après la correction : ils échouent
   aujourd'hui (le défaut est reproduit), sans bloquer les autres tests. La correction ne sera
   appliquée qu'après validation, avec les données du prochain test réel. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const T0 = 1_800_000_000_000, SEC = 1000, M = 1 / 111195, LAT0 = 48.85, LON0 = 2.35;
const fix = (sec, meters, acc = 2) => ({ t: T0 + sec * SEC, lat: LAT0 + meters * M, lon: LON0, acc });
// Marche régulière en ligne droite, une position par seconde (fréquence de l'iPhone en mouvement)
function walkLine(tr, sec, speed, acc = 2) {
  const res = [];
  for (let s = 0; s <= sec; s++) res.push(C.trackAddFix(tr, fix(s, s * speed, acc)));
  return res;
}
// Même marche avec un bruit réaliste (écart type 1 m par axe), toujours le même tirage
function walkNoisy(tr, sec, speed, acc, noise = 1) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const k = Math.cos(LAT0 * Math.PI / 180);
  for (let s = 0; s <= sec; s++) C.trackAddFix(tr, { t: T0 + s * SEC, lat: LAT0 + (s * speed + g() * noise) * M, lon: LON0 + g() * noise * M / k, acc });
}

// ===================== COMPTEURS DE DIAGNOSTIC =====================
test('diagnostic : chaque position reçue est classée dans une seule catégorie', () => {
  const tr = C.createTrack('walk');
  const win = { from: T0, to: T0 + 600 * SEC };
  C.trackAddFix(tr, fix(0, 0), win);                                 // retenue (départ)
  C.trackAddFix(tr, fix(1, 0.5), win);                               // immobilité
  C.trackAddFix(tr, fix(2, 1, 40), win);                             // précision insuffisante
  C.trackAddFix(tr, fix(3, 200), win);                               // vitesse aberrante
  C.trackAddFix(tr, fix(1, 1), win);                                 // horodatage : plus ancienne
  C.trackAddFix(tr, { ...fix(5, 5), t: T0 + 9999 * SEC }, win);      // horodatage : hors séance
  C.trackAddFix(tr, { t: T0 + 6 * SEC, lat: NaN, lon: LON0, acc: 2 }, win); // autre : invalide
  C.trackPause(tr);
  C.trackAddFix(tr, fix(7, 9), win);                                 // pendant la pause
  C.trackResume(tr);
  C.trackAddFix(tr, fix(8, 10), win);                                // retenue (reprise)
  assert.deepEqual(tr.diag, { kept: 2, still: 1, accuracy: 1, jump: 1, time: 2, paused: 1, other: 1 });
  const total = C.DIAG_KEYS.reduce((a, k) => a + tr.diag[k], 0);
  assert.equal(total, 9, 'aucune position oubliée ni comptée deux fois');
  // Le total affiché jusqu'ici (« positions ignorées ») reste précision + vitesse
  assert.equal(C.trackSummary(tr, 10 * SEC).rejected, 2);
});

test('diagnostic : enregistré avec la séance, conservé à l\'import, valeurs invalides écartées', () => {
  const tr = C.createTrack('walk');
  walkLine(tr, 120, 1.3);
  const t = C.createFreeTimer('walk', T0);
  const info = C.gpsSessionInfo(tr, t, T0 + 120 * SEC);
  assert.equal(info.diag.kept + info.diag.still + info.diag.jump, 121);
  const e = C.freeSessionEntry(t, T0 + 120 * SEC, { measured: { km: 0.16, source: 'gps' }, gps: info });
  const profile = { name: 'A', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
  const { data } = C.normalizeData({ profile, sessions: [{ id: 'a1', ...e }, { id: 'a2', ...e, gps: { ...info, diag: { kept: -4 } } }] });
  const back = C.normalizeData(JSON.parse(C.serialize(data))).data;
  assert.deepEqual(back.sessions[0].gps.diag, info.diag);
  assert.equal(back.sessions[1].gps.diag, undefined, 'diagnostic abîmé : ignoré, le reste de la séance est gardé');
  assert.equal(back.sessions[1].gps.coverage, info.coverage);
});

test('diagnostic : un suivi d\'avant cette version (sans compteurs) reste utilisable', () => {
  const tr = C.createTrack('walk'); delete tr.diag;
  assert.ok(C.isValidTrack(tr));
  C.trackAddFix(tr, fix(0, 0));
  assert.equal(tr.diag.kept, 1);
});

// ===================== DÉFAUT DU FILTRE DE VITESSE =====================
test('défaut reproduit (comportement actuel) : marche à 1,3 m/s, positions parfaites à ±2 m', () => {
  const tr = C.createTrack('walk');
  const res = walkLine(tr, 600, 1.3);
  // 1 position sur 4 rejetée pour « vitesse aberrante » alors que la marche est régulière
  assert.equal(tr.diag.jump, 150);
  assert.deepEqual(res.slice(1, 9), ['still', 'still', 'jump', 'move', 'still', 'still', 'jump', 'move']);
  // Ce que voit le filtre : 3,9 m parcourus en 3 s, mais divisés par 1 s
  // La distance reste juste ici, car la position suivante est acceptée et compte tout le trajet
  assert.equal(C.trackSummary(tr, 600 * SEC).km, 0.78);
});

test('défaut reproduit (comportement actuel) : à ±5 m avec bruit, la distance est sous-estimée', () => {
  const tr = C.createTrack('walk');
  walkNoisy(tr, 600, 1.3, 5);
  // 3 rejets d'affilée → nouveau tronçon : la distance entre les deux n'est pas comptée
  assert.ok(tr.segments.length > 20, `${tr.segments.length} tronçons pour une marche continue`);
  assert.equal(C.trackSummary(tr, 600 * SEC).km, 0.53, '0,53 km comptés pour 0,78 km parcourus (−32 %)');
});

test('défaut reproduit (comportement actuel) : marche rapide à 1,9 m/s avec bruit, sous-estimée', () => {
  const tr = C.createTrack('walk');
  walkNoisy(tr, 600, 1.9, 2);
  assert.ok(tr.diag.jump > 250, `${tr.diag.jump} rejets de vitesse sur 601 positions`);
  assert.equal(C.trackSummary(tr, 600 * SEC).km, 0.94, '0,94 km comptés pour 1,14 km parcourus (−18 %)');
});

test('positions après déverrouillage : pas de rejet systématique', () => {
  const tr = C.createTrack('walk');
  for (let s = 0; s <= 120; s += 3) C.trackAddFix(tr, fix(s, s * 1.3, 2));  // une position toutes les 3 s
  const before = { ...tr.diag };
  // 3 min écran verrouillé : la marche continue (234 m), aucune position
  const res = [];
  for (let s = 300; s <= 420; s += 3) res.push(C.trackAddFix(tr, fix(s, 390 + (s - 300) * 1.3, 2)));
  assert.equal(res[0], 'gap', 'la première position après déverrouillage ouvre un nouveau tronçon');
  assert.equal(tr.diag.jump - before.jump, 0, 'aucune position rejetée pour vitesse après le retour');
  assert.equal(tr.diag.time - before.time, 0);
  assert.equal(tr.gaps.length, 1);
});

// ===================== COMPORTEMENT ATTENDU APRÈS CORRECTION (todo) =====================
const TODO = { todo: 'correction du filtre de vitesse en attente de validation (test réel)' };

test('attendu : 10 min immobile (bruit réaliste) ne crée pas plus de 20 m', TODO, () => {
  // Garde-fou : la correction ne doit pas laisser passer le bruit d'un téléphone à l'arrêt
  const tr = C.createTrack('walk');
  walkNoisy(tr, 600, 0, 2);
  assert.ok(C.trackSummary(tr, 600 * SEC).km <= 0.02);
});

test('attendu : une marche régulière à ±2 m ne produit aucun rejet de vitesse', TODO, () => {
  const tr = C.createTrack('walk');
  walkLine(tr, 600, 1.3);
  assert.equal(tr.diag.jump, 0);
});

test('attendu : à ±5 m, la distance d\'une marche régulière est complète (± 5 %)', TODO, () => {
  const tr = C.createTrack('walk');
  walkNoisy(tr, 600, 1.3, 5);
  const km = C.trackSummary(tr, 600 * SEC).km;
  assert.ok(Math.abs(km - 0.78) <= 0.04, `${km} km`);
});

test('attendu : marche rapide à 1,9 m/s comptée en entier (± 5 %)', TODO, () => {
  const tr = C.createTrack('walk');
  walkNoisy(tr, 600, 1.9, 2);
  const km = C.trackSummary(tr, 600 * SEC).km;
  assert.ok(Math.abs(km - 1.14) <= 0.06, `${km} km`);
});
