export const SUPPORTED_LIFF_ROUTES = Object.freeze([
  "#member",
  "#promotions",
  "#rewards",
  "#history",
  "#profile"
]);

export const LIFF_ROUTE_STORAGE_KEY = "piyasiri_liff_route_before_login_v1";
export const LIFF_LOGIN_PENDING_KEY = "piyasiri_liff_login_pending_v1";
export const DEFAULT_LIFF_INIT_ATTEMPTS = 2;
export const LOGIN_PENDING_TTL_MS = 5 * 60 * 1000;

const SUPPORTED_ROUTE_SET = new Set(SUPPORTED_LIFF_ROUTES);

export class LiffInitializationError extends Error {
  constructor(error, { attempts = 0, networkFailure = false, code = "LIFF_INIT_FAILED" } = {}) {
    super(error?.message || "LIFF initialization failed", { cause: error });
    this.name = "LiffInitializationError";
    this.attempts = attempts;
    this.networkFailure = networkFailure;
    this.code = code;
  }
}

function text(value) {
  return String(value ?? "").trim();
}

function storageGet(storage, key) {
  try {
    return storage?.getItem?.(key) || "";
  } catch {
    return "";
  }
}

function storageSet(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
  } catch {
    // A blocked storage API must not break the authentication redirect.
  }
}

function storageRemove(storage, key) {
  try {
    storage?.removeItem?.(key);
  } catch {
    // A blocked storage API must not break the authenticated page.
  }
}

export function normalizeLiffRoute(value) {
  const route = text(value).toLowerCase();
  return SUPPORTED_ROUTE_SET.has(route) ? route : "#member";
}

export function resolveLiffId({ hostname, productionHostname, productionId, testId = "" }) {
  const currentHost = text(hostname).toLowerCase();
  const productionHost = text(productionHostname).toLowerCase();
  if (currentHost === productionHost) return text(productionId);
  if (["localhost", "127.0.0.1"].includes(currentHost)) return "";
  return text(testId);
}

export function saveLiffRoute(storage, route) {
  const normalized = normalizeLiffRoute(route);
  storageSet(storage, LIFF_ROUTE_STORAGE_KEY, normalized);
  return normalized;
}

export function consumeSavedLiffRoute(storage, fallbackRoute = "#member") {
  const saved = storageGet(storage, LIFF_ROUTE_STORAGE_KEY);
  storageRemove(storage, LIFF_ROUTE_STORAGE_KEY);
  return saved ? normalizeLiffRoute(saved) : normalizeLiffRoute(fallbackRoute);
}

export function buildLiffRedirectUri(locationLike) {
  const origin = text(locationLike?.origin);
  const pathname = text(locationLike?.pathname) || "/";
  const search = text(locationLike?.search);
  if (!origin) throw new Error("LIFF redirect origin is missing");
  return `${origin}${pathname}${search}`;
}

export function isLiffNetworkFailure(error) {
  const name = text(error?.name).toLowerCase();
  const message = text(error?.message || error).toLowerCase();
  return (
    (name === "typeerror" && message.includes("fetch")) ||
    /(failed to fetch|network(?:error| request failed)?|load failed|connection|offline|timed?\s*out|err_network)/i.test(message)
  );
}

export function clearLoginPending(storage) {
  storageRemove(storage, LIFF_LOGIN_PENDING_KEY);
}

export function hasFreshLoginPending(storage, now = Date.now()) {
  const raw = storageGet(storage, LIFF_LOGIN_PENDING_KEY);
  const timestamp = Number(raw);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || now - timestamp > LOGIN_PENDING_TTL_MS) {
    clearLoginPending(storage);
    return false;
  }
  return true;
}

export async function initLiffWithRetry({
  liff,
  liffId,
  maxAttempts = DEFAULT_LIFF_INIT_ATTEMPTS,
  retryDelayMs = 250,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay))
}) {
  if (!liff || typeof liff.init !== "function") {
    throw new LiffInitializationError(new Error("ไม่พบ LINE LIFF SDK"), {
      code: "LIFF_SDK_MISSING"
    });
  }

  const attemptsLimit = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  let lastError;

  for (let attempts = 1; attempts <= attemptsLimit; attempts += 1) {
    try {
      await liff.init({ liffId });
      return { attempts };
    } catch (error) {
      lastError = error;
      const networkFailure = isLiffNetworkFailure(error);
      if (!networkFailure || attempts >= attemptsLimit) {
        throw new LiffInitializationError(error, { attempts, networkFailure });
      }
      if (retryDelayMs > 0) await wait(retryDelayMs);
    }
  }

  throw new LiffInitializationError(lastError, {
    attempts: attemptsLimit,
    networkFailure: isLiffNetworkFailure(lastError)
  });
}

export async function establishLiffIdentity({
  liff,
  liffId,
  storage,
  locationLike,
  skipLogin = false,
  maxAttempts = DEFAULT_LIFF_INIT_ATTEMPTS,
  retryDelayMs = 250,
  now = Date.now()
}) {
  if (skipLogin) {
    return { status: "skipped", isLiffReady: false, attempts: 0 };
  }

  const { attempts } = await initLiffWithRetry({
    liff,
    liffId,
    maxAttempts,
    retryDelayMs
  });

  if (!liff.isLoggedIn()) {
    if (hasFreshLoginPending(storage, now)) {
      throw new LiffInitializationError(new Error("LINE Login callback did not complete"), {
        attempts,
        code: "LIFF_REDIRECT_LOOP"
      });
    }

    const route = saveLiffRoute(storage, locationLike?.hash);
    storageSet(storage, LIFF_LOGIN_PENDING_KEY, String(now));
    try {
      liff.login({ redirectUri: buildLiffRedirectUri(locationLike) });
    } catch (error) {
      clearLoginPending(storage);
      throw error;
    }
    return { status: "redirecting", isLiffReady: true, attempts, route };
  }

  clearLoginPending(storage);
  const profile = await liff.getProfile();
  const restoredRoute = consumeSavedLiffRoute(storage, locationLike?.hash);
  return {
    status: "ready",
    isLiffReady: true,
    attempts,
    profile,
    restoredRoute
  };
}
