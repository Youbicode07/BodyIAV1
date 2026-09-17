// Expo charge automatiquement les variables présentes dans .env lors de
// l'évaluation de cette configuration. dotenv reste réservé au backend Node.

/**
 * REPLI SUR eas.json
 * ==================
 *
 * EAS Build injecte lui-même les variables déclarées dans eas.json. Une
 * construction lancée à la main (`gradlew bundleRelease`, quand le quota EAS
 * du mois est épuisé) n'a rien de tel : `process.env` y est vide, et sans ce
 * repli l'application partait en mode « local seul » — elle fonctionne, elle
 * n'affiche aucune erreur, et aucune donnée ne quitte le téléphone.
 *
 * Relire eas.json plutôt que dupliquer les valeurs dans un second fichier
 * garde une seule source de vérité : corriger l'adresse du serveur à un seul
 * endroit vaut pour les deux façons de construire.
 */
function fromEasJson(name) {
  try {
    const profiles = require('./eas.json')?.build ?? {};
    const profile = process.env.EAS_BUILD_PROFILE || 'production';
    return profiles[profile]?.env?.[name] ?? profiles.production?.env?.[name];
  } catch {
    return undefined; // eas.json absent ou illisible : on continue sans repli.
  }
}

const env = (name) => process.env[name] || fromEasJson(name) || '';

const googleIosClientId = env('GOOGLE_IOS_CLIENT_ID');
const googleAndroidClientId = env('GOOGLE_ANDROID_CLIENT_ID');
const googleWebClientId = env('GOOGLE_WEB_CLIENT_ID');

/**
 * Le module natif Google Sign-In a besoin, côté iOS, du « schéma d'URL »
 * inversé de l'identifiant client — par exemple pour un identifiant
 * "1234-abc.apps.googleusercontent.com", le schéma attendu est
 * "com.googleusercontent.apps.1234-abc". C'est une construction mécanique
 * à partir de l'identifiant : on la calcule ici pour éviter une manipulation
 * manuelle source d'erreur (et d'échec silencieux de la connexion).
 */
function iosReversedScheme(clientId) {
  const suffix = '.apps.googleusercontent.com';
  if (!clientId.endsWith(suffix)) return null;
  return `com.googleusercontent.apps.${clientId.slice(0, -suffix.length)}`;
}

const googleIosScheme = googleIosClientId ? iosReversedScheme(googleIosClientId) : null;

/**
 * ADRESSE DU SERVEUR — ET LE GARDE-FOU QUI MANQUAIT
 * =================================================
 *
 * Symptôme observé en production : une build déposée sur le Play Store créait
 * des comptes que personne ne retrouvait jamais en base. Explication : sans
 * adresse de serveur, l'application bascule dans son mode « local seul ». Elle
 * fonctionne, elle n'affiche aucune erreur — et rien ne quitte le téléphone.
 *
 * Deux pièges se cumulaient :
 *
 *   1. aucune variable d'adresse n'était renseignée dans .env ;
 *   2. même renseignée, elle n'aurait pas suivi : `.env` est ignoré par git,
 *      et EAS Build n'envoie que les fichiers suivis. Les valeurs doivent donc
 *      être déclarées dans eas.json (ou via `eas env:create`), pas seulement
 *      dans .env.
 *
 * Ce fichier refuse désormais de produire une build de production muette : sans
 * adresse joignable, la construction s'arrête avec la marche à suivre, plutôt
 * que de livrer une application qui perd les données de ses utilisateurs.
 */
const apiUrl = (
  process.env.API_URL ||
  process.env.BACKEND_URL ||
  process.env.PAYMENTS_URL ||
  fromEasJson('API_URL') ||
  ''
).trim().replace(/\/+$/, '');

// Renseigné par EAS Build pendant la construction ; absent en local.
const buildProfile = process.env.EAS_BUILD_PROFILE ?? '';
const isReleaseBuild = buildProfile === 'production' || buildProfile === 'preview';

if (isReleaseBuild && process.env.ALLOW_LOCAL_ONLY !== '1') {
  if (!apiUrl) {
    throw new Error(
      `\n\n[BodyAI] Build « ${buildProfile} » interrompue : aucune adresse de serveur.\n\n` +
        "  L'application serait publiée en mode local seul : les comptes créés ne\n" +
        '  quitteraient jamais le téléphone, et ta base resterait vide.\n\n' +
        '  Corrige dans eas.json, profil « ' + buildProfile + ' » :\n' +
        '      "env": { "API_URL": "https://ton-backend.onrender.com" }\n\n' +
        '  (Renseigner .env ne suffit PAS : il est ignoré par git, donc absent\n' +
        "   de l'archive envoyée à EAS Build.)\n\n" +
        '  Pour construire volontairement une version locale : ALLOW_LOCAL_ONLY=1\n',
    );
  }
  if (apiUrl.includes('REMPLACE-MOI')) {
    throw new Error(
      `\n\n[BodyAI] Build « ${buildProfile} » interrompue : API_URL non renseignée.\n\n` +
        '  eas.json contient encore le marqueur de remplacement.\n\n' +
        "  Remplace « https://REMPLACE-MOI.onrender.com » par l'adresse réelle de\n" +
        '  ton backend déployé, dans les trois profils de eas.json.\n\n' +
        '  Tu l\'obtiens sur render.com après le déploiement du dossier backend/ :\n' +
        '  elle ressemble à https://bodyai-backend-xxxx.onrender.com\n\n' +
        '  Vérifie-la avant de construire :\n' +
        '      curl https://ton-backend.onrender.com/health\n' +
        '  Elle doit répondre {"ok":true, ... "database":"postgres"}.\n',
    );
  }
  if (apiUrl.startsWith('http://')) {
    throw new Error(
      `\n\n[BodyAI] Build « ${buildProfile} » interrompue : API_URL en http:// .\n\n` +
        `  Adresse reçue : ${apiUrl}\n\n` +
        '  Android bloque le trafic non chiffré depuis Android 9, SILENCIEUSEMENT\n' +
        '  dans une build de release : chaque appel au serveur échouerait sans\n' +
        "  message, exactement comme s'il n'y avait pas de serveur.\n\n" +
        '  Utilise une adresse https:// (Render et Neon en fournissent une).\n',
    );
  }
}

/**
 * ATTENTION — « plugins » ne doit apparaître QU'UNE SEULE FOIS.
 *
 * Ce fichier déclarait auparavant la clé deux fois. En JavaScript, la seconde
 * déclaration écrase silencieusement la première : seul le greffon Google
 * survivait, et expo-image-picker / expo-apple-authentication /
 * expo-notifications disparaissaient de la build native. Conséquence concrète
 * et invisible à la lecture : le manifeste Android généré ne contenait aucune
 * permission CAMERA ni notification — l'appareil photo et les rappels de
 * suivi ne pouvaient pas fonctionner sur un vrai téléphone.
 */
const plugins = [
  [
    'expo-image-picker',
    {
      photosPermission:
        'BodyAI a besoin de tes photos pour analyser ta silhouette et tes repas.',
      cameraPermission:
        "BodyAI utilise l'appareil photo pour analyser ta silhouette et tes repas.",
    },
  ],
  'expo-apple-authentication',
  [
    'expo-notifications',
    { color: '#0EA5A5' },
  ],
  // La connexion Google utilise le module natif Google Sign-In (SDK officiel
  // Google), pas un flux OAuth générique en navigateur : un identifiant OAuth
  // de type "iOS" n'accepte pas d'adresse de retour personnalisée comme
  // "bodyai://oauth" — c'est précisément ce qui faisait échouer la connexion.
  // Le module natif gère cette mécanique correctement, à condition de
  // connaître le schéma iOS ci-dessous.
  [
    '@react-native-google-signin/google-signin',
    // Le schéma est calculé depuis .env ; la valeur de repli garde la build
    // iOS fonctionnelle même si la variable n'est pas encore renseignée sur la
    // machine qui construit (EAS, CI).
    {
      iosUrlScheme:
        googleIosScheme ||
        'com.googleusercontent.apps.689996909933-6ajj3sopstehs802lg880nur6h7kl2rj',
    },
  ],
];

module.exports = {
  expo: {
    name: 'BodyAI',
    slug: 'bodyai',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    // "scheme" est l'adresse de redirection (bodyai://) utilisée par les flux
    // ouvrant un navigateur externe — dont le retour de paiement
    // (bodyai://payment?session_id=...).
    scheme: 'bodyai',
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.bodyai.app',
      // Active « Se connecter avec Apple » côté iOS. EAS Build s'en sert pour
      // demander automatiquement la capacité "Sign In with Apple" lors de la
      // génération des identifiants — encore faut-il un compte développeur
      // Apple payant pour que cette capacité puisse être accordée.
      usesAppleSignIn: true,
      infoPlist: {
        // Le paiement ouvre la page du prestataire dans le navigateur système.
        NSCameraUsageDescription:
          "BodyAI utilise l'appareil photo pour analyser ta silhouette et tes repas.",
        NSPhotoLibraryUsageDescription:
          'BodyAI a besoin de tes photos pour analyser ta silhouette et tes repas.',
      },
    },
    android: {
      package: 'com.bodyai.yourh2026',
      // Sans ça, Android sauvegarde automatiquement AsyncStorage (compte,
      // questionnaire, programme...) sur le Drive du compte Google de
      // l'appareil, et la restaure telle quelle à la prochaine installation.
      // Résultat observé : un « nouvel » utilisateur retombe sur le compte et
      // les données du test précédent au lieu d'un onboarding vierge. La
      // synchronisation réelle passe par le serveur (voir SubscriptionContext,
      // sync.ts) — cette sauvegarde silencieuse n'a donc aucune utilité et
      // ne fait que fausser le premier lancement.
      allowBackup: false,
      // Déclarées explicitement : le retour de paiement et l'appareil photo en
      // dépendent, et une permission manquante échoue silencieusement.
      permissions: ['CAMERA', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'POST_NOTIFICATIONS'],
      intentFilters: [
        {
          action: 'VIEW',
          category: ['DEFAULT', 'BROWSABLE'],
          data: [{ scheme: 'bodyai' }],
        },
      ],
    },
    plugins,
    extra: {
      geminiApiKey: process.env.GEMINI_API_KEY ?? '',
      backendUrl: process.env.BACKEND_URL ?? '',
      // Serveur BodyAI : comptes, base de donnees, abonnement. C'est le meme
      // service que backend/. Les anciennes variables restent acceptees en
      // repli pour ne pas casser une configuration existante.
      apiUrl,
      // Identifiants OAuth Google, créés sur console.cloud.google.com.
      // Laissés vides tant qu'ils ne sont pas configurés : l'écran de
      // connexion le détecte et l'explique au lieu de faire semblant.
      googleIosClientId,
      googleAndroidClientId,
      googleWebClientId,
      // Serveur de paiement (backend/). Vide = l'app affiche la formule mais
      // explique honnêtement que le paiement n'est pas encore branché, plutôt
      // que de simuler un encaissement.
      paymentsUrl: process.env.PAYMENTS_URL ?? process.env.BACKEND_URL ?? '',
      eas: {
        projectId: 'b038fcce-bdd5-4315-843b-c77e1cdeb3d3',
      },
    },
  },
};
