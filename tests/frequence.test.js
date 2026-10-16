'use strict';
/* Fréquence des annonces vocales en séance libre : six choix, 30 min par défaut, préférences
   conservées, migration des anciens réglages, pas d'annonce en retard, changement en cours de
   séance, et annonces essentielles des programmes guidés inchangées. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const T0 = 1_800_000_000_000, SEC = 1000, MIN = 60 * SEC;

// Fait tourner l'horloge comme l'app (un tick toutes les 500 ms) et garde ce qui serait dit
function run(t, every, from, to, marks = C.freeInitialMarks(), step = 500) {
  const said = [];
  for (let now = from; now <= to; now += step) {
    const r = C.freeCues(t, marks, now, every);
    marks = r.marks;
    for (const e of r.events) if (!e.late) said.push({ ...e, at: now });
  }
  return { said, marks };
}
const periodic = said => said.filter(e => e.type === 'milestone').map(e => e.minutes);

// ===================== RÉGLAGE =====================
test('six choix : désactivées, 5, 10, 15, 30 et 60 minutes', () => {
  assert.deepEqual(C.ANNOUNCE_CHOICES, [0, 5, 10, 15, 30, 60]);
  for (const m of C.ANNOUNCE_CHOICES) assert.equal(C.normSettings({ announceEvery: m }).announceEvery, m);
  // Valeur reçue d'un menu déroulant (texte) : acceptée
  assert.equal(C.normSettings({ announceEvery: '15' }).announceEvery, 15);
  // Valeurs inconnues : fréquence par défaut
  for (const bad of [7, -5, 120, 'abc', null, true]) assert.equal(C.normSettings({ announceEvery: bad }).announceEvery, 30);
});

test('fréquence par défaut : 30 minutes', () => {
  assert.equal(C.ANNOUNCE_DEFAULT, 30);
  assert.equal(C.normSettings(null).announceEvery, 30);
  assert.equal(C.normSettings({}).announceEvery, 30);
});

test('préférences conservées après fermeture ou mise à jour (sauvegarde puis relecture)', () => {
  for (const m of C.ANNOUNCE_CHOICES) {
    const saved = JSON.stringify(C.normSettings({ announceEvery: m, voiceRate: 1.1, voiceURI: 'x' }));
    const back = C.normSettings(JSON.parse(saved));
    assert.equal(back.announceEvery, m);
    assert.equal(back.voiceRate, 1.1);
    assert.equal(back.voiceURI, 'x');
  }
});

test('migration : anciens réglages sans fréquence → 30 min, le reste est gardé', () => {
  const old = { voice: true, voiceVolume: 0.6, voiceName: 'Thomas', voiceURI: 'com.apple.voice.Thomas', voiceRate: 0.9, sounds: false, vibration: true, warn10: false, countdown: true };
  const s = C.normSettings(old);
  assert.equal(s.announceEvery, 30);
  for (const k of Object.keys(old)) assert.equal(s[k], old[k], k);
});

test('migration : un choix explicite n\'est jamais écrasé, « désactivées » compris', () => {
  assert.equal(C.normSettings({ announceEvery: 0 }).announceEvery, 0);
  assert.equal(C.normSettings({ announceEvery: 5 }).announceEvery, 5);
  assert.equal(C.normSettings(C.normSettings({ announceEvery: 0 })).announceEvery, 0, 'relu plusieurs fois');
});

// ===================== ANNONCES =====================
test('texte annoncé : minutes, puis heures', () => {
  assert.equal(C.spokenElapsed(5), '5 minutes');
  assert.equal(C.spokenElapsed(30), '30 minutes');
  assert.equal(C.spokenElapsed(60), '1 heure');
  assert.equal(C.spokenElapsed(90), '1 heure 30');
  assert.equal(C.spokenElapsed(120), '2 heures');
  assert.equal(C.spokenElapsed(135), '2 heures 15');
});

for (const every of [5, 10, 15, 30, 60]) {
  test(`toutes les ${every} minutes : annonces aux bons paliers sur 2 h, à l'heure`, () => {
    const t = C.createFreeTimer('run', T0);
    const { said } = run(t, every, T0, T0 + 120 * MIN + 2 * SEC, undefined, 1000);
    const expected = []; for (let m = every; m <= 120; m += every) expected.push(m);
    assert.deepEqual(periodic(said), expected);
    for (const e of said.filter(x => x.type === 'milestone')) assert.ok(e.at - T0 - e.minutes * MIN < 1500, 'pas de dérive');
  });
}

test('désactivées : début annoncé, aucune annonce périodique, chrono inchangé', () => {
  const t = C.createFreeTimer('walk', T0, { countdownSec: 5 });
  const { said, marks } = run(t, 0, T0, T0 + 5 * SEC + 70 * MIN, undefined, 1000);
  assert.equal(said.filter(e => e.type === 'start').length, 1, 'annonce de début gardée');
  assert.equal(said.filter(e => e.type === 'countdown').length, 5);
  assert.deepEqual(periodic(said), []);
  assert.equal(marks.lastMin, 0);
  assert.equal(Math.round(C.freeState(t, T0 + 5 * SEC + 70 * MIN).activeMs / MIN), 70, 'le chrono ne dépend pas des annonces');
});

test('exemple à 30 min : départ, 30 minutes, 1 heure, 1 heure 30', () => {
  const t = C.createFreeTimer('run', T0);
  const { said } = run(t, 30, T0, T0 + 95 * MIN, undefined, 1000);
  assert.deepEqual(said.map(e => e.type === 'start' ? 'départ' : C.spokenElapsed(e.minutes)), ['départ', '30 minutes', '1 heure', '1 heure 30']);
});

test('pause exclue : les paliers suivent le temps actif réel', () => {
  const t = C.createFreeTimer('run', T0);
  let { marks } = run(t, 30, T0, T0 + 20 * MIN);
  C.timerPause(t, T0 + 20 * MIN);
  C.timerResume(t, T0 + 30 * MIN);           // 10 min de pause
  const r = run(t, 30, T0 + 30 * MIN, T0 + 41 * MIN, marks);
  assert.deepEqual(periodic(r.said), [30]);
  assert.ok(r.said[0].at >= T0 + 40 * MIN && r.said[0].at < T0 + 40 * MIN + 1500, '30 min actives = 40 min d\'horloge');
});

test('iPhone verrouillé : palier manqué jamais rejoué au déverrouillage, le suivant à l\'heure', () => {
  const t = C.createFreeTimer('run', T0);
  let { marks } = run(t, 30, T0, T0 + MIN);
  // Verrouillé de 1 min à 34 min : le palier de 30 min est manqué
  const back = C.freeCues(t, marks, T0 + 34 * MIN, 30);
  assert.deepEqual(back.events.map(e => [e.type, e.minutes, e.late]), [['milestone', 30, true]]);
  const r = run(t, 30, T0 + 34 * MIN + 500, T0 + 61 * MIN, back.marks);
  assert.deepEqual(periodic(r.said), [60], 'pas de « 30 minutes » en retard, « 1 heure » à l\'heure');
  // Rechargement de l'app après le verrouillage : rien n'est rejoué
  const resumed = C.freeResumeMarks(t, T0 + 34 * MIN, 30);
  assert.deepEqual(C.freeCues(t, resumed, T0 + 35 * MIN, 30).events, []);
});

test('changement de fréquence en cours de séance : ni annonce rétroactive, ni doublon', () => {
  const t = C.createFreeTimer('run', T0);
  // 30 min, puis passage à 5 min à 12 min de séance : « 10 minutes » ne doit pas être dit
  let { marks } = run(t, 30, T0, T0 + 12 * MIN);
  marks = C.freeRetuneMarks(t, marks, T0 + 12 * MIN, 5);
  let r = run(t, 5, T0 + 12 * MIN, T0 + 31 * MIN, marks);
  assert.deepEqual(periodic(r.said), [15, 20, 25, 30]);
  // Retour à 30 min juste après « 30 minutes » : pas de second « 30 minutes »
  marks = C.freeRetuneMarks(t, r.marks, T0 + 31 * MIN, 30);
  r = run(t, 30, T0 + 31 * MIN, T0 + 61 * MIN, marks);
  assert.deepEqual(periodic(r.said), [60]);
  // Passage à 15 min à 61 min (60 déjà annoncé) puis désactivation à 80 min
  marks = C.freeRetuneMarks(t, r.marks, T0 + 61 * MIN, 15);
  r = run(t, 15, T0 + 61 * MIN, T0 + 80 * MIN, marks);
  assert.deepEqual(periodic(r.said), [75]);
  marks = C.freeRetuneMarks(t, r.marks, T0 + 80 * MIN, 0);
  r = run(t, 0, T0 + 80 * MIN, T0 + 130 * MIN, marks);
  assert.deepEqual(periodic(r.said), []);
});

test('changement sans appel de recalage (sécurité) : pas de rafale, au plus un palier marqué en retard', () => {
  const t = C.createFreeTimer('run', T0);
  let { marks } = run(t, 30, T0, T0 + 23 * MIN);
  const r = C.freeCues(t, marks, T0 + 23 * MIN + 500, 5);
  assert.ok(r.events.length <= 1);
  assert.ok(r.events.every(e => e.late), '« 20 minutes » n\'est pas dit avec 3 minutes de retard');
});

test('anciennes marques (sans lastMin, version précédente) : reprises sans doublon', () => {
  const t = C.createFreeTimer('run', T0);
  const old = { count: 0, started: true, milestone: 2 };   // 10 min déjà annoncées, toutes les 5 min
  const r = run(t, 5, T0 + 11 * MIN, T0 + 16 * MIN, old);
  assert.deepEqual(periodic(r.said), [15]);
});

// ===================== PROGRAMMES GUIDÉS =====================
test('programmes guidés : annonces essentielles inchangées, quelle que soit la fréquence choisie', () => {
  const segs = [{ kind: 'warmup', label: 'Échauffement', sec: 60 }, { kind: 'run', label: 'Course', sec: 60 }, { kind: 'walk', label: 'Marche', sec: 60 }, { kind: 'cooldown', label: 'Retour au calme', sec: 60 }];
  const collect = () => {
    const t = C.createTimer(segs, T0, { countdownSec: 5 });
    let marks = C.initialMarks();
    const ev = [];
    for (let now = T0; now <= T0 + 5 * SEC + 4 * MIN + 2 * SEC; now += 500) {
      const r = C.timerCues(t, marks, now, 10);
      marks = r.marks;
      ev.push(...r.events.filter(e => !e.late).map(e => e.type + (e.idx !== undefined ? e.idx : '')));
    }
    return ev;
  };
  const before = collect();
  for (const m of C.ANNOUNCE_CHOICES) {
    C.normSettings({ announceEvery: m });       // le réglage n'a aucun effet sur le chrono guidé
    assert.deepEqual(collect(), before);
  }
  const types = new Set(before.map(x => x.replace(/\d+$/, '')));
  for (const k of ['countdown', 'phase', 'warn', 'done']) assert.ok(types.has(k), `annonce « ${k} » présente : ${[...types]}`);
});
