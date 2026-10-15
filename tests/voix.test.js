'use strict';
/* Tests de la personnalisation de la voix du coach : liste des voix françaises
   réellement disponibles, choix mémorisé, voix de secours, vitesse de parole. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

// Voix telles que Safari iOS peut les renvoyer (exemples : la liste réelle dépend de l'iPhone)
const V = (name, lang, extra = {}) => ({ name, lang, voiceURI: `com.apple.voice.${name}`, localService: true, default: false, ...extra });
const IOS = [
  V('Samantha', 'en-US', { default: true }),
  V('Thomas', 'fr-FR'),
  V('Amélie', 'fr-CA'),
  V('Audrey (Enhanced)', 'fr-FR', { voiceURI: 'com.apple.voice.enhanced.fr-FR.Audrey' }),
  V('Thomas', 'fr-FR'), // doublon renvoyé par certaines versions d'iOS
  V('Jacques', 'fr_FR'),
];

test('liste : uniquement les voix françaises, sans doublon, France d\'abord', () => {
  const fr = C.frenchVoicesOf(IOS);
  assert.deepEqual(fr.map(v => v.name), ['Audrey (Enhanced)', 'Jacques', 'Thomas', 'Amélie']);
  assert.deepEqual(C.frenchVoicesOf([]), []);
  assert.deepEqual(C.frenchVoicesOf(undefined), []);
});

test('description : nom lisible, région, qualité (sans deviner le genre)', () => {
  assert.deepEqual(C.describeVoice(IOS[3]), { name: 'Audrey', region: 'France', quality: 'qualité supérieure' });
  assert.deepEqual(C.describeVoice(IOS[2]), { name: 'Amélie', region: 'Canada', quality: '' });
  assert.equal(C.describeVoice(V('Marie', 'fr')).region, 'Français');
});

test('choix : la voix choisie est utilisée tant qu\'elle existe', () => {
  const r = C.pickVoice(IOS, { voiceURI: 'com.apple.voice.Amélie' });
  assert.equal(r.voice.name, 'Amélie');
  assert.equal(r.fallback, false);
});

test('secours : voix choisie disparue → autre voix française, et on le signale', () => {
  const r = C.pickVoice(IOS, { voiceURI: 'com.apple.voice.Supprimée', voiceName: 'Supprimée' });
  assert.equal(r.fallback, true);
  assert.match(r.voice.lang, /^fr/, 'jamais une voix anglaise par défaut');
});

test('automatique : voix française de France privilégiée', () => {
  const r = C.pickVoice(IOS, {});
  assert.equal(r.fallback, false);
  assert.match(r.voice.lang, /fr[-_]FR/);
  // S'il n'y a qu'une voix canadienne, c'est elle qui est prise
  assert.equal(C.pickVoice([IOS[0], IOS[2]], {}).voice.name, 'Amélie');
});

test('aucune voix française (liste pas encore chargée sur iOS) : pas de voix forcée', () => {
  assert.deepEqual(C.pickVoice([IOS[0]], { voiceURI: 'com.apple.voice.Thomas' }), { voice: null, fallback: true });
  assert.deepEqual(C.pickVoice([], {}), { voice: null, fallback: false });
});

test('anciens réglages (choix par nom, avant cette version) toujours reconnus', () => {
  assert.equal(C.pickVoice(IOS, { voiceName: 'Jacques' }).voice.name, 'Jacques');
});

test('réglages : vitesse bornée, voix mémorisée, anciens réglages conservés', () => {
  const s = C.normSettings({ voiceRate: 1.2, voiceURI: 'com.apple.voice.Amélie', voiceName: 'Amélie', voice: false });
  assert.equal(s.voiceRate, 1.2);
  assert.equal(s.voiceURI, 'com.apple.voice.Amélie');
  assert.equal(s.voice, false);
  assert.equal(C.normSettings({ voiceRate: 3 }).voiceRate, 1, 'vitesse hors limites ignorée');
  assert.equal(C.normSettings({ voiceRate: 'vite' }).voiceRate, 1);
  // Réglages enregistrés par la version précédente : rien n'est perdu
  const old = C.normSettings({ voice: true, voiceVolume: 0.6, voiceName: 'Thomas', sounds: false, warn10: true, countdown: false });
  assert.deepEqual([old.voiceVolume, old.voiceName, old.sounds, old.countdown, old.voiceRate, old.voiceURI], [0.6, 'Thomas', false, false, 1, '']);
});
