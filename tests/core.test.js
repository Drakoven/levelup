'use strict';
/* Tests automatisés de la logique de LEVEL UP.
   Lancement : node --test tests/
   (aucune dépendance à installer, Node.js 18 ou plus suffit) */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

// ---------- Outils pour fabriquer des données de test ----------
const PROFILE = { name: 'Drakoven', startWeight: 95, goalWeight: 80, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
let seq = 0;
const S = (date, type, duration, extra = {}) => ({ id: `t${++seq}`, date, type, duration, distance: 0, feel: 2, program: false, createdAt: seq, ...extra });
const P = (date, duration = 30, feel = 2) => S(date, 'run', duration, { program: true, feel });
const data = (sessions = [], weights = [], profile = PROFILE) => ({ profile, onboarded: true, sessions, weights });
const D = (d, today = '2026-12-31') => C.derive(d, today);
const ledgerKeys = d => D(d).ledger.map(e => e.key.split(':')[0]);

// ======================= DATES =======================
test('dates : lundi de la semaine, y compris passage d\'année', () => {
  assert.equal(C.weekKey('2026-10-15'), '2026-10-12'); // jeudi → lundi
  assert.equal(C.weekKey('2026-10-12'), '2026-10-12'); // lundi → lui-même
  assert.equal(C.weekKey('2026-10-18'), '2026-10-12'); // dimanche → lundi précédent
  assert.equal(C.weekKey('2027-01-01'), '2026-12-28'); // semaine à cheval sur deux années
});

test('dates : changement d\'heure (fin octobre / fin mars) sans décalage', () => {
  assert.equal(C.daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(C.daysBetween('2027-03-27', '2027-03-29'), 2);
  assert.equal(C.shiftWeek('2026-10-19', 1), '2026-10-26');
  assert.equal(C.shiftWeek('2027-03-22', 1), '2027-03-29');
  assert.equal(C.daysBetween('2026-10-15', '2027-06-01'), 229);
});

test('dates : validation des dates', () => {
  assert.ok(C.isValidISO('2026-10-15'));
  assert.ok(!C.isValidISO('2026-02-30'));
  assert.ok(!C.isValidISO('15/10/2026'));
  assert.ok(!C.isValidISO('<img src=x>'));
  assert.ok(!C.isValidISO(20261015));
});

// ======================= NIVEAUX & XP =======================
test('niveaux : seuils des 9 rangs', () => {
  assert.equal(C.levelInfo(0).title, 'Recrue');
  assert.equal(C.levelInfo(499).n, 1);
  assert.equal(C.levelInfo(500).title, 'Apprenti');
  assert.equal(C.levelInfo(14500).title, 'Légende');
  assert.equal(C.levelInfo(99999).pct, 1);
});

test('XP de base selon le type et la durée', () => {
  assert.equal(C.sessionXP({ type: 'walk', duration: 30 }), 50);
  assert.equal(C.sessionXP({ type: 'walk', duration: 15 }), 25);
  assert.equal(C.sessionXP({ type: 'walk', duration: 5 }), 10);
  assert.equal(C.sessionXP({ type: 'run', duration: 20 }), 100);
  assert.equal(C.sessionXP({ type: 'run', duration: 5 }), 50);
  assert.equal(C.sessionXP({ type: 'strength', duration: 40 }), 100);
  assert.equal(C.sessionXP({ type: 'strength', duration: 5 }), 50);
});

test('XP total = somme de l\'historique, recalculée après suppression', () => {
  const sessions = [S('2026-10-19', 'walk', 30), S('2026-10-20', 'run', 20), S('2026-10-21', 'strength', 30)];
  const full = D(data(sessions));
  // 50 + 100 + 100 + 200 (objectif hebdo : 3 jours différents)
  assert.equal(full.xp, 450);
  const without = D(data(sessions.slice(0, 2)));
  assert.equal(without.xp, 150, 'le bonus hebdo disparaît avec la séance supprimée');
  // On remet la séance : le bonus revient (avant, il était "consommé" à vie)
  assert.equal(D(data(sessions)).xp, 450);
});

test('objectif hebdo : 3 JOURS différents, pas 3 séances le même jour', () => {
  const sameDay = [S('2026-10-19', 'walk', 30), S('2026-10-19', 'run', 20), S('2026-10-19', 'strength', 30)];
  assert.ok(!ledgerKeys(data(sameDay)).includes('w'));
  const spread = [S('2026-10-19', 'walk', 30), S('2026-10-21', 'walk', 30), S('2026-10-25', 'walk', 30)];
  assert.ok(ledgerKeys(data(spread)).includes('w'));
});

test('pesée : +20 XP une seule fois par semaine', () => {
  const d = data([], [{ date: '2026-10-19', kg: 94.5 }, { date: '2026-10-22', kg: 94.2 }, { date: '2026-10-26', kg: 94 }]);
  assert.equal(D(d).xp, 40);
});

// ======================= RECORDS =======================
test('records : la première valeur sert de référence, puis +150 XP par nouveau record', () => {
  const sessions = [
    S('2026-10-19', 'walk', 30, { distance: 3 }),
    S('2026-10-21', 'walk', 30, { distance: 2.5 }),
    S('2026-10-23', 'walk', 40, { distance: 3.5 }),
  ];
  const r = D(data(sessions));
  assert.equal(r.records.maxDistance, 3.5);
  assert.equal(r.ledger.filter(e => e.key.startsWith('rd:')).length, 1);
});

test('records : supprimer la séance record annule le bonus et le record', () => {
  const a = S('2026-10-19', 'walk', 30, { distance: 3 }), b = S('2026-10-21', 'walk', 30, { distance: 5 });
  assert.equal(D(data([a, b])).records.maxDistance, 5);
  const r = D(data([a]));
  assert.equal(r.records.maxDistance, 3);
  assert.equal(r.ledger.filter(e => e.key.startsWith('rd:')).length, 0);
});

test('records : la course continue ne compte pas la marche du programme', () => {
  // Semaine 1 : 6 × 1 min de course, séance de 26 min au total, mesurée par le chrono
  const timed = S('2026-10-19', 'run', 26, { program: { status: 'validee', step: 0 }, timing: { runSec: 360, walkSec: 1200, maxRunSec: 60 } });
  const r = D(data([timed]));
  assert.equal(r.records.maxRun, 1, 'le record est 1 min de course continue, pas 26 min');
  // [Règle v3] Sans mesure du chrono (saisie à la main, déclaration, ancienne séance), aucun record de course continue
  assert.equal(D(data([S('2026-10-19', 'run', 20)])).records.maxRun, 0);
  assert.equal(D(data([P('2026-10-19', 26)])).records.maxRun, 0);
});

test('records : l\'ordre de saisie ne change rien, seul l\'ordre des dates compte', () => {
  const late = S('2026-10-25', 'walk', 30, { distance: 5 }), early = S('2026-10-19', 'walk', 30, { distance: 3 });
  // Saisie dans le désordre : la séance du 19 a été ajoutée après celle du 25
  const r = D(data([late, early]));
  assert.equal(r.ledger.filter(e => e.key.startsWith('rd:')).length, 1);
  assert.equal(r.ledger.find(e => e.key.startsWith('rd:')).date, '2026-10-25');
});

// ======================= PROGRAMME =======================
test('programme : facile/correct → on avance, dur → on répète, 2× dur → on recule', () => {
  assert.equal(D(data([P('2026-10-19', 26, 1)])).programStep, 1);
  assert.equal(D(data([P('2026-10-19', 26, 2), P('2026-10-21', 26, 2)])).programStep, 2);
  assert.equal(D(data([P('2026-10-19', 26, 2), P('2026-10-21', 26, 3)])).programStep, 1, 'dur : on répète');
  const d = data([P('2026-10-19', 26, 2), P('2026-10-21', 26, 2), P('2026-10-23', 26, 3), P('2026-10-25', 26, 3)]);
  assert.equal(D(d).programStep, 1, '2 séances dures d\'affilée : un cran en arrière');
});

test('programme : une séance trop courte ne fait pas avancer', () => {
  const r = D(data([P('2026-10-19', 5, 1)]));
  assert.equal(r.programStep, 0);
  assert.equal(r.sessions[0].prog.valid, false);
  assert.equal(r.sessions[0].xp, 50, 'reste une course courte classique');
});

test('programme : rejoué dans l\'ordre des dates, pas de la saisie', () => {
  const later = P('2026-10-23', 26, 3), first = P('2026-10-19', 26, 2), second = P('2026-10-21', 26, 3);
  // saisies dans le désordre
  const r = D(data([later, first, second]));
  assert.equal(r.programStep, 0, '19 : avance (1), 21 : dur → répète (1), 23 : 2e dur → recule (0)');
  assert.equal(r.sessionsById[later.id].prog.adapt, 'down');
});

test('programme : ne dépasse pas la dernière étape', () => {
  const sessions = Array.from({ length: 40 }, (_, i) => P(C.addDays('2026-10-15', i * 2), 45, 1));
  const r = D(data(sessions));
  assert.equal(r.programStep, C.PROGRAM_STEPS);
  assert.equal(C.programSession(r.programStep).done, true);
});

// ======================= SÉRIES =======================
test('séries : semaine en cours non terminée = pas de pénalité', () => {
  const week = mon => [S(mon, 'walk', 30), S(C.addDays(mon, 2), 'walk', 30), S(C.addDays(mon, 4), 'walk', 30)];
  const sessions = [...week('2026-10-19'), ...week('2026-10-26'), ...week('2026-11-02')];
  // Mercredi 11 novembre : semaine en cours vide, mais la série des 3 semaines précédentes tient
  const r = C.derive(data(sessions), '2026-11-11');
  assert.equal(r.stats.streak, 3);
  assert.equal(r.stats.bestStreak, 3);
});

test('séries : une semaine manquée remet la série à zéro, la meilleure série reste', () => {
  const week = mon => [S(mon, 'walk', 30), S(C.addDays(mon, 2), 'walk', 30), S(C.addDays(mon, 4), 'walk', 30)];
  const sessions = [...week('2026-10-19'), ...week('2026-10-26'), ...week('2026-11-09')];
  const r = C.derive(data(sessions), '2026-11-25');
  assert.equal(r.stats.streak, 0);
  assert.equal(r.stats.bestStreak, 2);
  assert.equal(C.bestStreakOf(['2026-12-21', '2026-12-28', '2027-01-04']), 3, 'série à cheval sur le nouvel an');
});

// ======================= SUCCÈS =======================
test('succès « 10 min non-stop » : seulement après avoir vraiment couru 10 min', () => {
  // 21 séances validées : on arrive en semaine 8, mais on n'a couru que 7 min d'affilée
  const sessions = Array.from({ length: 21 }, (_, i) => P(C.addDays('2026-10-15', i * 2), 40, 2));
  const r = D(data(sessions), '2027-03-01');
  assert.equal(r.programStep, 21);
  assert.equal(r.badges.run10, undefined);
  // [Règle v3] Une séance de semaine 8 DÉCLARÉE ne suffit pas : rien n'a été mesuré
  const declared = S('2027-01-01', 'run', 40, { program: { status: 'declaree', step: 21 } });
  assert.equal(D(data([...sessions, declared]), '2027-03-01').badges.run10, undefined);
  // Mesurée par le chrono (2 × 10 min) : le succès se débloque
  const timed = S('2027-01-01', 'run', 34, { program: { status: 'validee', step: 21 }, timing: { runSec: 1200, walkSec: 840, maxRunSec: 600 } });
  assert.ok(D(data([...sessions, timed]), '2027-03-01').badges.run10);
});

test('succès de poids : erreur de saisie corrigée → succès annulé', () => {
  const typo = { date: '2026-10-20', kg: 59.5 }; // 59,5 au lieu de 95
  assert.ok(D(data([], [typo])).badges.goal, 'avec la faute de frappe, tout se débloque');
  const fixed = D(data([], [{ date: '2026-10-20', kg: 95 }]));
  assert.equal(fixed.badges.goal, undefined, 'une fois corrigée, le succès disparaît');
  assert.equal(fixed.badges.kg1, undefined);
});

test('succès de poids : une performance réelle reste acquise même si le poids remonte', () => {
  const r = D(data([], [{ date: '2026-11-01', kg: 90 }, { date: '2026-12-01', kg: 92 }]));
  assert.ok(r.badges.q25, '−5 kg atteint le 1er novembre (25 % de 15 kg)');
  assert.equal(r.stats.lost, 3);
  assert.equal(r.stats.maxLost, 5);
});

test('succès : date de déblocage = date de l\'exploit', () => {
  const r = D(data([S('2026-10-20', 'walk', 30)]));
  assert.equal(r.badges.first, '2026-10-20');
});

test('suppression : niveau et succès suivent les données réelles', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => S(C.addDays('2026-10-19', i), 'run', 20));
  const r = D(data(sessions));
  assert.ok(r.badges.s10);
  assert.ok(r.level.n >= 2);
  const r2 = D(data(sessions.slice(0, 1)));
  assert.equal(r2.badges.s10, undefined);
  assert.equal(r2.level.n, 1);
});

// ======================= SAUVEGARDES =======================
test('import : refuse les fichiers qui ne sont pas des sauvegardes', () => {
  assert.throws(() => C.normalizeData(null));
  assert.throws(() => C.normalizeData([]));
  assert.throws(() => C.normalizeData({ hello: 'world' }));
  assert.throws(() => C.normalizeData({ schemaVersion: 99, data: {} }), /plus récente/);
});

test('import : nettoie les données dangereuses ou invalides', () => {
  const { data: d, report } = C.normalizeData({
    profile: { ...PROFILE, name: '<img src=x onerror=alert(1)>Drakoven' },
    sessions: [
      { id: '"><script>', date: '2026-10-20', type: 'run', duration: 20, distance: 3, feel: 2 },
      { id: 'ok1', date: '<b>', type: 'run', duration: 20 },
      { id: 'ok2', date: '2026-10-21', type: 'hack', duration: 20 },
      { id: 'ok3', date: '2026-10-22', type: 'walk', duration: '30', distance: 9999, feel: 7 },
      'pas un objet',
    ],
    weights: [{ date: '2026-10-20', kg: 94 }, { date: '2026-10-20', kg: 93.8 }, { date: 'x', kg: 90 }, { date: '2026-10-21', kg: 5 }],
  });
  assert.ok(!d.profile.name.includes('<'));
  assert.equal(d.sessions.length, 2);
  assert.match(d.sessions[0].id, /^[A-Za-z0-9_-]+$/, 'identifiant dangereux remplacé');
  assert.equal(d.sessions[1].duration, 30);
  assert.equal(d.sessions[1].distance, undefined, 'distance absurde supprimée');
  assert.deepEqual(d.sessions[0].distance, { km: 3, source: 'manuel' }, 'format v3 : distance + source');
  assert.equal(d.sessions[1].feel, 2);
  assert.equal(report.droppedSessions, 3);
  assert.deepEqual(d.weights, [{ date: '2026-10-20', kg: 93.8 }]);
  assert.equal(report.droppedWeights, 2);
});

test('migration : ancien format (v1) → format actuel sans perte', () => {
  const v1 = {
    profile: { name: 'Drakoven', startWeight: 95, goalWeight: 75, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' },
    xp: 620, programStep: 1, badges: { first: '2026-10-14' }, records: { maxDistance: 3.5 },
    sessions: [{ id: 'mgb1x2y3', date: '2026-10-14', type: 'run', duration: 26, distance: 0, feel: 2, program: true, xp: 100, adapt: 'up' }],
    weights: [{ date: '2026-10-14', kg: 94.2 }],
  };
  const { data: d, report } = C.normalizeData(v1);
  assert.equal(report.version, 1);
  assert.equal(d.onboarded, true);
  assert.equal(d.sessions.length, 1);
  assert.equal(d.sessions[0].id, 'mgb1x2y3');
  assert.equal(d.sessions[0].xp, undefined, 'les valeurs calculées ne sont plus stockées');
  assert.deepEqual(d.sessions[0].program, { status: 'historique' }, 'ancienne case cochée : statut historique');
  // Aller-retour par le format actuel (v3)
  const again = C.normalizeData(JSON.parse(C.serialize(d)));
  assert.equal(again.report.version, C.SCHEMA_VERSION);
  assert.deepEqual(again.data, d);
});

test('profil : validations', () => {
  assert.equal(C.profileError(PROFILE), '');
  assert.match(C.profileError({ ...PROFILE, goalWeight: 96 }), /inférieur/);
  assert.match(C.profileError({ ...PROFILE, endDate: '2026-10-20' }), /2 semaines/);
  assert.equal(C.suggestedEnd('2026-10-15', 15), C.addDays('2026-10-15', 30 * 7));
});

// ======================= CHRONOMÈTRE =======================
const SEGS = [{ kind: 'walk', label: 'Échauffement', sec: 300 }, { kind: 'run', label: 'Course', sec: 60 }, { kind: 'walk', label: 'Marche', sec: 120 }, { kind: 'run', label: 'Course', sec: 60 }];
const T0 = 1_800_000_000_000;

test('chrono : enchaînement des phases', () => {
  const t = C.createTimer(SEGS, T0);
  assert.equal(C.timerState(t, T0).idx, 0);
  assert.equal(C.timerState(t, T0 + 299_000).leftSec, 1);
  assert.equal(C.timerState(t, T0 + 300_000).idx, 1);
  assert.equal(C.timerState(t, T0 + 360_000).runsDone, 1);
  const end = C.timerState(t, T0 + 540_000);
  assert.equal(end.done, true);
  assert.equal(end.runsDone, 2);
});

test('chrono : la pause n\'est pas comptée dans l\'effort', () => {
  const t = C.createTimer(SEGS, T0);
  C.timerPause(t, T0 + 60_000);
  assert.equal(C.timerState(t, T0 + 600_000).activeMs, 60_000, 'figé pendant la pause');
  C.timerResume(t, T0 + 600_000);
  assert.equal(C.timerState(t, T0 + 660_000).activeMs, 120_000);
  // double pause / double reprise sans effet de bord
  C.timerPause(t, T0 + 700_000); C.timerPause(t, T0 + 710_000);
  C.timerResume(t, T0 + 720_000); C.timerResume(t, T0 + 730_000);
  // 60 s avant la 1re pause + 100 s entre la reprise (600 s) et la 2e pause (700 s)
  assert.equal(C.timerState(t, T0 + 720_000).activeMs, 160_000);
  assert.equal(C.timerState(t, T0 + 780_000).activeMs, 220_000, 'reprise effective à 720 s');
});

test('chrono : sauter une phase ne gonfle PAS la durée enregistrée', () => {
  const t = C.createTimer(SEGS, T0);
  C.timerSkip(t, T0 + 10_000); // on saute l'échauffement après 10 s
  const st = C.timerState(t, T0 + 10_000);
  assert.equal(st.idx, 1, 'on passe directement à la course');
  assert.equal(st.activeMs, 10_000, 'l\'effort réel reste 10 s');
  C.timerSkip(t, T0 + 20_000); C.timerSkip(t, T0 + 30_000); C.timerSkip(t, T0 + 40_000);
  assert.equal(C.timerState(t, T0 + 40_000).done, true);
  assert.equal(C.timerMinutes(t, T0 + 40_000), 1, '40 s arrondies à 1 min, pas 9 min');
});

test('chrono : retour d\'arrière-plan = rattrapage exact, plusieurs phases d\'un coup', () => {
  const t = C.createTimer(SEGS, T0);
  // Le téléphone était verrouillé : aucun "tic" pendant 7 min
  const st = C.timerState(t, T0 + 420_000);
  assert.equal(st.idx, 2);
  assert.equal(st.leftSec, 60);
});

test('chrono : validation d\'un chrono restauré', () => {
  assert.ok(C.isValidTimer(C.createTimer(SEGS, T0)));
  assert.ok(!C.isValidTimer({ segs: [] }));
  assert.ok(!C.isValidTimer(null));
});
