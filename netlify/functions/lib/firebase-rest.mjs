import { createHash } from "node:crypto";

const DEFAULT_DATABASE_URL = "https://piyasiri-member-system-default-rtdb.asia-southeast1.firebasedatabase.app";
const FIREBASE_TIMEOUT_MS = 10_000;

async function firebaseFetch(url, options, operation) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(FIREBASE_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      const timeoutError = new Error(`Firebase ${operation} timed out after ${FIREBASE_TIMEOUT_MS}ms`);
      timeoutError.name = "FirebaseTimeoutError";
      throw timeoutError;
    }
    throw error;
  }
}

export function databaseUrl() {
  return (process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL).replace(/\/$/, "");
}

export function stableKey(value) {
  return createHash("sha256").update(String(value || "").trim().toLowerCase()).digest("hex");
}

export async function firebaseRead(path, { etag = false } = {}) {
  const response = await firebaseFetch(`${databaseUrl()}/${path}.json`, {
    headers: etag ? { "X-Firebase-ETag": "true" } : undefined
  }, `read (${path})`);
  if (!response.ok) throw new Error(`Firebase read failed: ${path}`);
  return { value: await response.json(), etag: response.headers.get("etag") };
}

export async function firebasePut(path, value, { ifMatch } = {}) {
  const response = await firebaseFetch(`${databaseUrl()}/${path}.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(ifMatch ? { "if-match": ifMatch } : {})
    },
    body: JSON.stringify(value)
  }, `write (${path})`);
  if (response.status === 412) return { written: false, conflict: true };
  if (!response.ok) throw new Error(`Firebase put failed: ${path}`);
  return { written: true, value: await response.json() };
}

export async function firebaseRootPatch(updates) {
  const response = await firebaseFetch(`${databaseUrl()}/.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates)
  }, "atomic patch");
  if (!response.ok) throw new Error("Firebase atomic patch failed");
  return response.json();
}

export async function claimOperation(kind, reference, payload = {}) {
  const key = stableKey(`${kind}:${reference}`);
  const path = `operationLocks/${key}`;
  const current = await firebaseRead(path, { etag: true });
  const claimedAt = current.value?.claimedAt ? new Date(current.value.claimedAt).getTime() : 0;
  const staleProcessing = current.value?.status === "processing" && Date.now() - claimedAt > 5 * 60 * 1000;
  const retryable = current.value?.status === "failed" || staleProcessing;
  if (current.value && !retryable) return { claimed: false, key, existing: current.value };
  const record = { kind, reference, status: "processing", claimedAt: new Date().toISOString(), ...payload };
  const result = await firebasePut(path, record, { ifMatch: current.etag || "null_etag" });
  return result.written ? { claimed: true, key, record } : { claimed: false, key, existing: null };
}

export async function finishOperation(key, updates) {
  const current = await firebaseRead(`operationLocks/${key}`);
  await firebasePut(`operationLocks/${key}`, { ...(current.value || {}), ...updates, finishedAt: new Date().toISOString() });
}

export function toArray(value) {
  return Object.entries(value || {}).map(([firebaseKey, item]) => ({ ...item, id: item?.id || firebaseKey, firebaseKey }));
}
