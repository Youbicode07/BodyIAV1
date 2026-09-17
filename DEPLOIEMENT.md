# Mettre l'application en ligne (Play Store)

Objectif : qu'un utilisateur qui télécharge l'application depuis le Play Store
voie ses données enregistrées dans la base Neon.

Il y a **trois maillons**, et ils doivent tous être en place :

```
  application (.aab)  ──►  serveur public  ──►  base Neon
       eas.json           Back4App              DATABASE_URL
```

| Maillon | État |
|---|---|
| base Neon | ✅ déjà fait — `npm run doctor` le confirme |
| serveur public | ⬜ **à faire** — c'est la seule étape bloquante |
| application | ⬜ une ligne à changer dans `eas.json`, une fois le serveur en ligne |

Tant que le serveur n'est pas public, rien ne peut fonctionner depuis le Play
Store : le téléphone de l'utilisateur n'est pas sur ton Wi-Fi, il ne peut pas
joindre ton PC.

## Pourquoi Back4App et pas Render

Render demande parfois une carte bancaire pour vérifier un compte, même sur
son offre gratuite — c'est irrégulier (lié à la vérification anti-fraude,
propre à chaque compte) mais réel, et c'est ce que tu as rencontré. Plutôt que
d'insister sur un hébergeur qui te bloque, ce guide utilise **Back4App
Containers** : gratuit, confirmé **sans carte bancaire à l'inscription**, et
il fait tourner le serveur Express tel quel, sans rien réécrire.

Le serveur est packagé dans un `Dockerfile` (`backend/Dockerfile`) plutôt que
décrit par un fichier propre à un hébergeur : le même conteneur peut se
redéployer ailleurs (Koyeb, Railway...) sans rien changer au code, si jamais
Back4App changeait ses conditions à son tour.

---

## Étape 1 — Pousser le projet sur GitHub

```bash
git add -A
git commit -m "Prêt pour le déploiement"
git push
```

> `.env` et `backend/.env` ne partent pas : ils sont ignorés par git. Aucune
> clé ne doit se retrouver sur GitHub — les valeurs sont renseignées à
> l'étape suivante, dans Back4App.

---

## Étape 2 — Créer le conteneur sur Back4App

1. [back4app.com](https://www.back4app.com) → **Sign up** (GitHub ou e-mail,
   **sans carte bancaire**).
2. **Containers** → **New App** → **Deploy from GitHub**.
3. Choisis ton dépôt. Quand Back4App demande le **dossier racine du build**
   (root/context directory), indique `backend` — c'est là que vit le
   `Dockerfile`, pas à la racine du projet (qui contient l'application
   mobile, inutile ici).
4. Back4App détecte le `Dockerfile` automatiquement. Renseigne les variables
   d'environnement (les mêmes que dans `backend/.env`) :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | ta chaîne de connexion Neon |
| `GEMINI_API_KEY` | ta clé Gemini |
| `SESSION_SECRET` | génère-la : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `GOOGLE_WEB_CLIENT_ID` | celui de `backend/.env` |
| `GOOGLE_ANDROID_CLIENT_ID` | celui de `backend/.env` |
| `GOOGLE_IOS_CLIENT_ID` | celui de `backend/.env` |
| `PUBLIC_URL` | *à remplir après* le premier déploiement (étape 5) |
| `CMI_CLIENT_ID` / `CMI_STORE_KEY` | laisse vide si le paiement n'est pas prêt |

   Contrairement à Render, Back4App **ne génère pas** `SESSION_SECRET` tout
   seul : génère-le toi-même et colle-le. Ne le change plus ensuite, sinon
   tout le monde est déconnecté.

5. **Deploy**. La première construction prend 2 à 5 minutes.
6. Back4App affiche l'adresse publique du conteneur, du type
   `https://bodyai-backend-xxxx.back4app.io`. Reviens dans les variables,
   colle cette adresse dans `PUBLIC_URL`, et laisse Back4App redéployer.

### Vérifier

```bash
curl https://ton-adresse.back4app.io/health
```

Tu dois obtenir :

```json
{"ok":true,"database":"postgres","googleAuth":true,"sessionSecret":true, ...}
```

- `"database":"sqlite"` → `DATABASE_URL` n'a pas été prise en compte. Les
  comptes seraient perdus au redémarrage du conteneur.
- `"googleAuth":false` → `GOOGLE_WEB_CLIENT_ID` manque. **Toute** connexion
  Google serait refusée, même avec un jeton valide.

---

## Étape 3 — Pointer l'application sur ce serveur

Dans `eas.json`, remplace `https://REMPLACE-MOI.onrender.com` par ton adresse
Back4App, dans **les trois profils** (`development`, `preview`,
`production`).

La build refuse de démarrer tant que le marqueur est là : c'est volontaire,
pour qu'une version muette ne reparte plus jamais sur le Play Store.

Déclare aussi la clé Gemini comme secret EAS (elle n'a rien à faire dans un
fichier suivi par git) :

```bash
eas env:create --name GEMINI_API_KEY --value "ta-cle" \
  --visibility secret --environment production --environment preview
```

---

## Étape 4 — Construire et vérifier

```bash
eas build --profile production --platform android
```

Installe l'AAB via le Play Console (test interne), crée un compte, puis :

```bash
cd backend && npm run data
```

Le compte doit apparaître. S'il n'apparaît pas, ouvre **Profil → Diagnostic**
dans l'application : la ligne en rouge dit exactement quel maillon est rompu.

---

## Construire l'AAB sans EAS (quota épuisé)

Le forfait gratuit EAS accorde un nombre limité de builds par mois. Une fois
épuisé, `eas build` refuse de démarrer jusqu'à la remise à zéro. La machine de
développement peut produire exactement la même archive, sans quota ni attente.

### La clé de publication, d'abord

Le Play Store identifie une application par la clé qui signe ses archives.
Publier avec une autre clé **n'est pas rattrapable** : Google refuse l'envoi, et
aucune manipulation ne permet de reprendre l'application existante.

Ta clé est sur les serveurs EAS. Récupère-la une fois pour toutes :

```bash
npx eas credentials -p android
```

Choisis le profil **production**, puis
`Keystore: Manage everything needed to build your project`
→ `Download existing keystore`.

EAS écrit un fichier `.jks` et affiche les trois mots de passe
(*Keystore password*, *Key alias*, *Key password*). **Note-les** : ils ne sont
plus réaffichés ensuite.

Place le `.jks` dans `android/app/`, puis crée `android/keystore.properties` :

```properties
storeFile=le-nom-du-fichier.jks
storePassword=...
keyAlias=...
keyPassword=...
```

Ce fichier et les `.jks` sont exclus de git : ils contiennent les mots de passe
en clair, et quiconque détient la clé peut signer une mise à jour que les
téléphones déjà équipés accepteront comme venant de toi.

### Construire

```bash
cd android
./gradlew bundleRelease
```

L'archive sort dans :

```
android/app/build/outputs/bundle/release/app-release.aab
```

### Ce que le projet fait pour toi

- **Les variables d'environnement** — EAS injectait `API_URL` et les
  identifiants Google depuis `eas.json`. En local, `process.env` est vide, et
  l'application serait partie en mode « local seul » : elle fonctionne, elle
  n'affiche aucune erreur, et aucune donnée ne quitte le téléphone.
  `app.config.js` relit donc `eas.json` en repli. Une seule source de vérité :
  corriger l'adresse du serveur à un endroit vaut pour les deux façons de
  construire.

- **La signature** — le modèle Expo signait la version release avec la clé de
  *debug*. L'archive se construit sans broncher puis se fait refuser à l'envoi,
  vingt minutes plus tard. `android/app/build.gradle` interrompt désormais la
  construction tout de suite si `keystore.properties` manque.

### Numéro de version

EAS incrémentait `versionCode` à chaque build. En local, c'est à toi :
`android/app/build.gradle`, champ `versionCode`. Le Play Store **refuse** un
numéro déjà envoyé — prends strictement supérieur au dernier publié.

---

## Le piège Google Sign-In sur une build Play Store

Google Play **resigne** ton application (Play App Signing, actif par défaut
pour un AAB). L'empreinte SHA-1 de l'application installée n'est donc **pas**
celle de ta clé de dépôt.

Récupère la bonne : Play Console → **Test et publication** → **Intégrité de
l'application** → *Certificat de signature d'application*, puis ajoute-la à ton
identifiant OAuth « Android » sur console.cloud.google.com.

Sans elle : `DEVELOPER_ERROR`, la fenêtre Google se referme instantanément.

---

## Rester à 0 € — la pile gratuite complète

| Brique | Service | Gratuit ? | Limite réelle |
|---|---|---|---|
| Base de données | **Neon** | Permanent, sans carte | 0,5 Go · **100 h de calcul/mois** |
| Serveur API | **Back4App Containers** | Permanent, sans carte | **600 h de calcul/mois** · le conteneur s'endort après un moment d'inactivité |
| Maintien en éveil | **cron-job.org** | Permanent, sans carte | — |

600 heures suffisent pour un usage réel (pas un service allumé 24 h/24, mais
largement de quoi couvrir des utilisateurs qui ouvrent l'app plusieurs fois par
jour). Comme sur toute offre gratuite, un ping régulier limite les réveils.

### Empêcher le conteneur de s'endormir

1. [cron-job.org](https://cron-job.org) → créer un compte (gratuit, sans carte).
2. **Create cronjob** :
   - URL : `https://ton-adresse.back4app.io/ping`
   - Intervalle : toutes les **10 minutes**
3. Enregistrer.

### Le piège à éviter absolument

**Ne fais JAMAIS pointer le cron sur `/health`.**

`/health` interroge la base. Or Neon facture à l'heure de **calcul** — 100 h
par mois — et s'endort d'elle-même au bout de cinq minutes d'inactivité. Un
appel toutes les 10 minutes la maintiendrait allumée en permanence, soit
~720 h : le quota serait épuisé en **moins d'une semaine**, et Neon
suspendrait la base jusqu'au mois suivant.

`/ping` existe exactement pour ça : il répond sans toucher à la base.

```
/ping    → garde le conteneur éveillé,  ne réveille PAS Neon   ✅ pour le cron
/health  → diagnostic complet,          réveille Neon          ❌ pour le cron
```

L'application suit la même règle : elle réveille le serveur par `/ping` avant
d'envoyer ses données, jamais par `/health`.

### Si tu préfères ne rien installer

Sans cron, tout fonctionne quand même : l'application réveille le serveur
toute seule et attend jusqu'à 70 secondes. L'utilisateur voit simplement ses
données locales pendant ce temps, et tout part ensuite.

### Surveiller les quotas

- Neon : [console.neon.tech](https://console.neon.tech) → **Usage** →
  *compute hours*.
- Back4App : tableau de bord du conteneur → **Metrics**.

---

## Si tu préfères quand même Render

Render reste une option valable pour qui n'est pas bloqué par la demande de
carte : c'est un vrai crédit gratuit (750 h/mois), pas un abonnement caché. Le
fichier `render.yaml`, à la racine du projet, est toujours prêt pour ça
(**New → Blueprint** sur render.com). Les deux chemins (Back4App via
`backend/Dockerfile`, ou Render via `render.yaml`) déploient le même code —
choisis simplement celui que ton compte accepte sans carte.
