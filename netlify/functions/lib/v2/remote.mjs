import { createPrivateKey, sign } from 'node:crypto';
import { error } from '../http.mjs';

export const syntheticNamespace = value => /^synthetic-[a-zA-Z0-9_-]{1,100}$/.test(value || '');
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const databasePattern = /^(?:\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/;
const fail = () => { throw error(503, 'v2_remote_configuration_denied'); };
function list(env, name) {
  try { const v = JSON.parse(env[name]); if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== 'string' || !x || x.trim() !== x) || new Set(v).size !== v.length) fail(); return v; } catch { fail(); }
}
export function remoteConfig(env = process.env) {
  if (env.FIRESTORE_V2_MODE !== 'staging-test' || env.V2_STAGING_TEST_ENABLED !== 'true' ||
      env.CONTEXT !== 'branch-deploy' || env.BRANCH !== 'staging' || env.FIRESTORE_EMULATOR_HOST) fail();
  const project = env.FIRESTORE_V2_PROJECT, database = env.FIRESTORE_V2_DATABASE, namespace = env.FIRESTORE_V2_NAMESPACE;
  const projects = list(env, 'V2_ALLOWED_PROJECTS'), databases = list(env, 'V2_ALLOWED_DATABASES');
  const deniedProjects = list(env, 'V2_DENIED_PROJECTS'), deniedTargets = list(env, 'V2_DENIED_TARGETS');
  if (![...projects, ...deniedProjects].every(v => projectPattern.test(v)) || !databases.every(v => databasePattern.test(v)) ||
      !deniedTargets.every(v => { const a = v.split('/'); return a.length === 2 && projectPattern.test(a[0]) && databasePattern.test(a[1]); })) fail();
  if (!projectPattern.test(project || '') || !databasePattern.test(database || '') || !syntheticNamespace(namespace) ||
      !projects.includes(project) || !databases.includes(database) || deniedProjects.includes(project) ||
      deniedTargets.includes(`${project}/${database}`) || project === 'piyasiri-member-staging') fail();
  // Existing live Staging is excluded even if accidentally placed on an allowlist.
  if (projects.some(p => deniedProjects.includes(p)) || projects.some(p => databases.some(d => deniedTargets.includes(`${p}/${d}`)))) fail();
  let origin;
  try { origin = new URL(env.APP_ORIGIN); } catch { fail(); }
  if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN || origin.username || origin.password ||
      !list(env, 'V2_ALLOWED_ORIGINS').includes(origin.origin)) fail();
  const subjects = list(env, 'V2_TEST_LINE_SUBJECTS');
  if (!subjects.every(v => /^U[a-f0-9]{32}$/.test(v)) || !env.V2_TEST_LINE_CHANNEL_ID || env.LINE_LOGIN_CHANNEL_ID !== env.V2_TEST_LINE_CHANNEL_ID) fail();
  let account, privateKey;
  try {
    account = JSON.parse(env.V2_SERVICE_ACCOUNT_JSON);
    if (account.type !== 'service_account' || account.project_id !== project ||
        !new RegExp(`^[a-zA-Z0-9_-]+@${project}\\.iam\\.gserviceaccount\\.com$`).test(account.client_email) ||
        account.token_uri !== 'https://oauth2.googleapis.com/token') fail();
    privateKey = createPrivateKey(account.private_key);
    if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) fail();
  } catch { fail(); }
  return { project, database, namespace, origin: origin.origin, subjects, account, privateKey,
    root: `projects/${project}/databases/${database}/documents` };
}

export function createRemoteTransport({ env = process.env, fetcher = fetch, now = Date.now } = {}) {
  const initial = remoteConfig(env);
  // Bind every config input; changing flags, credentials, identity or target invalidates this instance.
  const names = Object.keys(env).filter(k => /^(V2_|FIRESTORE_V2_|FIRESTORE_EMULATOR_HOST$|CONTEXT$|BRANCH$|APP_ORIGIN$|LINE_LOGIN_CHANNEL_ID$)/.test(k));
  const binding = names.map(k => [k, env[k]]);
  const assertTarget = () => { if (binding.some(([k, v]) => env[k] !== v) || env.FIRESTORE_EMULATOR_HOST || env.CONTEXT !== 'branch-deploy') fail(); return initial; };
  let cached;
  async function accessToken(signal) {
    assertTarget();
    if (cached && cached.until > now() + 60_000) return cached.value;
    // Do not share a request tied to a different invocation's abort signal.
    const iat = Math.floor(now() / 1000);
    const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: initial.account.client_email,
      scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 600 })}`;
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), initial.privateKey).toString('base64url')}`;
    try {
      const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
      const data = await response.json();
      if (!response.ok || data.token_type !== 'Bearer' || typeof data.access_token !== 'string' || !/^[\x21-\x7e]+$/.test(data.access_token) || !Number.isFinite(data.expires_in) || data.expires_in <= 60) throw 0;
      cached = { value: data.access_token, until: now() + Math.min(data.expires_in, 3600) * 1000 };
      return cached.value;
    } catch { throw error(503, 'v2_oauth_unavailable'); }
  }
  const prefix = `${initial.root}/v2/${initial.namespace}`;
  const scoped = name => typeof name === 'string' && (name === prefix || name.startsWith(prefix + '/')) &&
    name.slice(prefix.length).split('/').every(part => !part || /^[a-zA-Z0-9_-]+$/.test(part));
  async function request(suffix, body, { signal, method = 'POST' } = {}) {
    assertTarget();
    const base = `/v2/${initial.namespace}`;
    if ([':beginTransaction', ':rollback'].includes(suffix)) {
      if (suffix === ':beginTransaction' && JSON.stringify(body) !== JSON.stringify({ options: { readOnly: {} } })) fail();
    } else if (suffix === ':batchGet') {
      if (!Array.isArray(body.documents) || !body.documents.length || !body.documents.every(scoped)) fail();
    } else if (suffix === ':commit') {
      if (!Array.isArray(body.writes) || !body.writes.length || body.writes.length > 200 || body.transaction || body.writes.some(w =>
        !scoped(w.update?.name || w.delete || w.verify) || !w.currentDocument || w.transform || w.updateTransforms)) fail();
    } else if (suffix === `${base}:runQuery`) {
      if (!body.transaction || body.structuredQuery?.from?.some(f => f.allDescendants) || body.structuredQuery?.limit > 26) fail();
    } else {
      const path = suffix.split('?')[0].replace(/:listCollectionIds$/, '');
      if (!scoped(initial.root + path) || !(suffix.endsWith(':listCollectionIds') || method === 'GET')) fail();
    }
    const token = await accessToken(signal);
    assertTarget(); signal?.throwIfAborted();
    return fetcher(`https://firestore.googleapis.com/v1/${initial.root}${suffix}`, { method, redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  }
  return { ...initial, remote: true, prefix, request, assertTarget };
}
