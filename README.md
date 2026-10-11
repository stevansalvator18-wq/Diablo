# MonPremierElectron REC — mode centralisé (expérimental)

Cette version ajoute un service Node autonome et des clients Electron. Le service est le seul processus applicatif qui ouvre la base centrale; les clients utilisent l’API HTTP. La base centrale est distincte des données locales existantes : aucun dossier n’est importé automatiquement.

## Prérequis

- Windows et Node.js 22.12 ou plus récent (Electron utilise `node:sqlite`).
- Réseau local privé; le service n’est pas destiné à être exposé sur Internet.

## Installation et démarrage

Dans le dossier de développement, installer les dépendances avec `npm ci`.

Le serveur central est un processus séparé et n’est pas démarré automatiquement par Electron. Sur l’ordinateur qui héberge le service, lancer `npm run server` et laisser ce processus ouvert. Au premier démarrage, la console affiche un code de configuration à usage unique. Conserver ce code temporairement pour créer le premier compte administrateur depuis le client. Le service écoute par défaut sur le port TCP 8765; les paramètres de données sont stockés sous `server\data`. Si le client signale que le serveur est inaccessible, vérifier que ce processus tourne et utiliser « Réessayer la connexion ».

Sur chaque client, lancer `npm start`, saisir l’adresse locale du serveur dans l’écran de connexion, puis se connecter. Utiliser `http://127.0.0.1:8765` depuis l’ordinateur serveur, ou `http://ADRESSE-LAN-DU-SERVEUR:8765` depuis un client. Les comptes éditeur et lecteur sont gérés par un administrateur dans l’application.

Le pare-feu Windows doit autoriser le port 8765 uniquement sur le profil privé et pour le sous-réseau local utilisé. Ne pas créer de redirection de port sur le routeur.

## Base, sauvegarde et restauration

Par défaut, la base dédiée est `server\data\lotissement.sqlite`; les sauvegardes sont dans `server\data\backups`. Les valeurs peuvent être changées dans l’administration. La sauvegarde quotidienne est planifiée à 02:00 heure locale et la rotation conserve sept sauvegardes quotidiennes. Les sauvegardes manuelles restent disponibles dans la liste. Une restauration vérifie l’intégrité, garde une copie `before-restore-*`, puis invalide les sessions : les utilisateurs doivent se reconnecter.

Pour restaurer, arrêter de préférence les clients en cours d’édition, sélectionner une sauvegarde depuis l’administration et confirmer. Avant un transfert de serveur, créer une sauvegarde, arrêter le service, copier le dossier de données et les sauvegardes vers l’ordinateur de destination, puis démarrer avec `LOTISSEMENT_SERVER_DATA` ou `--data-dir` pointant sur ce dossier. Vérifier `/health` et la connexion d’un client avant de retirer l’ancienne copie.

Pour revenir à l’état antérieur à la centralisation, arrêter le service et le client, sauvegarder les fichiers actuels, puis restaurer le point de retour `backups\pre-centralisation-20261010.zip` (la sauvegarde de dépendances `node_modules` n’est pas incluse; exécuter ensuite `npm ci`). Ne pas restaurer cette archive par-dessus des fichiers modifiés sans en conserver une copie.

## Tests

- `npm test` exécute les tests du service sur des répertoires temporaires isolés, y compris l’enregistrement et le rechargement des factures GU pour les huit catégories d’ouvrages, ainsi que les tests des commandes de rapport renderer.
- `npm audit` vérifie les vulnérabilités déclarées des dépendances.

## Limites importantes avant déploiement réel

- Le transport réseau est actuellement HTTP, sans chiffrement TLS. Ne pas utiliser sur un réseau non maîtrisé ni avec des identifiants sensibles avant d’ajouter une configuration TLS et la confiance du certificat côté clients.
- La base choisie est SQLite mono-serveur. Elle évite tout accès direct des clients au fichier, mais une charge représentative de 4 à 10 utilisateurs doit encore être évaluée avant exploitation.
- L’import des anciennes données n’est pas implémenté. Les données locales ne sont ni modifiées ni envoyées au nouveau serveur.
- Les tests automatisés couvrent le service et des workflows métier isolés; ils ne remplacent pas encore la validation de bout en bout de l’interface Electron, de l’impression physique, des exports via les boîtes de dialogue ni une campagne de concurrence sur plusieurs postes.
