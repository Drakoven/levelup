'use strict';
/* LEVEL UP 2.9.0 : suivi du poids facultatif.
   Nouveaux utilisateurs sans poids, utilisateurs existants (migration), quêtes de poids
   remplacées par des objectifs sportifs sans perte des récompenses déjà obtenues,
   aucune XP en double, réglage sans effet sur l'XP. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const DRAKOVEN = { name: 'Drakoven', startWeight: 95, goalWeight: 80, bonusGoal: 75, height: 170, startDate: '2026-10-15', endDate: '2027-06-01' };
let seq = 0;
const S = (date, type, duration, extra = {}) => ({ id: `p${++seq}`, date, type, duration, feel: 2, createdAt: seq, ...extra });
const km = v => ({ distance: { km: v, source: 'manuel' } });
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const G = (d, today = '2027-03-01') => C.deriveGame(d, today);
const norm = raw => C.normalizeData(raw).data;
const questKeys = g => g.quests.ledger.map(e => e.key);

// ===================== NOUVEAUX UTILISATEURS =====================
test('nouvel utilisateur : suivi du poids désactivé par défaut, aucun poids demandé', () => {
  const d = C.emptyData();
  assert.equal(d.profile.weightTracking, false);
  assert.equal(C.profileError({ ...d.profile, name: 'Léa' }), '', 'aucune erreur sans poids ni échéance');
  const back = norm({ profile: { name: 'Léa', weightTracking: false }, onboarded: true, sessions: [], weights: [] });
  assert.equal(back.onboarded, true, 'profil valide sans poids');
  assert.equal(back.profile.weightTracking, false);
  assert.equal(C.weightOn(back.profile), false);
});

test('suivi activé : poids de départ et objectif obligatoires (règles inchangées)', () => {
  assert.equal(C.profileError({ weightTracking: true, startWeight: null, goalWeight: null }), 'Indique ton poids actuel.');
  assert.equal(C.profileError({ ...DRAKOVEN, weightTracking: true }), '');
  assert.equal(C.profileError({ weightTracking: true, startWeight: 80, goalWeight: 85 }), 'Ton poids cible doit être inférieur à ton poids actuel.');
});

test('nouvel utilisateur sans aucune pesée : les cinq chapitres sont réalisables', () => {
  const sessions = [];
  const start = '2026-11-02'; // un lundi
  // Programme guidé : 15 séances validées (3 par semaine), qui font avancer jusqu'à la semaine 6
  const progDays = [0, 2, 4];
  for (let i = 0; i < 15; i++) {
    const day = Math.floor(i / 3) * 7 + progDays[i % 3];
    sessions.push(S(addDays(start, day), 'run', 26, { program: { status: 'validee', step: i }, timing: { activeSec: 1560, runSec: 400, walkSec: 1160, maxRunSec: 60 } }));
  }
  // Marches quotidiennes de 2 km pendant 50 jours (100 km)
  for (let day = 0; day < 50; day++) sessions.push(S(addDays(start, day), 'walk', 30, km(2)));
  // Une course libre chronométrée de 26 min sans pause
  sessions.push(S(addDays(start, 45), 'run', 26, { mode: 'libre', timing: { activeSec: 1560, runSec: 1560, walkSec: 0, maxRunSec: 1560 }, ...km(4) }));
  const d = norm({ profile: { name: 'Sam', weightTracking: false }, onboarded: true, sessions, weights: [] });
  const g = G(d);
  assert.equal(d.weights.length, 0);
  assert.deepEqual(g.quests.chapters.map(c => !!c.done), [true, true, true, true, true], g.quests.chapters.map(c => c.quests.filter(q => !q.done).map(q => q.id)).flat().join(','));
  const c1 = g.quests.chapters[0].quests.find(q => q.id === 'c1q3');
  assert.equal(c1.name, 'Premier kilomètre');
  const c5 = g.quests.chapters[4].quests.find(q => q.id === 'c5q3');
  assert.equal(c5.name, 'Fidèle au poste');
  assert.equal(c5.target, 40);
  // Aucune quête de chapitre ne parle de poids ni de pesée
  for (const ch of C.CHAPTERS) for (const q of ch.quests) assert.doesNotMatch(q.desc, /poids|pesée/i, q.id);
  // Chaque récompense n'apparaît qu'une fois
  const keys = questKeys(g);
  assert.equal(new Set(keys).size, keys.length);
});

test('« Premier kilomètre » : 1 km cumulé, marche ou course, kilomètres déjà enregistrés comptés', () => {
  const base = { profile: { name: 'Sam', weightTracking: false }, onboarded: true, weights: [] };
  const g1 = G(norm({ ...base, sessions: [S('2026-11-02', 'walk', 20, km(0.6)), S('2026-11-04', 'run', 15, km(0.5)), S('2026-11-06', 'walk', 20)] }));
  assert.equal(g1.quests.chapters[0].quests[2].done, '2026-11-04', '0,6 + 0,5 km : atteint à la 2e séance');
  assert.equal(g1.quests.chapters[0].done, '2026-11-06');
  // Musculation seule : pas de kilomètre, la quête attend
  const g2 = G(norm({ ...base, sessions: [S('2026-11-02', 'strength', 30), S('2026-11-04', 'strength', 30), S('2026-11-06', 'strength', 30)] }));
  assert.equal(g2.quests.chapters[0].quests[2].done, null);
  assert.equal(g2.quests.chapters[0].done, null);
});

test('« Fidèle au poste » : 40 séances de marche ou de course (musculation non comptée)', () => {
  const sessions = [];
  for (let i = 0; i < 39; i++) sessions.push(S(addDays('2026-11-02', i), i % 2 ? 'walk' : 'run', 20));
  for (let i = 0; i < 5; i++) sessions.push(S(addDays('2026-11-02', i), 'strength', 30));
  const d = norm({ profile: { name: 'Sam', weightTracking: false }, onboarded: true, sessions, weights: [] });
  assert.equal(C.derive(d, '2027-03-01').snap.runWalk, 39);
  sessions.push(S('2026-12-20', 'walk', 20));
  assert.equal(C.derive(norm({ ...d, sessions }), '2027-03-01').snap.runWalk, 40);
});

// ===================== UTILISATEURS EXISTANTS =====================
test('migration : un profil avec poids garde le suivi actif ; un choix enregistré est respecté', () => {
  assert.equal(norm({ profile: DRAKOVEN, sessions: [], weights: [] }).profile.weightTracking, true, 'ancien profil configuré');
  assert.equal(norm({ profile: { ...DRAKOVEN, weightTracking: false }, sessions: [], weights: [] }).profile.weightTracking, false, 'désactivé explicitement');
  assert.equal(norm({ profile: { name: 'X' }, sessions: [], weights: [] }).profile.weightTracking, false, 'pas de poids : désactivé');
  assert.equal(norm({ profile: { ...DRAKOVEN, weightTracking: 'oui' }, sessions: [], weights: [] }).profile.weightTracking, true, 'valeur invalide : déduite');
  // Les poids et objectifs sont conservés tels quels, même suivi désactivé
  const off = norm({ profile: { ...DRAKOVEN, weightTracking: false }, sessions: [], weights: [{ date: '2026-10-15', kg: 95 }] });
  assert.equal(off.profile.startWeight, 95);
  assert.equal(off.profile.goalWeight, 80);
  assert.equal(off.profile.bonusGoal, 75);
  assert.equal(off.weights.length, 1);
  assert.equal(off.onboarded, true);
});

test('ancienne sauvegarde (avant 2.9.0) : importée avec le suivi actif et sans XP en double', () => {
  const old = { app: 'levelup', schemaVersion: 3, data: { profile: DRAKOVEN, onboarded: true,
    sessions: [S('2026-10-15', 'walk', 30, km(2)), S('2026-10-16', 'run', 20), S('2026-10-17', 'walk', 30, km(2.5))],
    weights: [{ date: '2026-10-15', kg: 95 }, { date: '2026-10-17', kg: 94.4 }], adjustments: [] } };
  const d = norm(old);
  assert.equal(d.profile.weightTracking, true);
  const g = G(d);
  const again = G(norm(JSON.parse(C.serialize(d))));                 // export puis réimport
  assert.equal(again.xp, g.xp);
  assert.deepEqual(again.ledger.map(e => e.key), g.ledger.map(e => e.key));
  const keys = g.ledger.map(e => e.key);
  assert.equal(new Set(keys).size, keys.length, 'chaque gain une seule fois');
});

test('quête « Le point zéro » déjà accomplie (pesée avant la 2.9.0) : reste acquise, même XP', () => {
  // Musculation seulement (aucun kilomètre) + pesée le 16 octobre : chapitre 1 terminé en 2.8.0
  const sessions = [S('2026-10-15', 'strength', 30), S('2026-10-16', 'strength', 30), S('2026-10-17', 'strength', 30)];
  const d = norm({ profile: DRAKOVEN, onboarded: true, sessions, weights: [{ date: '2026-10-16', kg: 94.8 }] });
  const g = G(d);
  assert.equal(g.quests.chapters[0].quests[2].done, '2026-10-16');
  assert.equal(g.quests.chapters[0].done, '2026-10-17');
  assert.equal(g.quests.ledger.filter(e => e.key === 'qm:c1q3').length, 1);
  // Suivi désactivé ensuite : la quête et le chapitre restent acquis
  const off = G(norm({ ...d, profile: { ...d.profile, weightTracking: false } }));
  assert.equal(off.quests.chapters[0].done, '2026-10-17');
  assert.equal(off.xp, g.xp);
  // Pesée APRÈS la mise à jour : ne remplace plus l'objectif sportif
  const late = G(norm({ profile: DRAKOVEN, onboarded: true, sessions: sessions.map(s => ({ ...s, date: s.date.replace('2026-10', '2026-11') })), weights: [{ date: '2026-11-16', kg: 94.8 }] }));
  assert.equal(late.quests.chapters[0].quests[2].done, null);
});

test('quête « La promesse tenue » déjà accomplie (objectif atteint avant la 2.9.0) : reste acquise', () => {
  const p = { ...DRAKOVEN, startWeight: 81, goalWeight: 80, startDate: '2026-09-01' };
  const g = C.derive(norm({ profile: p, onboarded: true, sessions: [], weights: [{ date: '2026-10-10', kg: 79.8 }] }), '2027-03-01');
  assert.equal(g.snap.legacyGoal, 1);
  const g2 = C.derive(norm({ profile: p, onboarded: true, sessions: [], weights: [{ date: '2026-11-10', kg: 79.8 }] }), '2027-03-01');
  assert.equal(g2.snap.legacyGoal, 0, 'objectif atteint après la mise à jour : la quête demande 40 séances');
});

test('activer ou désactiver le suivi ne change ni l\'XP, ni les quêtes, ni les succès', () => {
  const sessions = [S('2026-10-15', 'walk', 30, km(2)), S('2026-10-16', 'run', 20, km(2)), S('2026-10-17', 'walk', 30, km(2))];
  const weights = [{ date: '2026-10-15', kg: 95 }, { date: '2026-10-17', kg: 93.9 }];
  const on = G(norm({ profile: { ...DRAKOVEN, weightTracking: true }, onboarded: true, sessions, weights }));
  const off = G(norm({ profile: { ...DRAKOVEN, weightTracking: false }, onboarded: true, sessions, weights }));
  assert.equal(off.xp, on.xp);
  assert.deepEqual(off.badges, on.badges, 'succès de poids conservés (Point zéro, Premier kilo)');
  assert.ok(on.badges.weigh && on.badges.kg1);
  assert.deepEqual(off.ledger.map(e => e.key), on.ledger.map(e => e.key));
  assert.deepEqual(off.quests.chapters.map(c => c.done), on.quests.chapters.map(c => c.done));
});

test('quête épique de poids marquée comme telle (masquée sans suivi), les autres non', () => {
  const g = G(norm({ profile: { name: 'Sam', weightTracking: false }, onboarded: true, sessions: [], weights: [] }));
  assert.deepEqual(g.quests.epics.filter(e => e.weight).map(e => e.id), ['ebonus']);
  assert.equal(g.quests.epics.find(e => e.id === 'ebonus').target, 0, 'jamais atteignable sans objectif bonus');
});

test('coach : aucune pesée demandée sans suivi du poids', () => {
  const p = { name: 'Sam', weightTracking: false, startDate: '2026-12-01' };
  const d = norm({ profile: p, onboarded: true, sessions: [], weights: [] });
  const r = C.coachAdvice(d, C.derive(d, '2026-11-20'), '2026-11-20');
  assert.doesNotMatch(r.text, /pesée/);
  const dw = norm({ profile: { ...DRAKOVEN, startDate: '2026-12-01' }, onboarded: true, sessions: [], weights: [] });
  assert.match(C.coachAdvice(dw, C.derive(dw, '2026-11-20'), '2026-11-20').text, /pesée/, 'avec suivi : inchangé');
});
