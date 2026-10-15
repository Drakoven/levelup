'use strict';
/* Tests de la validation des séances du programme et du format v3
   (décisions validées avant l'étape 4). */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const PROFILE = { name: 'Drakoven', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
let seq = 0;
const S = (date, type, duration, extra = {}) => ({ id: `v${++seq}`, date, type, duration, feel: 2, createdAt: seq, ...extra });
const data = (sessions = [], weights = []) => ({ profile: PROFILE, onboarded: true, sessions, weights });
const D = d => C.derive(d, '2027-01-31');

const T0 = 1_800_000_000_000, SEC = 1000;
// Semaine 1 : échauffement 5 min, 6 × (1 min course + 2 min marche), retour au calme 5 min
const ps0 = C.programSession(0);
const SEGS = ps0.segs.map(s => ({ ...s, sec: s.min * 60 }));
const timer = () => C.createTimer(SEGS, T0);
// Avance jusqu'au début de la phase idx
const startOf = idx => SEGS.slice(0, idx).reduce((a, s) => a + s.sec * 1000, 0);

// ===================== RÈGLE DES INTERVALLES (chrono) =====================
test('validée : chaque intervalle de course fait à 90 % ou plus', () => {
  const sum = C.timerSummary(timer(), T0 + ps0.total * 60 * SEC);
  assert.equal(sum.intervalsOk, true);
  assert.equal(sum.runsDone, 6);
  assert.equal(C.timerProgramStatus(sum), 'validee');
});

test('un seul intervalle écourté sous 90 % suffit à rendre la séance interrompue', () => {
  const t = timer();
  // On saute les 10 dernières secondes de la 1re course (50 s sur 60 = 83 %)
  const firstRun = SEGS.findIndex(s => s.kind === 'run');
  C.timerSkip(t, T0 + startOf(firstRun) + 50 * SEC);
  const sum = C.timerSummary(t, T0 + ps0.total * 60 * SEC);
  assert.ok(sum.runMs >= sum.plannedRunMs * 0.9, 'au total, plus de 90 % de course…');
  assert.equal(sum.intervalsOk, false, '…mais un intervalle est incomplet : pas de validation');
  assert.equal(C.timerProgramStatus(sum), 'interrompue');
  assert.equal(sum.runsDone, 5);
});

test('tolérance : un intervalle fait à 90 % exactement reste valable', () => {
  const t = timer();
  const firstRun = SEGS.findIndex(s => s.kind === 'run');
  C.timerSkip(t, T0 + startOf(firstRun) + 54 * SEC); // 54 s sur 60 = 90 %
  assert.equal(C.timerSummary(t, T0 + ps0.total * 60 * SEC).intervalsOk, true);
});

test('sauter une course = interrompue ; sauter l\'échauffement = validée', () => {
  const t = timer();
  const firstRun = SEGS.findIndex(s => s.kind === 'run');
  C.timerSkip(t, T0 + startOf(firstRun) + 1 * SEC);
  assert.equal(C.timerSummary(t, T0 + 3600 * SEC).intervalsOk, false);
  const u = timer();
  C.timerSkip(u, T0 + 10 * SEC);
  assert.equal(C.timerSummary(u, T0 + 3600 * SEC).intervalsOk, true);
});

test('arrêt pendant le retour au calme, toutes les courses faites = validée', () => {
  const lastRunEnd = startOf(SEGS.length - 1);
  const sum = C.timerSummary(timer(), T0 + lastRunEnd + 60 * SEC);
  assert.equal(sum.done, false);
  assert.equal(sum.intervalsOk, true);
});

test('arrêt avant la dernière course = interrompue', () => {
  const sum = C.timerSummary(timer(), T0 + startOf(SEGS.length - 2));
  assert.equal(sum.intervalsOk, false);
});

// ===================== PROGRAMME =====================
const prog = (date, status, feel = 2, extra = {}) => S(date, 'run', 26, { feel, program: { status, step: extra.step }, ...extra });

test('interrompue : n\'avance jamais le programme, l\'étape est conservée', () => {
  const r = D(data([prog('2026-10-19', 'interrompue', 1)]));
  assert.equal(r.programStep, 0);
  assert.equal(r.sessions[0].prog.adapt, 'none');
  assert.equal(r.sessions[0].prog.valid, false);
});

test('interrompue : ne compte pas dans « 2 séances dures d\'affilée »', () => {
  const r = D(data([prog('2026-10-19', 'validee', 2, { step: 0 }), prog('2026-10-21', 'validee', 3, { step: 1 }),
    prog('2026-10-23', 'interrompue', 3), prog('2026-10-25', 'validee', 3, { step: 1 })]));
  assert.equal(r.programStep, 0, 'les deux « dur » validés se suivent malgré l\'interruption entre eux : un cran en arrière');
});

test('déclarée : fait avancer le programme, marquée comme telle', () => {
  const r = D(data([prog('2026-10-19', 'declaree', 2, { step: 0 })]));
  assert.equal(r.programStep, 1);
  assert.equal(r.sessions[0].prog.status, 'declaree');
  assert.equal(r.sessions[0].label, 'Séance S1·1 déclarée');
  assert.equal(r.sessions[0].xp, 100);
});

test('déclarée : jamais de record ni de succès « non-stop »', () => {
  const sessions = [prog('2026-10-19', 'validee', 2, { step: 0, timing: { runSec: 360, maxRunSec: 60 } })];
  for (let i = 0; i < 30; i++) sessions.push(prog(C.addDays('2026-10-21', i * 2), 'declaree', 1, { step: i + 1 }));
  const r = D(data(sessions));
  assert.equal(r.records.maxRun, 1, 'seule la minute mesurée au chrono compte');
  assert.equal(r.badges.run10, undefined);
  assert.equal(r.badges.run30, undefined);
  assert.equal(r.ledger.filter(e => e.key.startsWith('rr:')).length, 0);
});

test('séance validée pour une étape déjà dépassée : ne fait pas avancer une 2e fois', () => {
  // Deux séances validées toutes les deux à l'étape 0 (ex. une déclaration antidatée)
  const r = D(data([prog('2026-10-19', 'validee', 2, { step: 0 }), prog('2026-10-21', 'declaree', 2, { step: 0 })]));
  assert.equal(r.programStep, 1);
  assert.equal(r.sessions[1].prog.adapt, 'earlier');
});

test('statut inconnu dans un fichier importé : ce n\'est PAS une séance du programme', () => {
  const { data: d } = C.normalizeData({ profile: PROFILE, sessions: [S('2026-10-19', 'run', 26, { program: { status: 'super-validee' } })] });
  assert.equal(d.sessions[0].program, undefined);
  assert.equal(C.derive(d, '2026-10-20').programStep, 0);
});

// ===================== XP DES SÉANCES INTERROMPUES =====================
const interrupted = (duration, runSec) => S('2026-10-19', 'run', duration, { program: { status: 'interrompue', runPlannedSec: 360 }, timing: { runSec, walkSec: duration * 60 - runSec } });

test('XP interrompue : proportionnelle au temps de course réellement fait', () => {
  assert.equal(D(data([interrupted(15, 240)])).xp, 65, '4 min sur 6 = 67 % → 65 XP');
  assert.equal(D(data([interrupted(8, 90)])).xp, 25, '1 min 30 sur 6 = 25 %');
  assert.equal(D(data([interrupted(25, 357)])).xp, 95, 'plafond : toujours moins qu\'une séance validée (100)');
});

test('XP interrompue : jamais moins que la marche équivalente', () => {
  assert.equal(D(data([interrupted(7, 0)])).xp, 10, '7 min de marche');
  assert.equal(D(data([interrupted(35, 30)])).xp, 50, '35 min, presque que de la marche : XP de marche de 30 min');
});

// ===================== DÉCLARATION ET COHÉRENCE =====================
test('déclaration : confirmation explicite et durée cohérente obligatoires', () => {
  const ok = { confirmed: true, date: '2026-10-19', duration: 26, km: 2.5 };
  assert.equal(C.declarationError(ok, ps0), '');
  assert.match(C.declarationError({ ...ok, confirmed: false }, ps0), /confirmation/);
  assert.match(C.declarationError({ ...ok, duration: 15 }, ps0), /26 min/);
  assert.match(C.declarationError({ ...ok, km: 25 }, ps0), /peu plausible/);
});

test('distance : refuse les vitesses impossibles (faute de frappe)', () => {
  assert.equal(C.distanceError('run', 5, 30), '');
  assert.match(C.distanceError('run', 25, 30), /50 km\/h|plus de 20 km\/h/);
  assert.match(C.distanceError('walk', 6, 30), /plus de 8 km\/h/);
  assert.match(C.distanceError('walk', NaN, 30), /Distance entre/);
});

test('modification : ce que le chrono a mesuré n\'est plus modifiable', () => {
  const timed = C.editableFields({ type: 'run', timing: { runSec: 360 }, program: { status: 'validee' } });
  assert.deepEqual(timed, { type: false, duration: false, date: false, distance: true, feel: true, status: false });
  const declared = C.editableFields({ type: 'run', program: { status: 'declaree' } });
  assert.equal(declared.type, false, 'une séance du programme reste une course');
  assert.equal(declared.duration, true);
  assert.equal(C.editableFields({ type: 'walk' }).type, true);
});

// ===================== FORMAT V3 ET MIGRATION =====================
test('migration v2 → v3 : rien n\'est perdu, anciennes validations classées « historique »', () => {
  const v2 = {
    app: 'levelup', schemaVersion: 2, data: {
      profile: PROFILE, onboarded: true,
      sessions: [
        { id: 'a1', date: '2026-10-19', type: 'run', duration: 26, distance: 2.4, feel: 2, program: true, createdAt: 1, runSec: 360, walkSec: 1200, maxRunSec: 60 },
        { id: 'a2', date: '2026-10-21', type: 'run', duration: 8, distance: 0, feel: 2, program: true, createdAt: 2 },
        { id: 'a3', date: '2026-10-22', type: 'walk', duration: 40, distance: 3.1, feel: 1, program: false, createdAt: 3 },
        { id: 'a4', date: '2026-10-23', type: 'run', duration: 27, distance: 0, feel: 3, program: true, createdAt: 4 },
      ],
      weights: [{ date: '2026-10-19', kg: 94.6 }],
    },
  };
  const { data: d, report } = C.normalizeData(v2);
  assert.equal(report.version, 2);
  assert.equal(d.sessions.length, 4);
  assert.deepEqual(d.sessions.map(s => s.id), ['a1', 'a2', 'a3', 'a4']);
  assert.deepEqual(d.sessions.map(s => s.program && s.program.status), ['historique', 'interrompue', undefined, 'historique']);
  assert.equal(report.historique, 2);
  assert.equal(report.interrompues, 1);
  assert.deepEqual(d.sessions[0].distance, { km: 2.4, source: 'manuel' });
  assert.deepEqual(d.sessions[0].timing, { runSec: 360, walkSec: 1200, maxRunSec: 60 });
  assert.equal(d.sessions[1].distance, undefined);
  assert.deepEqual(d.weights, [{ date: '2026-10-19', kg: 94.6 }]);
  assert.deepEqual(d.dailySteps, []);
  // Même résultat de jeu avant et après conversion
  const before = C.derive(v2.data, '2026-10-31'), after = C.derive(d, '2026-10-31');
  assert.equal(after.xp, before.xp);
  assert.equal(after.programStep, before.programStep);
  assert.deepEqual(after.badges, before.badges);
  // L'étiquette distingue les anciennes validations
  assert.equal(after.sessions[0].label, 'Séance S1·1 (historique)');
});

test('format v3 : aller-retour complet sans perte (GPS, santé, pas, parcours)', () => {
  const full = {
    profile: PROFILE, onboarded: true, weights: [],
    sessions: [{
      id: 'g1', date: '2026-11-02', type: 'run', duration: 31, feel: 4, createdAt: 9,
      startedAt: '2026-11-02T07:15:00.000Z', endedAt: '2026-11-02T07:47:00.000Z',
      timing: { activeSec: 1860, runSec: 900, walkSec: 960, maxRunSec: 300, pausedSec: 60 },
      program: { status: 'validee', step: 15, intervalsDone: 3, intervalsPlanned: 3, runPlannedSec: 900, plannedMin: 31 },
      distance: { km: 4.21, source: 'gps', measuredKm: 4.35, corrected: true },
      steps: { count: 5120, source: 'podometre' },
      routeId: 'route-g1',
    }],
    dailySteps: [{ date: '2026-11-02', count: 11250, source: 'sante' }],
  };
  const once = C.normalizeData({ app: 'levelup', schemaVersion: 3, data: full }).data;
  assert.deepEqual(once.sessions[0], full.sessions[0]);
  assert.deepEqual(once.dailySteps, full.dailySteps);
  const twice = C.normalizeData(JSON.parse(C.serialize(once))).data;
  assert.deepEqual(twice, once);
});

test('pas : uniquement des mesures réelles (aucune estimation, aucune saisie)', () => {
  const { data: d } = C.normalizeData({
    profile: PROFILE,
    sessions: [
      S('2026-10-19', 'walk', 30, { steps: { count: 4000, source: 'estimation' } }),
      S('2026-10-20', 'walk', 30, { steps: { count: 4000, source: 'manuel' } }),
      S('2026-10-21', 'walk', 30, { steps: { count: 4000, source: 'sante' } }),
    ],
    dailySteps: [{ date: '2026-10-19', count: 9000, source: 'manuel' }, { date: '2026-10-20', count: -3, source: 'sante' }, { date: '2026-10-21', count: 8000, source: 'sante' }],
  });
  assert.deepEqual(d.sessions.map(s => s.steps), [undefined, undefined, { count: 4000, source: 'sante' }]);
  assert.deepEqual(d.dailySteps, [{ date: '2026-10-21', count: 8000, source: 'sante' }]);
});

test('distance : la source est conservée, une source inconnue devient « manuel »', () => {
  const { data: d } = C.normalizeData({
    profile: PROFILE,
    sessions: [S('2026-10-19', 'walk', 30, { distance: { km: 2, source: 'gps' } }), S('2026-10-20', 'walk', 30, { distance: { km: 2, source: 'satellite-espion' } })],
  });
  assert.deepEqual(d.sessions.map(s => s.distance.source), ['gps', 'manuel']);
  assert.equal(C.derive(d, '2026-10-31').stats.totals.km, 4, 'cumul automatique, toutes sources confondues');
});

test('ressenti « Très difficile » (4) accepté par le format, compté comme dur', () => {
  const { data: d } = C.normalizeData({ profile: PROFILE, sessions: [S('2026-10-19', 'run', 26, { feel: 4, program: { status: 'validee', step: 0 } })] });
  assert.equal(d.sessions[0].feel, 4);
  assert.equal(C.derive(d, '2026-10-31').sessions[0].prog.adapt, 'repeat');
});
