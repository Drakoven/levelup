'use strict';
/* Tests de l'étape 5 : statistiques avancées, défis, titres, récompenses, objectif bonus. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const PROFILE = { name: 'Drakoven', startWeight: 95, goalWeight: 80, bonusGoal: 75, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
let seq = 0;
const S = (date, type, duration, extra = {}) => ({ id: `x${++seq}`, date, type, duration, feel: 2, createdAt: seq, ...extra });
const km = (v, source = 'manuel') => ({ distance: { km: v, source } });
const timed = (activeSec, runSec, maxRunSec = runSec) => ({ timing: { activeSec, runSec, walkSec: activeSec - runSec, maxRunSec } });
const mk = (sessions = [], weights = [], profile = PROFILE) => ({ profile, onboarded: true, sessions, weights, adjustments: [] });
const report = (d, today) => C.statsReport(d, C.derive(d, today), today);

// ===================== STATISTIQUES =====================
test('totaux : distance, durée, et séparation mesuré / saisi', () => {
  const d = mk([
    S('2026-10-19', 'walk', 40, km(3.2)),
    S('2026-10-21', 'run', 25, { mode: 'libre', ...timed(1500, 1500, 900), ...km(4, 'gps') }),
    S('2026-10-23', 'strength', 30),
  ]);
  const r = report(d, '2026-10-25');
  assert.equal(r.totals.km, 7.2);
  assert.equal(r.totals.kmMeasured, 4);
  assert.equal(r.totals.kmManual, 3.2);
  assert.equal(r.totals.minutes, 95);
  assert.equal(r.totals.runSec, 1500, 'temps de course : uniquement mesuré');
  assert.equal(r.totals.walkSec, 0, 'la marche saisie à la main n\'est pas un temps mesuré');
  assert.equal(r.totals.activeDays, 3);
});

test('séances par type : programme, course libre, marche libre, saisies', () => {
  const d = mk([
    S('2026-10-19', 'run', 26, { program: { status: 'validee', step: 0 }, ...timed(1560, 360, 60) }),
    S('2026-10-20', 'run', 10, { program: { status: 'interrompue', step: 1, runPlannedSec: 360 }, ...timed(600, 60, 60) }),
    S('2026-10-21', 'run', 20, { mode: 'libre', ...timed(1200, 1200) }),
    S('2026-10-22', 'walk', 30, { mode: 'libre', timing: { activeSec: 1800, runSec: 0, walkSec: 1800 } }),
    S('2026-10-23', 'walk', 30), S('2026-10-24', 'run', 15), S('2026-10-25', 'strength', 20),
  ]);
  assert.deepEqual(report(d, '2026-10-26').types, { programme: 2, programmeValides: 1, courseLibre: 1, marcheLibre: 1, courseManuelle: 1, marcheManuelle: 1, muscu: 1 });
});

test('par semaine et par mois : regroupements justes, semaines vides comprises', () => {
  const d = mk([S('2026-10-19', 'walk', 30, km(2)), S('2026-10-21', 'walk', 30, km(3)), S('2026-11-03', 'run', 20, km(3.5))]);
  const r = report(d, '2026-11-04');
  assert.equal(r.weeks.length, 8);
  assert.equal(r.weeks[7].key, '2026-11-02');
  assert.equal(r.weeks[7].km, 3.5);
  assert.equal(r.weeks[6].km, 0, 'semaine sans séance');
  assert.equal(r.weeks[5].km, 5);
  assert.equal(r.weeks[5].days, 2);
  assert.deepEqual(r.months.slice(-2).map(m => [m.key, m.km]), [['2026-10', 5], ['2026-11', 3.5]]);
});

test('comparaison avec la semaine précédente', () => {
  const d = mk([S('2026-10-19', 'walk', 30, km(2)), S('2026-10-26', 'walk', 45, km(3.5)), S('2026-10-28', 'walk', 30, km(2))]);
  const c = Object.fromEntries(report(d, '2026-10-29').compare.map(x => [x.key, x]));
  assert.deepEqual([c.km.now, c.km.before, c.km.diff], [5.5, 2, 3.5]);
  assert.equal(c.days.diff, 1);
  assert.equal(c.minutes.diff, 45);
});

test('records : mesurés ou saisis, toujours indiqué', () => {
  const d = mk([
    S('2026-10-19', 'walk', 60, km(5.2)),
    S('2026-10-21', 'run', 30, { mode: 'libre', ...timed(1800, 1800, 1200), ...km(4.5, 'gps') }),
  ]);
  const rec = Object.fromEntries(report(d, '2026-10-25').records.map(x => [x.id, x]));
  assert.equal(rec.distance.value, 5.2);
  assert.equal(rec.distance.measured, false, 'distance saisie à la main');
  assert.equal(rec.run.value, 20);
  assert.equal(rec.run.measured, true);
  assert.equal(rec.long.value, 30);
  assert.equal(rec['week-km'].value, 9.7);
});

test('endurance : temps de course mesuré et plus longue course par semaine', () => {
  const d = mk([S('2026-10-20', 'run', 20, { mode: 'libre', ...timed(1200, 1200, 700) }), S('2026-10-22', 'run', 40)]);
  const w = report(d, '2026-10-25').weeks[7];
  assert.equal(w.runSec, 1200, 'la course saisie à la main n\'est pas comptée');
  assert.equal(w.maxRunSec, 700);
});

test('aucune donnée : rien d\'inventé', () => {
  const r = report(mk(), '2026-10-25');
  assert.equal(r.totals.km, 0);
  assert.deepEqual(r.records, []);
  assert.equal(r.weight.weekChange, null);
  assert.equal(r.weeks.every(w => w.km === 0 && w.sessions === 0), true);
});

// ===================== POIDS =====================
test('poids : moyenne mobile 7 jours, évolution hebdo et mensuelle', () => {
  const ws = [{ date: '2026-10-19', kg: 95 }, { date: '2026-10-21', kg: 94.4 }, { date: '2026-10-26', kg: 94 }, { date: '2026-10-28', kg: 93.6 }];
  const r = report(mk([], ws), '2026-10-29');
  assert.deepEqual(r.weight.movingAvg.map(x => x.kg), [95, 94.7, 94.2, 93.8]);
  assert.deepEqual(r.weight.weekChange, { key: '2026-10-26', diff: -0.9 }, '93,8 en moyenne contre 94,7');
  assert.equal(r.weight.monthChange, null, 'pas de mois précédent : rien d\'inventé');
});

test('poids : objectif principal 80 kg et objectif bonus 75 kg', () => {
  const r = report(mk([], [{ date: '2026-11-01', kg: 88 }]), '2026-11-02');
  const [main, bonus] = r.weight.goals;
  assert.deepEqual([main.target, main.total, main.done, main.left], [80, 15, 7, 8]);
  assert.deepEqual([bonus.target, bonus.total, bonus.left], [75, 20, 13]);
  assert.equal(Math.round(bonus.pct * 100), 35);
});

test('objectif bonus : facultatif, et forcément sous l\'objectif principal', () => {
  assert.equal(C.profileError({ ...PROFILE }), '');
  assert.equal(C.profileError({ ...PROFILE, bonusGoal: null }), '');
  assert.match(C.profileError({ ...PROFILE, bonusGoal: 82 }), /bonus/);
  const { data } = C.normalizeData({ profile: { ...PROFILE, bonusGoal: 85 }, sessions: [] });
  assert.equal(data.profile.bonusGoal, null, 'bonus incohérent ignoré à l\'import');
  assert.equal(report(mk([], [], { ...PROFILE, bonusGoal: null }), '2026-11-02').weight.goals.length, 1);
});

test('succès « Au-delà » : objectif bonus atteint', () => {
  assert.ok(C.derive(mk([], [{ date: '2027-05-01', kg: 74.8 }]), '2027-05-02').badges.bonus);
  assert.equal(C.derive(mk([], [{ date: '2027-05-01', kg: 79.5 }]), '2027-05-02').badges.bonus, undefined);
});

// ===================== DÉFIS =====================
test('défis débutant : première séance, première course libre, 5/10/25/50 km', () => {
  const sessions = [S('2026-10-19', 'walk', 30, km(2)), S('2026-10-21', 'run', 20, { mode: 'libre', ...timed(1200, 1200), ...km(3.2) })];
  let b = C.derive(mk(sessions), '2026-10-25').badges;
  assert.equal(b.first, '2026-10-19');
  assert.equal(b.free1, '2026-10-21');
  assert.equal(b.km1, '2026-10-19');
  assert.equal(b.km5, '2026-10-21');
  assert.equal(b.km10, undefined);
  for (let i = 0; i < 10; i++) sessions.push(S(C.addDays('2026-10-23', i * 2), 'walk', 45, km(4.5)));
  b = C.derive(mk(sessions), '2026-11-30').badges;
  assert.ok(b.km10 && b.km25 && b.km50);
  assert.equal(b.km100, undefined);
});

test('défis : la marche est valorisée', () => {
  const sessions = Array.from({ length: 5 }, (_, i) => S(C.addDays('2026-10-19', i * 2), 'walk', 40, km(2.5)));
  const b = C.derive(mk(sessions), '2026-11-30').badges;
  assert.ok(b.walk5);
  assert.ok(b.walkkm10, '12,5 km de marche');
  assert.equal(b.walk20, undefined);
});

test('défis : 3 jours actifs, et « petit à petit » (2 jours par semaine, 4 semaines)', () => {
  const two = mon => [S(mon, 'walk', 30), S(C.addDays(mon, 3), 'walk', 30)];
  const sessions = [...two('2026-10-19'), ...two('2026-10-26'), ...two('2026-11-02'), ...two('2026-11-09')];
  const b = C.derive(mk(sessions), '2026-11-20').badges;
  assert.equal(b.gentle4, '2026-11-12');
  assert.equal(b.week, undefined, 'jamais 3 jours dans une semaine');
});

test('défi « 10 min non-stop » : seulement une course mesurée', () => {
  const manual = S('2026-10-19', 'run', 40);
  assert.equal(C.derive(mk([manual]), '2026-10-25').badges.run10, undefined);
  const free = S('2026-10-21', 'run', 12, { mode: 'libre', ...timed(720, 720, 660) });
  const b = C.derive(mk([manual, free]), '2026-10-25').badges;
  assert.equal(b.run5, '2026-10-21');
  assert.equal(b.run10, '2026-10-21');
});

test('défi « Écoute ton corps » : récompense le repos, jamais le fait de courir fatigué', () => {
  const hard = S('2026-10-19', 'run', 20, { feel: 3 });
  // Course dès le lendemain d'une séance difficile : pas de récompense
  assert.equal(C.derive(mk([hard, S('2026-10-20', 'run', 20)]), '2026-10-20').badges.listen1, undefined);
  // Un jour de repos respecté : récompense
  assert.equal(C.derive(mk([hard, S('2026-10-21', 'run', 20)]), '2026-10-22').badges.listen1, '2026-10-21');
  // Très difficile : 2 jours de repos conseillés
  const vhard = S('2026-10-19', 'run', 20, { feel: 4 });
  assert.equal(C.derive(mk([vhard, S('2026-10-21', 'run', 20)]), '2026-10-22').badges.listen1, undefined);
  assert.ok(C.derive(mk([vhard, S('2026-10-22', 'run', 20)]), '2026-10-23').badges.listen1);
  // Repos en cours, sans nouvelle course : compte aussi une fois le repos écoulé
  assert.ok(C.derive(mk([hard]), '2026-10-21').badges.listen1);
  assert.equal(C.derive(mk([hard]), '2026-10-20').badges.listen1, undefined);
});

test('défis : progression affichable, objectif de poids relatif au profil', () => {
  const D = C.derive(mk([S('2026-10-19', 'walk', 30, km(3.7))], [{ date: '2026-10-20', kg: 92 }]), '2026-10-25');
  const byId = id => C.BADGES.find(b => b.id === id);
  assert.deepEqual(C.badgeProgress(byId('km10'), D.snap), { value: 3.7, target: 10 });
  assert.deepEqual(C.badgeProgress(byId('q25'), D.snap), { value: 3, target: 3.8 });
  assert.deepEqual(C.badgeProgress(byId('bonus'), D.snap), { value: 3, target: 20 });
});

test('défis : chaque succès a une catégorie et un identifiant unique, aucune XP', () => {
  const ids = C.BADGES.map(b => b.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(C.BADGES.every(b => C.BADGE_CATS[b.cat]));
  // Les succès ne figurent pas dans l'historique d'XP : pas de doublon
  const D = C.derive(mk([S('2026-10-19', 'walk', 30, km(5))]), '2026-10-25');
  assert.equal(D.xp, 50);
  assert.ok(D.ledger.every(e => /^(s|rd|rr|w|p):/.test(e.key)));
});

// ===================== TITRES ET RÉCOMPENSES =====================
test('titres : date de passage de chaque niveau, une récompense par rang', () => {
  const sessions = Array.from({ length: 6 }, (_, i) => S(C.addDays('2026-10-19', i * 2), 'run', 20));
  const D = C.derive(mk(sessions), '2026-11-30');
  // 19, 21 et 23 octobre : 3 × 100 XP + 200 de bonus hebdo (3e jour actif) = 500 XP le 23
  assert.equal(D.levelDates[2], '2026-10-23');
  assert.equal(D.levelDates[3], undefined, '800 XP au total : pas encore Éclaireur (1 200)');
  assert.equal(C.REWARDS.length, C.LEVELS.length);
  assert.ok(D.ledger.every((e, i, a) => i === 0 || e.total === a[i - 1].total + e.amount), 'cumul de l\'historique d\'XP');
});
