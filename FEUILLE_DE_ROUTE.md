# LEVEL UP — Feuille de route

Méthode : une étape à la fois, design conservé, aucune fonctionnalité supprimée,
sauvegarde avant toute migration, tests automatisés, compte rendu à chaque étape.

## Fait

| Étape | Contenu |
|---|---|
| 1. Audit | Diagnostic de 23 problèmes |
| 2. Fiabilisation | `core.js` testable, tout est recalculé, import sécurisé, migration, PWA |
| 3. Assistant de course | Compte à rebours, voix, alerte 10 s, bilan, réglages, reprise après fermeture |
| Avant l'étape 4 | Validation au chrono (90 % par intervalle), séances déclarées, format v3 (sources de mesure) |
| 4. Coach adaptatif | Ressenti sur 4 niveaux, récupération, régularité, endurance mesurée, propositions de retour en arrière, marche de remplacement |
| 4.5 Séance libre | Course libre et marche libre au chrono : démarrer, pause, terminer, bilan (durée, distance, ressenti, XP), reprise après rechargement, records de course continue (sans pause), jamais d'effet sur le programme guidé |
| 5. Statistiques et RPG | Statistiques par semaine et par mois, séances par type, records mesurés ou saisis, endurance, poids (moyenne 7 jours, objectif bonus), 34 succès et défis avec progression, titres et récompenses, journal des exploits, historique des XP |

## Prochaines étapes (PWA)

### Étape 5.5 — Journal de quêtes ✅ (version 2.6.1)
- Univers Fantasy / MMORPG discret, au service de l'entraînement réel.
- Quêtes principales en chapitres, quotidiennes, hebdomadaires et épiques.
- Progression automatique à partir des séances enregistrées (aucune validation manuelle).
- XP de quête attribuée une seule fois par accomplissement (clé unique, recalculée).
- Quêtes adaptées au niveau et aux jours de récupération du coach, avec alternatives de marche.
- Réutilise le moteur de défis de l'étape 5 (succès conservés, sans XP).

### Étape 6 — Tests sur ordinateur et iPhone
- Hébergement HTTPS gratuit (GitHub Pages) pour installer la PWA sur l'iPhone 17 Pro.
- Vérification réelle de la voix, des bips, de l'écran maintenu allumé.

### Étape 6.1 — GPS en direct ✅ (version 2.7.2, en attente de validation)
- Bouton « Activer le GPS » facultatif en course et marche libres (autorisation demandée après un toucher).
- Distance GPS, allure moyenne, durée et précision du signal pendant la séance.
- Positions imprécises (> 25 m) et sauts aberrants ignorés ; rien n'est compté pendant la pause.
- Coupures (écran verrouillé, signal perdu) détectées et jamais comptées ; message explicite.
- Distance marquée `gps` (📍 dans le journal) ; une correction manuelle reste marquée « saisie ».
- Couverture = temps réellement couvert par des positions exploitables (chacune couvre au plus 10 s),
  hors pauses, hors positions datées en dehors de la séance ; coupures, rechargement et perte en fin
  de séance comptés comme interruptions. Sous 80 % : « GPS partiel » (bilan, journal, records).
- Résumé `gps { coverage, gaps, points, rejected, uncoveredSec }` enregistré avec la séance.
- Limite PWA : sur iPhone, le GPS s'arrête quand l'écran est verrouillé (il faut Capacitor).

### Étape 6.2 — Cartes de parcours (à venir)
- Conserver les points GPS (base séparée, IndexedDB) et afficher le tracé.

### Étape 6.3 — Application native (à venir)
- Capacitor : GPS en arrière-plan, podomètre, Apple Santé.

## Phase application iPhone (Capacitor)

Prérequis : accès à un Mac (ou Mac en ligne / compilation dans le cloud). Le programme
développeur Apple (environ 99 €/an) n'est pas engagé pour l'instant.

- GPS en arrière-plan (écran verrouillé, téléphone dans la poche).
- Annonces vocales programmées côté natif (le JavaScript peut être suspendu en arrière-plan).
- Podomètre de l'iPhone : pas réellement mesurés par séance.
- Apple Santé : pas quotidiens, enregistrement des séances (facultatif).
- Parcours enregistrés localement (base séparée), tracé sans fond de carte par défaut.
- Données privées, stockées sur l'appareil, export uniquement sur demande.

Déjà prêt dans le format v3 : source de la distance (`gps`, `sante`, `podometre`, `manuel`),
distance mesurée d'origine, pas mesurés uniquement, temps du chrono, heures de début et de fin,
`routeId` pour le parcours, liste `dailySteps` pour les pas quotidiens.

## Vision long terme — Communauté sportive (inspirée de Strava)

**Non développé pour l'instant.** Fonctionnalités envisagées :
- Profil sportif public (pseudo, avatar, niveau).
- Publication volontaire d'une course et de son parcours GPS, avec photo et commentaire.
- « J'aime » et commentaires sur les publications des autres.
- Suivre d'autres coureurs.
- Découvrir les parcours publics de sa région, en enregistrer un pour le refaire.
- Activités privées par défaut.

Ce qu'il faudra : comptes utilisateurs, base de données en ligne, stockage des photos,
modération, conformité RGPD (consentement, suppression du compte, export des données),
coûts d'hébergement.

Préparation déjà en place dans l'architecture :
- **Local d'abord** : l'application fonctionne entièrement sans serveur ; la synchronisation
  viendra s'ajouter sans changer le calcul (tout est recalculé à partir des données saisies).
- **Identifiants uniques** pour chaque séance et chaque décision du coach (synchronisables).
- **Visibilité par séance** dans le format v3 : privée par défaut, `visibility: "public"`
  uniquement par choix explicite.
- **Parcours séparés des séances** (`routeId`) : on pourra publier une séance sans son parcours,
  ou masquer le départ et l'arrivée (zones de confidentialité autour du domicile).
- **Import / export versionnés** : base de la future synchronisation.
