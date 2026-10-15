'use strict';
/* =========================================================
   LEVEL UP — app.js
   Affichage et interactions. Toute la logique de calcul
   (XP, records, succès, programme, chrono…) est dans core.js.

   1. Stockage, migration, copies de secours
   2. Recalcul et annonces (toasts, montée de niveau)
   3. Écrans
   4. Premier lancement
   5. Séances, pesées, import / export
   6. Chronomètre
   7. Navigation, événements, mise à jour PWA, démarrage
   ========================================================= */

const C = window.LevelCore;
const {
  XP, WEEKLY_TARGET, LEVELS, PROGRAM, PROGRAM_STEPS, WARMUP, COOLDOWN, BADGES, DAY, HEALTHY_PACE, LIMITS,
  toISO, parseISO, todayISO, daysBetween, weekKey, shiftWeek, fmtMin, programSession, profileError, suggestedEnd,
} = C;

const QUOTES = [
  'La régularité bat l\'intensité.',
  'Chaque séance est une pièce d\'XP dans ta tirelire.',
  'Lent, c\'est toujours plus rapide que le canapé.',
  'Tu n\'as pas besoin d\'être motivé, juste d\'enfiler tes baskets.',
  'Petit pas aujourd\'hui, grand niveau demain.',
  'Le meilleur entraînement, c\'est celui que tu fais.',
  'Tu ne te compares qu\'à toi d\'hier.',
];

// ---------- Petits outils d'affichage ----------
const $ = sel => document.querySelector(sel);
const fmtDate = iso => parseISO(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const fmtLongDate = iso => parseISO(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtNum = (n, d = 1) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d });
const fmtDuration = min => (min >= 60 ? `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}` : `${Math.round(min)} min`);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Lit un nombre saisi à la française (« 0,8 ») ou à l'anglaise (« 0.8 »)
const parseDec = v => parseFloat(String(v).trim().replace(/\s/g, '').replace(',', '.'));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 1. Stockage, migration, copies de secours ----------
const STORAGE_KEY = 'levelup-data';                       // format versionné (schemaVersion)
const LEGACY_KEYS = ['levelup-v1', 'levelup-75kg-v1'];    // anciennes versions, jamais effacées
const BACKUP_KEY = 'levelup-backup';                      // copie automatique avant import, migration ou remise à zéro
const TIMER_KEY = 'levelup-timer';                        // chrono en cours (survit à une fermeture de l'app)

// localStorage peut être indisponible (navigation privée, stockage plein) : on ne plante jamais
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

let startupNotice = null;
let needsSave = false;

function loadData() {
  const raw = storage.get(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const { data: d, report } = C.normalizeData(parsed);
      if (parsed.schemaVersion < C.SCHEMA_VERSION) {
        // Conversion vers le nouveau format : la version précédente est gardée intacte, à part
        const key = `levelup-avant-v${C.SCHEMA_VERSION}`;
        if (!storage.get(key)) storage.set(key, raw);
        storage.set(BACKUP_KEY, JSON.stringify({ reason: 'migration', savedAt: new Date().toISOString(), payload: raw }));
        needsSave = true;
        startupNotice = `Données converties au format v${C.SCHEMA_VERSION} : ${report.sessions} séance(s) conservée(s)` +
          (report.historique ? `, dont ${report.historique} validée(s) selon l'ancienne règle (« historique »)` : '') + '.';
      }
      return d;
    }
    catch (e) {
      // Données illisibles : on les met de côté au lieu de les écraser
      storage.set(`levelup-illisible-${Date.now()}`, raw);
      startupNotice = 'Tes données n\'ont pas pu être lues. Une copie a été mise de côté sur l\'appareil ; tu peux réimporter une sauvegarde.';
      return C.emptyData();
    }
  }
  // Migration depuis une ancienne version (l'ancienne clé reste intacte)
  for (const key of LEGACY_KEYS) {
    const old = storage.get(key);
    if (!old) continue;
    try {
      const { data: migrated, report } = C.normalizeData(JSON.parse(old));
      storage.set(BACKUP_KEY, JSON.stringify({ reason: 'migration', savedAt: new Date().toISOString(), payload: old }));
      needsSave = true;
      startupNotice = `Données converties au nouveau format : ${report.sessions} séance(s), ${report.weights} pesée(s).`;
      return migrated;
    } catch (e) { /* ancienne clé illisible : on essaie la suivante */ }
  }
  return C.emptyData();
}

let saveWarned = false;
function save() {
  const ok = storage.set(STORAGE_KEY, C.serialize(data));
  if (!ok && !saveWarned) toast('⚠️', 'Sauvegarde impossible sur cet appareil (stockage plein ou navigation privée). Exporte tes données.', 'badge');
  saveWarned = !ok;
  return ok;
}

// Copie de secours de l'état actuel (une seule, la plus récente)
function backup(reason) {
  if (!data.onboarded && !data.sessions.length && !data.weights.length) return;
  storage.set(BACKUP_KEY, JSON.stringify({ reason, savedAt: new Date().toISOString(), payload: C.serialize(data) }));
}
function readBackup() {
  try {
    const b = JSON.parse(storage.get(BACKUP_KEY));
    if (!b || typeof b.payload !== 'string') return null;
    return { ...b, parsed: C.normalizeData(JSON.parse(b.payload)) };
  } catch (e) { return null; }
}

let data = loadData();
let D = C.derive(data);   // état recalculé (XP, niveau, succès, stats…)
if (needsSave) save();

// ---------- 2. Recalcul et annonces ----------
let pendingLevelUp = null;

// Toute modification passe par ici : on modifie les données, on recalcule, on sauvegarde.
function commit(mutate, opts = {}) {
  const before = D;
  mutate(data);
  D = C.derive(data);
  save();
  if (!opts.silent) announce(before, D);
  renderAll();
}

// Compare avant/après pour annoncer les nouveaux gains (aucune pénalité affichée)
function announce(before, after) {
  const known = new Set(before.ledger.map(e => e.key));
  after.ledger.filter(e => !known.has(e.key)).forEach(e => toast(`+${e.amount} XP`, e.label));
  BADGES.forEach(b => { if (after.badges[b.id] && !before.badges[b.id]) toast(`${b.icon} Succès débloqué`, b.name, 'badge'); });
  if (after.level.n > before.level.n) pendingLevelUp = after.level;
}

// ---------- 3. Écrans ----------
const TYPE = {
  run: { icon: '🏃', name: 'Course' },
  walk: { icon: '🚶', name: 'Marche' },
  strength: { icon: '🏋️', name: 'Musculation' },
};
const FEEL = { 1: '😌 Facile', 2: '🙂 Correct', 3: '😓 Difficile', 4: '🥵 Très difficile' };
// Choix du ressenti (4 niveaux) pour les formulaires
function feelSeg(prefix, current = 2) {
  return `<div class="seg feel4">${[1, 2, 3, 4].map(v => {
    const [emoji, ...words] = FEEL[v].split(' ');
    return `<input type="radio" name="feel" id="${prefix}-${v}" value="${v}" ${v === current ? 'checked' : ''}><label for="${prefix}-${v}"><span>${emoji}</span>${words.join(' ')}</label>`;
  }).join('')}</div>`;
}
const ui = { showAllWeights: false, showAllExploits: false, showAllXp: false, statsPeriod: 'week', statsMetric: 'km', weightRange: 'recent' };

// Carte du coach : recommandation du jour, proposition éventuelle, repères.
// Toute la réflexion est dans core.js (coachAdvice), testée automatiquement.
const COACH_ICON = { start: '🎒', run: '🏃', rest: '✅', recovery: '😴' };
function coachCard(c) {
  const prop = c.proposals[0];
  return `<div class="card coach-card">
    <div class="coach">
      <div class="avatar">🤖</div>
      <div style="flex:1;min-width:0">
        <div class="eyebrow">Ton coach · aujourd'hui</div>
        <h2 class="coach-title">${COACH_ICON[c.kind]} ${esc(c.title)}</h2>
        <p>${esc(c.text)}</p>
      </div>
    </div>
    ${prop ? `<div class="coach-prop">
      <p>${esc(prop.text)}</p>
      <div class="btns">
        <button class="btn ghost" data-action="coach-back" data-reason="${prop.reason}">↩️ Revenir à S${prop.to.week}·${prop.to.session}</button>
        <button class="btn ghost" data-action="coach-keep" data-reason="${prop.reason}">Garder S${prop.from.week}·${prop.from.session}</button>
      </div>
    </div>` : ''}
    ${c.kind === 'recovery' ? '<button class="btn ghost block" style="margin-top:12px" data-action="free" data-kind="walk">🚶 Marche libre de récupération</button>' : ''}
    <ul class="coach-insights">${c.insights.map(i => `<li><span>${i.icon}</span><span>${esc(i.text)}</span></li>`).join('')}</ul>
  </div>`;
}

// Réponse à une proposition du coach : enregistrée (et annulable depuis le journal)
function coachAnswer(kind, reason) {
  const before = programSession(D.programStep);
  commit(d => {
    d.adjustments = d.adjustments || [];
    d.adjustments.push({ id: C.newId(), date: todayISO(), kind, reason, createdAt: Date.now() });
  }, { silent: true });
  const now = programSession(D.programStep);
  toast(kind === 'step-back' ? '↩️' : '✓', kind === 'step-back' ? `Retour à S${now.week} · Séance ${now.session}` : `On garde S${before.week} · Séance ${before.session}`, 'badge');
}

function cancelAdjustment(id) {
  if (!confirm('Annuler cette décision du coach ? Le programme sera recalculé.')) return;
  commit(d => { d.adjustments = (d.adjustments || []).filter(a => a.id !== id); }, { silent: true });
  toast('✓', 'Décision annulée · programme recalculé', 'badge');
}

function ring(pct, size = 112, stroke = 10) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
    <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
    <circle class="prog" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - clamp(pct, 0.001, 1))}"/>
  </svg>`;
}

function segBar(ps) {
  return `<div class="segbar">${ps.segs.map(s => `<i class="${s.kind}" style="flex:${s.min}"></i>`).join('')}</div>
    <div class="legend"><span><i style="background:var(--lime)"></i>Course</span><span><i style="background:var(--cyan);opacity:.6"></i>Marche</span><span style="margin-left:auto">${ps.total} min au total</span></div>`;
}

function sessionCard(ps, big = false, coach = null) {
  const resting = coach && (coach.kind === 'recovery' || coach.kind === 'rest');
  return `<div class="card session-card">
    <div class="row between">
      <span class="eyebrow">${ps.done ? 'Programme terminé · entretien' : `Prochaine mission · S${ps.week} · Séance ${ps.session}/3`}</span>
      <span class="badge-xp lime">+${XP.run} XP</span>
    </div>
    <div class="session-desc">${ps.desc}</div>
    ${segBar(ps)}
    ${big ? `<div class="small muted" style="margin-top:12px">${WARMUP} min de marche pour s'échauffer, ${COOLDOWN} min pour finir. Cours à une allure où tu peux encore parler.</div>` : ''}
    ${resting ? '<div class="coach-note">😴 Le coach conseille de récupérer aujourd\'hui. Si tu te sens bien, tu peux quand même lancer la séance.</div>' : ''}
    <div class="btns">
      <button class="btn primary" data-action="runner">▶ Lancer le chrono</button>
      <button class="btn ghost" data-action="declare">✍️ Déclarer</button>
    </div>
    <button class="swap-link" data-action="swap">🚶 Pas envie de courir ? Remplace par une marche</button>
  </div>`;
}

// Séance libre : course ou marche au chrono, hors programme
function freeCard(title) {
  return `<div class="card">
    <div class="eyebrow">Séance libre au chrono</div>
    <h2 style="margin:4px 0 4px">${title}</h2>
    <p class="small muted" style="margin:0 0 12px">À ton rythme, sans intervalles. Compte pour les statistiques, l'XP et les records, jamais pour le programme guidé.</p>
    <div class="quick two">
      <button data-action="free" data-kind="run"><span>🏃</span>Course libre</button>
      <button data-action="free" data-kind="walk"><span>🚶</span>Marche libre</button>
    </div>
  </div>`;
}

function renderTop() {
  const L = D.level;
  $('#topXp').innerHTML = `<span class="lv">${L.n}</span><span class="mini"><i style="width:${L.pct * 100}%"></i></span>${fmtNum(D.xp, 0)} XP`;
}

function renderHome() {
  const p = data.profile, st = D.stats, L = D.level;
  const coach = C.coachAdvice(data, D);
  const today = todayISO();
  const daysToStart = daysBetween(today, p.startDate);
  const daysLeft = Math.max(0, daysBetween(today, p.endDate));
  const pctW = clamp(st.lost / st.goalTotal, 0, 1);
  const quote = QUOTES[Math.floor(parseISO(today) / DAY) % QUOTES.length];
  const marks = [0.25, 0.5, 0.75, 1].map(f => {
    const kg = Math.round(st.goalTotal * f * 2) / 2;
    return `<span class="${st.lost >= kg ? 'hit' : ''}" style="left:${f * 100}%;${f === 1 ? 'transform:translateX(-100%)' : ''}">−${fmtNum(kg)}</span>`;
  }).join('');

  $('#view-home').innerHTML = `
    <div class="eyebrow">${fmtLongDate(today)}</div>
    <h1>Salut ${esc(p.name || 'Héros')} 👋</h1>
    <p class="quote">« ${quote} »</p>

    <div class="card glow">
      <div class="hero-card">
        <div class="ring">${ring(L.pct)}<div class="center"><div><span>NIVEAU</span><b>${L.n}</b></div></div></div>
        <div class="hero-info">
          <div class="eyebrow">Opération ${fmtNum(p.goalWeight)} kg</div>
          <div class="title">${L.title}</div>
          <div class="row between small"><span class="xp-num">${fmtNum(D.xp, 0)} XP</span>
            <span class="muted">${L.next ? `${L.next.xp - D.xp} XP → ${L.next.title}` : 'Niveau max !'}</span></div>
          <div class="bar" style="margin-top:8px"><i style="width:${L.pct * 100}%"></i></div>
        </div>
      </div>
    </div>

    <div class="grid-3">
      <div class="tile"><div class="v">${fmtNum(st.current)}<small> kg</small></div><div class="l">Poids actuel</div></div>
      <div class="tile accent"><div class="v">${st.lost ? `−${fmtNum(st.lost)}` : 0}<small> kg</small></div><div class="l">Perdus</div></div>
      <div class="tile"><div class="v">${daysToStart > 0 ? `J-${daysToStart}` : daysLeft}</div><div class="l">${daysToStart > 0 ? 'Avant le départ' : 'Jours restants'}</div></div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="row between"><h2>${fmtNum(p.startWeight)} → ${fmtNum(p.goalWeight)} kg</h2><span class="muted small">${fmtNum(st.lost)} / ${fmtNum(st.goalTotal)} kg</span></div>
      <div class="milestones"><div class="bar lime thick" style="margin-top:12px"><i style="width:${pctW * 100}%"></i></div><div class="marks">${marks}</div></div>
    </div>

    <div class="card">
      <div class="row between">
        <div>
          <div class="eyebrow">Quête de la semaine</div>
          <h2 style="margin:4px 0 12px">${WEEKLY_TARGET} jours d'entraînement</h2>
          <div class="pips">${Array.from({ length: WEEKLY_TARGET }, (_, i) => `<div class="pip ${i < st.thisWeek ? 'on' : ''}">${i < st.thisWeek ? '✓' : i + 1}</div>`).join('')}
            <span class="badge-xp" style="align-self:center;margin-left:4px">${st.thisWeek >= WEEKLY_TARGET ? 'Bonus gagné ✓' : `+${XP.weeklyGoal} XP`}</span></div>
        </div>
        <div class="flame"><span style="font-size:22px">🔥</span><b>${st.streak}</b><span>SEMAINES</span></div>
      </div>
    </div>

    ${coachCard(coach)}

    ${(() => { const nx = nextChallenges(1)[0]; return nx ? `<div class="card"><div class="row between"><div class="eyebrow">🎯 Prochain défi</div><button class="link-btn" data-go="hero">Tous les défis →</button></div>${challengeRow(nx)}</div>` : ''; })()}

    ${sessionCard(programSession(D.programStep), false, coach)}

    ${freeCard('Envie de bouger autrement ?')}`;
}

const ADJ_REASON = { 'tres-difficile': 'après une séance très difficile', interruptions: 'après deux séances interrompues', reprise: 'reprise après une pause', manuel: '' };

function renderTrain() {
  const ps = programSession(D.programStep);
  const sessions = [...D.sessions].reverse(); // plus récentes en premier
  const coach = C.coachAdvice(data, D);
  // Journal : séances et décisions du coach, les plus récentes d'abord
  const items = [
    ...D.sessions.map(s => ({ date: s.date, at: s.createdAt || 0, s })),
    ...(D.adjustments || []).map(a => ({ date: a.date, at: a.createdAt || 0, a })),
  ].sort((x, y) => y.date.localeCompare(x.date) || y.at - x.at);
  const adjRow = a => {
    const to = programSession(a.to || 0);
    return `<div class="h-item">
      <div class="h-ic coach">${a.kind === 'step-back' ? '↩️' : '✋'}</div>
      <div class="h-main"><b>${a.kind === 'step-back' ? `Coach : retour à S${to.week}·${to.session}` : 'Coach : étape conservée'}</b>
        <div>${fmtDate(a.date)}${ADJ_REASON[a.reason] ? ` · ${ADJ_REASON[a.reason]}` : ''}</div></div>
      <button class="h-del" data-action="del-adj" data-id="${esc(a.id)}" aria-label="Annuler cette décision">×</button>
    </div>`;
  };
  const curWeek = Math.floor(Math.min(D.programStep, PROGRAM_STEPS) / 3);

  const timeline = PROGRAM.map((w, i) => {
    const cls = i < curWeek ? 'done' : i === curWeek ? 'current' : '';
    const dots = [0, 1, 2].map(j => {
      const step = i * 3 + j;
      return `<i class="${step < D.programStep ? 'on' : step === D.programStep ? 'now' : ''}"></i>`;
    }).join('');
    const d = w.reps > 1 ? `${w.reps}×${fmtMin(w.run)} course` : `${w.run} min continu`;
    return `<div class="tl-row ${cls}"><b>Sem. ${i + 1}</b><span>${d}</span><div class="tl-dots">${dots}</div></div>`;
  }).join('');

  // Statut visible : ⏱️ validée au chrono, ✍️ déclarée, ⏸️ interrompue, 📜 historique (ancienne règle)
  const STATUS_TAG = { validee: '⏱️', declaree: '✍️ déclarée', interrompue: '⏸️ interrompue', historique: '📜 historique' };
  const progTag = s => (s.prog ? ` · S${s.prog.week}·${s.prog.session} ${STATUS_TAG[s.prog.status]}` : '');

  $('#view-train').innerHTML = `
    <div class="eyebrow">Programme marche / course</div>
    <h1>Entraînements</h1>
    <p class="quote">Le programme s'adapte à ton ressenti : facile ou correct, tu avances. Difficile, on répète.</p>
    ${sessionCard(ps, true, coach)}

    ${freeCard('Course ou marche à ton rythme')}

    ${assistCard()}

    <div class="section-title"><h2>Saisie manuelle</h2><span class="muted small">sans chrono</span></div>
    <div class="quick">
      <button data-action="log" data-type="walk"><span>🚶</span>Marche</button>
      <button data-action="log" data-type="run"><span>🏃</span>Course</button>
      <button data-action="log" data-type="strength"><span>🏋️</span>Muscu</button>
    </div>

    <div class="section-title"><h2>Programme 12 semaines</h2><span class="muted small">${Math.min(D.programStep, PROGRAM_STEPS)}/${PROGRAM_STEPS}</span></div>
    <div class="card" style="padding:10px"><div class="timeline">${timeline}</div></div>

    <div class="section-title"><h2>Journal</h2><span class="muted small">${sessions.length} séance${sessions.length > 1 ? 's' : ''} · touche pour modifier</span></div>
    <div class="history">${items.length ? items.map(({ s, a }) => a ? adjRow(a) : `
      <div class="h-item">
        <div class="h-ic ${s.type}">${TYPE[s.type].icon}</div>
        <div class="h-main editable" data-action="edit" data-id="${esc(s.id)}" role="button" tabindex="0" aria-label="Modifier cette séance">
          <b>${TYPE[s.type].name}${progTag(s)}${s.mode === 'libre' ? ' · libre ⏱️' : ''}</b>
          <div>${fmtDate(s.date)} · ${s.duration} min${s.km ? ` · ${fmtNum(s.km)} km` : ''} · ${FEEL[s.feel] || ''}${s.swap ? ' · remplace une course' : ''}</div>
        </div>
        <span class="badge-xp lime">+${s.xp}</span>
        <button class="h-del" data-action="del" data-id="${esc(s.id)}" aria-label="Supprimer">×</button>
      </div>`).join('') : '<div class="empty">Aucune séance pour l\'instant.<br>Ta première ligne d\'histoire s\'écrit ici ✍️</div>'}
    </div>`;
}

// Réglages de l'assistant de course (voix, bips, alertes)
function assistCard() {
  const voices = frenchVoices();
  const chk = (key, label) => `<label class="check"><input type="checkbox" data-setting="${key}" ${settings[key] ? 'checked' : ''}> ${label}</label>`;
  return `<div class="section-title"><h2>Assistant de course</h2></div>
    <div class="card" id="assistCard">
      ${chk('voice', '🗣️ Annonces vocales en français')}
      ${canSpeak && voices.length > 1 ? `<label class="f">Voix<select data-setting="voiceName">
        <option value="">Automatique</option>
        ${voices.map(v => `<option value="${esc(v.name)}" ${v.name === settings.voiceName ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
      </select></label>` : ''}
      <label class="f">Volume de la voix<input type="range" min="0.2" max="1" step="0.1" data-setting="voiceVolume" value="${settings.voiceVolume}"></label>
      ${chk('sounds', '🔔 Bips sonores')}
      ${chk('warn10', '⏳ Alerte 10 secondes avant chaque changement')}
      ${chk('countdown', '5️⃣ Compte à rebours de 5 secondes')}
      ${canVibrate ? chk('vibration', '📳 Vibrations') : ''}
      <button class="btn ghost block" data-action="test-voice">▶ Tester la voix et les bips</button>
      <p class="small muted" style="margin:12px 0 0;line-height:1.5">
        ${!canSpeak ? 'Ce navigateur ne propose pas d\'annonces vocales : seuls les bips seront utilisés.<br>' : !voices.length ? 'Aucune voix française détectée pour l\'instant : la voix par défaut sera utilisée.<br>' : ''}
        Sur iPhone, les annonces et les bips <b>s'arrêtent quand l'écran est verrouillé</b> ou que l'app passe en arrière-plan : iOS met la page en pause. L'app garde l'écran allumé pendant la séance ; au retour, le chrono est exact et la phase en cours est annoncée. Le bouton silencieux peut couper les bips${canVibrate ? '' : ', et l\'iPhone ne permet pas de vibrer depuis une app web'}.
      </p>
    </div>`;
}

// ---------- Outils d'affichage de l'étape 5 ----------
const fmtSigned = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmtNum(Math.abs(v), d)}`;
// Écart neutre : on montre la progression sans jamais culpabiliser
const deltaChip = (v, unit = '', d = 1) => `<span class="chip ${v > 0 ? 'up' : ''}">${fmtSigned(v, d)}${unit}</span>`;
const fmtHours = sec => fmtDuration(Math.round(sec / 60));

// Défis les plus proches d'être réussis. Un jour de récupération, aucun défi de course n'est mis en avant.
function nextChallenges(n = 3) {
  const coach = C.coachAdvice(data, D);
  const resting = coach.kind === 'recovery' || coach.kind === 'rest';
  return BADGES.filter(b => !D.badges[b.id] && !(resting && b.run))
    .map(b => ({ b, ...C.badgeProgress(b, D.snap) }))
    .filter(x => x.target > 0)
    .sort((a, b) => b.value / b.target - a.value / a.target || a.target - b.target)
    .slice(0, n);
}

function challengeRow(x) {
  const pct = clamp(x.value / x.target, 0, 1);
  return `<div class="defi">
    <div class="defi-ic">${x.b.icon}</div>
    <div class="defi-main"><div class="row between"><b>${x.b.name}</b><span class="muted small">${fmtNum(Math.min(x.value, x.target))} / ${fmtNum(x.target)}</span></div>
      <div class="small muted">${x.b.desc}</div>
      <div class="bar" style="margin-top:6px"><i style="width:${pct * 100}%"></i></div></div>
  </div>`;
}

// Diagramme en barres générique (semaines, mois, endurance)
function barChart(items, { fmt = v => fmtNum(v), id = 'bar' } = {}) {
  const W = 380, H = 170, pb = 24, pt = 18, n = items.length;
  const max = Math.max(1, ...items.map(i => i.value));
  const bw = W / n;
  return `<svg viewBox="0 0 ${W} ${H}" role="img">
    <defs><linearGradient id="${id}G" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
    ${items.map((it, i) => {
      const h = it.value / max * (H - pb - pt), x = i * bw + bw * 0.2, y = H - pb - h;
      return `<rect x="${x}" y="${pt}" width="${bw * 0.6}" height="${H - pb - pt}" rx="8" fill="rgba(255,255,255,.04)"/>
        <rect x="${x}" y="${y}" width="${bw * 0.6}" height="${Math.max(h, 0)}" rx="8" fill="url(#${id}G)" opacity="${it.current ? 1 : .75}"/>
        ${it.value ? `<text x="${x + bw * 0.3}" y="${y - 5}" text-anchor="middle" style="fill:var(--text);font-weight:600">${fmt(it.value)}</text>` : ''}
        <text x="${x + bw * 0.3}" y="${H - 6}" text-anchor="middle">${it.label}</text>`;
    }).join('')}
  </svg>`;
}

// Courbe de poids : pesées réelles, moyenne mobile 7 jours, trajectoire conseillée, objectifs.
// Deux vues : les 8 dernières semaines (lisible sur iPhone) ou tout le défi.
function weightChart(st, rep) {
  const p = data.profile, W = 380, H = 220, pl = 30, pr = 8, pt = 14, pb = 26;
  const recent = ui.weightRange !== 'all';
  const today = todayISO();
  const first = st.sortedW.length ? st.sortedW[0].date : p.startDate;
  const last = st.sortedW.length ? st.sortedW[st.sortedW.length - 1].date : p.endDate;
  let x0 = Math.min(parseISO(p.startDate), parseISO(first));
  let x1 = Math.max(+parseISO(p.endDate), +parseISO(last), x0 + DAY);
  if (recent) {
    x0 = Math.max(x0, +parseISO(C.addDays(today, -56)));
    x1 = Math.max(+parseISO(C.addDays(today, 7)), x0 + 7 * DAY);
  }
  const t0 = +parseISO(p.startDate), t1 = +parseISO(p.endDate);
  // Trajectoire conseillée : ligne droite du poids de départ à l'objectif principal
  const traj = t => p.startWeight + (p.goalWeight - p.startWeight) * clamp((t - t0) / (t1 - t0), 0, 1);
  const visible = st.sortedW.filter(w => +parseISO(w.date) >= x0);
  const vals = recent
    ? [...visible.map(w => w.kg), ...rep.weight.movingAvg.filter(w => +parseISO(w.date) >= x0).map(w => w.kg), traj(x0), traj(x1), ...(visible.length ? [] : [st.current])]
    : [p.startWeight, p.goalWeight, ...(p.bonusGoal ? [p.bonusGoal] : []), ...st.sortedW.map(w => w.kg)];
  const span = Math.max(...vals) - Math.min(...vals);
  const stepKg = recent && span < 8 ? 1 : 5;
  const yMin = Math.floor((Math.min(...vals) - (recent ? 0.5 : 2)) / stepKg) * stepKg;
  const yMax = Math.ceil((Math.max(...vals) + (recent ? 0.5 : 2)) / stepKg) * stepKg;
  const X = d => pl + ((typeof d === 'number' ? d : +parseISO(d)) - x0) / (x1 - x0) * (W - pl - pr);
  const Y = v => pt + (yMax - v) / (yMax - yMin) * (H - pt - pb);
  const inRange = v => v >= yMin && v <= yMax;

  let grid = '';
  for (let v = yMin; v <= yMax; v += stepKg)
    grid += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,.06)"/><text x="${pl - 8}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  const ticks = [];
  if (recent) {
    for (let k = weekKey(toISO(new Date(x0))); +parseISO(k) <= x1; k = shiftWeek(k, 2))
      if (+parseISO(k) >= x0) ticks.push(`<text x="${X(k)}" y="${H - 6}" text-anchor="middle">${fmtDate(k).replace('.', '')}</text>`);
  } else {
    for (let d = new Date(x0), i = 0; d <= x1 && i < 14; d.setMonth(d.getMonth() + 1), i++) {
      const m = new Date(d.getFullYear(), d.getMonth(), 1);
      if (m >= x0) ticks.push(`<text x="${X(toISO(m))}" y="${H - 6}" text-anchor="middle">${m.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '')}</text>`);
    }
  }
  const goalLine = (kg, color, label, dy) => inRange(kg)
    ? `<line x1="${pl}" x2="${W - pr}" y1="${Y(kg)}" y2="${Y(kg)}" stroke="${color}" stroke-dasharray="2 5" stroke-width="2" opacity=".85"/>
       <text x="${W - pr}" y="${Y(kg) + dy}" text-anchor="end" style="fill:${color};font-weight:600">${label}</text>` : '';
  let line = '', area = '', dots = '', avgLine = '';
  const pts = st.sortedW.filter(w => +parseISO(w.date) >= x0).map(w => [X(w.date), Y(w.kg)]);
  if (pts.length) {
    line = `<polyline points="${pts.map(q => q.join(',')).join(' ')}" fill="none" stroke="var(--lime)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" style="filter:drop-shadow(0 0 6px rgba(198,255,61,.5))"/>`;
    area = `<polygon points="${pts[0][0]},${H - pb} ${pts.map(q => q.join(',')).join(' ')} ${pts[pts.length - 1][0]},${H - pb}" fill="url(#wArea)"/>`;
    const avgPts = rep.weight.movingAvg.filter(w => +parseISO(w.date) >= x0);
    if (avgPts.length > 1)
      avgLine = `<polyline points="${avgPts.map(w => `${X(w.date)},${Y(w.kg)}`).join(' ')}" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" opacity=".9"/>`;
    const lp = pts[pts.length - 1];
    dots = pts.map(q => `<circle cx="${q[0]}" cy="${q[1]}" r="3" fill="var(--lime)"/>`).join('') +
      `<circle cx="${lp[0]}" cy="${lp[1]}" r="7" fill="none" stroke="var(--lime)" stroke-width="2" opacity=".6"/>
       <text x="${Math.min(lp[0] + 10, W - 60)}" y="${lp[1] - 10}" style="fill:var(--text);font-weight:700">${fmtNum(st.current)} kg</text>`;
  }
  const ta = Math.max(x0, t0), tb = Math.min(x1, t1);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de poids">
    <defs><linearGradient id="wArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c6ff3d" stop-opacity=".25"/><stop offset="1" stop-color="#c6ff3d" stop-opacity="0"/></linearGradient></defs>
    ${grid}${ticks.join('')}
    ${goalLine(p.goalWeight, '#c4b5fd', `Objectif ${fmtNum(p.goalWeight)} kg`, -7)}
    ${p.bonusGoal ? goalLine(p.bonusGoal, '#ffc39b', `Bonus ${fmtNum(p.bonusGoal)} kg`, 14) : ''}
    ${tb > ta ? `<line x1="${X(ta)}" y1="${Y(traj(ta))}" x2="${X(tb)}" y2="${Y(traj(tb))}" stroke="rgba(255,255,255,.25)" stroke-dasharray="6 6" stroke-width="1.5"/>` : ''}
    ${area}${avgLine}${line}${dots}
  </svg>`;
}

function weightList(st) {
  if (!st.sortedW.length) return '';
  const rows = [...st.sortedW].reverse();
  const shown = ui.showAllWeights ? rows : rows.slice(0, 5);
  return `<div class="w-list">${shown.map(w => {
    const i = st.sortedW.indexOf(w), prev = st.sortedW[i - 1];
    const diff = prev ? Math.round((w.kg - prev.kg) * 10) / 10 : null;
    return `<div class="w-row">
      <button class="w-main" data-action="edit-weight" data-date="${esc(w.date)}" aria-label="Modifier cette pesée">
        <span>${fmtDate(w.date)}</span><b>${fmtNum(w.kg)} kg</b>
        <span class="muted small">${diff === null ? '' : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${fmtNum(Math.abs(diff))}`}</span>
      </button>
      <button class="h-del" data-action="del-weight" data-date="${esc(w.date)}" aria-label="Supprimer cette pesée">×</button>
    </div>`;
  }).join('')}
  ${rows.length > 5 ? `<button class="w-more" data-action="toggle-weights">${ui.showAllWeights ? 'Réduire' : `Voir les ${rows.length} pesées`}</button>` : ''}</div>`;
}

// ---------- Écran Perso : personnage, défis, succès, titres, exploits, XP ----------
function renderHero() {
  const st = D.stats, L = D.level;
  const attrs = [
    { name: '🫁 Endurance', v: clamp(D.programStep / PROGRAM_STEPS * 80 + st.totals.km / 5, 0, 100), c: 'var(--lime)' },
    { name: '💪 Force', v: clamp(st.totals.strength * 4, 0, 100), c: 'var(--pink)' },
    { name: '📅 Régularité', v: clamp(st.perfectWeeks * 6 + st.streak * 4, 0, 100), c: 'var(--orange)' },
    { name: '🧠 Volonté', v: clamp(st.totals.sessions * 2 + st.weightsCount * 2, 0, 100), c: 'var(--violet)' },
  ];
  const unlocked = Object.keys(D.badges).length;
  const reward = C.REWARDS[L.n - 1], nextReward = L.next ? C.REWARDS[L.n] : null;
  const challenges = nextChallenges(3);

  // Journal des exploits : niveaux, succès et records, du plus récent au plus ancien
  const exploits = [
    ...Object.entries(D.levelDates).map(([n, date]) => ({ date, icon: C.REWARDS[n - 1].icon, text: `Niveau ${n} : ${LEVELS[n - 1].title}`, sub: `Récompense : ${C.REWARDS[n - 1].name}` })),
    ...BADGES.filter(b => D.badges[b.id]).map(b => ({ date: D.badges[b.id], icon: b.icon, text: `Succès : ${b.name}`, sub: b.desc })),
    ...D.ledger.filter(e => /^r[dr]:/.test(e.key)).map(e => ({ date: e.date, icon: '🏅', text: e.label.replace('🏅 ', ''), sub: `+${e.amount} XP` })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const shownEx = ui.showAllExploits ? exploits : exploits.slice(0, 8);
  const xpRows = [...D.ledger].reverse();
  const shownXp = ui.showAllXp ? xpRows : xpRows.slice(0, 10);

  $('#view-hero').innerHTML = `
    <div class="card glow avatar-card">
      <div class="emblem">${L.n}<small>${L.title.toUpperCase()}</small><span class="emblem-reward" title="${esc(reward.name)}">${reward.icon}</span></div>
      <h1 style="margin-top:22px">${esc(data.profile.name || 'Héros')}</h1>
      <div class="muted small">Titre : <b style="color:var(--text)">${L.title}</b> · ${reward.icon} ${reward.name}</div>
      <div class="bar" style="margin:16px 0 6px"><i style="width:${L.pct * 100}%"></i></div>
      <div class="row between small muted"><span>${fmtNum(D.xp, 0)} XP${L.next ? ` / ${fmtNum(L.next.xp, 0)}` : ''}</span>
        <span>${L.next ? `encore ${fmtNum(L.next.xp - D.xp, 0)} XP → ${nextReward.icon} ${L.next.title}` : 'Niveau maximum'}</span></div>
      <div class="muted small" style="margin-top:8px">${unlocked}/${BADGES.length} succès débloqués</div>
    </div>

    <div class="section-title"><h2>Prochains défis</h2><span class="muted small">les plus proches</span></div>
    <div class="card">${challenges.length ? challenges.map(challengeRow).join('') : '<p class="small muted" style="margin:0">Tous les défis disponibles sont réussis. Incroyable !</p>'}
      <p class="small muted" style="margin:10px 0 0">Les défis de course ne sont pas proposés les jours de récupération : le repos fait partie du jeu.</p>
    </div>

    <div class="section-title"><h2>Attributs</h2></div>
    <div class="card">${attrs.map(a => `
      <div class="attr"><div class="row"><span>${a.name}</span><b>${Math.round(a.v)}</b></div>
      <div class="bar"><i style="width:${a.v}%;background:${a.c}"></i></div></div>`).join('')}
    </div>

    <div class="section-title"><h2>Succès</h2><span class="muted small">${unlocked}/${BADGES.length}</span></div>
    ${Object.entries(C.BADGE_CATS).map(([cat, title]) => {
      const list = BADGES.filter(b => b.cat === cat);
      const got = list.filter(b => D.badges[b.id]).length;
      return `<div class="cat-title"><span>${title}</span><span class="muted small">${got}/${list.length}</span></div>
      <div class="badges">${list.map(b => {
        const done = D.badges[b.id], pr = C.badgeProgress(b, D.snap);
        return `<div class="bdg ${done ? 'unlocked' : 'locked'}">
          <div class="i">${b.icon}</div><b>${b.name}</b>
          <div class="bdg-d">${done ? `Débloqué le ${fmtDate(done)}` : b.desc}</div>
          ${!done && pr.target > 0 ? `<div class="mini-bar"><i style="width:${clamp(pr.value / pr.target, 0, 1) * 100}%"></i></div>` : ''}
        </div>`;
      }).join('')}</div>`;
    }).join('')}

    <div class="section-title"><h2>Titres et récompenses</h2></div>
    <div class="card" style="padding:10px"><div class="levels">${LEVELS.map((lv, i) => {
      const n = i + 1, got = n <= L.n, date = n === 1 ? null : D.levelDates[n];
      return `<div class="lv-row ${n < L.n ? 'reached' : n === L.n ? 'reached current' : 'locked'}">
        <span class="n">${n}</span>
        <span class="lv-txt"><b>${lv.title}</b><span class="small muted">${C.REWARDS[i].icon} ${C.REWARDS[i].name}</span></span>
        <span class="xp">${got ? (date ? fmtDate(date) : 'Départ') : `${fmtNum(lv.xp, 0)} XP`}</span>
      </div>`;
    }).join('')}</div></div>

    <div class="section-title"><h2>Journal des exploits</h2><span class="muted small">${exploits.length}</span></div>
    <div class="card" style="padding:8px 12px">${exploits.length ? shownEx.map(e => `
      <div class="ex-row"><span class="ex-ic">${e.icon}</span><span class="ex-main"><b>${esc(e.text)}</b><span class="small muted">${esc(e.sub)}</span></span><span class="small muted">${fmtDate(e.date)}</span></div>`).join('')
      : '<p class="small muted">Tes exploits apparaîtront ici dès ta première séance.</p>'}
      ${exploits.length > 8 ? `<button class="w-more" data-action="toggle-exploits">${ui.showAllExploits ? 'Réduire' : `Voir les ${exploits.length} exploits`}</button>` : ''}
    </div>

    <div class="section-title"><h2>Historique des XP</h2><span class="muted small">${fmtNum(D.xp, 0)} XP</span></div>
    <div class="card" style="padding:8px 12px">${xpRows.length ? shownXp.map(e => `
      <div class="ex-row"><span class="ex-main"><b>${esc(e.label)}</b><span class="small muted">${fmtDate(e.date)} · total ${fmtNum(e.total, 0)} XP</span></span><span class="badge-xp lime">+${e.amount}</span></div>`).join('')
      : '<p class="small muted">Aucun gain d\'XP pour l\'instant.</p>'}
      ${xpRows.length > 10 ? `<button class="w-more" data-action="toggle-xp">${ui.showAllXp ? 'Réduire' : `Voir les ${xpRows.length} gains`}</button>` : ''}
    </div>

    <div class="section-title"><h2>Comment gagner de l'XP</h2></div>
    <div class="card"><table class="rewards">
      <tr><td>🚶 Marche de 30 min</td><td>+${XP.walk30}</td></tr>
      <tr><td>🏃 Séance de course (≥ 10 min ou programme)</td><td>+${XP.run}</td></tr>
      <tr><td>🏋️ Musculation (≥ 15 min)</td><td>+${XP.strength}</td></tr>
      <tr><td>⏳ Séance plus courte</td><td>+${XP.walkMini} à +${XP.runShort}</td></tr>
      <tr><td>📅 Objectif hebdo (3 jours actifs)</td><td>+${XP.weeklyGoal}</td></tr>
      <tr><td>🏅 Nouveau record perso (mesuré)</td><td>+${XP.record}</td></tr>
      <tr><td>⚖️ Pesée hebdomadaire</td><td>+${XP.weighIn}</td></tr>
    </table>
    <p class="small muted" style="margin:12px 0 0">L'XP récompense la régularité, pas la vitesse de perte de poids. Les succès sont des récompenses symboliques : ils ne rapportent pas d'XP en plus.</p></div>`;
}

// ---------- Écran Statistiques ----------
const PERIOD_LABEL = { week: 'Semaines', month: 'Mois' };
const METRIC = {
  km: { label: 'Distance', get: b => b.km, fmt: v => fmtNum(v) },
  minutes: { label: 'Durée', get: b => b.minutes, fmt: v => `${Math.round(v)}'` },
  days: { label: 'Jours actifs', get: b => b.days, fmt: v => fmtNum(v, 0) },
};
const monthLabel = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short' }).replace('.', ''); };

function renderStats() {
  const st = D.stats, p = data.profile;
  const rep = C.statsReport(data, D);
  const T = rep.totals, ty = rep.types;
  // Carte de régularité : une case par semaine du défi
  const startW = weekKey(p.startDate), endW = weekKey(p.endDate), nowW = weekKey(todayISO());
  let heat = '';
  for (let k = startW; k <= endW; k = shiftWeek(k, 1)) {
    const c = st.byWeek[k] || 0;
    heat += `<i class="${k > nowW ? 'future' : `l${Math.min(c, 3)}`} ${k === nowW ? 'now' : ''}" title="Semaine du ${fmtDate(k)} : ${c} jour(s) d'entraînement"></i>`;
  }
  // Évolution : semaines ou mois, distance / durée / jours actifs
  const metric = METRIC[ui.statsMetric] || METRIC.km;
  const buckets = ui.statsPeriod === 'month' ? rep.months : rep.weeks;
  const evoItems = buckets.map((b, i) => ({
    label: ui.statsPeriod === 'month' ? monthLabel(b.key) : i === buckets.length - 1 ? 'En cours' : fmtDate(b.key).replace('.', ''),
    value: metric.get(b), current: i === buckets.length - 1,
  }));
  const seg = (action, value, current, label) => `<button class="seg-btn ${value === current ? 'on' : ''}" data-action="${action}" data-v="${value}">${label}</button>`;
  // Séances par type
  const typeRows = [
    ['📋', 'Programme', ty.programme, ty.programme ? `${ty.programmeValides} validée${ty.programmeValides > 1 ? 's' : ''} ou déclarée${ty.programmeValides > 1 ? 's' : ''}` : ''],
    ['🏃', 'Course libre', ty.courseLibre, 'mesurée au chrono'],
    ['🚶', 'Marche libre', ty.marcheLibre, 'mesurée au chrono'],
    ['✍️', 'Course saisie', ty.courseManuelle, 'sans chrono'],
    ['✍️', 'Marche saisie', ty.marcheManuelle, 'sans chrono'],
    ['🏋️', 'Musculation', ty.muscu, ''],
  ];
  const typeMax = Math.max(1, ...typeRows.map(r => r[2]));
  const cmpLabels = { km: ['Distance', v => `${fmtNum(v)} km`], minutes: ['Durée', v => fmtDuration(v)], days: ['Jours actifs', v => fmtNum(v, 0)], sessions: ['Séances', v => fmtNum(v, 0)] };
  const enduranceItems = rep.weeks.map((w, i) => ({ label: i === rep.weeks.length - 1 ? 'En cours' : fmtDate(w.key).replace('.', ''), value: Math.round(w.runSec / 60), current: i === rep.weeks.length - 1 }));
  const wc = rep.weight.weekChange, mc = rep.weight.monthChange;

  $('#view-stats').innerHTML = `
    <div class="eyebrow">Tableau de bord</div>
    <h1>Statistiques</h1>
    <p class="quote">Les chiffres ne mentent pas : chaque barre, c'est toi.</p>

    <div class="grid-2">
      <div class="tile"><div class="ic">👣</div><div class="v">${fmtNum(T.km)}<small> km</small></div><div class="l">Distance totale</div>
        <div class="tile-sub">${T.kmMeasured ? `${fmtNum(T.kmMeasured)} km mesurés · ` : ''}${fmtNum(T.kmManual)} km saisis</div></div>
      <div class="tile"><div class="ic">⏱️</div><div class="v">${fmtDuration(T.minutes)}</div><div class="l">Durée d'activité</div>
        <div class="tile-sub">${T.activeDays} jour${T.activeDays > 1 ? 's' : ''} actif${T.activeDays > 1 ? 's' : ''}</div></div>
      <div class="tile"><div class="ic">🔥</div><div class="v">${T.sessions}</div><div class="l">Séances réalisées</div>
        <div class="tile-sub">${T.timedSessions} au chrono</div></div>
      <div class="tile"><div class="ic">🏅</div><div class="v">${fmtNum(D.records.maxRun)}<small> min</small></div><div class="l">Record course continue</div>
        <div class="tile-sub">⏱️ mesuré au chrono</div></div>
    </div>

    <div class="section-title"><h2>Temps mesuré au chrono</h2></div>
    <div class="card">
      <div class="grid-2">
        <div><div class="eyebrow">🏃 Course</div><div class="session-desc" style="margin:4px 0 0;color:var(--lime)">${fmtHours(T.runSec)}</div></div>
        <div><div class="eyebrow">🚶 Marche</div><div class="session-desc" style="margin:4px 0 0;color:var(--cyan)">${fmtHours(T.walkSec)}</div></div>
      </div>
      <p class="small muted" style="margin:10px 0 0">Seules les séances chronométrées comptent ici. Les séances saisies à la main ne détaillent pas la course et la marche.</p>
    </div>

    <div class="section-title"><h2>Cette semaine</h2><span class="muted small">vs semaine dernière</span></div>
    <div class="card" style="padding:8px 14px">${rep.compare.map(c => `
      <div class="cmp-row"><span>${cmpLabels[c.key][0]}</span><b>${cmpLabels[c.key][1](c.now)}</b>${deltaChip(c.diff, c.key === 'km' ? ' km' : c.key === 'minutes' ? ' min' : '', c.key === 'km' ? 1 : 0)}</div>`).join('')}
    </div>

    <div class="section-title"><h2>Évolution</h2></div>
    <div class="card chart">
      <div class="seg-mini">${seg('stats-period', 'week', ui.statsPeriod, 'Semaines')}${seg('stats-period', 'month', ui.statsPeriod, 'Mois')}</div>
      <div class="seg-mini">${Object.entries(METRIC).map(([k, m]) => seg('stats-metric', k, ui.statsMetric, m.label)).join('')}</div>
      ${barChart(evoItems, { fmt: metric.fmt, id: 'evo' })}
    </div>

    <div class="section-title"><h2>Séances par type</h2></div>
    <div class="card">${typeRows.map(([ic, label, n, sub]) => `
      <div class="type-row ${n ? '' : 'zero'}"><div class="row between"><span>${ic} ${label}</span><b>${n}</b></div>
        <div class="bar"><i style="width:${n / typeMax * 100}%"></i></div>${sub && n ? `<div class="small muted">${sub}</div>` : ''}</div>`).join('')}
    </div>

    <div class="section-title"><h2>Records personnels</h2></div>
    <div class="card" style="padding:8px 14px">${rep.records.length ? rep.records.map(r => `
      <div class="rec-row"><span class="ex-ic">${r.icon}</span>
        <span class="ex-main"><b>${r.label}</b><span class="small muted">${r.week ? `semaine du ${fmtDate(r.date)}` : fmtDate(r.date)} · <span class="tag ${r.measured ? 'measured' : ''}">${r.week ? '📅 cumul' : r.measured ? '⏱️ mesuré' : '✍️ saisi'}</span></span></span>
        <b class="rec-v">${fmtNum(r.value)} ${r.unit}</b></div>`).join('')
      : '<p class="small muted">Tes records apparaîtront après tes premières séances.</p>'}
    </div>

    <div class="section-title"><h2>Endurance</h2><span class="muted small">course mesurée / semaine</span></div>
    <div class="card chart">
      ${barChart(enduranceItems, { fmt: v => `${v}'`, id: 'endu' })}
      <p class="small muted" style="margin:8px 0 0">Minutes de course mesurées au chrono (programme et course libre). Plus longue course sans pause : <b style="color:var(--text)">${fmtNum(D.records.maxRun)} min</b>.</p>
    </div>

    <div class="section-title"><h2>Courbe de poids</h2><span class="muted small">pesées saisies</span></div>
    <div class="card chart">
      <div class="seg-mini">${seg('weight-range', 'recent', ui.weightRange, '8 dernières semaines')}${seg('weight-range', 'all', ui.weightRange, 'Tout le défi')}</div>
      ${weightChart(st, rep)}
      <div class="legend" style="margin-top:8px;flex-wrap:wrap"><span><i style="background:var(--lime)"></i>Pesées</span><span><i style="background:var(--cyan)"></i>Moyenne 7 j</span><span><i style="background:rgba(255,255,255,.3)"></i>Trajectoire conseillée</span></div>
      ${st.sortedW.length ? `<div class="cmp-row" style="margin-top:6px"><span>Cette semaine</span>${wc ? deltaChip(wc.diff, ' kg') : '<span class="muted small">pas de pesée la semaine précédente</span>'}</div>
        <div class="cmp-row"><span>Ce mois-ci</span>${mc ? deltaChip(mc.diff, ' kg') : '<span class="muted small">pas de pesée le mois précédent</span>'}</div>`
        : '<p class="small muted" style="margin:8px 0 0">Ajoute ta première pesée pour voir ta courbe apparaître.</p>'}
      <form id="weightForm" style="margin-top:14px">
        <div class="grid-2">
          <label class="f">Poids (kg)<input id="wKg" type="text" inputmode="decimal" autocomplete="off" placeholder="${fmtNum(st.current)}" required></label>
          <label class="f">Date<input id="wDate" type="date" value="${todayISO()}" max="${todayISO()}" required></label>
        </div>
        <button class="btn primary block" type="submit">⚖️ Enregistrer ma pesée · +${XP.weighIn} XP</button>
      </form>
      ${weightList(st)}
    </div>

    <div class="section-title"><h2>Régularité</h2><span class="muted small">${st.perfectWeeks} semaine${st.perfectWeeks > 1 ? 's' : ''} parfaite${st.perfectWeeks > 1 ? 's' : ''}</span></div>
    <div class="card">
      <div class="heat">${heat}</div>
      <div class="legend" style="margin-top:12px"><span>Jours actifs</span><span><i style="background:rgba(198,255,61,.25)"></i>1</span><span><i style="background:rgba(198,255,61,.55)"></i>2</span><span><i style="background:var(--lime)"></i>3+</span><span style="margin-left:auto">Meilleure série : ${st.bestStreak}</span></div>
    </div>`;
}

// ---------- Écran Objectifs ----------
function goalCard(g, color) {
  return `<div class="card ${g.label === 'Objectif principal' ? 'glow' : ''}">
    <div class="row between">
      <div><div class="eyebrow">${g.label}</div><div class="session-desc" style="margin:4px 0">${fmtNum(g.target)} kg</div></div>
      <div style="text-align:right"><div class="eyebrow">${g.reached ? 'Atteint 🎉' : 'Reste'}</div><div class="session-desc" style="margin:4px 0;color:${color}">${g.reached ? '✓' : `${fmtNum(g.left)} kg`}</div></div>
    </div>
    <div class="bar thick ${color === 'var(--lime)' ? 'lime' : ''}" style="margin:8px 0"><i style="width:${g.pct * 100}%;${color !== 'var(--lime)' ? `background:${color}` : ''}"></i></div>
    <div class="row between small muted"><span>${fmtNum(g.done)} / ${fmtNum(g.total)} kg perdus</span><span>${Math.round(g.pct * 100)} %</span></div>
  </div>`;
}

function renderGoals() {
  const p = data.profile, st = D.stats;
  const rep = C.statsReport(data, D);
  const totalDays = daysBetween(p.startDate, p.endDate);
  const weeks = totalDays / 7;
  const pace = st.goalTotal / weeks;
  const elapsed = clamp(daysBetween(p.startDate, todayISO()), 0, totalDays);
  // Paliers = quarts de l'objectif, arrondis au demi-kilo
  const steps = [0.25, 0.5, 0.75, 1].map(f => Math.round(st.goalTotal * f * 2) / 2).filter((v, i, a) => v > 0 && a.indexOf(v) === i);
  const bk = readBackup();
  const reasons = { import: 'avant import', migration: 'avant conversion', reset: 'avant remise à zéro', restore: 'avant restauration' };
  const [main, bonus] = rep.weight.goals;

  $('#view-goals').innerHTML = `
    <div class="eyebrow">Mission principale</div>
    <h1>Objectifs</h1>
    <p class="quote">Un objectif sans date, c'est juste un souhait.</p>

    <div class="card glow">
      <div class="row between">
        <div><div class="eyebrow">Départ</div><div class="session-desc" style="margin:4px 0">${fmtNum(p.startWeight)} kg</div></div>
        <div style="font-size:22px" class="grad-text">⟶</div>
        <div style="text-align:right"><div class="eyebrow">Objectif</div><div class="session-desc grad-text" style="margin:4px 0">${fmtNum(p.goalWeight)} kg</div></div>
      </div>
      <div class="bar lime thick" style="margin:10px 0 8px"><i style="width:${clamp(st.lost / st.goalTotal, 0, 1) * 100}%"></i></div>
      <div class="row between small muted"><span>${fmtNum(st.lost)} / ${fmtNum(st.goalTotal)} kg</span><span>Jour ${elapsed} / ${totalDays}</span></div>
      <p class="small muted" style="margin:14px 0 0">Rythme sain visé : environ <b style="color:var(--text)">${fmtNum(pace)} kg / semaine</b>, soit ${fmtNum(st.goalTotal)} kg en ${Math.round(weeks)} semaines. Pas besoin d'aller plus vite.</p>
    </div>

    ${main ? goalCard(main, 'var(--lime)') : ''}
    ${bonus ? goalCard(bonus, 'var(--orange)')
      : '<div class="card"><p class="small muted" style="margin:0">🌟 Envie d\'aller plus loin ? Ajoute un <b style="color:var(--text)">objectif bonus</b> dans ton profil, plus bas. Il viendra après l\'objectif principal, sans changer le rythme conseillé.</p></div>'}

    <div class="section-title"><h2>Paliers</h2></div>
    <div class="card" style="padding:10px"><div class="levels">${steps.map(kg => {
      const hit = st.maxLost >= kg;
      const target = new Date(parseISO(p.startDate).getTime() + kg / st.goalTotal * totalDays * DAY);
      return `<div class="lv-row ${hit ? 'reached current' : ''}">
        <span class="n">${hit ? '✓' : '🎯'}</span><span><b>−${fmtNum(kg)} kg</b> <span class="muted small">· ${fmtNum(p.startWeight - kg)} kg</span></span>
        <span class="xp">${hit ? 'Atteint !' : `vers le ${fmtDate(toISO(target))}`}</span></div>`;
    }).join('')}
    ${bonus ? `<div class="lv-row ${bonus.reached ? 'reached current' : ''}"><span class="n">${bonus.reached ? '✓' : '🌟'}</span><span><b>Bonus −${fmtNum(bonus.total)} kg</b> <span class="muted small">· ${fmtNum(bonus.target)} kg</span></span><span class="xp">${bonus.reached ? 'Atteint !' : 'après l\'objectif'}</span></div>` : ''}
    </div></div>

    <div class="section-title"><h2>Mon profil</h2></div>
    <form class="card" id="profileForm">
      <label class="f">Prénom / pseudo<input name="pname" value="${esc(p.name)}" placeholder="Héros" maxlength="20"></label>
      <div class="grid-2">
        <label class="f">Poids de départ (kg)<input name="startWeight" type="text" inputmode="decimal" autocomplete="off" value="${p.startWeight}" required></label>
        <label class="f">Objectif (kg)<input name="goalWeight" type="text" inputmode="decimal" autocomplete="off" value="${p.goalWeight}" required></label>
        <label class="f">Taille (cm)<input name="height" type="number" min="${LIMITS.height[0]}" max="${LIMITS.height[1]}" value="${p.height || ''}" placeholder="optionnel"></label>
        <label class="f">Objectif bonus (kg)<input name="bonusGoal" type="text" inputmode="decimal" autocomplete="off" value="${p.bonusGoal || ''}" placeholder="optionnel"></label>
        <label class="f">Début du défi<input name="startDate" type="date" value="${p.startDate}" required></label>
        <label class="f">Échéance<input name="endDate" type="date" value="${p.endDate}" required></label>
      </div>
      <button class="btn primary block" type="submit">Enregistrer</button>
    </form>

    <div class="section-title"><h2>Mes données</h2></div>
    <div class="card">
      <p class="small muted" style="margin:0 0 12px">Tout est sauvegardé sur cet appareil. Exporte régulièrement une copie de secours.</p>
      <div class="btns" style="margin:0">
        <button class="btn ghost" data-action="export">⬇ Exporter</button>
        <button class="btn ghost" data-action="import">⬆ Importer</button>
      </div>
      ${bk ? `<button class="btn ghost block" style="margin-top:10px" data-action="restore">↶ Restaurer la copie du ${new Date(bk.savedAt).toLocaleDateString('fr-FR')} (${reasons[bk.reason] || 'copie de secours'})</button>` : ''}
      <button class="btn danger block" style="margin-top:10px" data-action="reset">Recommencer à zéro</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>`;
}

function renderAll() {
  if (!data.onboarded) return renderOnboarding();
  document.title = `Level Up — Opération ${fmtNum(data.profile.goalWeight)} kg`;
  renderTop(); renderHome(); renderTrain(); renderHero(); renderStats(); renderGoals();
  if (pendingLevelUp) { showLevelUp(pendingLevelUp); pendingLevelUp = null; }
}

// ---------- 4. Premier lancement : "Crée ton personnage" ----------
// Chacun saisit son poids actuel, son poids cible et son échéance.
function obValues() {
  const f = $('#obForm'), num = n => parseFloat(String(f[n].value).replace(',', '.'));
  return {
    name: f.pname.value.replace(/[<>]/g, '').trim(), startWeight: num('startWeight'), goalWeight: num('goalWeight'),
    height: Math.round(num('height')) || null, startDate: f.startDate.value, endDate: f.endDate.value,
  };
}

let obStep = 0;
function renderOnboarding() {
  const el = $('#onboard');
  el.classList.add('open');
  if ($('#obForm')) return; // déjà affiché
  const p = data.profile; // en cas de profil incomplet importé, on pré-remplit
  el.innerHTML = `
  <form id="obForm" class="ob" novalidate>
    <div class="ob-head"><div class="brand"><span class="brand-dot"></span>LEVEL UP</div><div class="ob-dots"><i class="on"></i><i></i><i></i></div></div>

    <section class="ob-step active" data-step="0">
      <div class="ob-hero">⚡</div>
      <div class="eyebrow">Nouvelle partie</div>
      <h1>Crée ton personnage</h1>
      <p class="muted">Chaque séance te rapporte de l'XP. Ton personnage monte de niveau… et toi aussi, dans la vraie vie.</p>
      <label class="f">Ton prénom ou pseudo<input name="pname" maxlength="20" placeholder="Héros" autocomplete="given-name" value="${esc(p.name || '')}"></label>
      <div class="btns"><button type="button" class="btn primary" data-ob="next">C'est parti →</button></div>
    </section>

    <section class="ob-step" data-step="1">
      <div class="eyebrow">Étape 2 / 3</div>
      <h1>Ta mission</h1>
      <p class="muted">D'où tu pars, et où tu veux arriver. Tu pourras tout modifier plus tard.</p>
      <div class="grid-2">
        <label class="f">Poids actuel (kg)<input name="startWeight" type="text" inputmode="decimal" autocomplete="off" placeholder="ex. 88" value="${p.startWeight || ''}"></label>
        <label class="f">Poids cible (kg)<input name="goalWeight" type="text" inputmode="decimal" autocomplete="off" placeholder="ex. 78" value="${p.goalWeight || ''}"></label>
      </div>
      <label class="f">Taille (cm) · optionnel<input name="height" type="number" min="100" max="250" inputmode="numeric" placeholder="ex. 175" value="${p.height || ''}"></label>
      <div class="ob-preview" id="obMission"></div>
      <p class="ob-err" id="obErr"></p>
      <div class="btns"><button type="button" class="btn ghost back" data-ob="prev">←</button><button type="button" class="btn primary" data-ob="next">Continuer →</button></div>
    </section>

    <section class="ob-step" data-step="2">
      <div class="eyebrow">Étape 3 / 3</div>
      <h1>Ton échéance</h1>
      <p class="muted">Environ ${fmtNum(HEALTHY_PACE)} kg par semaine, c'est un rythme qui tient dans la durée. On te propose une date sur cette base.</p>
      <div class="grid-2">
        <label class="f">Début<input name="startDate" type="date" value="${esc(p.startDate || todayISO())}"></label>
        <label class="f">Échéance<input name="endDate" type="date" value="${esc(p.endDate || '')}"></label>
      </div>
      <div class="ob-preview" id="obPace"></div>
      <button type="button" class="btn ghost block" data-ob="suggest">↺ Date conseillée</button>
      <p class="ob-err" id="obErr2"></p>
      <div class="btns"><button type="button" class="btn ghost back" data-ob="prev">←</button><button type="submit" class="btn primary">Lancer la mission 🚀</button></div>
    </section>
  </form>`;
  obShow(obStep);
}

function obShow(n) {
  obStep = n;
  document.querySelectorAll('.ob-step').forEach(s => s.classList.toggle('active', +s.dataset.step === n));
  document.querySelectorAll('.ob-dots i').forEach((d, i) => d.classList.toggle('on', i <= n));
  if (n === 2 && !$('#obForm').endDate.value) obSuggest();
  obUpdate();
}

function obSuggest() {
  const v = obValues();
  $('#obForm').endDate.value = suggestedEnd(v.startDate || todayISO(), v.startWeight - v.goalWeight);
  obUpdate();
}

// Aperçus en direct : nom de la mission et rythme par semaine
function obUpdate() {
  const v = obValues();
  const okWeights = !profileError({ startWeight: v.startWeight, goalWeight: v.goalWeight });
  $('#obMission').innerHTML = okWeights
    ? `<div class="eyebrow">Ta mission</div><div class="big grad-text">Opération ${fmtNum(v.goalWeight)} kg</div><div class="muted small">${fmtNum(v.startWeight)} → ${fmtNum(v.goalWeight)} kg · ${fmtNum(v.startWeight - v.goalWeight)} kg à perdre</div>`
    : '';
  const box = $('#obPace');
  const days = C.isValidISO(v.startDate) && C.isValidISO(v.endDate) ? daysBetween(v.startDate, v.endDate) : 0;
  if (okWeights && days >= 7) {
    const weeks = days / 7, pace = (v.startWeight - v.goalWeight) / weeks;
    const [cls, msg] = pace <= 0.75 ? ['ok', 'Rythme sain 👍'] : pace <= 1 ? ['warn', 'Ambitieux mais jouable'] : ['bad', 'Trop rapide : repousse un peu l\'échéance'];
    box.className = `ob-preview ${cls}`;
    box.innerHTML = `<div class="big">${fmtNum(pace, 2)} kg <small class="muted">/ semaine</small></div><div class="small">${Math.round(weeks)} semaines · ${days} jours · <b>${msg}</b></div>`;
  } else { box.className = 'ob-preview'; box.innerHTML = ''; }
}

function obNext() {
  if (obStep === 1) {
    const v = obValues();
    const err = profileError({ startWeight: v.startWeight, goalWeight: v.goalWeight });
    $('#obErr').textContent = err;
    if (err) return;
  }
  obShow(Math.min(2, obStep + 1));
}

function obFinish() {
  const v = obValues();
  const err = profileError(v);
  $('#obErr2').textContent = err;
  if (err) return;
  $('#onboard').classList.remove('open');
  $('#onboard').innerHTML = '';
  obStep = 0;
  // On ne touche qu'au profil : les séances et pesées éventuelles sont conservées
  commit(d => { d.profile = v; d.onboarded = true; }, { silent: true });
  go('home');
  toast('🚀', `Mission « Opération ${fmtNum(v.goalWeight)} kg » lancée !`, 'badge');
}

// ---------- 5. Séances, pesées, import / export ----------
function toast(big, small, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(big)}</b><span>${esc(small)}</span>`;
  const box = $('#toasts');
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove(); // 3 notifications max à l'écran
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
}

function showLevelUp(L) {
  const colors = ['#c6ff3d', '#22d3ee', '#8b5cf6', '#ff8a3d', '#ff4d8d'];
  const confetti = Array.from({ length: 60 }, () =>
    `<i class="confetti" style="left:${Math.random() * 100}%;background:${colors[Math.floor(Math.random() * colors.length)]};animation-duration:${2 + Math.random() * 2.5}s;animation-delay:${Math.random() * .6}s"></i>`).join('');
  const el = $('#levelup');
  el.innerHTML = `${confetti}<div class="lu-box">
    <div class="lu-tag">LEVEL UP</div><div class="lu-n">${L.n}</div><div class="lu-title">${L.title}</div>
    <p class="muted">Nouveau rang débloqué. Continue comme ça !</p>
    <button class="btn primary" style="margin-top:14px" data-action="close-levelup">Continuer</button></div>`;
  el.classList.add('open');
  beep(660, 0.12); setTimeout(() => beep(880, 0.2), 140);
  vibrate([80, 60, 160]);
}

// Modale "Enregistrer / modifier une séance" (hors programme, ou modification)
// Une séance du programme se valide au chrono, ou se « déclare » (voir openDeclare).
function openLog(pre = {}) {
  const editing = pre.editId ? data.sessions.find(s => s.id === pre.editId) : null;
  const can = editing ? C.editableFields(editing) : { type: true, duration: true, date: true, distance: true, feel: true };
  const d = { type: 'walk', date: todayISO(), duration: 30, feel: 2, ...(editing || {}), ...pre };
  const km = editing ? C.sessionKm(editing) : 0;
  const radio = (name, val, cur, inner, disabled) =>
    `<input type="radio" name="${name}" id="${name}-${val}" value="${val}" ${String(val) === String(cur) ? 'checked' : ''} ${disabled ? 'disabled' : ''}><label for="${name}-${val}">${inner}</label>`;
  const status = editing && editing.program ? editing.program.status : null;
  const lockNote = !editing ? '' : editing.timing
    ? '⏱️ Mesurée par le chrono : type, durée et date ne sont plus modifiables.'
    : status === 'declaree' ? '✍️ Séance déclarée : elle reste marquée comme telle.'
    : status === 'historique' ? '📜 Historique : validée selon l\'ancienne règle.' : '';

  $('#sheet').innerHTML = `<div class="grab"></div>
    <h2 style="margin-bottom:14px">${editing ? 'Modifier la séance' : pre.swap ? '🚶 Marche à la place de la course' : 'Nouvelle séance'}</h2>
    ${!editing && pre.swap ? '<p class="small muted" style="margin:-6px 0 12px">Bonne idée si tu es fatigué : elle compte pour ta régularité, et le programme t\'attend à la même étape.</p>' : ''}
    ${lockNote ? `<p class="small muted" style="margin:-6px 0 12px">${lockNote}</p>` : ''}
    <form id="logForm" novalidate>
      <div class="seg">${Object.entries(TYPE).map(([k, t]) => radio('type', k, d.type, `<span>${t.icon}</span>${t.name}`, !can.type)).join('')}</div>
      <div class="grid-2">
        <label class="f">Durée (min)<input name="duration" type="number" min="${LIMITS.duration[0]}" max="${LIMITS.duration[1]}" inputmode="numeric" value="${esc(d.duration)}" ${can.duration ? '' : 'readonly'} required></label>
        <label class="f">Distance (km)<input name="distance" type="text" inputmode="decimal" autocomplete="off" value="${km ? esc(String(km).replace('.', ',')) : ''}" placeholder="optionnel"></label>
      </div>
      <label class="f">Date<input name="date" type="date" value="${esc(d.date)}" max="${todayISO()}" ${can.date ? '' : 'readonly'} required></label>
      <div class="small muted">Ressenti</div>
      ${feelSeg('feel', d.feel)}
      ${!editing ? '<p class="small muted" id="runHint" style="margin:-6px 0 12px;display:none">Séance du programme ? Utilise le chrono, ou « ✍️ Déclarer » sur la carte du programme.</p>' : ''}
      <p class="ob-err" id="logErr"></p>
      <button class="btn primary block" type="submit">${editing ? 'Enregistrer les modifications' : 'Valider et gagner l\'XP ⚡'}</button>
    </form>`;
  $('#modal').classList.add('open');

  const form = $('#logForm');
  const hint = () => { if ($('#runHint')) $('#runHint').style.display = form.type.value === 'run' ? '' : 'none'; };
  hint();
  form.addEventListener('change', hint);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    if (btn.disabled) return; // évite la double validation (double tap)
    const type = can.type ? form.type.value : editing.type;
    const duration = can.duration ? Math.round(parseFloat(form.duration.value)) : editing.duration;
    const date = can.date ? form.date.value : editing.date;
    const kmText = form.distance.value.trim();
    const dist = kmText ? Math.round(parseDec(kmText) * 100) / 100 : 0;
    const feel = +form.feel.value;
    // Vérifications
    const plannedMin = editing && editing.program && editing.program.plannedMin;
    const err = !C.isValidISO(date) || date > todayISO() ? 'Choisis une date valide (pas dans le futur).'
      : !(duration >= LIMITS.duration[0] && duration <= LIMITS.duration[1]) ? `Durée entre ${LIMITS.duration[0]} et ${LIMITS.duration[1]} min.`
      : status === 'declaree' && plannedMin && duration < plannedMin ? `Durée incohérente : la séance déclarée dure au moins ${plannedMin} min.`
      : C.distanceError(type, dist, duration);
    $('#logErr').textContent = err;
    if (err) return;

    // Distance + source : une distance mesurée corrigée à la main garde sa mesure d'origine
    let distance;
    if (dist > 0) {
      const old = editing && editing.distance;
      distance = old && old.source !== 'manuel' && old.km !== dist
        ? { km: dist, source: 'manuel', measuredKm: old.measuredKm || old.km, corrected: true }
        : old && old.km === dist ? old : { km: dist, source: 'manuel' };
    }
    const entry = { type, duration, date, feel };
    if (!editing && pre.swap && type === 'walk') entry.swap = true; // marche faite à la place d'une course
    if (!editing && !confirmNewSession({ ...entry, km: dist })) return;
    btn.disabled = true;
    closeModal();
    if (editing) {
      commit(dd => {
        const i = dd.sessions.findIndex(x => x.id === editing.id);
        if (i < 0) return;
        const next = { ...dd.sessions[i], ...entry };
        if (distance) next.distance = distance; else delete next.distance;
        dd.sessions[i] = next;
      });
      toast('✓', 'Séance modifiée · totaux recalculés', 'badge');
    } else {
      commit(dd => dd.sessions.push({ id: C.newId(), createdAt: Date.now(), ...entry, ...(distance ? { distance } : {}) }));
    }
  });
}
const closeModal = () => $('#modal').classList.remove('open');

// Modale "Déclarer une séance du programme" : pour une séance faite SANS le chrono.
// Elle fait avancer le programme, mais reste marquée « Déclarée » : ni record ni succès « non-stop ».
function openDeclare() {
  const ps = programSession(D.programStep);
  const runs = PROGRAM[Math.floor(ps.step / 3)];
  const runText = runs.reps > 1 ? `${runs.reps} × ${fmtMin(runs.run)} de course` : `${runs.run} min de course continue`;
  $('#sheet').innerHTML = `<div class="grab"></div>
    <h2 style="margin-bottom:6px">✍️ Déclarer S${ps.week} · Séance ${ps.session}</h2>
    <p class="small muted" style="margin:0 0 14px;line-height:1.5">Pour une séance faite <b>sans le chrono</b> (montre, téléphone déchargé…). Elle fera avancer le programme, mais restera marquée <b>« Déclarée »</b> : pas de record ni de succès « non-stop », qui demandent une mesure réelle.</p>
    <div class="card" style="padding:12px 14px;margin-bottom:14px"><div class="eyebrow">Prévu</div><b>${ps.desc}</b><div class="small muted">${ps.total} min avec l'échauffement et le retour au calme</div></div>
    <form id="declForm" novalidate>
      <div class="grid-2">
        <label class="f">Durée (min)<input name="duration" type="number" min="${ps.total}" max="${LIMITS.duration[1]}" inputmode="numeric" value="${ps.total}" required></label>
        <label class="f">Distance (km)<input name="distance" type="text" inputmode="decimal" autocomplete="off" placeholder="optionnel"></label>
      </div>
      <label class="f">Date<input name="date" type="date" value="${todayISO()}" max="${todayISO()}" required></label>
      <div class="small muted">Ressenti</div>
      ${feelSeg('dfeel')}
      <label class="check"><input type="checkbox" name="confirmed"> Je confirme avoir réalisé toutes les courses prévues (${runText}).</label>
      <p class="ob-err" id="declErr"></p>
      <button class="btn primary block" type="submit">✍️ Déclarer la séance</button>
    </form>`;
  $('#modal').classList.add('open');

  const form = $('#declForm');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    if (btn.disabled) return;
    const kmText = form.distance.value.trim();
    const d = {
      confirmed: form.confirmed.checked,
      date: form.date.value,
      duration: Math.round(parseFloat(form.duration.value)),
      km: kmText ? Math.round(parseDec(kmText) * 100) / 100 : 0,
      feel: +form.feel.value,
    };
    const err = d.date > todayISO() ? 'Choisis une date valide (pas dans le futur).' : C.declarationError(d, ps);
    $('#declErr').textContent = err;
    if (err) return;
    const entry = {
      type: 'run', date: d.date, duration: d.duration, feel: d.feel,
      program: { status: 'declaree', step: ps.step, intervalsPlanned: runs.reps, runPlannedSec: ps.runPlannedSec, plannedMin: ps.total },
      ...(d.km > 0 ? { distance: { km: d.km, source: 'manuel' } } : {}),
    };
    if (!confirmNewSession({ ...entry, km: d.km })) return;
    btn.disabled = true;
    closeModal();
    commit(dd => dd.sessions.push({ id: C.newId(), createdAt: Date.now(), ...entry }));
  });
}

// Doublons probables (saisie manuelle, déclaration et chrono)
const isProgramDone = x => x.program && ['validee', 'declaree', 'historique'].includes(x.program.status);
function confirmNewSession(entry) {
  const twin = data.sessions.some(x => x.date === entry.date && x.type === entry.type && x.duration === entry.duration && C.sessionKm(x) === (entry.km || 0));
  if (twin && !confirm('Une séance identique existe déjà ce jour-là. L\'enregistrer quand même ?')) return false;
  if (isProgramDone(entry) && data.sessions.some(x => isProgramDone(x) && x.date === entry.date) &&
    !confirm('Tu as déjà validé une séance du programme ce jour-là. Le corps progresse pendant le repos : l\'enregistrer quand même ?')) return false;
  return true;
}

function deleteSession(id) {
  const s = data.sessions.find(x => x.id === id);
  if (!s || !confirm('Supprimer cette séance ? L\'XP, les bonus et les succès seront recalculés.')) return;
  commit(d => { d.sessions = d.sessions.filter(x => x.id !== id); }, { silent: true });
  toast('✓', 'Séance supprimée · totaux recalculés', 'badge');
}

function addWeight(kg, date) {
  const existed = data.weights.some(w => w.date === date);
  commit(d => { d.weights = d.weights.filter(w => w.date !== date); d.weights.push({ date, kg }); });
  if (existed) toast('✓', 'Pesée du jour mise à jour', 'badge');
}

function deleteWeight(date) {
  if (!confirm(`Supprimer la pesée du ${fmtDate(date)} ?`)) return;
  commit(d => { d.weights = d.weights.filter(w => w.date !== date); }, { silent: true });
  toast('✓', 'Pesée supprimée · totaux recalculés', 'badge');
}

async function exportData() {
  const json = C.serialize(data);
  const name = `levelup-sauvegarde-${todayISO()}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  // Sur iPhone (surtout en mode application installée), le partage est plus fiable que le téléchargement
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && navigator.canShare) {
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Sauvegarde LEVEL UP' }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('⬇', 'Sauvegarde exportée', 'badge');
}

async function importFile(file) {
  let parsed;
  try {
    if (file.size > 5e6) throw new Error('Fichier trop volumineux pour être une sauvegarde.');
    parsed = C.normalizeData(JSON.parse(await file.text()));
  } catch (e) {
    alert(`Import impossible : ${e instanceof SyntaxError ? 'ce fichier n\'est pas un fichier JSON valide.' : e.message}`);
    return;
  }
  const { data: incoming, report } = parsed;
  const preview = C.derive(incoming);
  const dropped = report.droppedSessions + report.droppedWeights;
  const msg = `Importer cette sauvegarde ?\n\n` +
    `• Pseudo : ${incoming.profile.name || '—'}\n` +
    `• ${report.sessions} séance(s), ${report.weights} pesée(s)\n` +
    `• ${preview.xp} XP · niveau ${preview.level.n} (${preview.level.title})\n` +
    (dropped ? `• Ignorées car invalides : ${report.droppedSessions} séance(s), ${report.droppedWeights} pesée(s)\n` : '') +
    (incoming.onboarded ? '' : '• Profil incomplet : il te sera demandé de le compléter\n') +
    `\n⚠️ Tes données actuelles (${data.sessions.length} séance(s), ${data.weights.length} pesée(s)) seront remplacées.\nUne copie de secours est gardée sur cet appareil (bouton « Restaurer »).`;
  if (!confirm(msg)) return;
  backup('import');
  data = incoming;
  D = C.derive(data);
  save();
  renderAll();
  go('home');
  toast('✓', 'Sauvegarde importée', 'badge');
}

function restoreBackup() {
  const bk = readBackup();
  if (!bk) return;
  const { report } = bk.parsed;
  if (!confirm(`Restaurer la copie de secours du ${new Date(bk.savedAt).toLocaleString('fr-FR')} ?\n(${report.sessions} séance(s), ${report.weights} pesée(s))\n\nTes données actuelles deviendront à leur tour la copie de secours.`)) return;
  const restored = bk.parsed.data;
  backup('restore');
  data = restored;
  D = C.derive(data);
  save();
  renderAll();
  go('home');
  toast('✓', 'Copie de secours restaurée', 'badge');
}

// ---------- 6. Assistant de course (chronomètre) ----------
// Le temps est calculé à partir de l'horloge (voir core.js), donc il reste juste
// même si le téléphone ralentit ou suspend l'app. L'état est enregistré : si
// l'app est fermée en pleine séance (ou sur l'écran de bilan), elle reprend au
// même point à la réouverture.
//
// Limites d'iOS (Safari et app installée) :
//  - écran verrouillé ou app en arrière-plan : iOS suspend la page. Aucune annonce
//    ni aucun bip n'est possible pendant ce temps. Au retour, le chrono est exact
//    et la phase en cours est annoncée.
//  - la vibration n'existe pas sur iPhone ;
//  - la voix et le son doivent être "débloqués" par un toucher : c'est fait sur
//    le bouton « Lancer le chrono » ;
//  - le bouton silencieux de l'iPhone peut couper les bips.

// Réglages, propres à l'appareil (pas dans la sauvegarde)
const SETTINGS_KEY = 'levelup-settings';
let settings = (() => { try { return C.normSettings(JSON.parse(storage.get(SETTINGS_KEY))); } catch (e) { return C.normSettings(null); } })();
const saveSettings = () => storage.set(SETTINGS_KEY, JSON.stringify(settings));

let audioCtx = null;
function unlockAudio() {
  // Doit être appelé pendant un toucher de l'utilisateur (règle d'iOS)
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* pas de son disponible */ }
}
function beep(freq = 880, dur = 0.15, force = false) {
  if (!settings.sounds && !force) return;
  try {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(0.3, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* pas de son disponible */ }
}
const canVibrate = typeof navigator.vibrate === 'function';
// La vibration n'existe pas sur iPhone : on l'appelle seulement si elle est disponible
function vibrate(pattern) { if (!settings.vibration || !canVibrate) return; try { navigator.vibrate(pattern); } catch (e) { /* ignore */ } }

// Voix française (synthèse vocale du système)
const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
function frenchVoices() {
  if (!canSpeak) return [];
  try { return speechSynthesis.getVoices().filter(v => /^fr([-_]|$)/i.test(v.lang)); } catch (e) { return []; }
}
function speak(text, force = false) {
  if (!canSpeak || !text || (!settings.voice && !force)) return;
  try {
    speechSynthesis.cancel(); // une annonce remplace la précédente, pas de file d'attente
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    const voices = frenchVoices();
    const v = voices.find(x => x.name === settings.voiceName) || voices.find(x => x.lang === 'fr-FR') || voices[0];
    if (v) u.voice = v;
    u.volume = settings.voiceVolume;
    speechSynthesis.speak(u);
  } catch (e) { /* synthèse vocale indisponible */ }
}
if (canSpeak && speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', () => { if ($('#assistCard')) renderTrain(); });

const fmtClock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtMinSec = ms => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')}` : ''}` : `${s} s`; };

let runner = null; // { t: chrono de core.js, meta, marks, stage: 'run' | 'summary', end, interval, wake }

function startRunner() {
  if (runner) return showRunner(); // un seul chrono à la fois (évite le double démarrage)
  unlockAudio();
  const ps = programSession(D.programStep);
  runner = {
    t: C.createTimer(ps.segs.map(s => ({ ...s, sec: s.min * 60 })), Date.now(), { countdownSec: settings.countdown ? 5 : 0 }),
    meta: { step: ps.step, week: ps.week, session: ps.session, done: ps.done }, marks: C.initialMarks(), stage: 'run',
  };
  persistRunner();
  // Prononcé pendant le toucher : c'est ce qui autorise la voix ensuite sur iPhone
  speak(C.CUES.ready);
  showRunner();
}

const persistRunner = () => {
  if (runner && runner.t) storage.set(TIMER_KEY, JSON.stringify({ t: runner.t, meta: runner.meta, stage: runner.stage, end: runner.end || null, measured: runner.measured || null }));
};

function showRunner() {
  if (!runner) return;
  $('#runner').classList.add('open');
  const free = runner.mode === 'free';
  if (free && runner.stage === 'ready') return drawFreeReady();
  if (runner.stage === 'summary') return free ? drawFreeSummary() : drawSummary();
  if (free) buildFree(); else buildRunner();
  clearInterval(runner.interval);
  runner.interval = setInterval(tickRunner, 200);
  requestWake();
  tickRunner();
}

function closeRunner() {
  if (!runner) return;
  clearInterval(runner.interval);
  try { if (runner.wake) runner.wake.release(); } catch (e) { /* ignore */ }
  runner = null;
  storage.del(TIMER_KEY);
  const r = $('#runner');
  r.className = 'runner'; // retire aussi countdown / summary, qui forcent l'affichage
  r.innerHTML = '';
}

// Garde l'écran allumé. Le navigateur libère ce verrou quand l'app passe en
// arrière-plan : on le redemande à chaque retour au premier plan.
async function requestWake() {
  try {
    if (!runner || runner.stage !== 'run' || runner.wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    const lock = await navigator.wakeLock.request('screen');
    if (!runner || runner.stage !== 'run') { lock.release(); return; }
    runner.wake = lock;
    lock.addEventListener('release', () => { if (runner && runner.wake === lock) { runner.wake = null; updateHint(); } });
    updateHint();
  } catch (e) { /* non disponible : l'écran pourra s'éteindre */ }
}

function tickRunner() {
  if (runner && runner.mode === 'free') return tickFree();
  if (!runner || runner.stage !== 'run') return;
  const { st, events, marks } = C.timerCues(runner.t, runner.marks, Date.now(), settings.warn10 ? 10 : 0);
  runner.marks = marks;
  for (const ev of events) {
    if (ev.type === 'countdown') {
      beep(ev.n === 1 ? 990 : 660, 0.12);
      vibrate(60);
      if (ev.n <= 3) speak(String(ev.n));
    } else if (ev.type === 'catchup') {
      toast('⏱', `${ev.jumped} phase${ev.jumped > 1 ? 's' : ''} passée${ev.jumped > 1 ? 's' : ''} pendant ton absence`, 'badge');
    } else if (ev.type === 'phase') {
      beep(ev.seg.kind === 'run' ? 990 : 520, 0.4);
      vibrate(ev.seg.kind === 'run' ? [200, 100, 200] : [400]);
      speak(C.phaseCue(ev.seg));
    } else if (ev.type === 'warn') {
      beep(880, 0.1); setTimeout(() => beep(880, 0.1), 180);
      vibrate([80, 80, 80]);
      speak(C.warnCue(ev.next));
    } else if (ev.type === 'done') {
      return endRunner(false);
    }
  }
  updateRunner(st);
}

// L'écran du chrono est construit une seule fois ; ensuite on ne change que
// les textes. Les boutons ne sont donc jamais recréés sous le doigt
// (un toucher sur "Pause" ne peut plus être perdu).
function buildRunner() {
  const r = $('#runner');
  r.innerHTML = `
    <div class="r-top">
      <span id="rTitle">${runner.meta.done ? 'Entretien' : `S${runner.meta.week} · Séance ${runner.meta.session}`}</span>
      <span class="r-icons">
        <button class="r-ico" id="rVoice" data-action="toggle-voice"></button>
        <button class="r-ico" id="rSound" data-action="toggle-sounds"></button>
      </span>
    </div>
    <div class="bar" style="margin-top:12px"><i id="rBar" style="width:0%;background:linear-gradient(90deg,var(--cyan),var(--lime))"></i></div>
    <div class="r-stats"><span>⏱ <b id="rElapsed">0:00</b></span><span>🏃 <b id="rRuns">0/0</b> intervalles</span><span id="rPhaseNo"></span></div>
    <div class="r-mid">
      <div class="eyebrow" id="rLabel"></div>
      <div class="phase" id="rPhase"></div>
      <div class="time" id="rTime"></div>
      <div class="next" id="rNext"></div>
    </div>
    <p class="r-hint" id="rHint"></p>
    <div class="r-ctrl" id="rCtrl"></div>`;
  runner.ctrlKey = null;
  updateIcons();
  updateHint();
}

function updateIcons() {
  const v = $('#rVoice'), s = $('#rSound');
  if (v) { v.textContent = settings.voice ? '🗣️' : '🔇'; v.setAttribute('aria-label', settings.voice ? 'Couper la voix' : 'Activer la voix'); v.classList.toggle('off', !settings.voice); }
  if (s) { s.textContent = settings.sounds ? '🔔' : '🔕'; s.setAttribute('aria-label', settings.sounds ? 'Couper les bips' : 'Activer les bips'); s.classList.toggle('off', !settings.sounds); }
}

function updateHint() {
  const h = $('#rHint');
  if (!h || !runner) return;
  h.textContent = runner.wake
    ? '🔆 Écran maintenu allumé. Ne le verrouille pas : verrouillé, le téléphone coupe les annonces.'
    : '⚠️ Garde l\'écran allumé : s\'il se verrouille, les annonces s\'arrêtent (le chrono, lui, reste juste).';
}

const nextName = seg => (seg.kind === 'run' ? 'course' : seg.label === 'Marche' ? 'récupération' : 'marche');

function updateRunner(st) {
  const { segs } = runner.t;
  const r = $('#runner');
  const set = (id, txt) => { const el = document.getElementById(id); if (el && el.textContent !== txt) el.textContent = txt; };
  $('#rBar').style.width = `${st.positionMs / st.totalMs * 100}%`;
  set('rElapsed', fmtClock(st.activeMs));
  set('rRuns', `${st.runsDone}/${st.runsTotal}`);

  let mode;
  if (st.countdown) {
    mode = 'countdown';
    r.className = 'runner open countdown';
    set('rPhaseNo', '');
    set('rLabel', 'Prépare-toi');
    set('rPhase', 'DÉPART');
    set('rTime', String(st.countdownSec));
    set('rNext', `Puis : ${segs[0].label.toLowerCase()} · ${nextName(segs[0])} ${fmtMin(segs[0].sec / 60)}`);
  } else {
    const seg = segs[st.idx], next = segs[st.idx + 1];
    mode = st.paused ? 'paused' : 'active';
    const warn = !st.paused && st.leftMs <= 10000;
    r.className = `runner open ${seg.kind}${warn ? ' warn' : ''}${st.paused ? ' paused' : ''}`;
    set('rPhaseNo', `Phase ${st.idx + 1}/${segs.length}`);
    set('rLabel', st.paused ? '⏸ En pause' : seg.label);
    set('rPhase', `${C.phaseName(seg)} ${seg.kind === 'run' ? '🏃' : '🚶'}`);
    set('rTime', fmtClock(st.leftMs));
    set('rNext', next ? `Ensuite : ${nextName(next)} ${fmtMin(next.sec / 60)}` : 'Dernière phase, tu y es presque !');
  }
  // Boutons : reconstruits seulement quand le mode change
  if (runner.ctrlKey !== mode) {
    runner.ctrlKey = mode;
    $('#rCtrl').innerHTML = mode === 'countdown'
      ? `<button class="btn ghost" data-action="runner-cancel">✕ Annuler</button>
         <button class="btn primary" data-action="runner-now">▶ Partir maintenant</button>`
      : `<button class="btn ghost" data-action="runner-stop">■ Arrêter</button>
         <button class="btn primary" data-action="runner-pause">${mode === 'paused' ? '▶ Reprendre' : '❚❚ Pause'}</button>
         <button class="btn ghost" data-action="runner-skip" aria-label="Passer à la phase suivante">⏭</button>`;
  }
}

// Fin de séance (naturelle ou arrêt) : on fige l'heure de fin et on montre le bilan
function endRunner(stopped) {
  if (runner && runner.mode === 'free') return endFree(stopped);
  if (!runner || runner.stage !== 'run') return;
  const now = Date.now();
  if (runner.t.pausedAt === null) C.timerPause(runner.t, now); // fige le chrono
  clearInterval(runner.interval);
  try { if (runner.wake) runner.wake.release(); } catch (e) { /* ignore */ }
  runner.wake = null;
  runner.stage = 'summary';
  runner.end = { at: now, stopped };
  persistRunner();
  if (!stopped) { beep(660, 0.15); setTimeout(() => beep(990, 0.3), 160); vibrate([100, 50, 100, 50, 300]); speak(C.CUES.done); }
  drawSummary();
}

// Étape du programme suivie par ce chrono (anciens chronos : déduite de semaine/séance)
const runnerStep = () => (Number.isFinite(runner.meta.step) ? runner.meta.step : ((runner.meta.week || 1) - 1) * 3 + (runner.meta.session || 1) - 1);

function summaryEntry() {
  const sum = C.timerSummary(runner.t, runner.end.at);
  const f = $('#sumForm');
  const kmText = f ? f.distance.value.trim() : '';
  const km = kmText ? Math.round(parseDec(kmText) * 100) / 100 : 0; // NaN si illisible : refusé à l'enregistrement
  const status = C.timerProgramStatus(sum); // fixé par le chrono, jamais par une case à cocher
  const ps = programSession(runnerStep());
  const startMs = Math.min(runner.t.startedAt, runner.end.at);
  return {
    sum, km, status,
    entry: {
      type: 'run',
      date: C.toISO(new Date(startMs)),
      duration: Math.max(1, Math.round(sum.activeMs / 60000)),
      feel: f ? +f.feel.value : 2,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(runner.end.at).toISOString(),
      timing: {
        activeSec: Math.round(sum.activeMs / 1000),
        runSec: Math.round(sum.runMs / 1000),
        walkSec: Math.round(sum.walkMs / 1000),
        maxRunSec: Math.round(sum.longestRunMs / 1000), // plus longue course d'une traite (records)
        pausedSec: Math.round(runner.t.pausedMs / 1000),
      },
      program: { status, step: ps.step, intervalsDone: sum.runsDone, intervalsPlanned: sum.runsTotal, runPlannedSec: Math.round(sum.plannedRunMs / 1000), plannedMin: ps.total },
      ...(km > 0 ? { distance: { km, source: 'manuel' } } : {}),
    },
  };
}

// Aperçu de l'XP gagnée si on enregistre (calcul exact via core.js)
function summaryXP(entry) {
  const trial = { ...data, sessions: [...data.sessions, { id: 'apercu', createdAt: Date.now(), ...entry }] };
  return C.derive(trial).xp - D.xp;
}

function drawSummary() {
  const r = $('#runner');
  r.className = 'runner open summary';
  const { sum, status } = summaryEntry();
  const tooShort = sum.activeMs < 60000;
  const ok = status === 'validee';
  const title = ok ? 'Séance validée 🎉' : 'Séance interrompue';
  r.innerHTML = `
    <div class="sum-box">
      <div class="eyebrow">${runner.meta.done ? 'Entretien' : `S${runner.meta.week} · Séance ${runner.meta.session}`}</div>
      <h1>${title}</h1>
      <div class="sum-status ${ok ? 'ok' : 'ko'}">
        ${ok ? `⏱️ <b>Validée par le chrono</b> : ${sum.runsDone}/${sum.runsTotal} intervalles de course faits.`
          : `⏸️ <b>Interrompue</b> : ${sum.runsDone}/${sum.runsTotal} intervalles faits à 90 % ou plus. Elle est enregistrée avec l'XP de l'effort réel, mais le programme reste à cette étape.`}
      </div>
      <div class="grid-2">
        <div class="tile accent"><div class="v">${fmtMinSec(sum.activeMs)}</div><div class="l">Durée réelle</div></div>
        <div class="tile"><div class="v">${sum.runsDone}/${sum.runsTotal}</div><div class="l">Intervalles terminés</div></div>
        <div class="tile"><div class="v" style="color:var(--lime)">${fmtMinSec(sum.runMs)}</div><div class="l">Temps de course</div></div>
        <div class="tile"><div class="v" style="color:var(--cyan)">${fmtMinSec(sum.walkMs)}</div><div class="l">Temps de marche</div></div>
      </div>
      ${tooShort ? '<p class="ob-err" style="margin-top:14px">Moins d\'une minute d\'effort : rien à enregistrer.</p>' : `
      <form id="sumForm" novalidate style="margin-top:16px">
        <label class="f">Distance parcourue (km) · optionnel<input name="distance" type="text" inputmode="decimal" autocomplete="off" placeholder="ex. 3,2"></label>
        <div class="small muted">Ressenti</div>
        ${feelSeg('sfeel')}
        <p class="small muted" id="sumNote" style="margin:-6px 0 12px"></p>
        <p class="ob-err" id="sumErr"></p>
        <button class="btn primary block" type="submit" id="sumSave">Enregistrer</button>
      </form>`}
      <button class="btn ghost block" style="margin-top:10px" data-action="sum-discard">${tooShort ? 'Fermer' : 'Ne pas enregistrer'}</button>
    </div>`;
  if (!tooShort) updateSummary();
}

// Met à jour l'aperçu d'XP et l'explication du programme selon le ressenti
function updateSummary() {
  if (runner && runner.mode === 'free') return updateFreeSummary();
  if (!runner || runner.stage !== 'summary' || !$('#sumForm')) return;
  const { entry, status, km } = summaryEntry();
  const note = status !== 'validee' ? 'XP calculée sur ton temps de course réel.'
    : entry.feel >= 4 ? 'Très difficile : l\'étape sera répétée, et le coach te proposera de revenir un cran en arrière.'
    : entry.feel === 3 ? 'Ressenti difficile : l\'étape sera répétée.' : 'Le programme passera à l\'étape suivante.';
  $('#sumNote').textContent = note;
  const xp = summaryXP(Number.isFinite(km) ? entry : { ...entry, distance: undefined });
  $('#sumSave').textContent = `Enregistrer · +${xp} XP ⚡`;
}

function saveSummary() {
  if (runner && runner.mode === 'free') return saveFreeSummary();
  if (!runner || runner.stage !== 'summary') return;
  const { entry, km } = summaryEntry();
  const err = C.distanceError('run', km, entry.duration);
  $('#sumErr').textContent = err;
  if (err) return;
  if (!confirmNewSession({ ...entry, km })) return;
  closeRunner();
  commit(d => d.sessions.push({ id: C.newId(), createdAt: Date.now(), ...entry }));
}

// ---------- 6 bis. Séance libre (course ou marche au chrono, hors programme) ----------
// Même écran que le chrono du programme (même design), sans intervalles.
// Le programme guidé n'avance jamais avec une séance libre.
// GPS (plus tard) : il suffira de remplir runner.measured = { km, source: 'gps' } pendant
// la séance ; l'affichage et l'enregistrement l'utiliseront à la place de la saisie manuelle.
const FREE_NAME = { run: 'Course libre', walk: 'Marche libre' };
const FREE_PHASE = { run: 'COURSE LIBRE 🏃', walk: 'MARCHE LIBRE 🚶' };
const FREE_GO = { run: 'C\'est parti. Cours à ton rythme.', walk: 'C\'est parti. Bonne marche.' };

function startFree(kind) {
  if (runner) return showRunner(); // un seul chrono à la fois
  runner = { mode: 'free', kind: kind === 'walk' ? 'walk' : 'run', stage: 'ready', meta: {}, measured: null };
  showRunner();
}

// Écran d'attente : rien ne démarre avant « Démarrer »
function drawFreeReady() {
  const r = $('#runner');
  r.className = `runner open ${runner.kind}`;
  r.innerHTML = `
    <div class="r-top"><span>${FREE_NAME[runner.kind]}</span>
      <span class="r-icons"><button class="r-ico" id="rVoice" data-action="toggle-voice"></button><button class="r-ico" id="rSound" data-action="toggle-sounds"></button></span></div>
    <div class="r-mid">
      <div class="eyebrow">Hors programme</div>
      <div class="phase">${FREE_PHASE[runner.kind]}</div>
      <div class="time">0:00</div>
      <div class="next">À ton rythme, sans intervalles. Elle compte pour tes statistiques, ton XP${runner.kind === 'run' ? ' et tes records' : ''}, mais ne fait pas avancer le programme guidé.</div>
    </div>
    <div class="r-ctrl">
      <button class="btn ghost" data-action="runner-cancel">✕ Annuler</button>
      <button class="btn primary" data-action="free-start">▶ Démarrer</button>
    </div>`;
  updateIcons();
}

function beginFree() {
  if (!runner || runner.mode !== 'free' || runner.stage !== 'ready') return;
  unlockAudio(); // pendant le toucher : autorise le son et la voix sur iPhone
  runner.t = C.createFreeTimer(runner.kind, Date.now(), { countdownSec: settings.countdown ? 5 : 0 });
  runner.marks = C.freeInitialMarks();
  runner.stage = 'run';
  persistRunner();
  speak(settings.countdown ? C.CUES.ready : FREE_GO[runner.kind]);
  showRunner();
}

function buildFree() {
  const r = $('#runner');
  r.innerHTML = `
    <div class="r-top"><span>${FREE_NAME[runner.kind]} · hors programme</span>
      <span class="r-icons"><button class="r-ico" id="rVoice" data-action="toggle-voice"></button><button class="r-ico" id="rSound" data-action="toggle-sounds"></button></span></div>
    <div class="r-stats">
      <span>⏸ <b id="rPause">0:00</b> de pause</span>
      ${runner.kind === 'run' ? '<span>🏃 <b id="rLongest">0:00</b> sans pause</span>' : '<span></span>'}
      <span id="rDist">${runner.measured ? '' : '📍 distance à la fin'}</span>
    </div>
    <div class="r-mid">
      <div class="eyebrow" id="rLabel"></div>
      <div class="phase" id="rPhase"></div>
      <div class="time" id="rTime"></div>
      <div class="next" id="rNext"></div>
    </div>
    <p class="r-hint" id="rHint"></p>
    <div class="r-ctrl" id="rCtrl"></div>`;
  runner.ctrlKey = null;
  updateIcons();
  updateHint();
}

function tickFree() {
  if (!runner || runner.stage !== 'run') return;
  const { st, events, marks } = C.freeCues(runner.t, runner.marks, Date.now());
  runner.marks = marks;
  for (const ev of events) {
    if (ev.type === 'countdown') { beep(ev.n === 1 ? 990 : 660, 0.12); vibrate(60); if (ev.n <= 3) speak(String(ev.n)); }
    else if (ev.type === 'start') { beep(990, 0.4); vibrate([200, 100, 200]); if (settings.countdown) speak(FREE_GO[runner.kind]); }
    else if (ev.type === 'milestone') { beep(880, 0.2); vibrate(150); speak(`${ev.minutes} minutes.`); }
    else if (ev.type === 'capped') { toast('⏱', 'Chrono arrêté automatiquement après 10 h', 'badge'); return endFree(true); }
  }
  updateFree(st);
}

function updateFree(st) {
  const r = $('#runner');
  const set = (id, txt) => { const el = document.getElementById(id); if (el && el.textContent !== txt) el.textContent = txt; };
  let mode;
  if (st.countdown) {
    mode = 'countdown';
    r.className = 'runner open countdown';
    set('rLabel', 'Prépare-toi');
    set('rPhase', 'DÉPART');
    set('rTime', String(st.countdownSec));
    set('rNext', `Puis : ${FREE_NAME[runner.kind].toLowerCase()}, à ton rythme`);
  } else {
    mode = st.paused ? 'paused' : 'active';
    r.className = `runner open ${runner.kind}${st.paused ? ' paused' : ''}`;
    set('rLabel', st.paused ? '⏸ En pause' : 'Temps écoulé');
    set('rPhase', FREE_PHASE[runner.kind]);
    set('rTime', fmtClock(st.activeMs));
    set('rNext', st.paused ? 'Reprends quand tu es prêt.' : 'Termine quand tu veux.');
    set('rPause', fmtClock(st.pausedMs));
    if (runner.kind === 'run') set('rLongest', fmtClock(st.longestMs));
    if (runner.measured) set('rDist', `📍 ${fmtNum(runner.measured.km, 2)} km`);
  }
  if (runner.ctrlKey !== mode) {
    runner.ctrlKey = mode;
    $('#rCtrl').innerHTML = mode === 'countdown'
      ? `<button class="btn ghost" data-action="runner-cancel">✕ Annuler</button>
         <button class="btn primary" data-action="runner-now">▶ Partir maintenant</button>`
      : `<button class="btn ghost" data-action="runner-stop">■ Terminer</button>
         <button class="btn primary" data-action="runner-pause">${mode === 'paused' ? '▶ Reprendre' : '❚❚ Pause'}</button>`;
  }
}

function endFree(stopped) {
  if (!runner || runner.stage !== 'run') return;
  const now = Date.now();
  if (runner.t.pausedAt === null) C.timerPause(runner.t, now); // fige le chrono
  clearInterval(runner.interval);
  try { if (runner.wake) runner.wake.release(); } catch (e) { /* ignore */ }
  runner.wake = null;
  runner.stage = 'summary';
  runner.end = { at: now, stopped };
  persistRunner();
  beep(660, 0.15); setTimeout(() => beep(990, 0.3), 160); vibrate([100, 50, 100, 50, 300]); speak(C.CUES.done);
  drawFreeSummary();
}

// Bilan : durée mesurée (réductible si le chrono a été oublié), distance, ressenti, XP
function freeEntry() {
  const f = $('#sumForm');
  const kmText = f ? f.distance.value.trim() : '';
  const km = kmText ? Math.round(parseDec(kmText) * 100) / 100 : 0;
  const duration = f ? Math.round(parseFloat(f.duration.value)) : NaN;
  const entry = C.freeSessionEntry(runner.t, runner.end.at, { duration, km: Number.isFinite(km) ? km : 0, feel: f ? +f.feel.value : 2, measured: runner.measured });
  return { entry, km, st: C.freeState(runner.t, runner.end.at) };
}

function drawFreeSummary() {
  const r = $('#runner');
  r.className = 'runner open summary';
  const { st, entry } = freeEntry();
  const tooShort = st.activeMs < 60000;
  const measuredMin = Math.max(1, Math.round(st.activeMs / 60000));
  r.innerHTML = `
    <div class="sum-box">
      <div class="eyebrow">Séance libre · hors programme</div>
      <h1>${FREE_NAME[runner.kind]} terminée 🎉</h1>
      <div class="sum-status ok">⏱️ <b>Mesurée par le chrono</b> : elle compte pour tes statistiques et ton XP${runner.kind === 'run' ? ', et la plus longue course sans pause peut battre ton record' : ''}. Le programme guidé reste à la même étape.</div>
      ${st.capped ? '<p class="ob-err">Le chrono est resté ouvert très longtemps : vérifie la durée avant d\'enregistrer.</p>' : ''}
      <div class="grid-2">
        <div class="tile accent"><div class="v">${fmtMinSec(st.activeMs)}</div><div class="l">Durée réelle</div></div>
        <div class="tile"><div class="v">${fmtMinSec(st.pausedMs)}</div><div class="l">Temps de pause</div></div>
        ${runner.kind === 'run'
          ? `<div class="tile"><div class="v" style="color:var(--lime)">${fmtMinSec(entry.timing.maxRunSec * 1000)}</div><div class="l">Plus long sans pause</div></div>`
          : `<div class="tile"><div class="v" style="color:var(--cyan)">${fmtMinSec(st.activeMs)}</div><div class="l">Temps de marche</div></div>`}
        <div class="tile"><div class="v" id="sumPace">—</div><div class="l">Allure moyenne</div></div>
      </div>
      ${tooShort ? '<p class="ob-err" style="margin-top:14px">Moins d\'une minute d\'effort : rien à enregistrer.</p>' : `
      <form id="sumForm" novalidate style="margin-top:16px">
        <div class="grid-2">
          <label class="f">Durée (min)<input name="duration" type="number" min="1" max="${measuredMin}" inputmode="numeric" value="${measuredMin}"></label>
          <label class="f">Distance (km)<input name="distance" type="text" inputmode="decimal" autocomplete="off" placeholder="${runner.measured ? fmtNum(runner.measured.km, 2) : 'ex. 3,2'}" value="${runner.measured ? String(runner.measured.km).replace('.', ',') : ''}"></label>
        </div>
        <p class="small muted" style="margin:-6px 0 12px">Durée mesurée : ${measuredMin} min. Tu peux la réduire si tu as oublié d'arrêter le chrono, pas l'augmenter.</p>
        <div class="small muted">Ressenti</div>
        ${feelSeg('sfeel')}
        <p class="small muted" id="sumNote" style="margin:-6px 0 12px"></p>
        <p class="ob-err" id="sumErr"></p>
        <button class="btn primary block" type="submit" id="sumSave">Enregistrer</button>
      </form>`}
      <button class="btn ghost block" style="margin-top:10px" data-action="sum-discard">${tooShort ? 'Fermer' : 'Ne pas enregistrer'}</button>
    </div>`;
  if (!tooShort) updateFreeSummary();
}

const fmtPace = (minutes, km) => {
  if (!(km > 0) || !(minutes > 0)) return '—';
  const s = Math.round(minutes * 60 / km);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')} /km`;
};

function updateFreeSummary() {
  if (!runner || runner.stage !== 'summary' || !$('#sumForm')) return;
  const { entry, km } = freeEntry();
  const dist = entry.distance ? entry.distance.km : 0;
  $('#sumPace').textContent = fmtPace(entry.timing.activeSec / 60, dist);
  $('#sumNote').textContent = entry.feel >= 3 ? 'Noté : le coach en tiendra compte pour ta récupération.' : '';
  const xp = summaryXP(Number.isFinite(km) ? entry : { ...entry, distance: undefined });
  $('#sumSave').textContent = `Enregistrer · +${xp} XP ⚡`;
}

function saveFreeSummary() {
  if (!runner || runner.stage !== 'summary') return;
  const { entry, km } = freeEntry();
  const err = C.distanceError(entry.type, km, entry.duration);
  $('#sumErr').textContent = err;
  if (err) return;
  if (!confirmNewSession({ ...entry, km: entry.distance ? entry.distance.km : 0 })) return;
  closeRunner();
  commit(d => d.sessions.push({ id: C.newId(), createdAt: Date.now(), ...entry }));
}

function restoreFree(saved) {
  if (!C.isValidFreeTimer(saved.t) || Date.now() - saved.t.startedAt > 24 * 3600e3) throw new Error('chrono libre périmé');
  runner = { mode: 'free', kind: saved.t.kind, t: saved.t, meta: {}, measured: saved.measured || null,
    stage: saved.stage === 'summary' && saved.end ? 'summary' : 'run', end: saved.end || null };
  if (runner.stage === 'run') runner.marks = C.freeResumeMarks(runner.t, Date.now());
  showRunner();
  if (runner && runner.stage === 'run') toast('⏱', `${FREE_NAME[runner.kind]} en cours reprise`, 'badge');
}

// Chrono resté ouvert lors de la dernière visite (app fermée en pleine séance)
function restoreRunner() {
  const raw = storage.get(TIMER_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (saved.t && saved.t.mode === 'free') return restoreFree(saved);
    if (!C.isValidTimer(saved.t) || Date.now() - saved.t.startedAt > 6 * 3600e3) throw new Error('chrono périmé');
    saved.t.skipped = saved.t.skipped || {};
    runner = { t: saved.t, meta: saved.meta || {}, stage: saved.stage === 'summary' && saved.end ? 'summary' : 'run', end: saved.end || null };
    if (runner.stage === 'summary') { showRunner(); return; }
    runner.marks = C.resumeMarks(runner.t, Date.now(), settings.warn10 ? 10 : 0);
    const st = C.timerState(runner.t, Date.now());
    if (st.done) { runner.marks = C.initialMarks(); runner.marks.idx = st.idx - 1; }
    showRunner();
    if (runner && runner.stage === 'run') toast('⏱', 'Séance en cours reprise', 'badge');
  } catch (e) { storage.del(TIMER_KEY); runner = null; }
}

// Bouton « Tester » des réglages
function testAssistant() {
  unlockAudio();
  beep(990, 0.3, true);
  vibrate([200, 100, 200]);
  if (!canSpeak) return toast('ℹ️', 'Ce navigateur ne propose pas d\'annonces vocales', 'badge');
  speak('Commence à courir. 1 minute.', true);
}

// ---------- 7. Navigation, événements, mise à jour, démarrage ----------
function go(view) {
  if (!document.getElementById(`view-${view}`)) view = 'home';
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.go === view));
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0 });
}

// Le son ne peut être activé que pendant un toucher : on en profite à chaque fois
document.addEventListener('pointerdown', unlockAudio, { passive: true });

// Un seul écouteur de clics pour toute l'app (délégation d'événements)
document.addEventListener('click', e => {
  const ob = e.target.closest('[data-ob]');
  if (ob) return ob.dataset.ob === 'next' ? obNext() : ob.dataset.ob === 'prev' ? obShow(Math.max(0, obStep - 1)) : obSuggest();
  const goBtn = e.target.closest('[data-go]');
  if (goBtn) return go(goBtn.dataset.go);
  const a = e.target.closest('[data-action]');
  if (!a) { if (e.target.id === 'modal') closeModal(); return; }
  switch (a.dataset.action) {
    case 'log': return openLog(a.dataset.type ? { type: a.dataset.type, duration: a.dataset.type === 'walk' ? 30 : a.dataset.type === 'run' ? 20 : 40 } : {});
    case 'declare': return openDeclare();
    case 'swap': return openLog({ type: 'walk', duration: 30, swap: true });
    case 'coach-back': return coachAnswer('step-back', a.dataset.reason);
    case 'coach-keep': return coachAnswer('keep', a.dataset.reason);
    case 'del-adj': return cancelAdjustment(a.dataset.id);
    case 'edit': return openLog({ editId: a.dataset.id });
    case 'del': return deleteSession(a.dataset.id);
    case 'runner': return startRunner();
    case 'free': return startFree(a.dataset.kind);
    case 'free-start': return beginFree();
    case 'runner-pause': {
      if (!runner || runner.stage !== 'run') return;
      const now = Date.now();
      const resume = runner.t.pausedAt !== null;
      if (resume) C.timerResume(runner.t, now); else C.timerPause(runner.t, now);
      persistRunner();
      speak(resume ? C.CUES.resumed : C.CUES.paused);
      return tickRunner();
    }
    case 'runner-skip': if (!runner || runner.stage !== 'run') return; C.timerSkip(runner.t, Date.now()); persistRunner(); return tickRunner();
    case 'runner-now': if (!runner) return; C.timerStartNow(runner.t, Date.now()); persistRunner(); return tickRunner();
    case 'runner-cancel': if (runner) { if (canSpeak) speechSynthesis.cancel(); closeRunner(); } return;
    case 'runner-stop':
      if (runner && runner.stage === 'run' && confirm(runner.mode === 'free' ? 'Terminer la séance ? Tu pourras l\'enregistrer.' : 'Arrêter la séance ? Tu pourras enregistrer le temps déjà fait.')) endRunner(true);
      return;
    case 'sum-discard':
      if (!runner) return;
      if ($('#sumForm') && !confirm('Ne pas enregistrer cette séance ? Elle sera perdue.')) return;
      return closeRunner();
    case 'toggle-voice':
      settings.voice = !settings.voice; saveSettings(); updateIcons();
      if (settings.voice) speak('Annonces activées.'); else if (canSpeak) speechSynthesis.cancel();
      return;
    case 'toggle-sounds': settings.sounds = !settings.sounds; saveSettings(); updateIcons(); beep(880, 0.1); return;
    case 'test-voice': return testAssistant();
    case 'close-levelup': return $('#levelup').classList.remove('open');
    case 'edit-weight': {
      const w = data.weights.find(x => x.date === a.dataset.date);
      if (w) { $('#wKg').value = w.kg; $('#wDate').value = w.date; $('#wKg').focus(); }
      return;
    }
    case 'del-weight': return deleteWeight(a.dataset.date);
    case 'toggle-weights': ui.showAllWeights = !ui.showAllWeights; return renderStats();
    case 'toggle-exploits': ui.showAllExploits = !ui.showAllExploits; return renderHero();
    case 'toggle-xp': ui.showAllXp = !ui.showAllXp; return renderHero();
    case 'stats-period': ui.statsPeriod = a.dataset.v; return renderStats();
    case 'stats-metric': ui.statsMetric = a.dataset.v; return renderStats();
    case 'weight-range': ui.weightRange = a.dataset.v; return renderStats();
    case 'export': return exportData();
    case 'import': return $('#importFile').click();
    case 'restore': return restoreBackup();
    case 'apply-update': return applyUpdate();
    case 'reset':
      if (confirm('Effacer toute ta progression ? Une copie de secours sera gardée sur cet appareil.')) {
        backup('reset'); data = C.emptyData(); D = C.derive(data); save(); obStep = 0; renderAll(); go('home');
      }
      return;
  }
});

// Clavier : Entrée sur une séance du journal = modifier
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && e.target.matches('.h-main.editable')) openLog({ editId: e.target.dataset.id });
});

// Formulaires (création, pesée, profil)
document.addEventListener('submit', e => {
  if (e.target.id === 'obForm') { e.preventDefault(); return obStep < 2 ? obNext() : obFinish(); }
  if (e.target.id === 'sumForm') { e.preventDefault(); return saveSummary(); }
  if (e.target.id === 'weightForm') {
    e.preventDefault();
    const kg = Math.round(parseDec($('#wKg').value) * 10) / 10;
    const date = $('#wDate').value;
    if (!(kg >= LIMITS.weight[0] && kg <= LIMITS.weight[1])) return toast('⚠️', `Poids entre ${LIMITS.weight[0]} et ${LIMITS.weight[1]} kg`, 'badge');
    if (!C.isValidISO(date) || date > todayISO()) return toast('⚠️', 'Date invalide', 'badge');
    addWeight(kg, date);
  }
  if (e.target.id === 'profileForm') {
    e.preventDefault();
    const f = e.target;
    const profile = {
      name: f.pname.value.replace(/[<>]/g, '').trim().slice(0, 20),
      startWeight: Math.round(parseDec(f.startWeight.value) * 10) / 10, goalWeight: Math.round(parseDec(f.goalWeight.value) * 10) / 10,
      bonusGoal: f.bonusGoal.value.trim() ? Math.round(parseDec(f.bonusGoal.value) * 10) / 10 : null,
      height: Math.round(parseFloat(f.height.value)) || null,
      startDate: f.startDate.value, endDate: f.endDate.value,
    };
    const err = profileError(profile);
    if (err) return toast('⚠️', err, 'badge');
    commit(d => { d.profile = profile; });
    toast('✓', 'Profil mis à jour', 'badge');
  }
});

document.addEventListener('change', e => {
  if (e.target.id !== 'importFile' || !e.target.files[0]) return;
  const file = e.target.files[0];
  e.target.value = ''; // permet de réimporter le même fichier
  importFile(file);
});
document.addEventListener('input', e => {
  if (e.target.closest('#obForm')) obUpdate();
  if (e.target.closest('#sumForm')) updateSummary();
});
// Réglages de l'assistant
document.addEventListener('change', e => {
  const key = e.target.dataset && e.target.dataset.setting;
  if (!key) return;
  const value = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'range' ? +e.target.value : e.target.value;
  settings = C.normSettings({ ...settings, [key]: value });
  saveSettings();
  updateIcons();
  if (key === 'voiceName' || key === 'voiceVolume') speak('Voix choisie.', true);
});
window.addEventListener('hashchange', () => go(location.hash.slice(1)));

// Une autre fenêtre de l'app a modifié les données : on se resynchronise
window.addEventListener('storage', e => {
  if (e.key !== STORAGE_KEY) return;
  data = loadData(); D = C.derive(data); renderAll();
});

// Changement de jour (app laissée ouverte après minuit) et retour au premier plan
let currentDay = todayISO();
function checkDay() {
  if (todayISO() === currentDay) return;
  currentDay = todayISO();
  D = C.derive(data);
  renderAll();
}
setInterval(checkDay, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { persistRunner(); return; }
  checkDay();
  if (runner && runner.stage === 'run') { requestWake(); tickRunner(); }
});

// Mise à jour de l'application (PWA) : on propose, on n'impose pas
let waitingWorker = null;
function showUpdate(worker) {
  waitingWorker = worker;
  const bar = $('#updateBar');
  bar.innerHTML = `<span>✨ Nouvelle version disponible</span><button class="btn primary" data-action="apply-update">Mettre à jour</button>`;
  bar.classList.add('open');
}
function applyUpdate() {
  if (!waitingWorker) return location.reload();
  // Le chrono est enregistré : il reprendra au même point après le rechargement
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}
function registerSW() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').then(reg => {
    const notify = w => { if (w && navigator.serviceWorker.controller) showUpdate(w); };
    if (reg.waiting) notify(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') notify(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 3600e3);
  }).catch(() => {});
}

// Démarrage
renderAll();
go(location.hash.slice(1) || 'home');
if (startupNotice) toast('ℹ️', startupNotice, 'badge');
if (data.onboarded) restoreRunner();
registerSW();
