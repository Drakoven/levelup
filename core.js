'use strict';
/* =========================================================
   LEVEL UP — core.js
   Toute la logique "pure" de l'application, sans affichage :
   règles du jeu, dates, programme, recalcul de l'XP, records,
   succès, séries, validation des sauvegardes et chronomètre.

   Principe clé : on ne stocke QUE les données saisies
   (profil, séances, pesées). Tout le reste (XP, niveau,
   bonus, records, succès, progression du programme) est
   RECALCULÉ à partir de l'historique. Ainsi, corriger ou
   supprimer une saisie remet toujours les compteurs d'aplomb.

   Ce fichier marche dans le navigateur (window.LevelCore)
   et dans Node.js (require) pour les tests automatisés.
   ========================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LevelCore = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // ---------- 1. Règles du jeu ----------
  const XP = {
    walk30: 50,        // marche d'au moins 30 min
    walkShort: 25,     // marche de 10 à 29 min
    walkMini: 10,      // marche de moins de 10 min
    run: 100,          // course d'au moins 10 min (ou séance du programme)
    runShort: 50,      // course de moins de 10 min
    strength: 100,     // musculation d'au moins 15 min
    strengthShort: 50, // musculation de moins de 15 min
    weeklyGoal: 200,   // 3 jours d'entraînement dans la semaine
    record: 150,       // nouveau record personnel
    weighIn: 20,       // première pesée de la semaine
    interruptedMax: 95, // séance du programme interrompue : toujours moins qu'une séance validée
  };
  const WEEKLY_TARGET = 3;          // nombre de JOURS différents d'entraînement par semaine
  const LIMITS = { duration: [1, 600], distance: [0, 100], weight: [30, 300], height: [100, 250], steps: [0, 200000] };

  const LEVELS = [
    { xp: 0, title: 'Recrue' },
    { xp: 500, title: 'Apprenti' },
    { xp: 1200, title: 'Éclaireur' },
    { xp: 2200, title: 'Coureur' },
    { xp: 3500, title: 'Athlète' },
    { xp: 5200, title: 'Guerrier' },
    { xp: 7500, title: 'Champion' },
    { xp: 10500, title: 'Titan' },
    { xp: 14500, title: 'Légende' },
  ];

  // Programme course progressif sur 12 semaines (3 séances / semaine).
  // run et walk sont en minutes, reps = nombre de répétitions.
  const PROGRAM = [
    { run: 1, walk: 2, reps: 6 },
    { run: 1.5, walk: 2, reps: 6 },
    { run: 2, walk: 2, reps: 5 },
    { run: 3, walk: 2, reps: 5 },
    { run: 4, walk: 2, reps: 4 },
    { run: 5, walk: 2, reps: 3 },
    { run: 7, walk: 2, reps: 3 },
    { run: 10, walk: 2, reps: 2 },
    { run: 12, walk: 2, reps: 2 },
    { run: 20, walk: 0, reps: 1 },
    { run: 25, walk: 0, reps: 1 },
    { run: 30, walk: 0, reps: 1 },
  ];
  const WARMUP = 5, COOLDOWN = 5;
  const PROGRAM_STEPS = PROGRAM.length * 3;

  // Succès et défis. Chacun mesure une valeur (metric) à comparer à un objectif (target),
  // ce qui permet d'afficher la progression des défis pas encore réussis.
  // Ils sont évalués dans l'ordre chronologique : la date de déblocage est celle de la
  // saisie qui a réellement permis l'exploit. Ils ne rapportent PAS d'XP (pas de doublon) :
  // ce sont des récompenses symboliques.
  //   run: true → défi qui demande de courir (jamais mis en avant un jour de récupération)
  const BADGE_CATS = {
    seances: '🏁 Séances', marche: '🚶 Marche', distance: '🛣️ Distance cumulée', course: '🏃 Course mesurée',
    regularite: '📅 Régularité', recup: '🧘 Récupération', poids: '⚖️ Poids',
  };
  const B = (id, cat, icon, name, desc, metric, target, extra = {}) => ({ id, cat, icon, name, desc, metric, target, ...extra });
  const BADGES = [
    // Séances
    B('first', 'seances', '🚀', 'Premier pas', '1ère séance', s => s.sessions, 1),
    B('freewalk1', 'seances', '🚶', 'Pas libres', '1ère marche libre au chrono', s => s.freeWalks, 1),
    B('free1', 'seances', '🏃', 'Esprit libre', '1ère course libre au chrono', s => s.freeRuns, 1, { run: true }),
    B('s10', 'seances', '💪', 'Régulier', '10 séances', s => s.sessions, 10),
    B('s25', 'seances', '⚡', 'Discipliné', '25 séances', s => s.sessions, 25),
    B('s50', 'seances', '🏆', 'Inarrêtable', '50 séances', s => s.sessions, 50),
    // Marche : valorisée autant que la course
    B('walk5', 'marche', '🥾', 'Promeneur', '5 marches', s => s.walks, 5),
    B('walk20', 'marche', '🌳', 'Randonneur', '20 marches', s => s.walks, 20),
    B('walkkm10', 'marche', '🗺️', '10 km à pied', '10 km de marche cumulés', s => s.walkKm, 10),
    B('walkkm50', 'marche', '🏞️', 'Grand marcheur', '50 km de marche cumulés', s => s.walkKm, 50),
    // Distance cumulée (marche + course)
    B('km1', 'distance', '📍', 'Premier kilomètre', '1 km cumulé', s => s.km, 1),
    B('km5', 'distance', '👣', '5 bornes', '5 km cumulés', s => s.km, 5),
    B('km10', 'distance', '👟', '10 bornes', '10 km cumulés', s => s.km, 10),
    B('km25', 'distance', '🧭', 'Explorateur', '25 km cumulés', s => s.km, 25),
    B('km50', 'distance', '🛣️', 'Voyageur', '50 km cumulés', s => s.km, 50),
    B('km100', 'distance', '🌍', 'Centurion', '100 km cumulés', s => s.km, 100),
    B('km250', 'distance', '🚀', 'Globe-trotteur', '250 km cumulés', s => s.km, 250),
    B('km500', 'distance', '🌋', 'Ultra', '500 km cumulés', s => s.km, 500),
    B('km1000', 'distance', '🌌', 'Légende de la route', '1 000 km cumulés', s => s.km, 1000),
    // Course continue MESURÉE au chrono (jamais une saisie manuelle ni une déclaration)
    B('run5', 'course', '⏳', '5 min non-stop', 'Courir 5 min sans t\'arrêter (mesuré)', s => s.maxRun, 5, { run: true }),
    B('run10', 'course', '⏱️', '10 min non-stop', 'Courir 10 min sans t\'arrêter (mesuré)', s => s.maxRun, 10, { run: true }),
    B('run30', 'course', '🥇', '30 min non-stop', 'Courir 30 min sans t\'arrêter (mesuré)', s => s.maxRun, 30, { run: true }),
    // Régularité
    B('week', 'regularite', '📅', 'Semaine parfaite', '3 jours actifs dans une semaine', s => s.perfectWeeks, 1),
    B('gentle4', 'regularite', '🌱', 'Petit à petit', '4 semaines d\'affilée avec au moins 2 jours actifs', s => s.gentleBest, 4),
    B('streak4', 'regularite', '🔥', 'Machine', '4 semaines parfaites d\'affilée', s => s.bestStreak, 4),
    // Récupération : récompense le repos après une séance difficile
    B('listen1', 'recup', '🧘', 'Écoute ton corps', 'Respecter la récupération après une séance difficile', s => s.respected, 1),
    B('listen5', 'recup', '🦉', 'Sagesse', 'Respecter 5 fois la récupération', s => s.respected, 5),
    // Poids : relatifs à l'objectif de chacun, sur le meilleur résultat atteint
    B('weigh', 'poids', '⚖️', 'Point zéro', '1ère pesée', s => s.weights, 1),
    B('kg1', 'poids', '🌱', 'Premier kilo', '−1 kg', s => s.maxLost, 1),
    B('q25', 'poids', '🎯', 'Premier quart', '25 % de l\'objectif', s => s.maxLost, s => s.goalTotal * 0.25),
    B('q50', 'poids', '💎', 'Mi-parcours', '50 % de l\'objectif', s => s.maxLost, s => s.goalTotal * 0.5),
    B('q75', 'poids', '🚀', 'Dernière ligne droite', '75 % de l\'objectif', s => s.maxLost, s => s.goalTotal * 0.75),
    B('goal', 'poids', '👑', 'Mission accomplie', 'Objectif principal atteint', s => s.maxLost, s => s.goalTotal),
    B('bonus', 'poids', '🌟', 'Au-delà', 'Objectif bonus atteint', s => s.maxLost, s => s.bonusTotal),
  ];
  // Progression d'un défi : { value, target } (target 0 = défi pas encore applicable)
  function badgeProgress(b, s) {
    const target = typeof b.target === 'function' ? b.target(s) : b.target;
    return { value: round(b.metric(s) || 0, 1), target: round(Math.max(0, target || 0), 1) };
  }
  for (const b of BADGES) b.test = s => { const { value, target } = badgeProgress(b, s); return target > 0 && value >= target; };

  // Récompenses symboliques débloquées à chaque rang
  // ---------- Journal de quêtes (étape 5.5) ----------
  // Les quêtes réutilisent le moteur des défis (metric / target / badgeProgress).
  // Contrairement aux succès, elles rapportent de l'XP : une seule fois par accomplissement,
  // grâce à une clé unique (ex. « qm:c1q2 », « qd:2026-10-19 », « qw:2026-10-19:days »).
  // Tout est recalculé à partir des séances : supprimer ou corriger une séance retire
  // ou déplace la récompense ; un import ne peut pas la dupliquer.
  const QUEST_XP = { main: 50, chapter: 150, daily: 15, weekly: 50, epic: 250 };
  const Q = (id, name, desc, metric, target, extra = {}) => ({ id, name, desc, metric, target, ...extra });
  const CHAPTERS = [
    { id: 'c1', title: 'L\'Éveil', lore: 'Tout héros commence par un premier pas.', quests: [
      Q('c1q1', 'Premier pas', 'Termine ta première séance', s => s.sessions, 1),
      Q('c1q2', 'Trois foulées', 'Termine 3 séances', s => s.sessions, 3),
      Q('c1q3', 'Le point zéro', 'Enregistre ta première pesée', s => s.weights, 1),
    ] },
    { id: 'c2', title: 'La Route', lore: 'Les chemins s\'ouvrent à ceux qui reviennent.', quests: [
      Q('c2q1', 'Dix bornes', 'Parcours 10 km au total', s => s.km, 10),
      Q('c2q2', 'Semaine du voyageur', 'Sois actif 3 jours dans une même semaine', s => s.perfectWeeks, 1),
      Q('c2q3', 'Souffle naissant', 'Cours 5 min sans t\'arrêter (mesuré au chrono)', s => s.maxRun, 5, { run: true }),
    ] },
    { id: 'c3', title: 'L\'Endurance', lore: 'La patience forge les jambes.', quests: [
      Q('c3q1', 'Explorateur', 'Parcours 25 km au total', s => s.km, 25),
      Q('c3q2', 'Dix minutes de feu', 'Cours 10 min sans t\'arrêter (mesuré au chrono)', s => s.maxRun, 10, { run: true }),
      Q('c3q3', 'Mi-chemin', 'Atteins la semaine 6 du programme', s => s.progStep, 15, { run: true }),
    ] },
    { id: 'c4', title: 'Le Coureur', lore: 'Ton pas devient régulier comme une horloge.', quests: [
      Q('c4q1', 'Voyageur', 'Parcours 50 km au total', s => s.km, 50),
      Q('c4q2', 'Le rythme du héros', '4 semaines d\'affilée avec au moins 2 jours actifs', s => s.gentleBest, 4),
      Q('c4q3', 'Vingt minutes', 'Cours 20 min sans t\'arrêter (mesuré au chrono)', s => s.maxRun, 20, { run: true }),
    ] },
    { id: 'c5', title: 'La Légende', lore: 'On parlera de toi dans les tavernes.', quests: [
      Q('c5q1', 'Grand voyageur', 'Parcours 75 km au total', s => s.km, 75),
      Q('c5q2', 'Le souffle du dragon', 'Cours 25 min sans t\'arrêter (mesuré au chrono)', s => s.maxRun, 25, { run: true }),
      Q('c5q3', 'La promesse tenue', 'Atteins ton objectif de poids principal', s => s.maxLost, s => s.goalTotal),
    ] },
  ];
  const EPICS = [
    Q('e100', 'Centurion', 'Parcours 100 km au total', s => s.km, 100),
    Q('e10k', 'Les dix mille', 'Cours 10 km en une seule séance chronométrée', s => s.bestTimedRunKm, 10, { run: true }),
    Q('e30', 'Trente minutes de légende', 'Cours 30 min sans t\'arrêter (mesuré au chrono)', s => s.maxRun, 30, { run: true }),
    Q('ebonus', 'Au-delà de l\'horizon', 'Atteins ton objectif bonus', s => s.maxLost, s => s.bonusTotal),
  ];
  const QUEST_METRICS = [...CHAPTERS.flatMap(c => c.quests), ...EPICS];
  for (const q of QUEST_METRICS) q.test = s => { const { value, target } = badgeProgress(q, s); return target > 0 && value >= target; };

  const REWARDS = [
    { icon: '🎒', name: 'Sac du départ' },
    { icon: '🎽', name: 'Maillot d\'apprenti' },
    { icon: '🧭', name: 'Boussole d\'éclaireur' },
    { icon: '👟', name: 'Chaussures de coureur' },
    { icon: '🏅', name: 'Médaille d\'athlète' },
    { icon: '🛡️', name: 'Bouclier du guerrier' },
    { icon: '🏆', name: 'Coupe du champion' },
    { icon: '⛰️', name: 'Cape du titan' },
    { icon: '👑', name: 'Couronne de légende' },
  ];

  // ---------- 2. Dates (format AAAA-MM-JJ, heure locale) ----------
  const DAY = 86400000;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const toISO = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayISO = () => toISO(new Date());
  // Math.round absorbe les heures en plus/en moins des changements d'heure été/hiver
  const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / DAY);
  // Lundi de la semaine qui contient la date
  const weekKey = iso => { const d = parseISO(iso); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return toISO(d); };
  const shiftWeek = (k, n) => { const d = parseISO(k); d.setDate(d.getDate() + 7 * n); return toISO(d); };
  const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };

  function isValidISO(s) {
    if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    if (y < 2000 || y > 2100) return false;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  const fmtMin = m => (m % 1 ? `${Math.floor(m)}'30` : `${m}'`);
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

  // ---------- 3. Niveaux & programme ----------
  function levelInfo(xp) {
    let i = 0;
    while (i < LEVELS.length - 1 && xp >= LEVELS[i + 1].xp) i++;
    const cur = LEVELS[i], next = LEVELS[i + 1];
    return { n: i + 1, title: cur.title, cur, next, pct: next ? (xp - cur.xp) / (next.xp - cur.xp) : 1 };
  }

  // Transforme une étape du programme (0 → 35) en liste de segments marche/course.
  function programSession(step) {
    const done = step >= PROGRAM_STEPS;
    const s = Math.max(0, Math.min(step, PROGRAM_STEPS - 1));
    const w = Math.floor(s / 3), p = PROGRAM[w];
    const segs = [{ kind: 'walk', min: WARMUP, label: 'Échauffement' }];
    for (let i = 0; i < p.reps; i++) {
      segs.push({ kind: 'run', min: p.run, label: 'Course' });
      if (p.walk && i < p.reps - 1) segs.push({ kind: 'walk', min: p.walk, label: 'Marche' });
    }
    segs.push({ kind: 'walk', min: COOLDOWN, label: 'Retour au calme' });
    const total = segs.reduce((a, x) => a + x.min, 0);
    return {
      step: s, week: w + 1, session: (s % 3) + 1, segs, done, total,
      runBlock: p.run,               // durée d'un bloc de course continue
      runMin: p.run * p.reps,
      runPlannedSec: Math.round(p.run * p.reps * 60), // temps de course prévu
      desc: p.reps > 1 ? `${p.reps} × (${fmtMin(p.run)} course + ${fmtMin(p.walk)} marche)` : `${p.run} min de course continue`,
    };
  }

  // ---------- Statuts des séances du programme (format v3) ----------
  //   validee     : faite au chrono, CHAQUE intervalle de course fait à 90 % ou plus
  //   interrompue : chrono arrêté, intervalle sauté ou écourté → n'avance JAMAIS le programme
  //   declaree    : faite sans le chrono, confirmée explicitement → avance, mais rien n'est « mesuré »
  //   historique  : enregistrée avant la v3 et validée selon l'ancienne règle (60 % de la durée)
  const PROGRAM_STATUSES = ['validee', 'interrompue', 'declaree', 'historique'];
  const INTERVAL_RATIO = 0.9;   // chaque intervalle de course doit être fait à 90 % au moins
  const LEGACY_RATIO = 0.6;     // ancienne règle, utilisée UNIQUEMENT pour classer les séances d'avant la v3
  const countsForProgram = status => status === 'validee' || status === 'declaree' || status === 'historique';

  // Distance d'une séance en km (format v3 { km, source } ou ancien nombre)
  const sessionKm = s => (s.distance && typeof s.distance === 'object' ? s.distance.km || 0 : +s.distance || 0);

  // Convertit une séance d'un ancien format (v1/v2) vers la forme v3, sans contrôle.
  // Les contrôles complets sont faits par normalizeData.
  function upgradeSession(s) {
    const u = { ...s };
    if (typeof u.distance === 'number' || typeof u.distance === 'string') {
      const km = +u.distance;
      if (km > 0) u.distance = { km, source: 'manuel' }; else delete u.distance;
    }
    if (!u.timing && ['runSec', 'walkSec', 'maxRunSec'].some(k => Number.isFinite(u[k]))) {
      u.timing = {};
      for (const k of ['runSec', 'walkSec', 'maxRunSec']) if (Number.isFinite(u[k])) u.timing[k] = u[k];
    }
    delete u.runSec; delete u.walkSec; delete u.maxRunSec;
    if (u.program === true) u.program = { status: 'legacy' }; // ancienne case cochée : classée au rejeu
    else if (!u.program || typeof u.program !== 'object') delete u.program;
    return u;
  }

  // XP de base d'une séance (hors bonus)
  const walkXP = d => (d >= 30 ? XP.walk30 : d >= 10 ? XP.walkShort : XP.walkMini);
  function sessionXP(s) {
    if (s.type === 'walk') return walkXP(s.duration);
    if (s.type === 'strength') return s.duration >= 15 ? XP.strength : XP.strengthShort;
    const status = s.prog ? s.prog.status : s.program && s.program.status;
    if (countsForProgram(status)) return XP.run;
    if (status === 'interrompue') {
      const t = s.timing, planned = s.program && s.program.runPlannedSec;
      if (t && Number.isFinite(t.runSec) && planned > 0) {
        // Proportionnel au temps de course réellement fait, arrondi à 5,
        // jamais moins que la marche équivalente, toujours moins qu'une séance validée.
        const prop = Math.round(XP.run * Math.min(1, t.runSec / planned) / 5) * 5;
        return Math.max(walkXP(s.duration), Math.min(XP.interruptedMax, prop));
      }
    }
    return s.duration >= 10 ? XP.run : XP.runShort;
  }

  // Course continue réellement MESURÉE (en minutes) : seul le chronomètre fait foi.
  // Une déclaration, une séance historique sans mesure ou une saisie manuelle ne comptent pas.
  function continuousRun(s) {
    if (s.type !== 'run') return 0;
    const t = s.timing || s;
    if (Number.isFinite(t.maxRunSec)) return round(t.maxRunSec / 60, 1);
    if (Number.isFinite(t.runSec)) return Math.min(s.duration, round(t.runSec / 60, 1));
    return 0;
  }

  // Rejoue le programme dans l'ordre des dates et renvoie l'étape atteinte.
  // Ajoute à chaque séance du programme : s.prog = { status, valid, step, week, session, block, adapt }
  //   adapt : up (étape suivante), repeat (dur : on répète), down (2× dur : on recule),
  //           none (interrompue : étape conservée), earlier (séance d'une étape déjà dépassée)
  function replayProgram(sorted, adjustments = []) {
    let step = 0, prevFeel = null, ai = 0;
    // Ajustements (retour en arrière accepté, étape conservée), appliqués à leur place dans le temps
    const adj = [...adjustments].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
    const applyUntil = (date, createdAt) => {
      while (ai < adj.length && (adj[ai].date < date || (adj[ai].date === date && (adj[ai].createdAt || 0) <= createdAt))) {
        const a = adj[ai++];
        a.from = step;
        if (a.kind === 'step-back') { step = Math.max(0, step - 1); prevFeel = null; }
        a.to = step;
      }
    };
    for (const s of sorted) {
      if (s.type !== 'run' || !s.program) continue;
      applyUntil(s.date, s.createdAt || 0);
      const ps = programSession(step);
      let status = s.program.status;
      if (status === 'legacy') {
        status = s.duration >= Math.ceil(ps.total * LEGACY_RATIO) ? 'historique' : 'interrompue';
        s.program = { ...s.program, status };
      }
      s.prog = { status, valid: countsForProgram(status), step: ps.step, week: ps.week, session: ps.session, block: ps.runBlock };
      if (!countsForProgram(status)) { s.prog.adapt = 'none'; continue; }
      const doneStep = s.program.step;
      if (status !== 'historique' && Number.isFinite(doneStep) && doneStep < ps.step) { s.prog.adapt = 'earlier'; continue; }
      if (s.feel < 3) { step = Math.min(PROGRAM_STEPS, step + 1); s.prog.adapt = 'up'; }
      else if (prevFeel !== null && prevFeel >= 3) { step = Math.max(0, step - 1); s.prog.adapt = 'down'; }
      else s.prog.adapt = 'repeat';
      prevFeel = s.feel;
    }
    applyUntil('9999-12-31', Infinity);
    return step;
  }

  // Distance plausible ? (évite les fautes de frappe : 25 au lieu de 2,5)
  const MAX_SPEED = { run: 20, walk: 8, strength: 8 }; // km/h
  function distanceError(type, km, minutes) {
    if (!Number.isFinite(km) || km < 0 || km > LIMITS.distance[1]) return `Distance entre 0 et ${LIMITS.distance[1]} km (ex. 3,2).`;
    if (km > 0 && minutes > 0 && km / (minutes / 60) > MAX_SPEED[type])
      return `Distance peu plausible : ${String(km).replace('.', ',')} km en ${minutes} min, soit plus de ${MAX_SPEED[type]} km/h.`;
    return '';
  }

  // Déclaration d'une séance du programme faite SANS le chrono
  function declarationError(d, ps) {
    if (d.confirmed !== true) return 'Coche la confirmation pour déclarer la séance.';
    if (!isValidISO(d.date)) return 'Choisis une date valide.';
    if (!(d.duration >= ps.total)) return `Durée incohérente : la séance prévue dure ${ps.total} min (échauffement et retour au calme compris).`;
    if (d.duration > LIMITS.duration[1]) return `Durée maximale : ${LIMITS.duration[1]} min.`;
    return distanceError('run', d.km || 0, d.duration);
  }

  // Ce qui reste modifiable sur une séance enregistrée.
  // Ce que le chrono a mesuré (type, durée, date, statut) ne se modifie plus :
  // on peut corriger une faute de frappe sans débloquer artificiellement de récompense.
  function editableFields(s) {
    const measured = !!s.timing;
    return { type: !measured && !s.program, duration: !measured, date: !measured, distance: true, feel: true, status: false };
  }

  // Statut d'une séance chronométrée, d'après le bilan du chrono
  const timerProgramStatus = sum => (sum.intervalsOk ? 'validee' : 'interrompue');

  // Ordre chronologique fiable : date, puis heure de saisie, puis identifiant
  const bySessionOrder = (a, b) =>
    a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id));

  function bestStreakOf(perfectWeekKeys) {
    const keys = [...perfectWeekKeys].sort();
    let best = 0, run = 0, prev = null;
    for (const k of keys) {
      run = prev && shiftWeek(prev, 1) === k ? run + 1 : 1;
      best = Math.max(best, run);
      prev = k;
    }
    return best;
  }

  // ---------- 4. Le grand recalcul ----------
  // À partir des seules données saisies, reconstruit tout l'état du jeu.
  function derive(data, today = todayISO()) {
    const p = data.profile || {};
    const goalTotal = p.startWeight > 0 && p.goalWeight > 0 ? Math.max(0, round(p.startWeight - p.goalWeight, 1)) : 0;
    const bonusTotal = p.startWeight > 0 && p.bonusGoal > 0 ? Math.max(0, round(p.startWeight - p.bonusGoal, 1)) : 0;

    // 4a. Programme : on rejoue les séances du programme dans l'ordre des dates
    const sessions = data.sessions.map(upgradeSession).sort(bySessionOrder);
    const adjustments = (data.adjustments || []).map(a => ({ ...a }));
    const step = replayProgram(sessions, adjustments);

    // 4b. Ligne du temps : séances + pesées, dans l'ordre chronologique
    const weights = [...data.weights].sort((a, b) => a.date.localeCompare(b.date));
    const timeline = [
      ...sessions.map(s => ({ kind: 's', date: s.date, item: s })),
      ...weights.map(w => ({ kind: 'w', date: w.date, item: w })),
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 's' ? -1 : 1) ||
      (a.kind === 's' ? bySessionOrder(a.item, b.item) : 0));

    const ledger = [];            // historique des XP : chaque gain est une ligne
    const badges = {};            // id du succès → date de déblocage
    const weekDays = {};          // semaine → ensemble des jours d'entraînement
    const perfectWeeks = new Set();
    const weighWeeks = new Set();
    const records = { maxDistance: 0, maxRun: 0, maxDistanceDate: null, maxRunDate: null };
    const acc = { sessions: 0, km: 0, minutes: 0, strength: 0, weights: 0, maxLost: 0, walks: 0, walkKm: 0, freeRuns: 0, freeWalks: 0, respected: 0, bestTimedRunKm: 0, progStep: 0 };
    const questDates = {};   // quête (principale / épique) → date où l'objectif a été atteint
    const questMeta = {};    // détails utiles à l'affichage (ex. distance déclarée des 10 km)
    let bestStreak = 0, gentleBest = 0, pendingHard = null, snap = null;
    const gentleWeeks = new Set(); // semaines avec au moins 2 jours actifs

    for (const it of timeline) {
      if (it.kind === 's') {
        const s = it.item;
        s.xp = sessionXP(s);
        s.label = s.type === 'walk' ? `Marche ${s.duration} min`
          : s.type === 'run' ? (s.prog ? `Séance S${s.prog.week}·${s.prog.session} ${PROGRAM_LABELS[s.prog.status]}` : 'Course terminée')
          : 'Séance de musculation';
        ledger.push({ key: `s:${s.id}`, date: s.date, amount: s.xp, label: s.label, ref: s.id });

        // Records : la toute première valeur sert de référence (pas de bonus)
        s.km = sessionKm(s);
        if (s.km > 0) {
          if (records.maxDistance > 0 && s.km > records.maxDistance)
            ledger.push({ key: `rd:${s.id}`, date: s.date, amount: XP.record, label: `🏅 Record de distance : ${String(s.km).replace('.', ',')} km`, ref: s.id });
          if (s.km > records.maxDistance) { records.maxDistance = s.km; records.maxDistanceDate = s.date; }
        }
        const cont = continuousRun(s);
        if (cont > 0) {
          if (records.maxRun > 0 && cont > records.maxRun)
            ledger.push({ key: `rr:${s.id}`, date: s.date, amount: XP.record, label: `🏅 Record de course continue : ${String(cont).replace('.', ',')} min`, ref: s.id });
          if (cont > records.maxRun) { records.maxRun = cont; records.maxRunDate = s.date; }
        }

        // Objectif hebdo : 3 JOURS différents d'entraînement dans la semaine
        const wk = weekKey(s.date);
        const days = weekDays[wk] || (weekDays[wk] = new Set());
        const before = days.size;
        days.add(s.date);
        if (before < 2 && days.size >= 2) { gentleWeeks.add(wk); gentleBest = bestStreakOf(gentleWeeks); }
        if (before < WEEKLY_TARGET && days.size >= WEEKLY_TARGET) {
          ledger.push({ key: `w:${wk}`, date: s.date, amount: XP.weeklyGoal, label: 'Objectif hebdo atteint 🔥' });
          perfectWeeks.add(wk);
          bestStreak = bestStreakOf(perfectWeeks);
        }
        acc.sessions++;
        acc.km = round(acc.km + s.km, 2);
        acc.minutes += s.duration;
        if (s.type === 'strength') acc.strength++;
        if (s.type === 'walk') { acc.walks++; acc.walkKm = round(acc.walkKm + s.km, 2); }
        if (s.mode === 'libre') { if (s.type === 'run') acc.freeRuns++; else acc.freeWalks++; }
        // Quête « 10 km » : uniquement une course CHRONOMÉTRÉE (la distance peut être déclarée)
        if (s.type === 'run' && s.timing && s.km > 0) {
          acc.bestTimedRunKm = Math.max(acc.bestTimedRunKm, s.km);
          if (s.km >= 10 && !questMeta.e10k) questMeta.e10k = { date: s.date, km: s.km, source: (s.distance && s.distance.source) || 'manuel', ref: s.id };
        }
        if (s.prog && s.prog.adapt === 'up') acc.progStep = Math.max(acc.progStep, s.prog.step + 1);
        // Récupération respectée : après une course difficile, la suivante attend le repos conseillé
        if (s.type === 'run') {
          if (pendingHard && daysBetween(pendingHard.date, s.date) > restDaysAfter(pendingHard)) acc.respected++;
          pendingHard = s.feel >= 3 ? s : null;
        }
      } else {
        const w = it.item, wk = weekKey(w.date);
        if (!weighWeeks.has(wk)) {
          weighWeeks.add(wk);
          ledger.push({ key: `p:${wk}`, date: w.date, amount: XP.weighIn, label: 'Pesée de la semaine' });
        }
        acc.weights++;
        if (p.startWeight > 0) acc.maxLost = Math.max(acc.maxLost, round(p.startWeight - w.kg, 1));
      }

      // Succès débloqués par cette saisie
      snap = { ...acc, perfectWeeks: perfectWeeks.size, bestStreak, gentleBest, maxRun: records.maxRun, goalTotal, bonusTotal };
      for (const b of BADGES) if (!badges[b.id] && b.test(snap)) badges[b.id] = it.date;
      for (const q of QUEST_METRICS) if (!questDates[q.id] && q.test(snap)) questDates[q.id] = it.date;
    }
    if (!snap) snap = { ...acc, perfectWeeks: 0, bestStreak: 0, gentleBest: 0, maxRun: 0, goalTotal, bonusTotal };
    // Récupération en cours : une course difficile récente dont le repos est respecté jusqu'à aujourd'hui compte aussi
    if (pendingHard && daysBetween(pendingHard.date, today) > restDaysAfter(pendingHard)) {
      snap = { ...snap, respected: snap.respected + 1 };
      for (const b of BADGES) if (!badges[b.id] && b.test(snap)) badges[b.id] = addDays(pendingHard.date, restDaysAfter(pendingHard) + 1);
    }

    // 4c. Statistiques du jour
    const byWeek = {};
    for (const k in weekDays) byWeek[k] = weekDays[k].size;
    const isPerfect = k => (byWeek[k] || 0) >= WEEKLY_TARGET;
    let k = weekKey(today), streak = 0;
    if (!isPerfect(k)) k = shiftWeek(k, -1); // la semaine en cours n'est pas encore finie : pas de pénalité
    while (isPerfect(k)) { streak++; k = shiftWeek(k, -1); }

    const current = weights.length ? weights[weights.length - 1].kg : p.startWeight;
    const xp = ledger.reduce((a, e) => a + e.amount, 0);
    const levelDates = {};
    let cum = 0, lv = 1;
    for (const e of ledger) {
      cum += e.amount;
      e.total = cum;
      while (lv < LEVELS.length && cum >= LEVELS[lv].xp) { levelDates[lv + 1] = e.date; lv++; }
    }
    const lastProgram = [...sessions].reverse().find(s => s.prog && s.prog.valid) || null;

    return {
      xp, level: levelInfo(xp), ledger, badges, records, programStep: step, adjustments, levelDates, snap, questDates, questMeta,
      sessions,                                     // séances enrichies (xp, label, prog), ordre chronologique
      sessionsById: Object.fromEntries(sessions.map(s => [s.id, s])),
      stats: {
        totals: { sessions: acc.sessions, km: acc.km, minutes: acc.minutes, strength: acc.strength },
        byWeek, perfectWeeks: perfectWeeks.size, streak, bestStreak,
        sortedW: weights, weightsCount: weights.length,
        current, lost: Math.max(0, round((p.startWeight || 0) - (current || 0), 1)), maxLost: acc.maxLost, goalTotal,
        last: sessions[sessions.length - 1] || null, lastProgram,
        thisWeek: byWeek[weekKey(today)] || 0,
        programStep: step,
      },
    };
  }

  // ---------- 5. Profil ----------
  const HEALTHY_PACE = 0.5; // kg par semaine : rythme durable proposé par défaut

  function profileError(p) {
    if (!(p.startWeight >= 30 && p.startWeight <= 300)) return 'Indique ton poids actuel.';
    if (!(p.goalWeight >= 30 && p.goalWeight <= 300)) return 'Indique ton poids cible.';
    if (p.goalWeight >= p.startWeight) return 'Ton poids cible doit être inférieur à ton poids actuel.';
    if (p.startWeight - p.goalWeight < 1) return 'Vise au moins 1 kg de différence.';
    if (p.bonusGoal !== undefined && p.bonusGoal !== null && !(p.bonusGoal >= 30 && p.bonusGoal < p.goalWeight))
      return 'L\'objectif bonus doit être inférieur à l\'objectif principal.';
    if (p.startDate !== undefined) {
      if (!isValidISO(p.startDate) || !isValidISO(p.endDate)) return 'Choisis une date de début et une échéance.';
      if (daysBetween(p.startDate, p.endDate) < 14) return 'Laisse-toi au moins 2 semaines.';
    }
    return '';
  }

  function suggestedEnd(start, kg) {
    return addDays(start, Math.max(4, Math.ceil(kg / HEALTHY_PACE)) * 7);
  }

  // ---------- 6. Sauvegardes : format, migration, validation ----------
  const SCHEMA_VERSION = 3;
  const PROGRAM_LABELS = { validee: 'validée', interrompue: 'interrompue', declaree: 'déclarée', historique: '(historique)' };
  const TYPES = ['run', 'walk', 'strength'];
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

  function newId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  const emptyData = () => ({
    profile: { name: '', startWeight: null, goalWeight: null, bonusGoal: null, height: null, startDate: todayISO(), endDate: '' },
    onboarded: false,
    sessions: [],
    weights: [],
    dailySteps: [], // pas quotidiens mesurés (Apple Santé, plus tard)
    adjustments: [], // réponses aux propositions du coach (retour en arrière, étape conservée)
  });

  const num = v => (typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(',', '.')) : NaN);
  const inRange = (v, [a, b]) => Number.isFinite(v) && v >= a && v <= b;
  const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);

  function normProfile(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const w = v => { const n = round(num(v), 1); return inRange(n, LIMITS.weight) ? n : null; };
    const h = Math.round(num(r.height));
    return {
      name: cleanText(r.name, 20),
      startWeight: w(r.startWeight),
      bonusGoal: (() => { const b = w(r.bonusGoal), g = w(r.goalWeight); return b && g && b < g ? b : null; })(),
      goalWeight: w(r.goalWeight),
      height: inRange(h, LIMITS.height) ? h : null,
      startDate: isValidISO(r.startDate) ? r.startDate : todayISO(),
      endDate: isValidISO(r.endDate) ? r.endDate : '',
    };
  }

  // Sources de mesure (format v3)
  const DIST_SOURCES = ['gps', 'sante', 'podometre', 'manuel'];
  const STEP_SOURCES = ['podometre', 'sante']; // jamais d'estimation : uniquement des mesures réelles
  const secs = v => { const n = Math.round(num(v)); return inRange(n, [0, LIMITS.duration[1] * 120]) ? n : null; };
  const isoTime = v => (typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

  // Renvoie une séance propre au format v3, ou null si elle est inutilisable.
  // Accepte aussi les anciens formats (distance en nombre, runSec à plat, program: true).
  function normSession(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    if (!TYPES.includes(raw.type) || !isValidISO(raw.date)) return null;
    const duration = Math.round(num(raw.duration));
    if (!inRange(duration, LIMITS.duration)) return null;
    let feel = Math.round(num(raw.feel));
    if (!inRange(feel, [1, 4])) feel = 2; // 4 = « Très difficile » (prévu pour l'étape 4)
    const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
    let createdAt = num(raw.createdAt);
    if (!Number.isFinite(createdAt)) {
      // Anciennes séances : l'identifiant était Date.now() en base 36
      const fromId = id ? parseInt(id, 36) : NaN;
      createdAt = fromId > 1.5e12 && fromId < 4e12 ? fromId : index;
    }
    const out = { id, date: raw.date, type: raw.type, duration, feel, createdAt };

    // Distance et source de la mesure
    const d = raw.distance;
    const kmRaw = d && typeof d === 'object' ? num(d.km) : num(d);
    const km = round(kmRaw, 2);
    if (inRange(km, LIMITS.distance) && km > 0) {
      out.distance = { km, source: d && typeof d === 'object' && DIST_SOURCES.includes(d.source) ? d.source : 'manuel' };
      if (d && typeof d === 'object') {
        const m = round(num(d.measuredKm), 2);
        if (inRange(m, LIMITS.distance)) out.distance.measuredKm = m;
        if (d.corrected === true) out.distance.corrected = true;
      }
    }

    // Pas : seulement s'ils ont été réellement mesurés
    const st = raw.steps;
    if (st && typeof st === 'object' && STEP_SOURCES.includes(st.source)) {
      const c = Math.round(num(st.count));
      if (inRange(c, LIMITS.steps)) out.steps = { count: c, source: st.source };
    }

    // Mesures du chronomètre (v3 : objet timing ; v2 : champs à plat)
    const tsrc = raw.timing && typeof raw.timing === 'object' ? raw.timing : raw;
    const timing = {};
    for (const k of ['activeSec', 'runSec', 'walkSec', 'maxRunSec', 'pausedSec']) { const v = secs(tsrc[k]); if (v !== null) timing[k] = v; }
    if (Object.keys(timing).length) out.timing = timing;
    for (const k of ['startedAt', 'endedAt']) { const v = isoTime(raw[k]); if (v) out[k] = v; }
    if (typeof raw.routeId === 'string' && ID_RE.test(raw.routeId)) out.routeId = raw.routeId; // parcours GPS (plus tard)
    if (raw.type === 'walk' && raw.swap === true) out.swap = true; // marche faite à la place d'une course
    if (raw.mode === 'libre' && raw.type !== 'strength' && !raw.program) out.mode = 'libre'; // séance libre au chrono
    // Communauté (plus tard) : tout est privé par défaut, « public » seulement par choix explicite
    if (raw.visibility === 'public') out.visibility = 'public';

    // Programme
    if (raw.type === 'run') {
      const pr = raw.program;
      if (pr === true) out.program = { status: 'legacy' }; // classée plus bas selon l'ancienne règle
      else if (pr && typeof pr === 'object' && PROGRAM_STATUSES.includes(pr.status)) {
        out.program = { status: pr.status };
        for (const k of ['step', 'intervalsDone', 'intervalsPlanned']) { const v = Math.round(num(pr[k])); if (inRange(v, [0, 100])) out.program[k] = v; }
        const rp = secs(pr.runPlannedSec); if (rp !== null) out.program.runPlannedSec = rp;
        const pm = Math.round(num(pr.plannedMin)); if (inRange(pm, LIMITS.duration)) out.program.plannedMin = pm;
      }
    }
    return out;
  }

  // Accepte une sauvegarde (v1 = format brut, v2 et v3 = formats versionnés),
  // la vérifie champ par champ et renvoie des données propres au format v3 + un rapport.
  // Lève une erreur (message en français) si le fichier est inexploitable.
  function normalizeData(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Ce fichier ne contient pas de sauvegarde LEVEL UP.');
    let src, version;
    if (raw.schemaVersion !== undefined) {
      version = raw.schemaVersion;
      if (!Number.isInteger(version) || version < 2) throw new Error('Version de sauvegarde inconnue.');
      if (version > SCHEMA_VERSION) throw new Error('Cette sauvegarde vient d\'une version plus récente de l\'application. Mets l\'application à jour avant de l\'importer.');
      src = raw.data;
    } else {
      version = 1;
      src = raw;
    }
    if (!src || typeof src !== 'object' || (!src.profile && !Array.isArray(src.sessions) && !Array.isArray(src.weights)))
      throw new Error('Aucune donnée LEVEL UP reconnue dans ce fichier.');

    const report = { version, sessions: 0, weights: 0, droppedSessions: 0, droppedWeights: 0, historique: 0, interrompues: 0 };
    const profile = normProfile(src.profile);

    const sessions = [], seen = new Set();
    (Array.isArray(src.sessions) ? src.sessions : []).forEach((s, i) => {
      const n = normSession(s, i);
      if (!n) { report.droppedSessions++; return; }
      if (!n.id || seen.has(n.id)) n.id = newId() + i;
      seen.add(n.id);
      sessions.push(n);
    });

    // Anciennes séances du programme (case cochée) : classées « historique »
    // ou « interrompue » en rejouant l'ancienne règle, dans l'ordre des dates.
    if (sessions.some(s => s.program && s.program.status === 'legacy')) {
      const copies = sessions.map(s => ({ ...s })).sort(bySessionOrder);
      replayProgram(copies);
      const statusOf = new Map(copies.filter(c => c.program).map(c => [c.id, c.program.status]));
      for (const s of sessions) {
        if (!s.program || s.program.status !== 'legacy') continue;
        s.program = { status: statusOf.get(s.id) };
        if (s.program.status === 'historique') report.historique++; else report.interrompues++;
      }
    }

    const byDate = new Map();
    (Array.isArray(src.weights) ? src.weights : []).forEach(w => {
      const kg = round(num(w && w.kg), 1);
      if (!w || !isValidISO(w.date) || !inRange(kg, LIMITS.weight)) { report.droppedWeights++; return; }
      byDate.set(w.date, { date: w.date, kg }); // une seule pesée par jour : la dernière gagne
    });
    const weights = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Pas quotidiens (Apple Santé / podomètre, plus tard) : mesures réelles uniquement
    const daily = new Map();
    (Array.isArray(src.dailySteps) ? src.dailySteps : []).forEach(x => {
      if (!x || !isValidISO(x.date) || !STEP_SOURCES.includes(x.source)) return;
      const c = Math.round(num(x.count));
      if (inRange(c, LIMITS.steps)) daily.set(x.date, { date: x.date, count: c, source: x.source });
    });
    const dailySteps = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));

    const profileOk = !profileError(profile);
    const onboarded = profileOk && (src.onboarded === undefined ? true : !!src.onboarded);
    report.sessions = sessions.length;
    report.weights = weights.length;
    const adjustments = normAdjustments(src.adjustments);
    return { data: { profile, onboarded, sessions, weights, dailySteps, adjustments }, report };
  }

  function serialize(data) {
    return JSON.stringify({ app: 'levelup', schemaVersion: SCHEMA_VERSION, savedAt: new Date().toISOString(), data });
  }

  // ---------- 7. Chronomètre ----------
  // Basé sur l'horloge (Date.now) et non sur le nombre de "tics" :
  // même si le navigateur ralentit ou suspend les timers en arrière-plan,
  // le temps affiché au retour est exact.
  //   startedAt   : début de la séance (dans le futur pendant le compte à rebours)
  //   countdownMs : durée du compte à rebours (informatif)
  //   pausedAt    : début de la pause en cours (ou null)
  //   pausedMs    : total des pauses terminées
  //   skipMs      : temps de phases sautées (avance le chrono, PAS l'effort réel)
  //   skipped     : détail du temps sauté par phase { indexDePhase: ms }
  function createTimer(segs, now, opts = {}) {
    const countdownMs = Math.max(0, Math.round((opts.countdownSec || 0) * 1000));
    return {
      segs: segs.map(s => ({ kind: s.kind, label: s.label, sec: Math.max(1, Math.round(s.sec)) })),
      startedAt: now + countdownMs, countdownMs, pausedAt: null, pausedMs: 0, skipMs: 0, skipped: {},
    };
  }

  const timerTotalMs = t => t.segs.reduce((a, s) => a + s.sec * 1000, 0);
  // Temps d'effort brut (peut dépasser la fin si l'app est restée fermée longtemps)
  const timerActiveMs = (t, now) => Math.max(0, (t.pausedAt !== null ? t.pausedAt : now) - t.startedAt - t.pausedMs);

  function timerState(t, now) {
    const totalMs = timerTotalMs(t);
    const ref = t.pausedAt !== null ? t.pausedAt : now;
    const countdown = ref < t.startedAt;
    const countdownLeftMs = countdown ? t.startedAt - ref : 0;
    const raw = timerActiveMs(t, now);
    const pos = Math.min(totalMs, raw + t.skipMs);
    // Une fois la séance finie, l'effort s'arrête à la fin de la dernière phase
    const activeMs = Math.min(raw, Math.max(0, totalMs - t.skipMs));
    const skipped = t.skipped || {};
    let acc = 0, idx = 0, runsDone = 0;
    while (idx < t.segs.length && pos >= acc + t.segs[idx].sec * 1000) {
      const seg = t.segs[idx], len = seg.sec * 1000;
      // Un intervalle sauté (plus de 10 % non fait) ne compte pas comme terminé
      if (seg.kind === 'run' && (skipped[idx] || 0) <= len * 0.1) runsDone++;
      acc += len;
      idx++;
    }
    const done = idx >= t.segs.length;
    const leftMs = done ? 0 : t.segs[idx].sec * 1000 - (pos - acc);
    return {
      idx, done, paused: t.pausedAt !== null, countdown,
      countdownLeftMs, countdownSec: Math.ceil(countdownLeftMs / 1000),
      leftMs, leftSec: Math.ceil(leftMs / 1000),
      activeMs, positionMs: pos, totalMs,
      runsDone, runsTotal: t.segs.filter(s => s.kind === 'run').length,
    };
  }

  function timerPause(t, now) {
    if (t.pausedAt !== null) return t;
    // Séance libre : une pause termine la période de course continue en cours
    if (t.mode === 'free' && now >= t.startedAt) {
      const from = Number.isFinite(t.stretchStart) ? t.stretchStart : t.startedAt;
      t.longestMs = Math.max(t.longestMs || 0, now - from);
    }
    t.pausedAt = now;
    return t;
  }
  function timerResume(t, now) {
    if (t.pausedAt === null) return t;
    // Pause pendant le compte à rebours : on décale simplement le départ
    if (t.pausedAt < t.startedAt) t.startedAt += now - t.pausedAt;
    else {
      t.pausedMs += now - t.pausedAt;
      if (t.mode === 'free') t.stretchStart = now; // nouvelle période de course continue
    }
    t.pausedAt = null;
    return t;
  }
  // Démarrer tout de suite (passer le compte à rebours)
  function timerStartNow(t, now) {
    if (now < t.startedAt) { t.startedAt = now; if (t.pausedAt !== null) t.pausedAt = now; }
    return t;
  }
  function timerSkip(t, now) {
    const st = timerState(t, now);
    if (st.done || st.countdown) return t;
    t.skipped = t.skipped || {};
    t.skipped[st.idx] = (t.skipped[st.idx] || 0) + st.leftMs;
    t.skipMs += st.leftMs;
    return t;
  }
  // Durée réellement passée à faire l'effort, en minutes (pauses et phases sautées exclues)
  const timerMinutes = (t, now) => Math.round(timerState(t, now).activeMs / 60000);

  // Bilan de fin de séance : ce qui a VRAIMENT été couru et marché.
  // Séance complète = CHAQUE intervalle de course fait à 90 % au moins (la marche peut être raccourcie).
  function timerSummary(t, now) {
    const st = timerState(t, now), skipped = t.skipped || {};
    let start = 0, runMs = 0, walkMs = 0, plannedRunMs = 0, plannedWalkMs = 0, longestRunMs = 0;
    const intervals = [];
    t.segs.forEach((s, i) => {
      const len = s.sec * 1000;
      const covered = Math.min(len, Math.max(0, st.positionMs - start));
      const did = covered - Math.min(covered, skipped[i] || 0);
      if (s.kind === 'run') { runMs += did; plannedRunMs += len; longestRunMs = Math.max(longestRunMs, did); intervals.push({ plannedMs: len, didMs: did }); }
      else { walkMs += did; plannedWalkMs += len; }
      start += len;
    });
    const okCount = intervals.filter(i => i.didMs >= i.plannedMs * INTERVAL_RATIO).length;
    const intervalsOk = intervals.length > 0 && okCount === intervals.length;
    return {
      activeMs: st.activeMs, runMs, walkMs, plannedRunMs, plannedWalkMs, longestRunMs, intervals,
      runsDone: okCount, runsTotal: intervals.length, skippedMs: t.skipMs, done: st.done,
      intervalsOk, complete: intervalsOk,
    };
  }

  function isValidTimer(t) {
    return !!t && typeof t === 'object' && Array.isArray(t.segs) && t.segs.length > 0 &&
      t.segs.every(s => s && (s.kind === 'run' || s.kind === 'walk') && s.sec > 0) &&
      [t.startedAt, t.pausedMs, t.skipMs].every(Number.isFinite) && (t.pausedAt === null || Number.isFinite(t.pausedAt)) &&
      (t.skipped === undefined || (typeof t.skipped === 'object' && t.skipped !== null));
  }

  // ---------- 8. Assistant de course : annonces et alertes ----------
  // Nom affiché de la phase : marche, course ou récupération (marche entre deux courses)
  function phaseName(seg) {
    if (seg.kind === 'run') return 'COURS';
    return seg.label === 'Marche' ? 'RÉCUPÉRATION' : 'MARCHE';
  }

  function spokenDuration(sec) {
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    if (!m) return `${s} secondes`;
    const mm = m === 1 ? '1 minute' : `${m} minutes`;
    return s ? `${mm} ${s}` : mm;
  }

  const CUES = { ready: 'Prépare-toi.', done: 'Séance terminée. Bravo !', paused: 'Pause.', resumed: 'C\'est reparti.' };

  function phaseCue(seg) {
    const d = spokenDuration(seg.sec);
    if (seg.kind === 'run') return `Commence à courir. ${d}.`;
    if (seg.label === 'Échauffement') return `Échauffement. Marche ${d}.`;
    if (seg.label === 'Retour au calme') return `Retour au calme. Marche ${d}.`;
    return `Marche. Récupération ${d}.`;
  }

  function warnCue(next, sec = 10) {
    if (!next) return `Dans ${sec} secondes : fin de la séance.`;
    return `Dans ${sec} secondes : ${next.kind === 'run' ? 'course' : 'marche'}.`;
  }

  // Repères de ce qui a déjà été annoncé (pour ne jamais répéter une annonce)
  const initialMarks = () => ({ idx: -1, count: null, warned: -1 });

  // Annonce manquée pendant que l'app était suspendue (iPhone verrouillé, autre app) :
  // si son échéance est passée depuis plus de LATE_MS, elle est marquée « late »
  // et l'app ne la joue PAS (pas d'annonce en retard, pas de rafale au déverrouillage).
  // Le calcul du temps, lui, reste exact. La prochaine échéance normale sera annoncée.
  const LATE_MS = 3000;

  // Calcule les événements à déclencher depuis le dernier passage :
  //   countdown (chaque seconde du compte à rebours), phase (nouvelle phase),
  //   warn (alerte avant changement), catchup (phases passées en arrière-plan), done (fin)
  function timerCues(t, marks, now, warnSec = 10) {
    const st = timerState(t, now), events = [], m = { ...marks };
    if (st.countdown) {
      if (m.count !== st.countdownSec) { m.count = st.countdownSec; events.push({ type: 'countdown', n: st.countdownSec }); }
      return { st, events, marks: m };
    }
    if (st.done) {
      if (m.idx !== 'done') {
        if (typeof m.idx === 'number' && m.idx >= 0 && t.segs.length - m.idx > 1) events.push({ type: 'catchup', jumped: t.segs.length - m.idx });
        m.idx = 'done';
        // Fin atteinte pendant la suspension : le bilan s'affiche, sans annonce tardive
        const overMs = timerActiveMs(t, now) + t.skipMs - st.totalMs;
        events.push({ type: 'done', late: overMs > LATE_MS });
      }
      return { st, events, marks: m };
    }
    if (st.idx !== m.idx) {
      if (typeof m.idx === 'number' && m.idx >= 0 && st.idx - m.idx > 1) events.push({ type: 'catchup', jumped: st.idx - m.idx });
      m.idx = st.idx;
      // Phase commencée depuis plus de 3 s (app suspendue) : pas d'annonce tardive
      const intoPhaseMs = t.segs[st.idx].sec * 1000 - st.leftMs;
      events.push({ type: 'phase', idx: st.idx, seg: t.segs[st.idx], next: t.segs[st.idx + 1] || null, late: intoPhaseMs > LATE_MS });
      if (warnSec > 0 && st.leftMs <= warnSec * 1000) m.warned = st.idx; // trop tard pour prévenir
    }
    if (warnSec > 0 && !st.paused && m.warned !== st.idx && st.leftMs <= warnSec * 1000 && t.segs[st.idx].sec > warnSec + 5) {
      m.warned = st.idx;
      // « Dans 10 secondes » n'est dit que s'il reste vraiment environ 10 secondes
      if (st.leftMs > warnSec * 1000 - LATE_MS) events.push({ type: 'warn', idx: st.idx, next: t.segs[st.idx + 1] || null });
    }
    return { st, events, marks: m };
  }

  // Repères pour un chrono restauré : on n'annonce pas à nouveau le passé
  function resumeMarks(t, now, warnSec = 10) {
    const st = timerState(t, now);
    if (st.countdown) return { idx: -1, count: st.countdownSec, warned: -1 };
    if (st.done) return { idx: 'done', count: 0, warned: -1 };
    return { idx: st.idx, count: 0, warned: warnSec > 0 && st.leftMs <= warnSec * 1000 ? st.idx : -1 };
  }

  // Réglages de l'assistant (stockés sur l'appareil, hors sauvegarde)
  const DEFAULT_SETTINGS = { voice: true, voiceVolume: 1, voiceName: '', voiceURI: '', voiceRate: 1, sounds: true, vibration: true, warn10: true, countdown: true };
  const VOICE_RATE = [0.7, 1.3]; // vitesse de parole autorisée (1 = normale)
  function normSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = { ...DEFAULT_SETTINGS };
    for (const k of ['voice', 'sounds', 'vibration', 'warn10', 'countdown']) if (typeof r[k] === 'boolean') out[k] = r[k];
    const v = num(r.voiceVolume);
    if (inRange(v, [0.1, 1])) out.voiceVolume = round(v, 1);
    if (typeof r.voiceName === 'string') out.voiceName = r.voiceName.slice(0, 100);
    if (typeof r.voiceURI === 'string') out.voiceURI = r.voiceURI.slice(0, 200);
    const rate = num(r.voiceRate);
    if (inRange(rate, VOICE_RATE)) out.voiceRate = round(rate, 2);
    return out;
  }

  // ----- Voix du coach -----
  // Les voix viennent du système (Safari iOS : celles installées dans Réglages › Accessibilité ›
  // Contenu énoncé › Voix). Aucune n'est supposée présente. iOS n'indique pas si une voix
  // est féminine ou masculine : on affiche le nom, la région, et on laisse écouter.
  const isFrench = v => !!v && /^fr([-_]|$)/i.test(v.lang || '');
  const REGIONS = { FR: 'France', CA: 'Canada', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg' };

  function frenchVoicesOf(voices) {
    const seen = new Set();
    return (voices || []).filter(isFrench).filter(v => {
      const key = v.voiceURI || v.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => (/fr[-_]FR/i.test(b.lang) - /fr[-_]FR/i.test(a.lang)) || String(a.name).localeCompare(String(b.name), 'fr'));
  }

  function describeVoice(v) {
    const region = REGIONS[String(v.lang || '').split(/[-_]/)[1]?.toUpperCase()] || 'Français';
    const quality = /enhanced|premium|améliorée|siri/i.test(`${v.name} ${v.voiceURI || ''}`) ? 'qualité supérieure' : '';
    const name = String(v.name || 'Voix').replace(/\s*\((enhanced|premium|améliorée)\)/i, '').trim();
    return { name, region, quality };
  }

  // Voix à utiliser : celle choisie si elle existe encore, sinon une voix française de secours.
  //   fallback = true si une voix avait été choisie mais n'est plus disponible
  function pickVoice(voices, s = {}) {
    const fr = frenchVoicesOf(voices);
    const wanted = s.voiceURI || s.voiceName;
    const chosen = wanted ? fr.find(v => (s.voiceURI && v.voiceURI === s.voiceURI) || (!s.voiceURI && v.name === s.voiceName)) : null;
    if (chosen) return { voice: chosen, fallback: false };
    const backup = fr.find(v => v.default) || fr.find(v => /fr[-_]FR/i.test(v.lang) && v.localService !== false) || fr.find(v => /fr[-_]FR/i.test(v.lang)) || fr[0] || null;
    return { voice: backup, fallback: !!wanted };
  }

  // ---------- 10. Séance libre (course ou marche, sans intervalles) ----------
  // Même principe que le chrono du programme : tout est calculé à partir de l'horloge,
  // donc juste même si l'app est suspendue, et l'état peut être restauré.
  // Une séance libre ne fait JAMAIS avancer le programme guidé (aucun champ « program »).
  //   longestMs / stretchStart : plus longue période de course SANS PAUSE (record de course continue)
  //   measured : distance mesurée automatiquement (GPS, plus tard). Absente aujourd'hui :
  //              la distance est saisie à la main dans le bilan.
  const FREE_MAX_MS = LIMITS.duration[1] * 60000;   // 10 h : au-delà, le chrono a sûrement été oublié
  const FREE_MILESTONE_MIN = 5;                      // annonce vocale toutes les 5 minutes

  function createFreeTimer(kind, now, opts = {}) {
    const countdownMs = Math.max(0, Math.round((opts.countdownSec || 0) * 1000));
    return {
      mode: 'free', kind: kind === 'walk' ? 'walk' : 'run',
      startedAt: now + countdownMs, countdownMs, pausedAt: null, pausedMs: 0, skipMs: 0,
      longestMs: 0, stretchStart: null,
    };
  }

  function freeState(t, now) {
    const ref = t.pausedAt !== null ? t.pausedAt : now;
    const countdown = ref < t.startedAt;
    const countdownLeftMs = countdown ? t.startedAt - ref : 0;
    const raw = timerActiveMs(t, now);
    const activeMs = Math.min(raw, FREE_MAX_MS);
    const from = Number.isFinite(t.stretchStart) ? t.stretchStart : t.startedAt;
    const stretch = countdown || t.pausedAt !== null ? 0 : Math.max(0, now - from);
    return {
      countdown, countdownLeftMs, countdownSec: Math.ceil(countdownLeftMs / 1000),
      paused: t.pausedAt !== null, activeMs, capped: raw >= FREE_MAX_MS,
      pausedMs: t.pausedMs, longestMs: Math.min(activeMs, Math.max(t.longestMs || 0, stretch)),
    };
  }

  // Annonces : compte à rebours, départ, puis toutes les 5 minutes
  const freeInitialMarks = () => ({ count: null, started: false, milestone: 0 });
  function freeCues(t, marks, now, everyMin = FREE_MILESTONE_MIN) {
    const st = freeState(t, now), events = [], m = { ...marks };
    if (st.countdown) {
      if (m.count !== st.countdownSec) { m.count = st.countdownSec; events.push({ type: 'countdown', n: st.countdownSec }); }
      return { st, events, marks: m };
    }
    if (!m.started) { m.started = true; events.push({ type: 'start', late: st.activeMs > LATE_MS }); }
    const reached = everyMin > 0 ? Math.floor(st.activeMs / (everyMin * 60000)) : 0;
    if (reached > m.milestone) {
      // Palier franchi pendant la suspension (ex. 5 min, déverrouillage à 8 min) :
      // marqué « late » et jamais annoncé ; le prochain palier (10 min) le sera normalement.
      m.milestone = reached;
      const sinceMs = st.activeMs - reached * everyMin * 60000;
      events.push({ type: 'milestone', minutes: reached * everyMin, late: sinceMs > LATE_MS });
    }
    if (st.capped) events.push({ type: 'capped' });
    return { st, events, marks: m };
  }
  function freeResumeMarks(t, now, everyMin = FREE_MILESTONE_MIN) {
    const st = freeState(t, now);
    return { count: st.countdownSec, started: !st.countdown, milestone: everyMin > 0 ? Math.floor(st.activeMs / (everyMin * 60000)) : 0 };
  }

  // Construit la séance à enregistrer à partir du chrono libre.
  //   opts.duration : durée corrigée (si le chrono a été oublié) — peut être RÉDUITE, jamais augmentée
  //   opts.km       : distance saisie à la main
  //   opts.measured : distance mesurée automatiquement ({ km, source: 'gps' }) — prioritaire
  function freeSessionEntry(t, endAt, opts = {}) {
    const st = freeState(t, endAt);
    const measuredMin = Math.max(1, Math.round(st.activeMs / 60000));
    const wanted = Math.round(num(opts.duration));
    const duration = Number.isFinite(wanted) && wanted >= 1 ? Math.min(measuredMin, wanted) : measuredMin;
    const activeSec = Math.min(Math.round(st.activeMs / 1000), duration * 60);
    const pausedSec = Math.round(st.pausedMs / 1000);
    const timing = t.kind === 'run'
      ? { activeSec, runSec: activeSec, walkSec: 0, maxRunSec: Math.min(Math.round(st.longestMs / 1000), activeSec), pausedSec }
      : { activeSec, runSec: 0, walkSec: activeSec, pausedSec };
    const startMs = Math.min(t.startedAt, endAt);
    const entry = {
      type: t.kind, mode: 'libre', date: toISO(new Date(startMs)), duration,
      feel: inRange(Math.round(num(opts.feel)), [1, 4]) ? Math.round(num(opts.feel)) : 2,
      startedAt: new Date(startMs).toISOString(), endedAt: new Date(endAt).toISOString(), timing,
    };
    // Distance : la mesure automatique fait foi ; une saisie différente est gardée comme correction
    const km = round(num(opts.km), 2);
    const m = opts.measured && Number.isFinite(opts.measured.km) && opts.measured.km > 0 ? opts.measured : null;
    if (m && (!(km > 0) || km === round(m.km, 2))) entry.distance = { km: round(m.km, 2), source: DIST_SOURCES.includes(m.source) ? m.source : 'gps' };
    else if (m && km > 0) entry.distance = { km, source: 'manuel', measuredKm: round(m.km, 2), corrected: true };
    else if (km > 0) entry.distance = { km, source: 'manuel' };
    return entry;
  }

  const isValidFreeTimer = t => !!t && typeof t === 'object' && t.mode === 'free' && (t.kind === 'run' || t.kind === 'walk') &&
    [t.startedAt, t.pausedMs].every(Number.isFinite) && (t.pausedAt === null || Number.isFinite(t.pausedAt));

  // ---------- 11. Statistiques avancées ----------
  // Tout est recalculé à partir des séances et des pesées : rien n'est stocké, rien n'est inventé.
  // « Mesuré » = chronomètre (temps) ou capteur (distance GPS / Santé / podomètre).
  const MEASURED_SOURCES = ['gps', 'sante', 'podometre'];
  const monthKey = iso => iso.slice(0, 7);
  const shiftMonth = (key, n) => {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const avg = list => (list.length ? list.reduce((a, x) => a + x, 0) / list.length : null);

  function statsReport(data, Dd, today = todayISO(), opts = {}) {
    const nWeeks = opts.weeks || 8, nMonths = opts.months || 6;
    const p = data.profile || {};
    const past = Dd.sessions.filter(s => s.date <= today);
    const bucket = key => ({ key, km: 0, minutes: 0, sessions: 0, days: new Set(), runSec: 0, walkSec: 0, maxRunSec: 0 });
    const add = (b, s) => {
      b.km = round(b.km + s.km, 2); b.minutes += s.duration; b.sessions++; b.days.add(s.date);
      if (s.timing) {
        b.runSec += s.timing.runSec || 0; b.walkSec += s.timing.walkSec || 0;
        if (s.type === 'run') b.maxRunSec = Math.max(b.maxRunSec, s.timing.maxRunSec || 0);
      }
    };
    const finish = b => ({ ...b, days: b.days.size });

    // Semaines (toutes, pour les records) et derniers mois
    const allWeeks = new Map();
    for (const s of past) { const k = weekKey(s.date); if (!allWeeks.has(k)) allWeeks.set(k, bucket(k)); add(allWeeks.get(k), s); }
    const cur = weekKey(today);
    const weeks = Array.from({ length: nWeeks }, (_, i) => shiftWeek(cur, i - nWeeks + 1)).map(k => finish(allWeeks.get(k) || bucket(k)));
    const curM = monthKey(today);
    const months = Array.from({ length: nMonths }, (_, i) => shiftMonth(curM, i - nMonths + 1)).map(k => {
      const b = bucket(k);
      past.filter(s => monthKey(s.date) === k).forEach(s => add(b, s));
      return finish(b);
    });

    // Totaux, en distinguant ce qui est mesuré de ce qui est saisi
    const totals = { km: 0, kmMeasured: 0, kmManual: 0, minutes: 0, sessions: past.length, runSec: 0, walkSec: 0, timedSessions: 0, activeDays: new Set() };
    for (const s of past) {
      totals.km = round(totals.km + s.km, 2);
      if (s.km > 0) {
        if (s.distance && MEASURED_SOURCES.includes(s.distance.source)) totals.kmMeasured = round(totals.kmMeasured + s.km, 2);
        else totals.kmManual = round(totals.kmManual + s.km, 2);
      }
      totals.minutes += s.duration;
      totals.activeDays.add(s.date);
      if (s.timing) { totals.timedSessions++; totals.runSec += s.timing.runSec || 0; totals.walkSec += s.timing.walkSec || 0; }
    }
    totals.activeDays = totals.activeDays.size;

    // Séances par type
    const types = { programme: 0, programmeValides: 0, courseLibre: 0, marcheLibre: 0, courseManuelle: 0, marcheManuelle: 0, muscu: 0 };
    for (const s of past) {
      if (s.prog) { types.programme++; if (s.prog.valid) types.programmeValides++; }
      else if (s.mode === 'libre') types[s.type === 'run' ? 'courseLibre' : 'marcheLibre']++;
      else if (s.type === 'run') types.courseManuelle++;
      else if (s.type === 'walk') types.marcheManuelle++;
      else types.muscu++;
    }

    // Records personnels (mesuré ou saisi, toujours indiqué)
    const records = [];
    const maxBy = (list, f) => list.reduce((best, x) => (f(x) > (best ? f(best) : 0) ? x : best), null);
    const far = maxBy(past.filter(s => s.km > 0), s => s.km);
    if (far) records.push({ id: 'distance', icon: '🛣️', label: 'Plus longue distance', value: far.km, unit: 'km', date: far.date, measured: !!(far.distance && MEASURED_SOURCES.includes(far.distance.source)) });
    if (Dd.records.maxRun > 0) records.push({ id: 'run', icon: '🏃', label: 'Course continue', value: Dd.records.maxRun, unit: 'min', date: Dd.records.maxRunDate, measured: true });
    const long = maxBy(past.filter(s => s.timing && s.timing.activeSec), s => s.timing.activeSec);
    if (long) records.push({ id: 'long', icon: '⏱️', label: 'Plus longue séance chronométrée', value: round(long.timing.activeSec / 60, 0), unit: 'min', date: long.date, measured: true });
    const wl = [...allWeeks.values()].map(finish);
    const bestKm = maxBy(wl.filter(w => w.km > 0), w => w.km);
    if (bestKm) records.push({ id: 'week-km', icon: '📈', label: 'Meilleure semaine (distance)', value: bestKm.km, unit: 'km', date: bestKm.key, week: true, measured: false });
    const bestDays = maxBy(wl, w => w.days);
    if (bestDays) records.push({ id: 'week-days', icon: '📅', label: 'Semaine la plus active', value: bestDays.days, unit: 'jours', date: bestDays.key, week: true, measured: false });

    // Comparaison avec la semaine précédente
    const thisW = weeks[weeks.length - 1], lastW = weeks[weeks.length - 2] || bucket('');
    const compare = ['km', 'minutes', 'days', 'sessions'].map(k => ({ key: k, now: thisW[k], before: lastW[k], diff: round((thisW[k] || 0) - (lastW[k] || 0), 2) }));

    // Poids : courbe réelle, moyenne mobile 7 jours, évolution, objectifs
    const ws = Dd.stats.sortedW;
    const movingAvg = ws.map(w => {
      const from = addDays(w.date, -6);
      return { date: w.date, kg: round(avg(ws.filter(x => x.date >= from && x.date <= w.date).map(x => x.kg)), 1) };
    });
    const change = (keyOf, shift) => {
      if (!ws.length) return null;
      const lastKey = keyOf(ws[ws.length - 1].date), prevKey = shift(lastKey, -1);
      const a = avg(ws.filter(w => keyOf(w.date) === lastKey).map(w => w.kg));
      const b = avg(ws.filter(w => keyOf(w.date) === prevKey).map(w => w.kg));
      return b === null ? null : { key: lastKey, diff: round(a - b, 1) };
    };
    const current = Dd.stats.current;
    const goal = (target, label) => {
      if (!(p.startWeight > 0) || !(target > 0) || target >= p.startWeight) return null;
      const total = round(p.startWeight - target, 1), done = round(Math.max(0, p.startWeight - current), 1);
      return { label, target, total, done, left: round(Math.max(0, current - target), 1), pct: Math.min(1, done / total), reached: Dd.stats.maxLost >= total };
    };
    const weight = {
      points: ws, movingAvg,
      weekChange: change(weekKey, shiftWeek), monthChange: change(monthKey, shiftMonth),
      goals: [goal(p.goalWeight, 'Objectif principal'), goal(p.bonusGoal, 'Objectif bonus')].filter(Boolean),
    };

    return { weeks, months, totals, types, records, compare, weight };
  }

  // ---------- 12. Journal de quêtes : calcul ----------
  const maxDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

  // Quête du jour, décidée UNIQUEMENT avec les séances des jours précédents (résultat stable).
  //  - Jour de récupération (lendemain d'une course, 2 jours après une course très difficile) :
  //    marche douce de 15 min. Une course ce jour-là ne valide PAS la quête.
  //  - Autre jour : bouger 20 min (30 min après 12 séances du programme), à pied, en courant ou en muscu.
  //  - Rien n'est jamais imposé : sans séance, pas de récompense et pas de pénalité.
  function dailyQuestFor(date, sessions) {
    const before = sessions.filter(s => s.date < date);
    const lastRun = [...before].reverse().find(s => s.type === 'run');
    // Mêmes règles que le coach : lendemain d'une course (2 jours après « Très difficile »),
    // ou programme de la semaine déjà bouclé (3 séances validées ou déclarées).
    const restAfterRun = !!lastRun && daysBetween(lastRun.date, date) <= restDaysAfter(lastRun);
    const programWeekDone = before.filter(s => weekKey(s.date) === weekKey(date) && s.prog && s.prog.valid).length >= WEEKLY_TARGET;
    if (restAfterRun || programWeekDone) return {
      kind: 'recovery', reason: restAfterRun ? 'apres-course' : 'semaine-bouclee', name: 'Marche douce',
      desc: 'Une marche tranquille d\'au moins 15 min. Le repos complet est aussi un bon choix (sans XP, sans pénalité).', minutes: 15, types: ['walk'],
    };
    const progDone = before.filter(s => s.prog && s.prog.valid).length;
    const minutes = progDone >= 12 ? 30 : 20;
    return { kind: 'active', name: `Bouger ${minutes} minutes`, desc: `Séance du programme, course libre, marche ou musculation : au moins ${minutes} min, comme tu le sens.`, minutes, types: ['walk', 'run', 'strength'] };
  }
  const dailyProgress = (q, daySessions) => {
    const ok = daySessions.filter(s => q.types.includes(s.type));
    const best = ok.reduce((m, s) => Math.max(m, s.duration), 0);
    const hit = ok.find(s => s.duration >= q.minutes);
    return { value: Math.min(best, q.minutes), target: q.minutes, done: hit ? hit.date : null, ref: hit ? hit.id : null };
  };

  // Quêtes de la semaine, adaptées au niveau à partir des semaines PRÉCÉDENTES uniquement.
  function weeklyQuestsFor(wk, sessions, programDone) {
    const before = sessions.filter(s => weekKey(s.date) < wk);
    const days = new Map();
    for (const s of before) { const k = weekKey(s.date); if (!days.has(k)) days.set(k, new Set()); days.get(k).add(s.date); }
    const beginner = ![...days.values()].some(set => set.size >= WEEKLY_TARGET); // jamais eu de semaine à 3 jours actifs
    const prev = [1, 2, 3, 4].map(i => shiftWeek(wk, -i));
    const avgKm = prev.reduce((a, k) => a + before.filter(s => weekKey(s.date) === k).reduce((b, s) => b + s.km, 0), 0) / 4;
    const kmTarget = avgKm > 0 ? Math.max(2, round(avgKm * 1.1, 1)) : 3; // jamais plus de 10 % au-dessus de la moyenne récente
    // Pas de doublon avec l'objectif hebdo existant (3 jours actifs = +200 XP) :
    // débutant → 2 jours ; ensuite → une vraie marche de 30 min (la marche est valorisée).
    const list = [
      beginner
        ? { id: 'days', name: 'Deux jours en mouvement', desc: 'Sois actif 2 jours différents cette semaine', target: 2 }
        : { id: 'walk', name: 'La grande marche', desc: "Fais une marche d'au moins 30 min cette semaine", target: 1 },
      { id: 'km', name: 'La route de la semaine', desc: `Parcours ${String(kmTarget).replace('.', ',')} km cette semaine (marche ou course)`, target: kmTarget },
    ];
    if (!programDone) list.push({ id: 'prog', name: 'Fidèle au programme', desc: 'Valide ou déclare une séance du programme guidé', target: 1 });
    return list;
  }

  function deriveQuests(data, Dd, today = todayISO()) {
    const ledger = [];
    const past = Dd.sessions.filter(s => s.date <= today);
    const qd = Dd.questDates || {};

    // Quêtes principales : un chapitre s'ouvre quand le précédent est terminé.
    // Une quête déjà accomplie avant l'ouverture de son chapitre est validée à l'ouverture.
    let openAt = null, prevDone = true;
    const chapters = CHAPTERS.map((ch, ci) => {
      const locked = !prevDone;
      const quests = ch.quests.map(q => {
        const pr = badgeProgress(q, Dd.snap);
        const done = !locked && qd[q.id] ? maxDate(qd[q.id], openAt) : null;
        if (done) ledger.push({ key: `qm:${q.id}`, date: done, amount: QUEST_XP.main, label: `📜 Quête : ${q.name}`, qtype: 'main' });
        return { id: q.id, name: q.name, desc: q.desc, run: !!q.run, ...pr, done };
      });
      const done = !locked && quests.every(q => q.done) ? quests.reduce((d, q) => maxDate(d, q.done), null) : null;
      if (done) ledger.push({ key: `qc:${ch.id}`, date: done, amount: QUEST_XP.chapter, label: `🏰 Chapitre terminé : ${ch.title}`, qtype: 'chapter' });
      const out = { id: ch.id, n: ci + 1, title: ch.title, lore: ch.lore, locked, openedAt: locked ? null : openAt, done, quests };
      prevDone = !!done;
      openAt = done;
      return out;
    });

    // Quêtes épiques
    const epics = EPICS.map(q => {
      const pr = badgeProgress(q, Dd.snap);
      const done = qd[q.id] || null;
      if (done) ledger.push({ key: `qe:${q.id}`, date: done, amount: QUEST_XP.epic, label: `🐉 Quête épique : ${q.name}`, qtype: 'epic' });
      const meta = q.id === 'e10k' && Dd.questMeta && Dd.questMeta.e10k ? Dd.questMeta.e10k : null;
      return { id: q.id, name: q.name, desc: q.desc, run: !!q.run, ...pr, done, meta };
    });

    // Quêtes du jour : chaque jour où une séance a eu lieu, plus aujourd'hui (affichage)
    const dates = [...new Set(past.map(s => s.date))];
    if (!dates.includes(today)) dates.push(today);
    let todayQuest = null;
    for (const date of dates.sort()) {
      const q = dailyQuestFor(date, past);
      const pr = dailyProgress(q, past.filter(s => s.date === date));
      if (pr.done) ledger.push({ key: `qd:${date}`, date, amount: QUEST_XP.daily, label: `☀️ Quête du jour : ${q.name}`, qtype: 'daily', ref: pr.ref });
      if (date === today) todayQuest = { ...q, ...pr, date };
    }

    // Quêtes de la semaine : de la première semaine active jusqu'à la semaine en cours
    const programDone = programSession(Dd.programStep).done;
    let thisWeek = [];
    {
      const first = past.length ? weekKey(past[0].date) : weekKey(today);
      for (let wk = first; wk <= weekKey(today); wk = shiftWeek(wk, 1)) {
        const list = weeklyQuestsFor(wk, past, programDone);
        const week = past.filter(s => weekKey(s.date) === wk);
        const days = new Set(); let km = 0, prog = 0, walk = 0;
        const doneAt = {};
        for (const s of week) {
          days.add(s.date); km = round(km + s.km, 2); if (s.prog && s.prog.valid) prog++;
          if (s.type === 'walk' && s.duration >= 30) walk++;
          const val = { days: days.size, km, prog, walk };
          for (const q of list) if (!doneAt[q.id] && val[q.id] >= q.target) doneAt[q.id] = s.date;
        }
        const val = { days: days.size, km, prog, walk };
        const res = list.map(q => ({ ...q, value: round(Math.min(val[q.id], q.target), 1), done: doneAt[q.id] || null }));
        for (const q of res) if (q.done) ledger.push({ key: `qw:${wk}:${q.id}`, date: q.done, amount: QUEST_XP.weekly, label: `🗓️ Quête de la semaine : ${q.name}`, qtype: 'weekly' });
        if (wk === weekKey(today)) thisWeek = res;
      }
    }

    ledger.sort((a, b) => a.date.localeCompare(b.date));
    const xp = ledger.reduce((a, e) => a + e.amount, 0);
    return { ledger, xp, chapters, epics, today: todayQuest, week: thisWeek, history: [...ledger].reverse() };
  }

  // État complet du jeu = activité (derive, inchangé) + quêtes.
  // L'XP d'activité et l'XP de quête restent séparées ; le niveau utilise le total.
  function deriveGame(data, today = todayISO()) {
    const Dd = derive(data, today);
    const Qd = deriveQuests(data, Dd, today);
    const ledger = [...Dd.ledger.map(e => ({ ...e })), ...Qd.ledger.map(e => ({ ...e }))]
      .sort((a, b) => a.date.localeCompare(b.date)); // tri stable : l'ordre d'une même journée est conservé
    const levelDates = {};
    let cum = 0, lv = 1;
    for (const e of ledger) {
      cum += e.amount;
      e.total = cum;
      while (lv < LEVELS.length && cum >= LEVELS[lv].xp) { levelDates[lv + 1] = e.date; lv++; }
    }
    return { ...Dd, activityXp: Dd.xp, questXp: Qd.xp, xp: cum, level: levelInfo(cum), ledger, levelDates, quests: Qd };
  }

  // ---------- 9. Coach adaptatif ----------
  // Le coach lit les données (ressenti, régularité, séances, récupération, endurance)
  // et PROPOSE. Il ne change jamais le programme tout seul au-delà des règles validées
  // (Difficile → on répète, 2 séances difficiles → un cran en arrière) : revenir en
  // arrière après une séance très difficile, des interruptions ou une longue pause
  // est une proposition que l'utilisateur accepte ou refuse (ajustement enregistré).
  const FEEL_LABELS = { 1: 'Facile', 2: 'Correct', 3: 'Difficile', 4: 'Très difficile' };
  const ADJ_KINDS = ['step-back', 'keep'];
  const ADJ_REASONS = ['tres-difficile', 'interruptions', 'reprise', 'manuel'];
  const LONG_BREAK_DAYS = 14;   // au-delà, le coach propose de reprendre un cran en dessous
  const restDaysAfter = run => (run.feel >= 4 ? 2 : 1); // jours sans course conseillés après une course

  function coachAdvice(data, Dd, today = todayISO()) {
    const p = data.profile || {}, st = Dd.stats;
    const past = Dd.sessions.filter(s => s.date <= today);
    const ps = programSession(Dd.programStep);
    const adjs = Dd.adjustments || [];
    // Un ajustement enregistré APRÈS cette séance ? (la proposition a déjà reçu une réponse)
    const answered = s => adjs.some(a => a.date > s.date || (a.date === s.date && (a.createdAt || 0) > (s.createdAt || 0)));

    const runs = past.filter(s => s.type === 'run');
    const lastRun = runs[runs.length - 1] || null;
    const progAll = past.filter(s => s.prog);
    const progDone = progAll.filter(s => s.prog.valid);
    const lastProg = progDone[progDone.length - 1] || null;
    const sinceRun = lastRun ? daysBetween(lastRun.date, today) : null;
    const sinceAny = past.length ? daysBetween(past[past.length - 1].date, today) : null;
    const wk = weekKey(today);
    const progThisWeek = progDone.filter(s => weekKey(s.date) === wk).length;
    const daysLeft = 7 - (parseISO(today).getDay() + 6) % 7; // aujourd'hui compris

    // --- Propositions (une seule à la fois) ---
    const proposals = [];
    const canGoBack = Dd.programStep > 0 && !ps.done;
    const back = reason => ({ reason, from: ps, to: programSession(Dd.programStep - 1) });
    if (canGoBack && lastProg && lastProg.feel >= 4 && lastProg.prog.adapt !== 'down' && !answered(lastProg)) {
      proposals.push({ ...back('tres-difficile'), text: 'Ta dernière séance était très difficile. Tu peux la refaire telle quelle, ou revenir un cran en arrière pour consolider.' });
    } else {
      const lastTwo = progAll.slice(-2);
      if (canGoBack && lastTwo.length === 2 && lastTwo.every(s => s.prog.status === 'interrompue' && !answered(s))) {
        proposals.push({ ...back('interruptions'), text: 'Tes deux dernières séances ont été interrompues. Revenir un cran en arrière peut t\'aider à repartir sur de bonnes bases.' });
      } else if (canGoBack && lastProg && daysBetween(lastProg.date, today) >= LONG_BREAK_DAYS && !answered(lastProg)) {
        proposals.push({ ...back('reprise'), text: `${daysBetween(lastProg.date, today)} jours depuis ta dernière séance du programme. Pour reprendre en douceur, tu peux revenir un cran en arrière.` });
      }
    }

    // --- Recommandation du jour ---
    let kind, title, text;
    const daysToStart = isValidISO(p.startDate) ? daysBetween(today, p.startDate) : 0;
    if (!past.length && daysToStart > 0) {
      kind = 'start'; title = 'Préparation';
      text = `Le défi démarre ${daysToStart === 1 ? 'demain' : `dans ${daysToStart} jours`}. Prépare tes baskets et fais ta première pesée pour fixer ton point de départ.`;
    } else if (!past.length) {
      kind = 'run'; title = `Première mission : S${ps.week} · Séance ${ps.session}`;
      text = `${ps.desc}. C'est volontairement facile : le but est de finir en te disant « j'aurais pu en faire plus ».`;
    } else if (sinceRun === 0) {
      kind = 'rest'; title = 'Séance du jour faite';
      text = 'Bravo ! Hydrate-toi et dors bien : c\'est pendant la récupération que le corps progresse.';
    } else if (sinceRun !== null && sinceRun <= restDaysAfter(lastRun)) {
      kind = 'recovery';
      title = lastRun.feel >= 4 ? 'Récupération : 2 jours sans course' : 'Jour de récupération';
      text = lastRun.feel >= 4
        ? 'Ta dernière course était très difficile. Repos, ou marche tranquille de 20 à 30 min si tu as envie de bouger.'
        : 'Un jour sans course entre deux séances limite le risque de blessure. Repos, ou marche légère si tu en as envie.';
    } else if (progThisWeek >= WEEKLY_TARGET) {
      kind = 'recovery'; title = 'Programme de la semaine bouclé 🔥';
      text = `${progThisWeek} séances du programme cette semaine : le reste est du bonus. Une marche tranquille, ou du repos.`;
    } else {
      kind = 'run';
      title = ps.done ? 'Séance d\'entretien' : `Jour de course : S${ps.week} · Séance ${ps.session}`;
      text = sinceAny !== null && sinceAny >= 7
        ? `${sinceAny} jours sans séance : on reprend tranquillement. ${ps.desc}, à ton rythme, sans chercher la performance.`
        : `${ps.desc}. Allure confortable : tu dois pouvoir parler en courant.`;
    }

    // --- Repères : niveau, régularité, endurance, programme ---
    const insights = [];
    const L = Dd.level;
    insights.push({ icon: '⭐', text: L.next ? `Niveau ${L.n} · ${L.title} : encore ${L.next.xp - Dd.xp} XP avant ${L.next.title}.` : `Niveau ${L.n} · ${L.title} : niveau maximum atteint !` });
    const left = Math.max(0, WEEKLY_TARGET - st.thisWeek);
    insights.push({
      icon: '📅',
      text: left === 0 ? `Objectif de la semaine atteint : ${st.thisWeek} jours actifs.`
        : left > daysLeft ? `Il manque ${left} jours actifs pour le bonus et il ne reste que ${daysLeft} jour${daysLeft > 1 ? 's' : ''} : pas grave, chaque séance compte.`
        : `Encore ${left} jour${left > 1 ? 's' : ''} actif${left > 1 ? 's' : ''} cette semaine pour le bonus de +${XP.weeklyGoal} XP.`,
    });
    if (st.streak >= 2) insights.push({ icon: '🔥', text: `${st.streak} semaines parfaites d'affilée. Continue !` });
    // Endurance : uniquement le temps de course MESURÉ par le chrono
    const measured = (from, to) => past.filter(s => s.date > from && s.date <= to && s.timing && Number.isFinite(s.timing.runSec)).reduce((a, s) => a + s.timing.runSec, 0);
    const d28 = addDays(today, -28), d56 = addDays(today, -56);
    const recent = measured(d28, today), before = measured(d56, d28);
    let trend = null;
    if (recent > 0) {
      trend = before > 0 ? Math.round((recent - before) / before * 100) : null;
      insights.push({
        icon: '🫁',
        text: `Endurance : ${Math.round(recent / 60)} min de course mesurée sur 4 semaines` +
          (trend === null ? '.' : trend >= 0 ? ` (+${trend} % par rapport aux 4 précédentes).` : ` (${trend} % : normal après une pause ou une semaine chargée).`) +
          (Dd.records.maxRun ? ` Record : ${String(Dd.records.maxRun).replace('.', ',')} min d'affilée.` : ''),
      });
    }
    insights.push({ icon: '🗺️', text: ps.done ? 'Programme terminé : 30 min de course continue. Bravo !' : `Programme : séance ${Math.min(Dd.programStep, PROGRAM_STEPS) + 1} sur ${PROGRAM_STEPS} (semaine ${ps.week}).` });

    return { kind, title, text, proposals, insights, sinceRun, sinceAny, progThisWeek, daysLeft, endurance: { recentSec: recent, beforeSec: before, trend } };
  }

  // Ajustements du programme acceptés ou refusés par l'utilisateur
  function normAdjustments(list) {
    const out = [], seen = new Set();
    (Array.isArray(list) ? list : []).forEach((a, i) => {
      if (!a || typeof a !== 'object' || !ADJ_KINDS.includes(a.kind) || !isValidISO(a.date)) return;
      let id = typeof a.id === 'string' && ID_RE.test(a.id) ? a.id : newId() + i;
      if (seen.has(id)) id = newId() + i;
      seen.add(id);
      const createdAt = Number.isFinite(num(a.createdAt)) ? num(a.createdAt) : i;
      const adj = { id, date: a.date, kind: a.kind, createdAt };
      if (ADJ_REASONS.includes(a.reason)) adj.reason = a.reason;
      out.push(adj);
    });
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  }

  return {
    QUEST_XP, CHAPTERS, EPICS, dailyQuestFor, weeklyQuestsFor, deriveQuests, deriveGame,
    BADGE_CATS, REWARDS, badgeProgress, statsReport, MEASURED_SOURCES, monthKey, shiftMonth,
    XP, WEEKLY_TARGET, LIMITS, LEVELS, PROGRAM, PROGRAM_STEPS, WARMUP, COOLDOWN, BADGES, HEALTHY_PACE, SCHEMA_VERSION, DAY,
    toISO, parseISO, todayISO, daysBetween, weekKey, shiftWeek, addDays, isValidISO, fmtMin,
    levelInfo, programSession, sessionXP, continuousRun, bestStreakOf, derive,
    PROGRAM_STATUSES, PROGRAM_LABELS, INTERVAL_RATIO, LEGACY_RATIO, DIST_SOURCES, STEP_SOURCES, MAX_SPEED,
    sessionKm, upgradeSession, replayProgram, distanceError, declarationError, editableFields, timerProgramStatus,
    profileError, suggestedEnd,
    newId, emptyData, normalizeData, serialize,
    createTimer, timerState, timerPause, timerResume, timerStartNow, timerSkip, timerMinutes, timerActiveMs, timerSummary, isValidTimer,
    FREE_MAX_MS, FREE_MILESTONE_MIN, createFreeTimer, freeState, freeCues, freeInitialMarks, freeResumeMarks, freeSessionEntry, isValidFreeTimer,
    FEEL_LABELS, ADJ_KINDS, ADJ_REASONS, LONG_BREAK_DAYS, restDaysAfter, coachAdvice, normAdjustments,
    LATE_MS, VOICE_RATE, frenchVoicesOf, describeVoice, pickVoice, phaseName, spokenDuration, phaseCue, warnCue, CUES, initialMarks, timerCues, resumeMarks, DEFAULT_SETTINGS, normSettings,
  };
});
