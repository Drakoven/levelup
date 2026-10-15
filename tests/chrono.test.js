'use strict';
/* Tests de l'assistant de course (étape 3) : compte à rebours, annonces,
   alerte 10 s, bilan course/marche, séance complète ou non, restauration. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const T0 = 1_800_000_000_000;
const SEC = 1000, MIN = 60 * SEC;
// Échauffement 5 min, course 1 min, récup 2 min, course 1 min, retour au calme 5 min
const SEGS = [
  { kind: 'walk', label: 'Échauffement', sec: 300 },
  { kind: 'run', label: 'Course', sec: 60 },
  { kind: 'walk', label: 'Marche', sec: 120 },
  { kind: 'run', label: 'Course', sec: 60 },
  { kind: 'walk', label: 'Retour au calme', sec: 300 },
];
const TOTAL = 840 * SEC;

// Fait "tourner" le chrono comme l'app (un tic toutes les 200 ms) et collecte les événements
function run(t, from, to, step = 200, warnSec = 10, marks = C.initialMarks()) {
  const events = [];
  for (let now = from; now <= to; now += step) {
    const r = C.timerCues(t, marks, now, warnSec);
    marks = r.marks;
    r.events.forEach(e => events.push({ ...e, at: now - from }));
  }
  return { events, marks };
}

// ===================== COMPTE À REBOURS =====================
test('compte à rebours : 5 s non comptées dans l\'effort', () => {
  const t = C.createTimer(SEGS, T0, { countdownSec: 5 });
  const st = C.timerState(t, T0 + 2 * SEC);
  assert.equal(st.countdown, true);
  assert.equal(st.countdownSec, 3);
  assert.equal(st.activeMs, 0);
  const after = C.timerState(t, T0 + 5 * SEC + 1);
  assert.equal(after.countdown, false);
  assert.equal(after.idx, 0);
  assert.ok(after.activeMs < 10);
});

test('compte à rebours : un événement par seconde, 5 → 1, puis la 1re phase', () => {
  const t = C.createTimer(SEGS, T0, { countdownSec: 5 });
  const { events } = run(t, T0, T0 + 6 * SEC);
  assert.deepEqual(events.filter(e => e.type === 'countdown').map(e => e.n), [5, 4, 3, 2, 1]);
  const first = events.find(e => e.type === 'phase');
  assert.equal(first.idx, 0);
  assert.ok(first.at >= 5 * SEC && first.at < 5.3 * SEC, 'annoncée dès la fin du décompte');
});

test('compte à rebours : « Démarrer maintenant » et pause pendant le décompte', () => {
  const t = C.createTimer(SEGS, T0, { countdownSec: 5 });
  C.timerStartNow(t, T0 + SEC);
  assert.equal(C.timerState(t, T0 + SEC).countdown, false);
  // Pause pendant le décompte : le départ est simplement décalé
  const u = C.createTimer(SEGS, T0, { countdownSec: 5 });
  C.timerPause(u, T0 + 2 * SEC);
  C.timerResume(u, T0 + 60 * SEC);
  const st = C.timerState(u, T0 + 61 * SEC);
  assert.equal(st.countdownSec, 2, 'il restait 3 s, 1 s s\'est écoulée');
  assert.equal(st.activeMs, 0);
  assert.equal(C.timerState(u, T0 + 63 * SEC + 1).countdown, false);
});

// ===================== ANNONCES ET ALERTES =====================
test('annonces : chaque phase annoncée une seule fois, dans l\'ordre, puis la fin', () => {
  const t = C.createTimer(SEGS, T0);
  const { events } = run(t, T0, T0 + TOTAL + 2 * SEC);
  assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.idx), [0, 1, 2, 3, 4]);
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(events.filter(e => e.type === 'catchup').length, 0);
});

test('alerte 10 s : une fois avant chaque changement, jamais pour une phase trop courte', () => {
  const t = C.createTimer(SEGS, T0);
  const { events } = run(t, T0, T0 + TOTAL);
  const warns = events.filter(e => e.type === 'warn');
  assert.deepEqual(warns.map(e => e.idx), [0, 1, 2, 3, 4]);
  // Alerte de l'échauffement : 10 s avant la fin des 5 min, annonce la course qui suit
  assert.ok(Math.abs(warns[0].at - 290 * SEC) <= 200);
  assert.equal(warns[0].next.kind, 'run');
  assert.equal(warns[4].next, null, 'dernière phase : on annonce la fin');
  // Phase de 12 s : trop courte pour une alerte
  const short = C.createTimer([{ kind: 'run', label: 'Course', sec: 12 }, { kind: 'walk', label: 'Marche', sec: 60 }], T0);
  assert.equal(run(short, T0, T0 + 13 * SEC).events.filter(e => e.type === 'warn').length, 0);
});

test('alerte 10 s désactivable', () => {
  const t = C.createTimer(SEGS, T0);
  assert.equal(run(t, T0, T0 + TOTAL, 200, 0).events.filter(e => e.type === 'warn').length, 0);
});

test('pause : pas d\'alerte ni de changement de phase pendant la pause', () => {
  const t = C.createTimer(SEGS, T0);
  let { marks } = run(t, T0, T0 + 285 * SEC);
  C.timerPause(t, T0 + 285 * SEC);
  const paused = run(t, T0 + 285 * SEC, T0 + 600 * SEC, 1000, 10, marks);
  assert.equal(paused.events.length, 0, 'rien ne se passe pendant 5 min de pause');
  C.timerResume(t, T0 + 600 * SEC);
  const after = run(t, T0 + 600 * SEC, T0 + 616 * SEC, 200, 10, paused.marks);
  assert.deepEqual(after.events.map(e => e.type), ['warn', 'phase']);
});

test('arrière-plan : au retour, un seul rattrapage + annonce de la phase en cours', () => {
  const t = C.createTimer(SEGS, T0);
  let { marks } = run(t, T0, T0 + 10 * SEC);
  // Écran verrouillé 7 min : aucun tic
  const r = C.timerCues(t, marks, T0 + 430 * SEC, 10);
  assert.deepEqual(r.events.map(e => e.type), ['catchup', 'phase']);
  assert.equal(r.events[0].jumped, 2);
  assert.equal(r.events[1].idx, 2);
});

test('restauration : rien n\'est annoncé deux fois', () => {
  const t = C.createTimer(SEGS, T0);
  const marks = C.resumeMarks(t, T0 + 295 * SEC); // il reste 5 s : l'alerte est déjà passée
  const r = run(t, T0 + 295 * SEC, T0 + 301 * SEC, 200, 10, marks);
  assert.deepEqual(r.events.map(e => e.type), ['phase']);
  assert.equal(r.events[0].idx, 1);
});

test('phrases en français', () => {
  assert.equal(C.spokenDuration(60), '1 minute');
  assert.equal(C.spokenDuration(90), '1 minute 30');
  assert.equal(C.spokenDuration(300), '5 minutes');
  assert.equal(C.spokenDuration(30), '30 secondes');
  assert.equal(C.phaseCue(SEGS[1]), 'Commence à courir. 1 minute.');
  assert.equal(C.phaseCue(SEGS[2]), 'Marche. Récupération 2 minutes.');
  assert.equal(C.phaseCue(SEGS[0]), 'Échauffement. Marche 5 minutes.');
  assert.equal(C.warnCue(SEGS[1]), 'Dans 10 secondes : course.');
  assert.equal(C.warnCue(null), 'Dans 10 secondes : fin de la séance.');
  assert.equal(C.CUES.ready, 'Prépare-toi.');
  assert.equal(C.CUES.done, 'Séance terminée. Bravo !');
  assert.deepEqual(SEGS.map(C.phaseName), ['MARCHE', 'COURS', 'RÉCUPÉRATION', 'COURS', 'MARCHE']);
});

// ===================== BILAN DE SÉANCE =====================
test('bilan : séance complète = temps de course et de marche exacts', () => {
  const t = C.createTimer(SEGS, T0, { countdownSec: 5 });
  const s = C.timerSummary(t, T0 + 5 * SEC + TOTAL);
  assert.equal(s.complete, true);
  assert.equal(s.runMs, 120 * SEC);
  assert.equal(s.walkMs, 720 * SEC);
  assert.equal(s.activeMs, TOTAL);
  assert.equal(s.runsDone, 2);
});

test('bilan : arrêt en cours de route = séance incomplète', () => {
  const t = C.createTimer(SEGS, T0);
  const s = C.timerSummary(t, T0 + 330 * SEC); // 5 min de marche + 30 s de course
  assert.equal(s.complete, false);
  assert.equal(s.runMs, 30 * SEC);
  assert.equal(s.walkMs, 300 * SEC);
  assert.equal(s.runsDone, 0);
});

test('bilan : course sautée = séance incomplète, même si on arrive au bout', () => {
  const t = C.createTimer(SEGS, T0);
  C.timerSkip(t, T0 + 300 * SEC);      // saute la 1re course
  C.timerSkip(t, T0 + 300 * SEC);      // saute la récup
  C.timerSkip(t, T0 + 300 * SEC);      // saute la 2e course
  const s = C.timerSummary(t, T0 + 600 * SEC);
  assert.equal(s.done, true);
  assert.equal(s.runMs, 0);
  assert.equal(s.complete, false);
  assert.equal(s.runsDone, 0);
  assert.equal(s.activeMs, 600 * SEC, 'durée réelle : 10 min de marche');
});

test('bilan : sauter l\'échauffement n\'empêche pas une séance complète', () => {
  const t = C.createTimer(SEGS, T0);
  C.timerSkip(t, T0 + 60 * SEC);
  const s = C.timerSummary(t, T0 + 600 * SEC);
  assert.equal(s.complete, true);
  assert.equal(s.runMs, 120 * SEC);
});

test('bilan : app fermée après la fin = durée plafonnée, pas gonflée', () => {
  const t = C.createTimer(SEGS, T0);
  const s = C.timerSummary(t, T0 + 3 * 3600 * SEC);
  assert.equal(s.activeMs, TOTAL);
  assert.equal(C.timerMinutes(t, T0 + 3 * 3600 * SEC), 14);
});

test('pause : exclue de la durée réelle et des temps de course/marche', () => {
  const t = C.createTimer(SEGS, T0);
  C.timerPause(t, T0 + 100 * SEC);
  C.timerResume(t, T0 + 400 * SEC);
  const s = C.timerSummary(t, T0 + 500 * SEC);
  assert.equal(s.activeMs, 200 * SEC);
  assert.equal(s.walkMs, 200 * SEC);
  assert.equal(s.runMs, 0);
});

// ===================== PROGRAMME ET SAUVEGARDE =====================
test('programme : une séance incomplète non cochée ne fait pas avancer', () => {
  const P = { name: 'Drakoven', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
  const sess = (program) => ({ id: 'x1', date: '2026-10-20', type: 'run', duration: 20, distance: 0, feel: 2, program, createdAt: 1 });
  assert.equal(C.derive({ profile: P, onboarded: true, sessions: [sess(false)], weights: [] }, '2026-10-21').programStep, 0);
  assert.equal(C.derive({ profile: P, onboarded: true, sessions: [sess(true)], weights: [] }, '2026-10-21').programStep, 1);
});

test('sauvegarde : temps de course et de marche conservés et vérifiés', () => {
  const { data } = C.normalizeData({
    profile: { name: 'A', startWeight: 95, goalWeight: 80, startDate: '2026-10-15', endDate: '2027-06-01' },
    sessions: [
      { id: 'a', date: '2026-10-20', type: 'run', duration: 26, runSec: 360, walkSec: 1200 },
      { id: 'b', date: '2026-10-21', type: 'run', duration: 26, runSec: -5, walkSec: 'x' },
    ],
  });
  assert.equal(data.sessions[0].timing.runSec, 360);
  assert.equal(data.sessions[0].timing.walkSec, 1200);
  assert.equal(data.sessions[1].timing, undefined, 'valeurs invalides ignorées');
});

test('chrono de l\'étape 2 restauré après mise à jour (sans détail des phases sautées)', () => {
  const old = { segs: SEGS, startedAt: T0, pausedAt: null, pausedMs: 0, skipMs: 0 };
  assert.ok(C.isValidTimer(old));
  assert.equal(C.timerState(old, T0 + 310 * SEC).idx, 1);
  assert.equal(C.timerSummary(old, T0 + 310 * SEC).runMs, 10 * SEC);
});

test('réglages : valeurs par défaut et nettoyage', () => {
  assert.deepEqual(C.normSettings(null), C.DEFAULT_SETTINGS);
  const s = C.normSettings({ voice: false, sounds: 'oui', voiceVolume: 5, warn10: false, countdown: false, voiceName: 'Thomas' });
  assert.equal(s.voice, false);
  assert.equal(s.sounds, true, 'valeur invalide ignorée');
  assert.equal(s.voiceVolume, 1);
  assert.equal(s.warn10, false);
  assert.equal(s.countdown, false);
  assert.equal(s.voiceName, 'Thomas');
});

// ===================== RECORDS AVEC LE CHRONO =====================
test('records : une séance chronométrée hors programme ne compte que la vraie course continue', () => {
  const P = { name: 'A', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
  const mk = (id, date, extra) => ({ id, date, type: 'run', duration: 8, distance: 0, feel: 2, program: false, createdAt: date.length + id.length, ...extra });
  // 1re séance : course libre saisie à la main, 3 min
  const manual = mk('m', '2026-10-19', { duration: 3 });
  // 2e : chrono arrêté, 8 min dont 1 min de course seulement
  const timed = mk('t', '2026-10-21', { runSec: 60, walkSec: 420, maxRunSec: 60 });
  const r = C.derive({ profile: P, onboarded: true, sessions: [manual, timed], weights: [] }, '2026-10-22');
  // [Règle v3] la course saisie à la main (3 min) n'est pas une mesure : seule la minute chronométrée compte
  assert.equal(r.records.maxRun, 1, 'les 8 min (marche comprise) ne sont pas un record de course');
  assert.equal(r.ledger.filter(e => e.key.startsWith('rr:')).length, 0);
  // Ancienne séance chronométrée sans maxRunSec : plafonnée au temps de course total
  const old = mk('o', '2026-10-23', { runSec: 120, walkSec: 360 });
  assert.equal(C.continuousRun(old), 2);
});

test('bilan : plus longue course d\'une traite', () => {
  const t = C.createTimer(SEGS, T0);
  assert.equal(C.timerSummary(t, T0 + 330 * SEC).longestRunMs, 30 * SEC);
  assert.equal(C.timerSummary(t, T0 + TOTAL).longestRunMs, 60 * SEC);
});
