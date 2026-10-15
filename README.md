# ⚡ LEVEL UP

Application de transformation physique façon RPG : chaque séance de marche ou de course
rapporte de l'XP, fait monter ton personnage de niveau… et toi aussi, dans la vraie vie.

**👉 Utiliser l'application : https://drakoven.github.io/levelup/**

## Fonctionnalités

- **Journal de quêtes** (onglet Héros) : quêtes principales en chapitres, quotidiennes, hebdomadaires et épiques,
  adaptées au niveau et à la récupération, XP attribuée une seule fois.
- **Personnage RPG** : 9 rangs (Recrue → Légende) avec récompenses symboliques, XP, 34 succès et défis progressifs, journal des exploits, historique des XP.
- **Programme course 12 semaines** : du 6 × 1 min de course jusqu'à 30 min sans s'arrêter.
- **Assistant de course** : chrono d'intervalles, compte à rebours, annonces vocales en français,
  alerte 10 s avant chaque changement, bilan de séance.
- **Séance libre** : course ou marche au chrono, à ton rythme, hors programme.
- **Coach adaptatif** : tient compte du ressenti, de la récupération, de la régularité et de l'endurance.
- **Statistiques** : distance et durée par semaine et par mois, temps de course et de marche mesurés, séances par type,
  comparaison avec la semaine précédente, records (mesurés ou saisis), endurance, courbe de poids avec moyenne 7 jours,
  objectif principal et objectif bonus.
- **Hors connexion** et installable sur iPhone (PWA).

## Installer sur iPhone

1. Ouvrir https://drakoven.github.io/levelup/ dans **Safari**.
2. Bouton **Partager** → **Sur l'écran d'accueil**.
3. Lancer LEVEL UP depuis l'icône ⚡.

## Confidentialité

Toutes les données (profil, séances, pesées) restent **sur ton appareil** (stockage local du navigateur).
Rien n'est envoyé sur internet. Pense à utiliser **Objectifs → Exporter** pour garder une copie de secours.

## Développement

Application en HTML, CSS et JavaScript natifs, sans dépendance.

- `core.js` : toute la logique (XP, programme, chrono, coach, sauvegardes), testée automatiquement.
- `app.js` : affichage et interactions.
- `sw.js` : fonctionnement hors connexion et mises à jour.

```bash
npm test          # 186 tests automatisés (Node.js 18 ou plus)
npm start         # serveur local sur http://localhost:5173
```

Feuille de route : [FEUILLE_DE_ROUTE.md](FEUILLE_DE_ROUTE.md)
