# PicPix

Application web Node.js + Express + MySQL avec vues EJS, securisation HTTP, monitoring de base et gestion des comptes utilisateurs.

## Fonctionnalites principales

- inscription utilisateur avec validation serveur et protection CSRF
- connexion / deconnexion avec session securisee
- profil utilisateur avec mise a jour du nom et du mot de passe
- creation d'evenements par utilisateur (UUID, nom, date/heure, statut actif/inactif, token 10 caracteres)
- consultation des evenements personnels depuis le profil
- interface d'administration pour lister, creer, modifier et supprimer des utilisateurs
- interface d'administration avec CRUD complet des evenements
- compte administrateur par defaut: admin@example.com / Admin1234
- logs applicatifs via Winston dans logs/app.log et logs/error.log
- endpoint de monitoring: /health

## Installation locale

1. Installer les dependances:

```bash
npm install
```

2. Configurer la base MySQL avec les variables d'environnement attendues:

```bash
export DB_HOST=localhost
export DB_PORT=3306
export DB_NAME=picpix
export DB_USER=picpix
export DB_PASSWORD=picpix_dev
export SESSION_SECRET="remplacer-par-un-secret-fort"
```

3. Initialiser la base:

```bash
mysql -u "$DB_USER" -p"$DB_PASSWORD" < database/install.sql
```

4. Demarrer l'application:

```bash
npm start
```

## Utilisation

- Accueil: /
- Inscription: /register
- Connexion: /login
- Profil utilisateur: /profile
- Creation evenement utilisateur: /profile (section Mes evenements)
- Administration utilisateurs et evenements: /admin
- Sante applicative: /health

## Maintenance et securite

- Helmet applique les en-tetes HTTP de securite.
- Les formulaires sensibles sont proteges par token CSRF.
- Les tentatives d'authentification sont limitees par IP.
- Les mots de passe sont haches avec bcrypt.
- Le dernier administrateur actif ne peut pas etre desactive ni supprime.

## Tests

Executer la suite complete:

```bash
npm test
```

Les tests HTTP utilisent un stockage memoire isole en environnement de test pour verifier inscription, connexion, profil et CRUD administrateur sans dependre de MySQL.
