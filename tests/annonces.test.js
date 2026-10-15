'use strict';
/* Annonces manquées pendant que l'iPhone est verrouillé (retour de test réel) :
   elles ne doivent jamais être jouées en retard ni en rafale au déverrouillage. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const T0 = 1_800_000_000_000, SEC = 1000, MIN = 60 * SEC;
// Simule l'app : un « tic » toutes les 200 ms tant qu'elle est active
function tick(fn, t, marks, from, to) {
  const events = [];
  for (let now = from; now <= to; now += 200) {
    const r = fn(t, marks, now);
    marks = r.marks;
    r.events.forEach(e => events.push({ ...e, at: now }));
  }
  return { events, marks };
}
// Ce que l'app joue réellement : les événements non marqués « late »
const spoken = events => events.filter(e => !e.late);

// ===================== COURSE LIBRE (le cas réel) =====================
test('course libre : verrouillage de 0:30 à 8:00 → aucune annonce « 5 minutes » au déverrouillage', () => {
  const t = C.createFreeTimer('run', T0);
  let { marks } = tick(C.freeCues, t, C.freeInitialMarks(), T0, T0 + 30 * SEC);
  // iPhone verrouillé : aucun tic pendant 7 min 30. Déverrouillage à 8:00
  const r = C.freeCues(t, marks, T0 + 8 * MIN);
  assert.equal(r.st.activeMs, 8 * MIN, 'le temps reste exact');
  assert.deepEqual(r.events.map(e => [e.type, e.minutes, e.late]), [['milestone', 5, true]]);
  assert.deepEqual(spoken(r.events), [], 'rien n\'est annoncé');
  // L'app reste active jusqu'à 10:05 : « 10 minutes » est annoncé à l'heure
  const after = tick(C.freeCues, t, r.marks, T0 + 8 * MIN + 200, T0 + 10 * MIN + 5 * SEC);
  const said = spoken(after.events);
  assert.equal(said.length, 1);
  assert.equal(said[0].minutes, 10);
  assert.ok(said[0].at - T0 - 10 * MIN < 1000, 'annoncé à moins d\'une seconde de l\'échéance');
});

test('course libre : déverrouillage après plusieurs paliers → aucune rafale', () => {
  const t = C.createFreeTimer('walk', T0);
  let { marks } = tick(C.freeCues, t, C.freeInitialMarks(), T0, T0 + 10 * SEC);
  const r = C.freeCues(t, marks, T0 + 23 * MIN);
  assert.equal(r.events.length, 1, 'un seul événement pour 5, 10, 15 et 20 min');
  assert.equal(spoken(r.events).length, 0);
  assert.equal(r.marks.milestone, 4);
});

test('course libre : déverrouillage juste à l\'échéance (moins de 3 s) → annonce normale', () => {
  const t = C.createFreeTimer('run', T0);
  let { marks } = tick(C.freeCues, t, C.freeInitialMarks(), T0, T0 + 30 * SEC);
  const r = C.freeCues(t, marks, T0 + 5 * MIN + 2 * SEC);
  assert.deepEqual(spoken(r.events).map(e => e.minutes), [5]);
});

test('course libre : départ manqué (verrouillé pendant le compte à rebours) → pas de « C\'est parti » en retard', () => {
  const t = C.createFreeTimer('run', T0, { countdownSec: 5 });
  let { marks } = tick(C.freeCues, t, C.freeInitialMarks(), T0, T0 + SEC);
  const r = C.freeCues(t, marks, T0 + 2 * MIN);
  assert.deepEqual(r.events.map(e => [e.type, e.late]), [['start', true]]);
});

// ===================== CHRONO DU PROGRAMME =====================
const SEGS = [
  { kind: 'walk', label: 'Échauffement', sec: 300 },
  { kind: 'run', label: 'Course', sec: 60 },
  { kind: 'walk', label: 'Marche', sec: 120 },
  { kind: 'run', label: 'Course', sec: 60 },
  { kind: 'walk', label: 'Retour au calme', sec: 300 },
];
const cues = (t, m, now) => C.timerCues(t, m, now, 10);

test('programme : phase commencée pendant le verrouillage → pas de « Commence à courir » en retard', () => {
  const t = C.createTimer(SEGS, T0);
  let { marks } = tick(cues, t, C.initialMarks(), T0, T0 + 10 * SEC);
  const r = cues(t, marks, T0 + 5 * MIN + 40 * SEC); // dans la 1re course depuis 40 s
  assert.deepEqual(r.events.map(e => [e.type, e.late]), [['phase', true]]);
  assert.equal(r.st.idx, 1, 'l\'affichage passe bien à la course');
  // La phase suivante (récupération à 6:00) est annoncée à l'heure
  const next = tick(cues, t, r.marks, T0 + 5 * MIN + 40 * SEC + 200, T0 + 6 * MIN + SEC);
  assert.deepEqual(spoken(next.events).map(e => e.type), ['warn', 'phase']);
});

test('programme : « Dans 10 secondes » jamais dit s\'il reste moins de 7 secondes', () => {
  const t = C.createTimer(SEGS, T0);
  let { marks } = tick(cues, t, C.initialMarks(), T0, T0 + 10 * SEC);
  // Déverrouillage alors qu'il reste 4 s d'échauffement
  const r = cues(t, marks, T0 + 296 * SEC);
  assert.deepEqual(r.events, []);
  assert.equal(r.marks.warned, 0, 'l\'alerte est considérée comme passée : pas de rattrapage');
});

test('programme : plusieurs phases passées → un seul rattrapage, silencieux', () => {
  const t = C.createTimer(SEGS, T0);
  let { marks } = tick(cues, t, C.initialMarks(), T0, T0 + 10 * SEC);
  const r = cues(t, marks, T0 + 7 * MIN + 20 * SEC);
  assert.deepEqual(r.events.map(e => [e.type, e.late || false]), [['catchup', false], ['phase', true]]);
  assert.deepEqual(spoken(r.events).map(e => e.type), ['catchup'], 'seul le message visuel « phases passées » reste');
});

test('programme : fin atteinte pendant le verrouillage → bilan affiché, sans annonce', () => {
  const t = C.createTimer(SEGS, T0);
  let { marks } = tick(cues, t, C.initialMarks(), T0, T0 + 10 * SEC);
  const r = cues(t, marks, T0 + 20 * MIN);
  const done = r.events.find(e => e.type === 'done');
  assert.ok(done, 'la fin est bien détectée (le bilan doit s\'ouvrir)');
  assert.equal(done.late, true);
  // Fin à l'heure, app active : annoncée normalement
  const u = C.createTimer(SEGS, T0);
  const live = tick(cues, u, C.initialMarks(), T0, T0 + 840 * SEC + 400);
  assert.equal(live.events.find(e => e.type === 'done').late, false);
});

test('programme : séance suivie écran allumé → toutes les annonces à l\'heure, aucune marquée en retard', () => {
  const t = C.createTimer(SEGS, T0, { countdownSec: 5 });
  const { events } = tick(cues, t, C.initialMarks(), T0, T0 + 5 * SEC + 840 * SEC + 400);
  assert.equal(events.filter(e => e.late).length, 0);
  assert.equal(events.filter(e => e.type === 'phase').length, 5);
});
