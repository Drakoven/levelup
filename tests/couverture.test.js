'use strict';
/* Tests de la couverture GPS (étape 6.1, correction) : pourcentage de la séance réellement suivi
   par des positions exploitables, pauses exclues, coupures, rechargement, positions hors séance,
   perte en fin de séance, suivi partiel jamais présenté comme entièrement mesuré. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const T0 = 1_800_000_000_000, SEC = 1000;
const LAT0 = 48.8566, LON0 = 2.3522;
const M = 1 / 111195;                            // 1 mètre en degrés de latitude
const fix = (t, meters, acc = 6) => ({ t: T0 + t, lat: LAT0 + meters * M, lon: LON0, acc });
// Course régulière à `speed` m/s, une position toutes les `every` secondes (de fromSec à toSec)
function runLine(tr, fromSec, toSec, speed = 3, startMeters = 0, every = 3, win) {
  for (let s = fromSec; s <= toSec; s += every) C.trackAddFix(tr, fix(s * SEC, startMeters + (s - fromSec) * speed), win);
}
const timer = () => C.createFreeTimer('run', T0);   // départ à T0, sans compte à rebours
const end = sec => T0 + sec * SEC;

test('séance entièrement suivie : 100 %, aucune interruption, pas de suivi partiel', () => {
  const t = timer(), tr = C.createTrack('run');
  runLine(tr, 0, 600);
  const s = C.trackSummary(tr, t, end(600));
  assert.equal(s.coverage, 1);
  assert.equal(s.gaps, 0);
  assert.equal(s.partial, false);
  assert.equal(s.uncoveredMs, 0);
  assert.equal(s.km, 1.8);
});

test('coupure GPS de 5 minutes : couverture réduite, interruption comptée, aucun km inventé', () => {
  const t = timer(), tr = C.createTrack('run');
  runLine(tr, 0, 300);                             // 900 m
  // 5 min sans position : le coureur continue (900 m non suivis)
  runLine(tr, 600, 900, 3, 1800);                  // 900 m
  const s = C.trackSummary(tr, t, end(900));
  assert.equal(s.km, 1.8, 'les 900 m de la coupure ne sont jamais ajoutés');
  assert.equal(s.coverage, 0.66, '600 s couvertes sur 900 s');
  assert.equal(s.gaps, 1);
  assert.equal(Math.round(s.uncoveredMs / SEC), 300);
  assert.equal(s.partial, true);
});

test('deux positions aux extrémités ne suffisent pas : chaque position couvre au plus 10 s', () => {
  const t = timer(), tr = C.createTrack('walk');
  // Une position toutes les 19 s (sous le seuil de coupure de 20 s)
  for (let s = 0; s <= 570; s += 19) C.trackAddFix(tr, fix(s * SEC, s * 1.2));
  const r = C.trackSummary(tr, t, end(570));
  assert.ok(r.coverage <= 0.53 && r.coverage >= 0.5, `${r.coverage} : 10 s couvertes sur 19`);
  assert.equal(r.partial, true);
});

test('pause volontaire : exclue de la durée de séance et de la couverture, rien n\'est compté', () => {
  const t = timer(), tr = C.createTrack('run');
  runLine(tr, 0, 300);                             // 900 m
  C.timerPause(t, end(300)); C.trackPause(tr);
  runLine(tr, 303, 477, 1.2, 900);                 // marche pendant la pause : ignorée
  C.timerResume(t, end(480)); C.trackResume(tr);
  runLine(tr, 480, 780, 3, 1200);                  // 900 m
  const s = C.trackSummary(tr, t, end(780));
  assert.equal(Math.round(s.activeMs / SEC), 600, 'la pause ne compte pas dans la durée');
  assert.equal(s.km, 1.8, 'les mètres de la pause ne comptent pas');
  assert.ok(s.coverage >= 0.99, `${s.coverage}`);
  assert.equal(s.gaps, 0, 'une pause n\'est pas une interruption du GPS');
  assert.deepEqual(t.pauses, [[end(300), end(480)]]);
});

test('séance terminée pendant une pause : la pause en cours est exclue', () => {
  const t = timer(), tr = C.createTrack('run');
  runLine(tr, 0, 300);
  C.timerPause(t, end(300)); C.trackPause(tr);
  const s = C.trackSummary(tr, t, end(900));
  assert.equal(Math.round(s.activeMs / SEC), 300);
  assert.equal(s.coverage, 1);
});

test('rechargement pendant la séance : la période sans GPS n\'est pas couverte', () => {
  const t = timer(), tr = C.createTrack('run');
  runLine(tr, 0, 300);
  // Rechargement à 300 s : chrono et suivi sauvegardés puis restaurés
  const saved = JSON.parse(JSON.stringify({ t, tr }));
  assert.ok(C.isValidFreeTimer(saved.t) && C.isValidTrack(saved.tr));
  // « Reprendre le GPS » touché 3 minutes plus tard
  assert.equal(C.trackAddFix(saved.tr, fix(480 * SEC, 1440)), 'gap');
  runLine(saved.tr, 483, 600, 3, 1449);
  const s = C.trackSummary(saved.tr, saved.t, end(600));
  assert.equal(s.coverage, 0.7, '420 s couvertes sur 600 s (de 0 à 300 s, puis de 480 à 600 s)');
  assert.equal(s.gaps, 1);
  assert.equal(s.partial, true);
  assert.ok(s.km < 1.3, `${s.km} km : la portion du rechargement n'est pas comptée`);
});

test('suivi restauré d\'un ancien format (sans temps couverts) : rien n\'est supposé couvert', () => {
  const t = timer(), tr = C.createTrack('run');
  runLine(tr, 0, 300);
  const old = JSON.parse(JSON.stringify(tr)); delete old.covered;
  assert.ok(C.isValidTrack(old));
  assert.equal(C.trackSummary(old, t, end(300)).coverage, 0);
  assert.equal(C.isValidTrack({ ...tr, covered: [[1, 'x']] }), false);
});

test('positions horodatées hors de la séance : jamais comptées ni dans la distance ni dans la couverture', () => {
  const t = C.createFreeTimer('run', T0, { countdownSec: 10 });   // départ réel à T0 + 10 s
  const win = { from: t.startedAt, to: end(600) };
  const tr = C.createTrack('run');
  assert.equal(C.trackAddFix(tr, fix(2 * SEC, 0), win), 'outside', 'pendant le compte à rebours');
  assert.equal(C.trackAddFix(tr, fix(4000 * SEC, 0), win), 'outside', 'horloge dans le futur');
  assert.equal(tr.segments.length, 0);
  // Sans fenêtre (cas de la simulation) : positions datées après la fin → couverture 0, pas 100 %
  const tr2 = C.createTrack('run');
  runLine(tr2, 1000, 1300);
  const s = C.trackSummary(tr2, t, end(600));
  assert.equal(s.coverage, 0, 'aucune position ne date de la séance');
  assert.equal(s.gaps, 1);
  // Positions avant le départ : la partie hors séance est retirée
  const tr3 = C.createTrack('run');
  runLine(tr3, -120, 300);
  const s3 = C.trackSummary(tr3, t, end(300));
  assert.equal(Math.round(s3.coveredMs / SEC), 290, 'uniquement de 10 s à 300 s');
  assert.equal(s3.coverage, 1);
});

test('perte de signal en fin de séance : la fin non suivie est une interruption', () => {
  const t = timer(), tr = C.createTrack('run');
  runLine(tr, 0, 400);                             // puis plus aucune position jusqu'à 600 s
  assert.equal(tr.gaps.length, 0, 'aucune position n\'est revenue pour signaler la coupure');
  const s = C.trackSummary(tr, t, end(600));
  assert.equal(s.coverage, 0.66);
  assert.equal(s.gaps, 1, 'la perte finale est quand même comptée');
  assert.equal(Math.round(s.uncoveredMs / SEC), 201, 'dernière position à 399 s');
  assert.equal(C.gpsSessionInfo(tr, t, end(600)).uncoveredSec, 201);
});

test('perte de 15 s seulement : pas une interruption, couverture presque complète', () => {
  const t = timer(), tr = C.createTrack('run');
  runLine(tr, 0, 300); runLine(tr, 315, 600, 3, 945);
  const s = C.trackSummary(tr, t, end(600));
  assert.equal(s.gaps, 0);
  assert.ok(s.coverage >= 0.98 && s.coverage < 1, `${s.coverage} : arrondi vers le bas, jamais 100 % s'il manque du temps`);
});

test('couverture inférieure à 80 % : séance marquée GPS partiel, distance jamais complétée', () => {
  const t = timer(), tr = C.createTrack('run');
  runLine(tr, 0, 420);                             // 1,26 km suivis sur 600 s de course
  const info = C.gpsSessionInfo(tr, t, end(600));
  const sum = C.trackSummary(tr, t, end(600));
  assert.equal(info.coverage, 0.7);
  const e = C.freeSessionEntry(t, end(600), { measured: { km: sum.km, source: 'gps' }, gps: info });
  assert.equal(e.distance.km, 1.26, 'pas d\'extrapolation (1,8 km) : seule la distance suivie');
  assert.equal(e.distance.source, 'gps');
  assert.equal(C.gpsPartial(e), true);
  // Sauvegarde puis import : le résumé (avec le temps non suivi) est conservé
  const { data } = C.normalizeData({ profile: { name: 'A', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' }, sessions: [{ id: 'a1', ...e }] });
  const back = C.normalizeData(JSON.parse(C.serialize(data))).data;
  assert.deepEqual(back.sessions[0].gps, { coverage: 0.7, gaps: 1, points: 141, rejected: 0, uncoveredSec: 180,
    diag: { kept: 141, still: 0, accuracy: 0, jump: 0, time: 0, paused: 0, other: 0 } });
  assert.equal(C.gpsPartial(back.sessions[0]), true);
});

test('records et statistiques : une distance GPS partielle n\'est pas présentée comme entièrement mesurée', () => {
  const profile = { name: 'A', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
  const timing = { activeSec: 1800, runSec: 1800, walkSec: 0, maxRunSec: 1800, pausedSec: 0 };
  const mkData = gps => ({ profile, onboarded: true, weights: [], adjustments: [], sessions: [
    { id: 's1', date: '2026-10-20', type: 'run', mode: 'libre', duration: 30, feel: 2, createdAt: 1, timing, distance: { km: 3.1, source: 'gps' }, gps },
    { id: 's2', date: '2026-10-21', type: 'walk', duration: 30, feel: 2, createdAt: 2, distance: { km: 2, source: 'manuel' } },
  ] });
  const rep = d => C.statsReport(d, C.derive(d, '2026-10-25'), '2026-10-25');
  const partial = rep(mkData({ coverage: 0.55, gaps: 2, points: 200, rejected: 0, uncoveredSec: 810 }));
  const far = partial.records.find(r => r.id === 'distance');
  assert.equal(far.value, 3.1);
  assert.equal(far.partial, true, 'record signalé « GPS partiel »');
  assert.equal(far.coverage, 0.55);
  assert.equal(partial.totals.kmGpsPartial, 3.1);
  const full = rep(mkData({ coverage: 0.97, gaps: 0, points: 600, rejected: 1, uncoveredSec: 54 }));
  const far2 = full.records.find(r => r.id === 'distance');
  assert.equal(far2.partial, false);
  assert.equal(far2.measured, true);
  assert.equal(full.totals.kmGpsPartial, 0);
});

test('XP inchangée : la couverture GPS ne modifie aucune règle d\'XP', () => {
  const profile = { name: 'A', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
  const timing = { activeSec: 1800, runSec: 1800, walkSec: 0, maxRunSec: 1800, pausedSec: 0 };
  const base = { id: 's1', date: '2026-10-20', type: 'run', mode: 'libre', duration: 30, feel: 2, createdAt: 1, timing, distance: { km: 3.1, source: 'gps' } };
  const xp = gps => C.derive({ profile, onboarded: true, weights: [], adjustments: [], sessions: [gps ? { ...base, gps } : base] }, '2026-10-25').xp;
  assert.equal(xp({ coverage: 0.4, gaps: 3, points: 80, rejected: 0 }), xp(null));
  assert.equal(xp({ coverage: 1, gaps: 0, points: 600, rejected: 0 }), xp(null));
});
