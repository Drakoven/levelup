'use strict';
/* Tests du journal de quêtes (étape 5.5) : chapitres, quotidiennes, hebdomadaires, épiques,
   XP attribuée une seule fois, recalcul après suppression / import, respect de la récupération. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const PROFILE = { name: 'Drakoven', startWeight: 95, goalWeight: 80, bonusGoal: 75, height: 170, startDate: '2026-10-01', endDate: '2027-06-01' };
let seq = 0;
const S = (date, type, duration, extra = {}) => ({ id: `q${++seq}`, date, type, duration, feel: 2, createdAt: seq, ...extra });
const km = v => ({ distance: { km: v, source: 'manuel' } });
const timedRun = (date, min, kmv, maxRunMin = min) => S(date, 'run', min, { mode: 'libre', timing: { activeSec: min * 60, runSec: min * 60, walkSec: 0, maxRunSec: maxRunMin * 60 }, ...(kmv ? km(kmv) : {}) });
const mk = (sessions = [], weights = []) => ({ profile: PROFILE, onboarded: true, sessions, weights, adjustments: [] });
const G = (d, today = '2026-12-31') => C.deriveGame(d, today);
const keys = g => g.quests.ledger.map(e => e.key);

// ===================== QUÊTES PRINCIPALES =====================
test('chapitre 1 : trois quêtes, puis le chapitre terminé (50 × 3 + 150)', () => {
  const d = mk([S('2026-10-05', 'walk', 30), S('2026-10-07', 'walk', 30), S('2026-10-09', 'walk', 30)], [{ date: '2026-10-06', kg: 94.5 }]);
  const g = G(d);
  const ch1 = g.quests.chapters[0];
  assert.deepEqual(ch1.quests.map(q => q.done), ['2026-10-05', '2026-10-09', '2026-10-06']);
  assert.equal(ch1.done, '2026-10-09');
  const ch1xp = g.quests.ledger.filter(e => /^(qm:c1|qc:c1)/.test(e.key));
  assert.equal(ch1xp.reduce((a, e) => a + e.amount, 0), 300);
  // 5, 7 et 9 octobre = aussi 3 jours actifs dans la semaine : « Semaine du voyageur » (chapitre 2)
  // est validée dès l'ouverture du chapitre 2
  assert.equal(g.quests.chapters[1].quests[1].done, '2026-10-09');
  assert.equal(g.quests.chapters[1].locked, false, 'le chapitre 2 s\'ouvre');
  assert.equal(g.quests.chapters[2].locked, true, 'le chapitre 3 reste verrouillé');
});

test('chapitre verrouillé : un exploit déjà accompli est validé à l\'ouverture, pas avant', () => {
  // 10 km parcourus AVANT la première pesée (qui termine le chapitre 1 le 20 octobre)
  const d = mk([S('2026-10-05', 'walk', 60, km(5)), S('2026-10-07', 'walk', 60, km(5.5)), S('2026-10-09', 'walk', 30)], [{ date: '2026-10-20', kg: 94 }]);
  const g = G(d);
  assert.equal(g.quests.chapters[0].done, '2026-10-20');
  assert.equal(g.quests.chapters[1].quests[0].done, '2026-10-20', '« Dix bornes » validée à l\'ouverture du chapitre 2');
});

test('quête de course continue : seulement mesurée au chrono', () => {
  const base = [S('2026-10-05', 'walk', 30), S('2026-10-07', 'walk', 30), S('2026-10-09', 'walk', 30)];
  const w = [{ date: '2026-10-05', kg: 94.8 }];
  assert.equal(G(mk([...base, S('2026-10-12', 'run', 15)], w)).quests.chapters[1].quests[2].done, null, 'course saisie à la main : non');
  assert.equal(G(mk([...base, timedRun('2026-10-12', 6)], w)).quests.chapters[1].quests[2].done, '2026-10-12');
});

// ===================== QUÊTES DU JOUR =====================
test('quête du jour : 20 min de marche un jour normal → +15 XP', () => {
  const g = G(mk([S('2026-10-05', 'walk', 25)]));
  assert.ok(keys(g).includes('qd:2026-10-05'));
  assert.equal(g.quests.ledger.find(e => e.key === 'qd:2026-10-05').amount, 15);
});

test('repos : aucune XP automatique pour une journée sans activité', () => {
  const g = G(mk([S('2026-10-05', 'walk', 25)]), '2026-10-08');
  const daily = g.quests.ledger.filter(e => e.key.startsWith('qd:'));
  assert.deepEqual(daily.map(e => e.key), ['qd:2026-10-05'], 'les jours sans séance ne rapportent rien');
  assert.equal(g.quests.today.done, null, 'la quête du jour reste à faire, sans pénalité');
});

test('jour de récupération : marche douce 15 min ; une course ne valide pas la quête', () => {
  const run = timedRun('2026-10-05', 20);
  const q = C.dailyQuestFor('2026-10-06', [run]);
  assert.equal(q.kind, 'recovery');
  assert.deepEqual(q.types, ['walk']);
  assert.equal(q.minutes, 15);
  // Course le lendemain : pas de quête du jour
  assert.ok(!keys(G(mk([run, timedRun('2026-10-06', 20)]))).includes('qd:2026-10-06'));
  // Marche de 15 min le lendemain : quête réussie
  assert.ok(keys(G(mk([run, S('2026-10-06', 'walk', 15)]))).includes('qd:2026-10-06'));
});

test('après « Très difficile » : deux jours de récupération', () => {
  const hard = timedRun('2026-10-05', 20);
  hard.feel = 4;
  assert.equal(C.dailyQuestFor('2026-10-07', [hard]).kind, 'recovery');
  assert.equal(C.dailyQuestFor('2026-10-08', [hard]).kind, 'active');
});

test('quête du jour : une seule récompense par jour, même avec plusieurs séances', () => {
  const g = G(mk([S('2026-10-05', 'walk', 30), S('2026-10-05', 'walk', 40), S('2026-10-05', 'strength', 30)]));
  assert.equal(keys(g).filter(k => k === 'qd:2026-10-05').length, 1);
});

test('quête du jour adaptée au niveau : 20 min, puis 30 min après 12 séances du programme', () => {
  assert.equal(C.dailyQuestFor('2026-10-05', []).minutes, 20);
  const prog = Array.from({ length: 12 }, (_, i) => ({ ...S(C.addDays('2026-10-01', i * 3), 'run', 26), prog: { valid: true } }));
  assert.equal(C.dailyQuestFor('2026-11-30', prog).minutes, 30);
});

// ===================== QUÊTES DE LA SEMAINE =====================
test('semaine débutant : 2 jours actifs et 3 km ; ensuite une marche de 30 min et une distance adaptée', () => {
  const first = C.weeklyQuestsFor('2026-10-05', [], false);
  assert.deepEqual(first.map(q => [q.id, q.target]), [['days', 2], ['km', 3], ['prog', 1]]);
  // Après une semaine à 3 jours actifs et 5 km/semaine en moyenne sur 4 semaines
  const hist = [];
  for (let w = 0; w < 4; w++) for (let d = 0; d < 3; d++) hist.push({ ...S(C.addDays('2026-10-05', w * 7 + d * 2), 'walk', 30), km: 5 / 3 });
  const later = C.weeklyQuestsFor('2026-11-02', hist, false);
  assert.deepEqual([later[0].id, later[0].target], ['walk', 1], "pas de « 3 jours actifs » : déjà récompensé par l'objectif hebdo (+200)");
  assert.equal(later[1].target, 5.5, '+10 % au maximum');
});

test('semaine : chaque quête rapporte une seule fois, à la date où elle est remplie', () => {
  const d = mk([S('2026-10-05', 'walk', 30, km(1.5)), S('2026-10-07', 'walk', 30, km(1)), S('2026-10-09', 'walk', 30, km(1))]);
  const g = G(d);
  const wk = g.quests.ledger.filter(e => e.key.startsWith('qw:2026-10-05'));
  assert.deepEqual(wk.map(e => [e.key, e.date]), [['qw:2026-10-05:days', '2026-10-07'], ['qw:2026-10-05:km', '2026-10-09']]);
});

test('semaine : sans programme terminé, la quête « Fidèle au programme » est proposée', () => {
  const d = mk([S('2026-10-05', 'run', 26, { program: { status: 'validee', step: 0 }, timing: { runSec: 360, walkSec: 1200, maxRunSec: 60 } })]);
  assert.ok(keys(G(d)).includes('qw:2026-10-05:prog'));
});

// ===================== QUÊTES ÉPIQUES =====================
test('épique 10 km : séance chronométrée obligatoire, distance déclarée signalée', () => {
  const manual = S('2026-10-05', 'run', 70, km(10.5)); // sans chrono
  assert.equal(G(mk([manual])).quests.epics.find(e => e.id === 'e10k').done, null);
  const timed = timedRun('2026-10-10', 65, 10.2);
  const e = G(mk([manual, timed])).quests.epics.find(x => x.id === 'e10k');
  assert.equal(e.done, '2026-10-10');
  assert.equal(e.meta.source, 'manuel', 'distance déclarée, jamais présentée comme mesurée par GPS');
  assert.equal(e.target, 10);
  assert.equal(e.value, 10.2, 'meilleure course chronométrée (distance déclarée)');
});

test('épiques : 250 XP, une seule fois, distinctes des quêtes de chapitre', () => {
  const sessions = Array.from({ length: 25 }, (_, i) => S(C.addDays('2026-10-01', i * 2), 'walk', 60, km(4.2)));
  const g = G(mk(sessions));
  const e100 = g.quests.ledger.filter(e => e.key === 'qe:e100');
  assert.equal(e100.length, 1);
  assert.equal(e100[0].amount, 250);
  const ids = [...C.CHAPTERS.flatMap(c => c.quests), ...C.EPICS].map(q => q.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ===================== COHÉRENCE DE L'XP =====================
test('XP totale = XP d\'activité + XP de quêtes, niveau calculé sur le total', () => {
  const d = mk([S('2026-10-05', 'walk', 30), S('2026-10-07', 'walk', 30), S('2026-10-09', 'walk', 30)], [{ date: '2026-10-06', kg: 94.5 }]);
  const g = G(d), act = C.derive(d, '2026-12-31');
  assert.equal(g.activityXp, act.xp, 'le calcul d\'activité existant ne change pas');
  assert.equal(g.xp, act.xp + g.questXp);
  assert.equal(g.level.n, C.levelInfo(g.xp).n);
  assert.equal(new Set(g.ledger.map(e => e.key)).size, g.ledger.length, 'aucune clé d\'XP en double');
});

test('suppression d\'une séance : les quêtes qui en dépendaient sont recalculées', () => {
  const s3 = S('2026-10-09', 'walk', 30);
  const full = mk([S('2026-10-05', 'walk', 30), S('2026-10-07', 'walk', 30), s3], [{ date: '2026-10-06', kg: 94.5 }]);
  assert.ok(keys(G(full)).includes('qc:c1'));
  const less = mk(full.sessions.filter(s => s !== s3), full.weights);
  const g = G(less);
  assert.ok(!keys(g).includes('qc:c1'), 'le chapitre n\'est plus terminé');
  assert.ok(!keys(g).includes('qm:c1q2'));
  assert.ok(!keys(g).includes('qd:2026-10-09'));
});

test('import / export : même XP, aucune quête dupliquée', () => {
  const d = mk([S('2026-10-05', 'walk', 30, km(3)), timedRun('2026-10-07', 12, 2)], [{ date: '2026-10-06', kg: 94.5 }]);
  const before = G(C.normalizeData(d).data);
  const again = G(C.normalizeData(JSON.parse(C.serialize(C.normalizeData(d).data))).data);
  assert.equal(again.xp, before.xp);
  assert.deepEqual(again.ledger.map(e => e.key), before.ledger.map(e => e.key));
});

test('aucune donnée : journal vide mais prêt, rien n\'est inventé', () => {
  const g = G(mk(), '2026-10-05');
  assert.equal(g.questXp, 0);
  assert.equal(g.quests.chapters[0].locked, false);
  assert.ok(g.quests.chapters.slice(1).every(c => c.locked));
  assert.equal(g.quests.today.kind, 'active');
  assert.equal(g.quests.week.length, 3);
});

test("pas de double récompense : « 3 jours actifs » reste payé uniquement par l'objectif hebdo existant", () => {
  const week = mon => [S(mon, 'walk', 30, km(1.5)), S(C.addDays(mon, 2), 'walk', 30, km(1.5)), S(C.addDays(mon, 4), 'walk', 30, km(1.5))];
  const g = G(mk([...week('2026-10-05'), ...week('2026-10-12')]));
  const w2 = g.quests.ledger.filter(e => e.key.startsWith('qw:2026-10-12'));
  assert.ok(!w2.some(e => e.key.endsWith(':days')), 'après une première semaine parfaite, plus de quête « jours actifs »');
  assert.ok(w2.some(e => e.key.endsWith(':walk')), 'remplacée par la grande marche de 30 min');
  assert.equal(g.ledger.filter(e => e.key === 'w:2026-10-12').length, 1, 'le bonus hebdo existant reste unique');
});
