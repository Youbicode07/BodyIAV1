import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

/**
 * CLIENT DU SERVEUR BODYAI
 * ========================
 *
 * Un seul point de passage vers le backend : compte, données, abonnement.
 *
 * Le jeton de session est gardé sur le téléphone et rejoué à chaque requête.
 * Il n'est pas un secret partagé « deviné » par l'application : il a été émis
 * et signé par le serveur, qui est seul capable de le vérifier. L'application
 * ne peut donc pas se fabriquer un accès.
 *
 * Toutes les erreurs réseau sont transformées en `ApiError` avec un message
 * lisible. C'est délibéré : l'application doit pouvoir dire « le serveur ne
 * répond pas » ou « session expirée » plutôt que d'afficher une exception
 * technique — ou pire, de rester silencieuse.
 */

const extra = (Constants.expoConfig?.extra ?? {}) as {
  apiUrl?: string;
  backendUrl?: string;
  paymentsUrl?: string;
};

export const API_URL = (extra.apiUrl || extra.backendUrl || extra.paymentsUrl || '')
  .trim()
  .replace(/\/+$/, '');

/** true si un serveur est configuré. Sinon l'app fonctionne en local seul. */
export const API_CONFIGURED = Boolean(API_URL);

const TOKEN_KEY = 'bodyai.session.token';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** La session n'est plus valable : il faut se reconnecter. */
  get isAuthError() {
    return this.status === 401;
  }
  /** Le serveur est injoignable : l'application doit basculer hors ligne. */
  get isOffline() {
    return this.status === 0;
  }
}

// ---------------------------------------------------------------------------
// Jeton de session
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;

export async function loadToken(): Promise<string | null> {
  if (cachedToken !== null) return cachedToken;
  try {
    cachedToken = await AsyncStorage.getItem(TOKEN_KEY);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

export async function setToken(token: string | null): Promise<void> {
  cachedToken = token;
  try {
    if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
    else await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // Un stockage plein ne doit pas empêcher la session en cours de fonctionner.
  }
}

// ---------------------------------------------------------------------------
// Requêtes
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 15000;

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** false pour les routes publiques (tarifs). Par défaut on joint le jeton. */
  auth?: boolean;
  timeoutMs?: number;
};

/**
 * RÉVEIL DU SERVEUR — LE PIÈGE DES HÉBERGEMENTS GRATUITS
 * ======================================================
 *
 * Un service web gratuit (Render, Koyeb, Fly…) est mis en veille après une
 * quinzaine de minutes sans trafic. La requête suivante ne tombe pas sur une
 * erreur : elle ATTEND que le conteneur redémarre, ce qui prend 30 à 60
 * secondes. Avec un délai d'attente de 15 secondes, elle échouait donc
 * systématiquement — et l'utilisateur voyait « le serveur ne répond pas » à la
 * première ouverture de la journée, ses données restant sur le téléphone.
 *
 * Plutôt que d'allonger le délai de toutes les requêtes (l'application
 * paraîtrait figée à chaque vraie panne), on absorbe le réveil sur un simple
 * GET /health, patient et sans effet de bord. Les vraies requêtes attendent ce
 * réveil, puis partent avec leur délai normal.
 *
 * Réveiller par une LECTURE est le point important : si on réveillait avec la
 * requête d'inscription elle-même, un délai dépassé laisserait l'application
 * incapable de savoir si le compte a été créé ou non.
 */
const WAKE_TIMEOUT_MS = 70_000;

let wakePromise: Promise<void> | null = null;
let lastWakeAt = 0;

/** Au-delà, on considère que le serveur a pu se rendormir. */
const WAKE_VALID_MS = 10 * 60 * 1000;

/**
 * On réveille par /ping, PAS par /health.
 *
 * /health interroge la base de données. Or une base Neon gratuite est facturée
 * à l'heure de calcul (100 h par mois) et s'endort d'elle-même au bout de cinq
 * minutes : la réveiller à chaque ouverture de l'application, juste pour savoir
 * si le serveur web est debout, gaspillerait ce quota pour rien. /ping ne
 * touche à rien.
 */
async function pingServer(timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${API_URL}/ping`, { signal: controller.signal });
    // Le CODE de réponse n'a pas d'importance : même un 404 prouve qu'un
    // serveur a répondu, donc qu'il est réveillé. Seule une absence de réponse
    // (réseau coupé, délai dépassé) signifie qu'il dort encore.
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * S'assure que le serveur est debout. Ne lève jamais : si le réveil échoue,
 * la requête part quand même et produira son propre message d'erreur, plus
 * précis que « réveil impossible ».
 */
export async function ensureAwake(): Promise<void> {
  if (!API_CONFIGURED) return;
  if (Date.now() - lastWakeAt < WAKE_VALID_MS) return;

  // Une seule tentative de réveil à la fois : au lancement, cinq contextes
  // interrogent le serveur en même temps. Sans ce partage, cinq réveils
  // concurrents partiraient pour rien.
  if (!wakePromise) {
    wakePromise = (async () => {
      const awake = await pingServer(WAKE_TIMEOUT_MS);
      if (awake) lastWakeAt = Date.now();
    })().finally(() => {
      wakePromise = null;
    });
  }
  await wakePromise;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!API_CONFIGURED) {
    throw new ApiError(
      "Aucun serveur configuré : renseigne API_URL dans .env avec l'adresse du backend.",
      0,
      'non_configure',
    );
  }

  const { method = 'GET', body, auth = true, timeoutMs = TIMEOUT_MS } = options;

  // /ping et /health servent eux-mêmes au réveil : les faire passer par
  // ensureAwake() bouclerait.
  if (path !== '/ping' && path !== '/health') await ensureAwake();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = await loadToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  // Sans limite de temps, un serveur endormi (offre gratuite Render) laisse
  // l'écran bloqué indéfiniment sur son indicateur de chargement.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    // Le serveur a pu se rendormir entre le réveil et cette requête : on
    // oublie le réveil pour que la prochaine tentative repasse par /health.
    lastWakeAt = 0;
    if (err?.name === 'AbortError') {
      throw new ApiError(
        'Le serveur met trop de temps à répondre. Réessaie dans quelques secondes.',
        0,
        'timeout',
      );
    }
    throw new ApiError(`Serveur injoignable (${API_URL}).`, 0, 'reseau');
  }
  clearTimeout(timer);

  const text = await response.text().catch(() => '');
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // Une réponse non-JSON ne vient jamais de l'application : le serveur
      // répond toujours en JSON, y compris pour ses erreurs. C'est donc
      // l'hébergeur qui a répondu à sa place, avec sa propre page d'erreur —
      // conteneur arrêté, endormi ou redéployé sous une autre adresse. Dire
      // « vérifie l'adresse configurée » envoyait l'utilisateur chercher une
      // faute de frappe dans un réglage auquel il n'a pas accès ; le seul
      // geste utile de son côté est de réessayer un peu plus tard.
      const indisponible =
        response.status === 404 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;
      throw new ApiError(
        indisponible
          ? 'Le service est momentanément indisponible. Réessaie dans quelques minutes.'
          : `Le serveur a renvoyé une réponse illisible (${response.status}).`,
        response.status,
        indisponible ? 'indisponible' : undefined,
      );
    }
  }

  if (!response.ok) {
    // La session a expiré : on efface le jeton tout de suite, sinon chaque
    // requête suivante repartirait avec un jeton mort.
    if (response.status === 401) await setToken(null);
    throw new ApiError(
      payload?.detail || payload?.error || `Le serveur a répondu ${response.status}.`,
      response.status,
      payload?.error,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Types partagés avec le serveur
// ---------------------------------------------------------------------------

export type RemoteUser = {
  id: string;
  provider: 'google' | 'apple' | 'email';
  providerUserId?: string;
  email?: string;
  name: string;
  photoUrl?: string;
  createdAt: number;
  lastSignInAt?: number;
};

export type AuthResponse = { user: RemoteUser; token: string };

// ---------------------------------------------------------------------------
// Comptes
// ---------------------------------------------------------------------------

/** Échange le jeton Google contre une session BodyAI. */
export async function authGoogle(idToken: string): Promise<AuthResponse> {
  const result = await apiRequest<AuthResponse>('/api/auth/google', {
    method: 'POST',
    body: { idToken },
    auth: false,
  });
  await setToken(result.token);
  return result;
}

export async function authApple(identityToken: string, fullName?: string): Promise<AuthResponse> {
  const result = await apiRequest<AuthResponse>('/api/auth/apple', {
    method: 'POST',
    body: { identityToken, fullName },
    auth: false,
  });
  await setToken(result.token);
  return result;
}

export async function authRegister(input: {
  email: string;
  password: string;
  name: string;
}): Promise<AuthResponse> {
  const result = await apiRequest<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: input,
    auth: false,
  });
  await setToken(result.token);
  return result;
}

export async function authLogin(input: { email: string; password: string }): Promise<AuthResponse> {
  const result = await apiRequest<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: input,
    auth: false,
  });
  await setToken(result.token);
  return result;
}

/** Vérifie que la session gardée sur le téléphone est toujours valable. */
export function authMe(): Promise<{ user: RemoteUser; hasSubscription: boolean }> {
  return apiRequest('/api/auth/me');
}

export function updateRemoteProfile(patch: { name?: string; photoUrl?: string }) {
  return apiRequest<{ user: RemoteUser }>('/api/auth/me', { method: 'PATCH', body: patch });
}

export async function signOutRemote(): Promise<void> {
  await setToken(null);
}

// ---------------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------------

export const dataApi = {
  getProfile: () =>
    apiRequest<{ answers: Record<string, unknown> | null; updatedAt: number }>('/api/data/profile'),
  putProfile: (answers: unknown, updatedAt: number) =>
    apiRequest<{ answers: Record<string, unknown>; updatedAt: number; conflict: boolean }>(
      '/api/data/profile',
      { method: 'PUT', body: { answers, updatedAt } },
    ),

  getProgram: () => apiRequest<{ program: any; updatedAt: number }>('/api/data/program'),
  putProgram: (program: unknown) =>
    apiRequest<{ program: any; updatedAt: number }>('/api/data/program', {
      method: 'PUT',
      body: { program },
    }),

  getAnalyses: () => apiRequest<{ analyses: any[] }>('/api/data/analyses'),
  postAnalysis: (analysis: unknown) =>
    apiRequest<{ analysis: any; duplicate: boolean }>('/api/data/analyses', {
      method: 'POST',
      body: { analysis },
    }),
  clearAnalyses: () => apiRequest<{ ok: true }>('/api/data/analyses', { method: 'DELETE' }),

  getMeals: () => apiRequest<{ meals: any[] }>('/api/data/meals'),
  postMeal: (meal: unknown) =>
    apiRequest<{ meal: any; duplicate: boolean }>('/api/data/meals', {
      method: 'POST',
      body: { meal },
    }),
  deleteMeal: (id: string) =>
    apiRequest<{ ok: true }>(`/api/data/meals/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getWorkouts: () => apiRequest<{ workouts: any[] }>('/api/data/workouts'),
  postWorkout: (workout: unknown) =>
    apiRequest<{ workout: any; duplicate: boolean }>('/api/data/workouts', {
      method: 'POST',
      body: { workout },
    }),

  reset: (keepAccount = true) =>
    apiRequest<{ ok: true }>('/api/data/reset', { method: 'POST', body: { keepAccount } }),
};

// ---------------------------------------------------------------------------
// Abonnement
// ---------------------------------------------------------------------------

export type RemoteSubscription = {
  status: 'none' | 'trial' | 'active' | 'expired';
  planId?: string;
  provider?: string;
  orderId?: string;
  amount?: number;
  currency?: string;
  startedAt?: number;
  trialEndsAt?: number | null;
  expiresAt?: number | null;
};

export const subscriptionApi = {
  get: () => apiRequest<{ subscription: RemoteSubscription }>('/api/subscription'),
  plans: () =>
    apiRequest<{
      configured: boolean;
      provider: string | null;
      capabilities: { trial: boolean; recurring: boolean };
      plans: any[];
      error?: string | null;
    }>('/api/subscription/plans', { auth: false }),
  checkout: (planId: string) =>
    apiRequest<{ sessionId: string; url: string; provider: string }>('/api/subscription/checkout', {
      method: 'POST',
      body: { planId },
    }),
  verify: (sessionId: string) =>
    apiRequest<{ paid: boolean; reason?: string; subscription: RemoteSubscription }>(
      '/api/subscription/verify',
      { method: 'POST', body: { sessionId }, timeoutMs: 30000 },
    ),
  restore: () =>
    apiRequest<{ restored: boolean; subscription: RemoteSubscription }>(
      '/api/subscription/restore',
      { method: 'POST', timeoutMs: 30000 },
    ),
};
