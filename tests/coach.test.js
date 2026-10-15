'use strict';
/* Tests du coach adaptatif (étape 4) : ressenti sur 4 niveaux, récupération,
   régularité, propositions de retour en arrière, endurance mesurée. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const PROFILE = { name: 'Drakoven', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
let seq = 0;
const S = (date, type, duration, extra = {}) => ({ id: `c${++seq}`, date, type, duration, feel: 2, createdAt: seq, ...extra });
// Séance du programme validée au chrono à l'étape `step`
const V = (date, step, feel = 2, runSec = 360) => S(date, 'run', 26, { feel, program: { status: 'validee', step }, timing: { runSec, walkSec: 1200, maxRunSec: 60 } });
const I = (date, step) => S(date, 'run', 10, { program: { status: 'interrompue', step, runPlannedSec: 360 }, timing: { runSec: 60, walkSec: 540 } });
const mk = (sessions = [], adjustments = []) => ({ profile: PROFILE, onboarded: true, sessions, weights: [], adjustments });
const coach = (d, today) => C.coachAdvice(d, C.derive(d, today), today);

// ===================== RECOMMANDATION DU JOUR =====================
test('avant le départ, sans séance : préparation', () => {
  const r = coach(mk(), '2026-10-14');
  assert.equal(r.kind, 'start');
  assert.match(r.text, /demain/);
});

test('première séance : mission volontairement facile', () => {
  const r = coach(mk(), '2026-10-16');
  assert.equal(r.kind, 'run');
  assert.match(r.title, /Première mission/);
});

test('course faite aujourd\'hui : repos', () => {
  assert.equal(coach(mk([V('2026-10-19', 0)]), '2026-10-19').kind, 'rest');
});

test('lendemain d\'une course : récupération (repos ou marche)', () => {
  const r = coach(mk([V('2026-10-19', 0)]), '2026-10-20');
  assert.equal(r.kind, 'recovery');
  assert.match(r.text, /marche/);
});

test('2 jours après une course correcte : jour de course, avec la bonne séance', () => {
  const r = coach(mk([V('2026-10-19', 0)]), '2026-10-21');
  assert.equal(r.kind, 'run');
  assert.match(r.title, /S1 · Séance 2/);
});

test('après une course « Très difficile » : 2 jours sans course', () => {
  const d = mk([V('2026-10-19', 0, 4)]);
  assert.equal(coach(d, '2026-10-21').kind, 'recovery');
  assert.match(coach(d, '2026-10-21').title, /2 jours/);
  assert.equal(coach(d, '2026-10-22').kind, 'run');
});

test('3 séances du programme dans la semaine : le reste est du bonus', () => {
  const d = mk([V('2026-10-19', 0), V('2026-10-21', 1), V('2026-10-23', 2)]);
  const r = coach(d, '2026-10-25');
  assert.equal(r.kind, 'recovery');
  assert.match(r.title, /bouclé/);
});

test('reprise après une semaine sans rien : texte de reprise en douceur', () => {
  const r = coach(mk([V('2026-10-19', 0)]), '2026-10-28');
  assert.equal(r.kind, 'run');
  assert.match(r.text, /9 jours sans séance/);
});

// ===================== RESSENTI SUR 4 NIVEAUX =====================
test('« Très difficile » compte comme difficile : l\'étape est répétée', () => {
  const r = C.derive(mk([V('2026-10-19', 0, 2), V('2026-10-21', 1, 4)]), '2026-10-25');
  assert.equal(r.programStep, 1);
  assert.equal(r.sessions[1].prog.adapt, 'repeat');
});

test('Difficile puis Très difficile : un cran en arrière automatiquement (règle validée)', () => {
  const r = C.derive(mk([V('2026-10-19', 0, 2), V('2026-10-21', 1, 2), V('2026-10-23', 2, 3), V('2026-10-26', 2, 4)]), '2026-10-30');
  assert.equal(r.programStep, 1);
});

// ===================== PROPOSITIONS DU COACH =====================
test('après « Très difficile », le coach PROPOSE de revenir en arrière (sans le faire seul)', () => {
  const d = mk([V('2026-10-19', 0, 2), V('2026-10-22', 1, 4)]);
  const r = coach(d, '2026-10-25');
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].reason, 'tres-difficile');
  assert.equal(r.proposals[0].to.step, 0);
  assert.equal(C.derive(d, '2026-10-25').programStep, 1, 'rien ne change tant que l\'utilisateur n\'a pas répondu');
});

test('proposition acceptée : retour d\'un cran, et la proposition disparaît', () => {
  const sessions = [V('2026-10-19', 0, 2), V('2026-10-22', 1, 4)];
  const d = mk(sessions, [{ id: 'a1', date: '2026-10-25', kind: 'step-back', reason: 'tres-difficile', createdAt: 999 }]);
  assert.equal(C.derive(d, '2026-10-25').programStep, 0);
  assert.equal(coach(d, '2026-10-25').proposals.length, 0);
  // La séance suivante (validée à l'étape 0) fait de nouveau avancer
  const d2 = mk([...sessions, V('2026-10-27', 0, 2)], d.adjustments);
  assert.equal(C.derive(d2, '2026-10-28').programStep, 1);
});

test('proposition refusée (« garder l\'étape ») : rien ne change, la proposition disparaît', () => {
  const d = mk([V('2026-10-19', 0, 2), V('2026-10-22', 1, 4)], [{ id: 'k1', date: '2026-10-25', kind: 'keep', reason: 'tres-difficile', createdAt: 999 }]);
  assert.equal(C.derive(d, '2026-10-25').programStep, 1);
  assert.equal(coach(d, '2026-10-25').proposals.length, 0);
});

test('annuler un ajustement (le supprimer) remet le programme comme avant', () => {
  const sessions = [V('2026-10-19', 0, 2), V('2026-10-22', 1, 4)];
  assert.equal(C.derive(mk(sessions, [{ id: 'a1', date: '2026-10-25', kind: 'step-back', createdAt: 999 }]), '2026-10-25').programStep, 0);
  assert.equal(C.derive(mk(sessions, []), '2026-10-25').programStep, 1);
});

test('deux séances interrompues de suite : proposition de revenir en arrière', () => {
  const d = mk([V('2026-10-19', 0), V('2026-10-21', 1), I('2026-10-23', 2), I('2026-10-26', 2)]);
  const r = coach(d, '2026-10-28');
  assert.equal(r.proposals[0].reason, 'interruptions');
});

test('longue pause (14 jours ou plus) : proposition de reprise un cran en dessous', () => {
  const d = mk([V('2026-10-19', 0), V('2026-10-21', 1)]);
  assert.equal(coach(d, '2026-11-03').proposals.length, 0, '13 jours : pas encore');
  const r = coach(d, '2026-11-04');
  assert.equal(r.proposals[0].reason, 'reprise');
  assert.match(r.proposals[0].text, /14 jours/);
});

test('au tout début du programme, pas de retour en arrière possible', () => {
  const d = mk([I('2026-10-19', 0), I('2026-10-21', 0)]);
  assert.equal(coach(d, '2026-10-24').proposals.length, 0);
});

test('« Difficile » puis « Très difficile » (recul déjà fait) : pas de 2e recul proposé', () => {
  const d = mk([V('2026-10-19', 0, 2), V('2026-10-21', 1, 2), V('2026-10-23', 2, 3), V('2026-10-26', 2, 4)]);
  assert.equal(coach(d, '2026-10-29').proposals.length, 0);
});

// ===================== RÉGULARITÉ ET ENDURANCE =====================
test('régularité : jamais de reproche quand la semaine est trop courte', () => {
  // Dimanche, aucune séance cette semaine : 3 jours manquants, 1 jour restant
  const r = coach(mk([V('2026-10-19', 0)]), '2026-11-01');
  const reg = r.insights.find(i => i.icon === '📅');
  assert.match(reg.text, /pas grave/);
  assert.equal(r.daysLeft, 1);
});

test('endurance : uniquement le temps de course mesuré, comparé aux 4 semaines précédentes', () => {
  const d = mk([
    V('2026-10-19', 0, 2, 360), V('2026-10-21', 1, 2, 360),            // il y a 5-6 semaines : 12 min
    V('2026-11-23', 2, 2, 540), V('2026-11-25', 3, 2, 540),            // ces 4 dernières semaines : 18 min
    S('2026-11-27', 'run', 40, { program: { status: 'declaree', step: 4 } }), // déclarée : non mesurée
  ]);
  const r = coach(d, '2026-11-30');
  assert.equal(r.endurance.recentSec, 1080);
  assert.equal(r.endurance.beforeSec, 720);
  assert.equal(r.endurance.trend, 50);
  assert.match(r.insights.find(i => i.icon === '🫁').text, /18 min.*\+50 %/);
});

test('niveau : le coach indique le prochain rang', () => {
  const r = coach(mk([V('2026-10-19', 0)]), '2026-10-21');
  assert.match(r.insights[0].text, /Niveau 1 · Recrue : encore 400 XP avant Apprenti/);
});

// ===================== FORMAT =====================
test('ajustements : nettoyés à l\'import, triés, types inconnus ignorés', () => {
  const { data } = C.normalizeData({
    profile: PROFILE, sessions: [],
    adjustments: [
      { id: 'b', date: '2026-10-25', kind: 'step-back', reason: 'reprise', createdAt: 2 },
      { id: 'a', date: '2026-10-20', kind: 'keep', reason: 'inconnue', createdAt: 1 },
      { id: 'x', date: '2026-10-21', kind: 'sauter-3-semaines' },
      { id: 'y', date: 'pas une date', kind: 'step-back' },
    ],
  });
  assert.deepEqual(data.adjustments, [
    { id: 'a', date: '2026-10-20', kind: 'keep', createdAt: 1 },
    { id: 'b', date: '2026-10-25', kind: 'step-back', createdAt: 2, reason: 'reprise' },
  ]);
});

test('marche de remplacement et visibilité (communauté) : privé par défaut', () => {
  const { data } = C.normalizeData({
    profile: PROFILE,
    sessions: [S('2026-10-20', 'walk', 30, { swap: true }), S('2026-10-21', 'run', 20, { swap: true, visibility: 'public' }), S('2026-10-22', 'walk', 30, { visibility: 'amis' })],
  });
  assert.equal(data.sessions[0].swap, true);
  assert.equal(data.sessions[1].swap, undefined, 'seule une marche peut remplacer une course');
  assert.equal(data.sessions[1].visibility, 'public');
  assert.equal(data.sessions[2].visibility, undefined, 'valeur inconnue = privé');
  assert.equal(data.sessions[0].visibility, undefined);
});

test('une marche de remplacement ne fait pas avancer le programme', () => {
  const r = C.derive(mk([V('2026-10-19', 0), S('2026-10-21', 'walk', 30, { swap: true })]), '2026-10-22');
  assert.equal(r.programStep, 1);
  assert.equal(r.xp, 150);
});
