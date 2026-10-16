'use strict';
/* Tests du GPS en direct (étape 6.1) : positions valides, sauts aberrants, immobilité,
   pauses et reprise, perte de signal, permissions refusées, sauvegarde et import. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const T0 = 1_800_000_000_000, SEC = 1000;
const LAT0 = 48.8566, LON0 = 2.3522;           // point de départ
const M = 1 / 111195;                            // 1 mètre en degrés de latitude
// Position à `meters` au nord du départ, à l'instant t (ms depuis T0)
const fix = (t, meters, acc = 6, east = 0) => ({ t: T0 + t, lat: LAT0 + meters * M, lon: LON0 + east * M / Math.cos(LAT0 * Math.PI / 180), acc });
// Course régulière : une position toutes les `every` secondes à `speed` m/s
function runLine(tr, fromSec, toSec, speed, startMeters = 0, every = 3, acc = 6) {
  for (let s = fromSec; s <= toSec; s += every) C.trackAddFix(tr, fix(s * SEC, startMeters + (s - fromSec) * speed, acc));
}

// ===================== BASES =====================
test('distance : formule de haversine (1 km plein nord)', () => {
  const d = C.haversine({ lat: LAT0, lon: LON0 }, { lat: LAT0 + 1000 * M, lon: LON0 });
  assert.ok(Math.abs(d - 1000) < 1, `${d} m`);
});

test('positions valides : 1 km de course à 3 m/s → environ 1 km, allure 5 min 33 /km', () => {
  const tr = C.createTrack('run');
  runLine(tr, 0, 333, 3);
  const s = C.trackSummary(tr, 333 * SEC);
  assert.ok(Math.abs(s.km - 1) <= 0.01, `${s.km} km`);
  assert.ok(Math.abs(s.paceSecPerKm - 333) <= 5);
  assert.equal(s.coverage, 1);
  assert.equal(s.gaps, 0);
});

test('marche : 1,4 m/s acceptée, aucune position rejetée', () => {
  const tr = C.createTrack('walk');
  runLine(tr, 0, 600, 1.4);
  assert.ok(Math.abs(C.trackSummary(tr, 600 * SEC).km - 0.84) < 0.01);
  assert.equal(tr.rejected.jump + tr.rejected.accuracy, 0);
});

// ===================== POSITIONS DOUTEUSES =====================
test('saut aberrant (300 m en 3 s) : rejeté, aucun kilomètre ajouté', () => {
  const tr = C.createTrack('run');
  runLine(tr, 0, 60, 3);                         // 180 m
  const before = tr.meters;
  assert.equal(C.trackAddFix(tr, fix(63 * SEC, 180 + 300)), 'jump');
  assert.equal(tr.meters, before);
  // La course continue normalement ensuite
  assert.equal(C.trackAddFix(tr, fix(66 * SEC, 189)), 'move');
  assert.equal(tr.rejected.jump, 1);
});

test('vitesse limite : 25 km/h en course passe, au-delà rejeté ; la marche est plus stricte', () => {
  const run = C.createTrack('run'); C.trackAddFix(run, fix(0, 0));
  assert.equal(C.trackAddFix(run, fix(10 * SEC, 65)), 'move', '6,5 m/s = 23 km/h');
  const walk = C.createTrack('walk'); C.trackAddFix(walk, fix(0, 0));
  assert.equal(C.trackAddFix(walk, fix(10 * SEC, 65)), 'jump', '23 km/h en marche : impossible');
});

test('point de référence faux : après 3 sauts, on repart du nouveau point SANS compter l\'écart', () => {
  const tr = C.createTrack('run');
  C.trackAddFix(tr, fix(0, 0, 8));
  // Le premier point était faux : toutes les positions suivantes paraissent à 400 m
  C.trackAddFix(tr, fix(3 * SEC, 400)); C.trackAddFix(tr, fix(6 * SEC, 409)); C.trackAddFix(tr, fix(9 * SEC, 418));
  assert.equal(tr.meters, 0, 'les 400 m fantômes ne sont jamais comptés');
  assert.equal(tr.segments.length, 2);
  assert.equal(C.trackAddFix(tr, fix(12 * SEC, 427)), 'move');
  assert.ok(tr.meters > 8 && tr.meters < 10);
});

test('précision insuffisante (> 25 m) : ignorée pour la distance', () => {
  const tr = C.createTrack('run');
  runLine(tr, 0, 30, 3, 0, 3, 40);
  assert.equal(tr.meters, 0);
  assert.equal(tr.rejected.accuracy, 11);
  assert.equal(C.gpsSignal(tr, T0 + 31 * SEC), 'faible');
});

test('téléphone immobile : le bruit GPS ne crée pas de distance', () => {
  // Bruit réaliste : ±2,5 m d'une position à l'autre, précision 8 m, pendant 5 minutes
  const tr = C.createTrack('walk');
  for (let s = 0; s <= 300; s += 3) C.trackAddFix(tr, fix(s * SEC, (s % 2 ? 2.5 : -2.5), 8, (s % 3) - 1));
  assert.ok(tr.meters < 5, `${tr.meters} m`);
  assert.equal(C.trackSummary(tr, 300 * SEC).coverage, 1, 'le temps immobile reste couvert');
});

// ===================== PAUSES ET REPRISE =====================
test('pause : les déplacements pendant la pause ne comptent pas, la reprise ouvre un tronçon', () => {
  const tr = C.createTrack('run');
  runLine(tr, 0, 120, 3);                        // 360 m
  C.trackPause(tr);
  runLine(tr, 123, 300, 1.5, 360);                // marche de 270 m pendant la pause
  assert.ok(Math.abs(tr.meters - 360) < 1, 'rien n\'est ajouté pendant la pause');
  C.trackResume(tr);
  runLine(tr, 303, 363, 3, 630);                  // reprise : 180 m
  assert.ok(Math.abs(tr.meters - 540) < 1, `${tr.meters} m`);
  assert.equal(tr.segments.length, 2);
  assert.equal(tr.gaps.length, 0, 'une pause n\'est pas une perte de signal');
});

// ===================== PERTE DE SIGNAL =====================
test('perte de signal (écran verrouillé 3 min) : aucun kilomètre inventé entre les tronçons', () => {
  const tr = C.createTrack('run');
  runLine(tr, 0, 120, 3);                         // 360 m
  // Silence de 180 s, pendant lesquels le coureur a fait ~540 m
  assert.equal(C.trackAddFix(tr, fix(300 * SEC, 900)), 'gap');
  runLine(tr, 303, 363, 3, 909);
  const s = C.trackSummary(tr, 363 * SEC);
  // 360 m + 9 m (300 → 303 s) + 180 m = 549 m : les 540 m parcourus pendant le silence ne comptent pas
  assert.equal(s.km, 0.55, `${s.km} km : seules les portions suivies comptent`);
  assert.equal(s.gaps, 1);
  assert.ok(s.coverage < 0.6, 'la couverture signale la portion manquante');
  assert.deepEqual(tr.gaps[0], { from: T0 + 120 * SEC, to: T0 + 300 * SEC });
});

test('signal : attente, bon, moyen, perdu', () => {
  const tr = C.createTrack('run');
  assert.equal(C.gpsSignal(tr, T0), 'attente');
  C.trackAddFix(tr, fix(0, 0, 5));
  assert.equal(C.gpsSignal(tr, T0 + SEC), 'bon');
  C.trackAddFix(tr, fix(3 * SEC, 9, 18));
  assert.equal(C.gpsSignal(tr, T0 + 4 * SEC), 'moyen');
  assert.equal(C.gpsSignal(tr, T0 + 20 * SEC), 'perdu');
});

test('positions invalides ou en double : ignorées', () => {
  const tr = C.createTrack('run');
  assert.equal(C.trackAddFix(tr, { t: T0, lat: 200, lon: 0, acc: 5 }), 'invalid');
  assert.equal(C.trackAddFix(tr, { t: T0, lat: NaN, lon: 0, acc: 5 }), 'invalid');
  C.trackAddFix(tr, fix(5 * SEC, 0));
  assert.equal(C.trackAddFix(tr, fix(5 * SEC, 10)), 'old');
  assert.equal(C.trackAddFix(tr, fix(2 * SEC, 10)), 'old');
});

// ===================== PERMISSIONS =====================
test('permission refusée et erreurs : messages clairs, la séance continue sans GPS', () => {
  assert.match(C.gpsErrorMessage(1), /refusée.*sans GPS.*Réglages/);
  assert.match(C.gpsErrorMessage(2), /indisponible/);
  assert.match(C.gpsErrorMessage(3), /met du temps/);
  assert.match(C.gpsErrorMessage('insecure'), /https/);
  // Sans aucune position : pas de distance mesurée, la séance s'enregistre comme aujourd'hui
  const t = C.createFreeTimer('run', T0);
  const tr = C.createTrack('run');
  const e = C.freeSessionEntry(t, T0 + 20 * 60 * SEC, { km: 3, measured: null, gps: C.gpsSessionInfo(tr, 20 * 60 * SEC) });
  assert.deepEqual(e.distance, { km: 3, source: 'manuel' });
  assert.equal(e.gps.points, 0);
});

// ===================== SÉANCE, SAUVEGARDE, IMPORT =====================
test('séance libre avec GPS : distance « gps », mesurée, résumé conservé', () => {
  const t = C.createFreeTimer('run', T0);
  const tr = C.createTrack('run');
  runLine(tr, 0, 1500, 3);
  const info = C.gpsSessionInfo(tr, 1500 * SEC);
  const e = C.freeSessionEntry(t, T0 + 1500 * SEC, { measured: { km: C.trackSummary(tr, 1500 * SEC).km, source: 'gps' }, gps: info });
  assert.equal(e.distance.source, 'gps');
  assert.ok(Math.abs(e.distance.km - 4.5) < 0.02);
  assert.deepEqual(e.gps, { coverage: 1, gaps: 0, points: 501, rejected: 0, uncoveredSec: 0 });
  // Corrigée à la main : marquée comme saisie, mesure GPS d'origine gardée
  const fixed = C.freeSessionEntry(t, T0 + 1500 * SEC, { km: 4.3, measured: { km: 4.5, source: 'gps' }, gps: info });
  assert.deepEqual(fixed.distance, { km: 4.3, source: 'manuel', measuredKm: 4.5, corrected: true });
});

test('sauvegarde et import : distance GPS et résumé conservés, valeurs invalides ignorées', () => {
  const PROFILE = { name: 'A', startWeight: 95, goalWeight: 80, startDate: '2026-10-01', endDate: '2027-06-01' };
  const ok = { id: 'g1', date: '2026-10-20', type: 'run', mode: 'libre', duration: 25, feel: 2, createdAt: 1, timing: { activeSec: 1500, runSec: 1500, walkSec: 0, maxRunSec: 1500 }, distance: { km: 4.5, source: 'gps' }, gps: { coverage: 0.94, gaps: 1, points: 480, rejected: 3 } };
  const bad = { ...ok, id: 'g2', gps: { coverage: 3, gaps: -1, points: 'x' } };
  const { data } = C.normalizeData({ profile: PROFILE, sessions: [ok, bad] });
  assert.deepEqual(data.sessions[0].gps, ok.gps);
  assert.equal(data.sessions[1].gps, undefined);
  assert.deepEqual(C.normalizeData(JSON.parse(C.serialize(data))).data, data);
  // Statistiques : la distance GPS est bien une mesure réelle
  const D = C.derive(data, '2026-10-25');
  const rep = C.statsReport(data, D, '2026-10-25');
  assert.equal(rep.totals.kmMeasured, 9);
  assert.equal(rep.records.find(r => r.id === 'distance').measured, true);
});

test('quête « 10 km » : avec le GPS, la distance est indiquée comme mesurée', () => {
  const PROFILE = { name: 'A', startWeight: 95, goalWeight: 80, startDate: '2026-10-01', endDate: '2027-06-01' };
  const s = { id: 'k', date: '2026-10-20', type: 'run', mode: 'libre', duration: 65, feel: 2, createdAt: 1, timing: { activeSec: 3900, runSec: 3900, walkSec: 0, maxRunSec: 3900 }, distance: { km: 10.1, source: 'gps' } };
  const e = C.deriveGame({ profile: PROFILE, onboarded: true, sessions: [s], weights: [], adjustments: [] }, '2026-10-21').quests.epics.find(q => q.id === 'e10k');
  assert.equal(e.meta.source, 'gps');
});

test('XP inchangée : le GPS ne modifie aucune règle d\'XP', () => {
  const PROFILE = { name: 'A', startWeight: 95, goalWeight: 80, startDate: '2026-10-01', endDate: '2027-06-01' };
  const base = { id: 'x', date: '2026-10-20', type: 'run', mode: 'libre', duration: 25, feel: 2, createdAt: 1, timing: { activeSec: 1500, runSec: 1500, walkSec: 0, maxRunSec: 1500 } };
  const mk = extra => ({ profile: PROFILE, onboarded: true, sessions: [{ ...base, ...extra }], weights: [], adjustments: [] });
  const manual = C.deriveGame(mk({ distance: { km: 4.5, source: 'manuel' } }), '2026-10-21');
  const gps = C.deriveGame(mk({ distance: { km: 4.5, source: 'gps' }, gps: { coverage: 1, gaps: 0, points: 500, rejected: 0 } }), '2026-10-21');
  assert.equal(gps.xp, manual.xp);
});

test('suivi restauré après rechargement : tracé valide, tracé abîmé refusé', () => {
  const tr = C.createTrack('walk');
  runLine(tr, 0, 60, 1.4);
  const copy = JSON.parse(JSON.stringify(tr));
  assert.ok(C.isValidTrack(copy));
  assert.ok(!C.isValidTrack({ ...copy, segments: [[[1, 2, 'x', 4]]] }));
  assert.ok(!C.isValidTrack(null));
  // La reprise après rechargement crée une coupure, sans distance inventée
  assert.equal(C.trackAddFix(copy, fix(200 * SEC, 300)), 'gap');
});

test('marche lente (0,8 m/s) avec précision moyenne (15 m) : distance complète malgré le filtre', () => {
  const tr = C.createTrack('walk');
  runLine(tr, 0, 600, 0.8, 0, 3, 15);
  const km = C.trackSummary(tr, 600 * SEC).km;
  assert.ok(Math.abs(km - 0.48) <= 0.02, `${km} km`);
});
