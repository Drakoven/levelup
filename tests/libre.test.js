'use strict';
/* Tests de la séance libre (étape 4.5) : course ou marche au chrono,
   sans intervalles, sans effet sur le programme guidé. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const T0 = 1_800_000_000_000, SEC = 1000, MIN = 60 * SEC;
const PROFILE = { name: 'Drakoven', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
const mk = (sessions, weights = []) => ({ profile: PROFILE, onboarded: true, sessions, weights, adjustments: [] });
let seq = 0;
const withId = (e, date) => ({ id: `l${++seq}`, createdAt: seq, ...e, ...(date ? { date } : {}) });

// ===================== CHRONO LIBRE =====================
test('chrono libre : temps écoulé, compte à rebours non compté', () => {
  const t = C.createFreeTimer('run', T0, { countdownSec: 5 });
  assert.equal(C.freeState(t, T0 + 3 * SEC).countdown, true);
  assert.equal(C.freeState(t, T0 + 3 * SEC).activeMs, 0);
  assert.equal(C.freeState(t, T0 + 5 * SEC + 12 * MIN).activeMs, 12 * MIN);
});

test('chrono libre : la pause est exclue, double pause sans effet', () => {
  const t = C.createFreeTimer('walk', T0);
  C.timerPause(t, T0 + 10 * MIN); C.timerPause(t, T0 + 11 * MIN);
  assert.equal(C.freeState(t, T0 + 30 * MIN).activeMs, 10 * MIN, 'figé pendant la pause');
  C.timerResume(t, T0 + 20 * MIN);
  assert.equal(C.freeState(t, T0 + 25 * MIN).activeMs, 15 * MIN);
  assert.equal(C.freeState(t, T0 + 25 * MIN).pausedMs, 10 * MIN);
});

test('course continue : une pause coupe la période sans pause', () => {
  const t = C.createFreeTimer('run', T0);
  C.timerPause(t, T0 + 8 * MIN);          // 8 min sans pause
  C.timerResume(t, T0 + 10 * MIN);
  assert.equal(C.freeState(t, T0 + 15 * MIN).longestMs, 8 * MIN, '5 min depuis la reprise : le record reste 8 min');
  assert.equal(C.freeState(t, T0 + 22 * MIN).longestMs, 12 * MIN, '12 min depuis la reprise : nouveau plus long');
});

test('compte à rebours mis en pause : le départ est décalé, pas de période fantôme', () => {
  const t = C.createFreeTimer('run', T0, { countdownSec: 5 });
  C.timerPause(t, T0 + 2 * SEC);
  C.timerResume(t, T0 + 60 * SEC);
  const st = C.freeState(t, T0 + 63 * SEC + 10 * MIN);
  assert.equal(st.activeMs, 10 * MIN);
  assert.equal(st.longestMs, 10 * MIN);
});

test('chrono oublié : plafonné à 10 h et signalé', () => {
  const t = C.createFreeTimer('walk', T0);
  const st = C.freeState(t, T0 + 30 * 3600 * SEC);
  assert.equal(st.activeMs, C.FREE_MAX_MS);
  assert.equal(st.capped, true);
});

test('chrono libre restauré : valide, l\'ancien format aussi', () => {
  assert.ok(C.isValidFreeTimer(C.createFreeTimer('run', T0)));
  assert.ok(!C.isValidFreeTimer({ mode: 'free', kind: 'vélo', startedAt: T0, pausedMs: 0, pausedAt: null }));
  assert.ok(!C.isValidFreeTimer(C.createTimer([{ kind: 'run', label: 'Course', sec: 60 }], T0)));
});

// ===================== ANNONCES =====================
test('annonces : décompte, départ, puis toutes les 5 minutes', () => {
  const t = C.createFreeTimer('run', T0, { countdownSec: 5 });
  let marks = C.freeInitialMarks();
  const events = [];
  for (let now = T0; now <= T0 + 5 * SEC + 11 * MIN; now += 500) {
    const r = C.freeCues(t, marks, now);
    marks = r.marks;
    events.push(...r.events);
  }
  assert.deepEqual(events.filter(e => e.type === 'countdown').map(e => e.n), [5, 4, 3, 2, 1]);
  assert.equal(events.filter(e => e.type === 'start').length, 1);
  assert.deepEqual(events.filter(e => e.type === 'milestone').map(e => e.minutes), [5, 10]);
});

test('annonces : au retour d\'arrière-plan, seul le dernier palier est annoncé', () => {
  const t = C.createFreeTimer('run', T0);
  let { marks } = C.freeCues(t, C.freeInitialMarks(), T0 + SEC);
  const r = C.freeCues(t, marks, T0 + 23 * MIN);
  assert.deepEqual(r.events.map(e => e.type), ['milestone']);
  assert.equal(r.events[0].minutes, 20);
  // Restauration : rien n'est annoncé deux fois
  assert.deepEqual(C.freeCues(t, C.freeResumeMarks(t, T0 + 23 * MIN), T0 + 24 * MIN).events, []);
});

// ===================== SÉANCE ENREGISTRÉE =====================
test('séance enregistrée : course libre mesurée, sans programme', () => {
  const t = C.createFreeTimer('run', T0);
  C.timerPause(t, T0 + 14 * MIN); C.timerResume(t, T0 + 16 * MIN);
  const e = C.freeSessionEntry(t, T0 + 26 * MIN, { km: 3.4, feel: 2 });
  assert.equal(e.type, 'run');
  assert.equal(e.mode, 'libre');
  assert.equal(e.program, undefined, 'jamais de programme');
  assert.equal(e.duration, 24);
  assert.deepEqual(e.timing, { activeSec: 1440, runSec: 1440, walkSec: 0, maxRunSec: 840, pausedSec: 120 });
  assert.deepEqual(e.distance, { km: 3.4, source: 'manuel' });
});

test('séance enregistrée : marche libre (temps de marche, pas de course)', () => {
  const e = C.freeSessionEntry(C.createFreeTimer('walk', T0), T0 + 40 * MIN, { feel: 1 });
  assert.equal(e.type, 'walk');
  assert.deepEqual(e.timing, { activeSec: 2400, runSec: 0, walkSec: 2400, pausedSec: 0 });
  assert.equal(e.distance, undefined);
});

test('durée : peut être réduite (chrono oublié), jamais augmentée', () => {
  const t = C.createFreeTimer('run', T0);
  const down = C.freeSessionEntry(t, T0 + 95 * MIN, { duration: 30 });
  assert.equal(down.duration, 30);
  assert.equal(down.timing.activeSec, 1800);
  assert.equal(down.timing.maxRunSec, 1800, 'la course continue ne dépasse jamais la durée retenue');
  assert.equal(C.freeSessionEntry(t, T0 + 20 * MIN, { duration: 90 }).duration, 20);
});

test('distance GPS (préparée) : la mesure fait foi, une saisie différente devient une correction', () => {
  const t = C.createFreeTimer('run', T0);
  const gps = { km: 4.12, source: 'gps' };
  assert.deepEqual(C.freeSessionEntry(t, T0 + 25 * MIN, { measured: gps }).distance, { km: 4.12, source: 'gps' });
  assert.deepEqual(C.freeSessionEntry(t, T0 + 25 * MIN, { measured: gps, km: 4.12 }).distance, { km: 4.12, source: 'gps' });
  assert.deepEqual(C.freeSessionEntry(t, T0 + 25 * MIN, { measured: gps, km: 4 }).distance, { km: 4, source: 'manuel', measuredKm: 4.12, corrected: true });
});

// ===================== EFFET SUR LE JEU =====================
test('course libre : XP, record de course continue mesuré, programme inchangé', () => {
  const t = C.createFreeTimer('run', T0);
  const e = withId(C.freeSessionEntry(t, T0 + 22 * MIN, { km: 3, feel: 1 }), '2026-10-20');
  const r = C.derive(mk([e]), '2026-10-21');
  assert.equal(r.programStep, 0, 'une séance libre « facile » ne fait pas avancer le programme');
  assert.equal(r.records.maxRun, 22);
  assert.equal(r.xp, 100);
  assert.equal(r.sessions[0].prog, undefined);
});

test('course libre : bat un record mesuré → +150 XP ; une saisie à la main, jamais', () => {
  const first = withId(C.freeSessionEntry(C.createFreeTimer('run', T0), T0 + 12 * MIN), '2026-10-20');
  const better = withId(C.freeSessionEntry(C.createFreeTimer('run', T0), T0 + 18 * MIN), '2026-10-22');
  const r = C.derive(mk([first, better]), '2026-10-23');
  assert.equal(r.records.maxRun, 18);
  assert.equal(r.ledger.filter(e => e.key.startsWith('rr:')).length, 1);
  const manual = withId({ type: 'run', duration: 40, feel: 2 }, '2026-10-24');
  assert.equal(C.derive(mk([first, better, manual]), '2026-10-25').records.maxRun, 18, 'règle stricte conservée');
});

test('course libre : débloque « 10 min non-stop » seulement sans pause', () => {
  const t = C.createFreeTimer('run', T0);
  C.timerPause(t, T0 + 6 * MIN); C.timerResume(t, T0 + 7 * MIN);
  const cut = withId(C.freeSessionEntry(t, T0 + 13 * MIN), '2026-10-20'); // 6 + 6 min
  assert.equal(C.derive(mk([cut]), '2026-10-21').badges.run10, undefined);
  const nonstop = withId(C.freeSessionEntry(C.createFreeTimer('run', T0), T0 + 11 * MIN), '2026-10-22');
  assert.ok(C.derive(mk([cut, nonstop]), '2026-10-23').badges.run10);
});

test('marche libre : XP de marche, aucun record de course', () => {
  const e = withId(C.freeSessionEntry(C.createFreeTimer('walk', T0), T0 + 45 * MIN, { km: 3.8 }), '2026-10-20');
  const r = C.derive(mk([e]), '2026-10-21');
  assert.equal(r.xp, 50);
  assert.equal(r.records.maxRun, 0);
  assert.equal(r.records.maxDistance, 3.8);
});

test('statistiques : durée et distance des séances libres ajoutées au total', () => {
  const run = withId(C.freeSessionEntry(C.createFreeTimer('run', T0), T0 + 20 * MIN, { km: 3 }), '2026-10-20');
  const walk = withId(C.freeSessionEntry(C.createFreeTimer('walk', T0), T0 + 40 * MIN, { km: 3.5 }), '2026-10-21');
  const st = C.derive(mk([run, walk]), '2026-10-22').stats;
  assert.equal(st.totals.km, 6.5);
  assert.equal(st.totals.minutes, 60);
  assert.equal(st.totals.sessions, 2);
});

test('coach : une course libre compte pour la récupération du lendemain', () => {
  const e = withId(C.freeSessionEntry(C.createFreeTimer('run', T0), T0 + 25 * MIN), '2026-10-20');
  const d = mk([e]);
  assert.equal(C.coachAdvice(d, C.derive(d, '2026-10-21'), '2026-10-21').kind, 'recovery');
});

test('format v3 : « libre » conservé, jamais avec un programme ni en musculation', () => {
  const { data } = C.normalizeData({
    profile: PROFILE,
    sessions: [
      { id: 'a', date: '2026-10-20', type: 'run', duration: 20, mode: 'libre', timing: { activeSec: 1200, runSec: 1200, maxRunSec: 1200 } },
      { id: 'b', date: '2026-10-21', type: 'run', duration: 26, mode: 'libre', program: { status: 'validee', step: 0 } },
      { id: 'c', date: '2026-10-22', type: 'strength', duration: 30, mode: 'libre' },
    ],
  });
  assert.deepEqual(data.sessions.map(s => s.mode), ['libre', undefined, undefined]);
  // Aller-retour sans perte
  assert.deepEqual(C.normalizeData(JSON.parse(C.serialize(data))).data, data);
});
