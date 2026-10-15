'use strict';
/* Cas limites vérifiés avant publication de la 2.6.1 : double XP, changement de jour
   et de semaine, cohérence avec le coach, données conservées. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const PROFILE = { name: 'Drakoven', startWeight: 95, goalWeight: 80, bonusGoal: 75, height: 170, startDate: '2026-10-01', endDate: '2027-06-01' };
let seq = 0;
const S = (date, type, duration, extra = {}) => ({ id: `l${++seq}`, date, type, duration, feel: 2, createdAt: seq, ...extra });
const P = (date, step, feel = 2) => S(date, 'run', 26, { feel, program: { status: 'validee', step }, timing: { activeSec: 1560, runSec: 360, walkSec: 1200, maxRunSec: 60 }, distance: { km: 2.6, source: 'manuel' } });
const mk = (sessions = [], weights = []) => ({ profile: PROFILE, onboarded: true, sessions, weights, adjustments: [] });

// Historique varié et déterministe sur 8 semaines (programme, marches, courses libres, ressentis)
function history() {
  const out = [];
  let step = 0;
  for (let i = 0; i < 56; i++) {
    const date = C.addDays('2026-10-05', i);
    if (i % 7 === 0 || i % 7 === 2 || i % 7 === 4) out.push(P(date, step++, i % 9 === 0 ? 3 : i % 13 === 0 ? 4 : 2));
    if (i % 5 === 1) out.push(S(date, 'walk', 20 + (i % 4) * 10, { distance: { km: 2 + (i % 3), source: 'manuel' } }));
    if (i % 11 === 3) out.push(S(date, 'run', 15, { mode: 'libre', timing: { activeSec: 900, runSec: 900, walkSec: 0, maxRunSec: 900 } }));
  }
  return out;
}

// ===================== DOUBLE ATTRIBUTION =====================
test('aucune double attribution sur 8 semaines variées', () => {
  const g = C.deriveGame(mk(history()), '2026-12-15');
  const keys = g.ledger.map(e => e.key);
  assert.equal(new Set(keys).size, keys.length, 'chaque clé d\'XP est unique');
  assert.equal(keys.filter(k => k.startsWith('qd:')).length, new Set(keys.filter(k => k.startsWith('qd:'))).size);
  assert.equal(g.xp, g.ledger.reduce((a, e) => a + e.amount, 0));
  assert.equal(g.xp, g.activityXp + g.questXp);
});

test('relire les mêmes données plus tard ne change pas l\'XP déjà gagnée', () => {
  const d = mk(history());
  const a = C.deriveGame(d, '2026-12-15'), b = C.deriveGame(d, '2027-02-01');
  assert.equal(b.xp, a.xp, 'les jours sans séance n\'ajoutent rien, rien n\'est recompté');
  assert.deepEqual(b.ledger.map(e => e.key), a.ledger.map(e => e.key));
});

test('ordre de saisie mélangé : même XP, mêmes quêtes', () => {
  const h = history();
  const shuffled = [...h].reverse().map((s, i) => ({ ...s, createdAt: 1000 - i }));
  // L'ordre de saisie d'une même journée peut changer le classement des séances, pas les quêtes du jour/semaine
  const a = C.deriveGame(mk(h), '2026-12-15'), b = C.deriveGame(mk(shuffled), '2026-12-15');
  const q = g => g.quests.ledger.filter(e => /^q[dw]:/.test(e.key)).map(e => e.key).sort();
  assert.deepEqual(q(b), q(a));
});

test('les données enregistrées ne contiennent ni XP ni quête (tout est recalculé)', () => {
  const { data } = C.normalizeData(mk(history()));
  const saved = C.serialize(data);
  for (const word of ['"xp"', '"ledger"', '"quests"', '"questXp"', '"badges"']) assert.ok(!saved.includes(word), `pas de ${word} stocké`);
});

// ===================== CHANGEMENT DE JOUR =====================
test('passage à minuit : la quête d\'hier reste acquise, celle d\'aujourd\'hui repart de zéro', () => {
  const d = mk([S('2026-10-06', 'walk', 25)]);
  const day1 = C.deriveGame(d, '2026-10-06'), day2 = C.deriveGame(d, '2026-10-07');
  assert.equal(day1.quests.today.done, '2026-10-06');
  assert.ok(day2.ledger.some(e => e.key === 'qd:2026-10-06'), 'la récompense d\'hier est conservée');
  assert.equal(day2.quests.today.date, '2026-10-07');
  assert.equal(day2.quests.today.done, null);
  assert.equal(day2.quests.today.value, 0);
  assert.equal(day2.xp, day1.xp, 'aucune XP ajoutée par le simple changement de jour');
});

test('séance commencée avant minuit : comptée pour le jour où elle a commencé', () => {
  const T = new Date(2026, 9, 6, 23, 50).getTime(); // 6 octobre, 23 h 50 (heure locale)
  const t = C.createFreeTimer('walk', T);
  const e = C.freeSessionEntry(t, T + 30 * 60000); // fin le 7 octobre à 0 h 20
  assert.equal(e.date, '2026-10-06');
  const g = C.deriveGame(mk([{ id: 'nuit', createdAt: 1, ...e }]), '2026-10-07');
  assert.ok(g.ledger.some(x => x.key === 'qd:2026-10-06'));
  assert.ok(!g.ledger.some(x => x.key === 'qd:2026-10-07'));
});

// ===================== CHANGEMENT DE SEMAINE =====================
test('dimanche → lundi : quêtes de la semaine passée conservées, nouvelles quêtes à zéro', () => {
  const d = mk([S('2026-10-05', 'walk', 30, { distance: { km: 2, source: 'manuel' } }), S('2026-10-11', 'walk', 30, { distance: { km: 1.5, source: 'manuel' } })]);
  const sunday = C.deriveGame(d, '2026-10-11'), monday = C.deriveGame(d, '2026-10-12');
  const lastWeek = k => k.startsWith('qw:2026-10-05');
  assert.deepEqual(monday.ledger.filter(e => lastWeek(e.key)).map(e => e.key), sunday.ledger.filter(e => lastWeek(e.key)).map(e => e.key));
  assert.ok(sunday.ledger.some(e => e.key === 'qw:2026-10-05:km'), '3,5 km : quête distance réussie dimanche');
  assert.ok(monday.quests.week.every(q => q.value === 0 && !q.done), 'semaine neuve');
  assert.equal(monday.xp, sunday.xp);
});

test('nouvelle semaine : objectifs recalculés à partir des semaines précédentes', () => {
  const d = mk(history());
  const w = C.deriveGame(d, '2026-11-30').quests.week;
  const km = w.find(q => q.id === 'km');
  assert.ok(km.target >= 2 && km.target < 20);
  // jamais plus de 10 % au-dessus de la moyenne des 4 semaines précédentes
  const g = C.deriveGame(d, '2026-11-30');
  const prev = [1, 2, 3, 4].map(i => C.shiftWeek('2026-11-30', -i));
  const avg = prev.reduce((a, k) => a + g.sessions.filter(s => C.weekKey(s.date) === k).reduce((b, s) => b + s.km, 0), 0) / 4;
  assert.ok(km.target <= Math.round(avg * 1.1 * 10) / 10 + 0.05);
});

// ===================== RÉCUPÉRATION =====================
test('la quête du jour suit TOUJOURS le coach : jour de récupération → marche douce', () => {
  const sessions = history();
  const d = mk(sessions);
  let checked = 0;
  for (let i = 0; i < 56; i++) {
    const date = C.addDays('2026-10-05', i);
    const D = C.deriveGame(mk(sessions.filter(s => s.date < date)), date);
    const coach = C.coachAdvice(d, D, date);
    const q = C.dailyQuestFor(date, D.sessions);
    if (coach.kind === 'recovery') { assert.equal(q.kind, 'recovery', `le ${date}`); checked++; }
  }
  assert.ok(checked > 10, 'de nombreux jours de récupération vérifiés');
});

test('programme de la semaine bouclé : marche douce, une course ne valide pas la quête', () => {
  const d = mk([P('2026-10-05', 0), P('2026-10-07', 1), P('2026-10-09', 2), P('2026-10-11', 3)]);
  const q = C.dailyQuestFor('2026-10-11', C.deriveGame(d, '2026-10-11').sessions);
  assert.equal(q.kind, 'recovery');
  assert.equal(q.reason, 'semaine-bouclee');
  assert.ok(!C.deriveGame(d, '2026-10-11').ledger.some(e => e.key === 'qd:2026-10-11'));
});

test('jour de repos complet : aucune XP, aucune pénalité', () => {
  const d = mk([P('2026-10-05', 0, 4)]);
  const before = C.deriveGame(d, '2026-10-05').xp;
  assert.equal(C.deriveGame(d, '2026-10-07').xp, before);
});

// ===================== DONNÉES EXISTANTES =====================
test('données enregistrées par la 2.5.5 : relues sans aucune modification', () => {
  const v255 = { app: 'levelup', schemaVersion: 3, data: { ...mk(history()), dailySteps: [] } };
  const { data, report } = C.normalizeData(JSON.parse(JSON.stringify(v255)));
  assert.equal(report.version, 3);
  assert.equal(data.sessions.length, v255.data.sessions.length);
  assert.deepEqual(C.normalizeData(JSON.parse(C.serialize(data))).data, data);
  assert.equal(C.deriveGame(data, '2026-12-15').activityXp, C.derive(data, '2026-12-15').xp, 'XP d\'activité identique à la 2.5.5');
});
