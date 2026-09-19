import { createHash, createSign } from 'node:crypto';
import { error } from './http.mjs';

// Review branch: explicit staging target only. No production default or migration.
export function databaseUrl() {
  const raw = process.env.FIREBASE_DATABASE_URL;
  if (!raw) throw error(503, 'database_not_configured');
  const url = new URL(raw);
  if (/piyasiri-member-system/i.test(url.hostname) || process.env.CONTEXT === 'production') throw error(503, 'production_disabled_pending_review');
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!local && (url.protocol !== 'https:' || !/\.(firebasedatabase\.app|firebaseio\.com)$/.test(url.hostname)) || local && process.env.FIREBASE_EMULATOR_MODE !== 'true') throw error(503, 'invalid_database_target');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw error(503, 'invalid_database_target');
  return url.origin;
}
let cachedToken;
async function authorization() {
  if (['localhost', '127.0.0.1'].includes(new URL(databaseUrl()).hostname)) return 'Bearer owner';
  if (cachedToken?.expires > Date.now() + 60_000) return `Bearer ${cachedToken.value}`;
  let account;
  try {
    account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '');
  } catch {
    throw error(503, 'server_credentials_missing');
  }
  if (!account.client_email || !account.private_key || account.project_id === 'piyasiri-member-system') throw error(503, 'invalid_server_credentials');
  const now = Math.floor(Date.now() / 1000),
    encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = `${encode({
    alg: 'RS256',
    typ: 'JWT'
  })}.${encode({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw error(503, 'server_authentication_failed');
  const token = await response.json();
  if (!token.access_token) throw error(503, 'server_authentication_failed');
  cachedToken = {
    value: token.access_token,
    expires: Date.now() + Number(token.expires_in) * 1000
  };
  return `Bearer ${cachedToken.value}`;
}
async function request(path, options = {}) {
  const base = databaseUrl();
  if (!/^[a-zA-Z0-9_/-]*$/.test(path)) throw error(400, 'invalid_database_path');
  const ns = process.env.FIREBASE_EMULATOR_MODE === 'true' ? '?ns=demo-member-stabilize' : '';
  return fetch(`${base}/${path}.json${ns}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: await authorization(),
      ...options.headers
    },
    signal: AbortSignal.timeout(10_000)
  });
}
export async function firebaseRead(path, {
  etag = false
} = {}) {
  const r = await request(path, {
    headers: etag ? {
      'X-Firebase-ETag': 'true'
    } : {}
  });
  if (!r.ok) throw error(503, 'database_read_failed');
  const text = await r.text();
  if (Buffer.byteLength(text) > 8_000_000) throw error(503, 'database_size_requires_review');
  return {
    value: JSON.parse(text),
    etag: r.headers.get('etag')
  };
}
export async function firebasePut(path, value, {
  ifMatch
} = {}) {
  if (!ifMatch) throw error(503, 'conditional_write_required');
  const r = await request(path, {
    method: 'PUT',
    headers: {
      'if-match': ifMatch
    },
    body: JSON.stringify(value)
  });
  if (r.status === 412) return {
    written: false,
    conflict: true
  };
  if (!r.ok) throw error(503, 'database_write_failed');
  return {
    written: true
  };
}
export function createTransaction({
  read = firebaseRead,
  put = firebasePut,
  maxAttempts = 12
} = {}) {
  return async mutate => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const snapshot = await read('', {
        etag: true
      });
      if (!snapshot.etag) throw error(503, 'database_etag_missing');
      const root = structuredClone(snapshot.value || {});
      if (typeof root !== 'object' || Array.isArray(root)) throw error(503, 'database_schema_requires_review');
      for (const name of ['customers', 'rewards', 'transactions', 'redemptions', 'pendingPurchases', 'secureOperations', 'security', 'operationLocks', 'notificationJobs']) {
        const collection = root[name];
        if (collection !== undefined && collection !== null && (typeof collection !== 'object' || Array.isArray(collection))) throw error(503, 'database_schema_requires_review');
      }
      const result = mutate(root); // Pure synchronous callback, no external effects.
      if (result instanceof Promise) throw error(503, 'async_transaction_forbidden');
      if (Buffer.byteLength(JSON.stringify(root)) > 8_000_000) throw error(503, 'database_size_requires_review');
      const write = await put('', root, {
        ifMatch: snapshot.etag
      });
      if (write.written) return result;
    }
    throw error(503, 'transaction_busy_retry_same_key');
  };
}
export const transaction = createTransaction();
export const stableKey = value => createHash('sha256').update(String(value)).digest('hex');
export const toArray = value => Object.entries(value || {}).filter(([, v]) => v && typeof v === 'object').map(([firebaseKey, item]) => ({
  ...item,
  id: item.id || firebaseKey,
  firebaseKey
}));
