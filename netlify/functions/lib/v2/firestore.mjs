import { setTimeout as delay } from 'node:timers/promises';
import { error, key } from '../http.mjs';

export const bytes = value => Buffer.byteLength(JSON.stringify(value));
// Spread optimistic conflicts rather than synchronizing every losing writer.
export const retryDelayMs = (attempt, random = Math.random) =>
  20 + Math.floor(random() * Math.min(480, 80 * 2 ** attempt));
export function emulatorTarget(env = process.env) {
  if (env.FIRESTORE_V2_MODE !== 'emulator' || env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085' ||
      env.FIRESTORE_V2_PROJECT !== 'demo-member-v2' || !['dev', 'test'].includes(env.CONTEXT)) {
    throw error(503, 'v2_local_emulator_only');
  }
  return 'http://127.0.0.1:8085/v1/projects/demo-member-v2/databases/(default)/documents';
}
export function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (value && typeof value === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encode(v)])) } };
  throw error(400, 'invalid_firestore_value');
}
export function decode(value) {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  return Object.fromEntries(Object.entries(value.mapValue?.fields || {}).map(([k, v]) => [k, decode(v)]));
}
export const documentData = doc => decode({ mapValue: { fields: doc.fields || {} } });
const validPath = p => { const parts = String(p).split('/'); return parts.length === 2 && /^[a-zA-Z]+$/.test(parts[0]) && !!key(parts[1]); };

// Snapshot reads + one atomic Commit guarded by the ENTIRE read set, including
// read-only guards and absent documents (Firestore client's optimistic pattern).
// Never batchWrite, blind writes, process-local locks or disjoint updates.
export function createStore({ namespace = 'synthetic', onMetric = () => {}, maxAttempts = 12, fetcher = fetch, transport, deadlineMs = 12_000 } = {}) {
  if (!/^synthetic(?:-[a-zA-Z0-9_-]+)?$/.test(namespace)) throw error(400, 'synthetic_namespace_required');
  const assertTarget = transport ? () => { transport.assertTarget(); if (namespace !== transport.namespace) throw error(503, 'v2_namespace_mismatch'); } : emulatorTarget;
  assertTarget();
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 12) throw error(503, 'v2_invalid_retry_budget');
  if (transport && (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 12_000)) throw error(503, 'v2_invalid_deadline');
  const prefix = transport?.prefix || `projects/demo-member-v2/databases/(default)/documents/v2/${namespace}`;
  const name = path => {
    if (!validPath(path)) throw error(400, 'invalid_document_path');
    return `${prefix}/${path}`;
  };
  async function request(suffix, body, metrics, options = {}) {
    assertTarget();
    const remaining = transport ? Math.floor((metrics?.deadlineAt ?? performance.now() + 12_000) - performance.now()) : 12_000;
    if (remaining <= 0) throw error(503, 'v2_deadline_retry_same_key');
    const signal = AbortSignal.timeout(Math.min(12_000, remaining));
    const payload = JSON.stringify(body);
    if (metrics) metrics.wireSentBytes += Buffer.byteLength(payload);
    const r = transport ? await transport.request(suffix, body, { ...options, signal }) : await fetcher(emulatorTarget() + suffix, {
      method: options.method || 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      ...(options.method === 'GET' ? {} : { body: payload }), signal
    });
    const text = await r.text();
    if (metrics) metrics.wireReceivedBytes += Buffer.byteLength(text);
    const data = JSON.parse(text || '{}');
    if (!r.ok) throw Object.assign(error(503, 'firestore_request_failed'), { firestoreStatus: data.error?.status, httpStatus: r.status });
    return data;
  }
  async function run(callback, { readOnly = false, label = 'operation' } = {}) {
    const start = performance.now();
    const total = { label, attempts: 0, conflicts: 0, wireSentBytes: 0, wireReceivedBytes: 0, docsRead: 0, docsWritten: 0, logicalBytes: 0, commitBytes: 0 };
    if (transport) total.deadlineAt = start + deadlineMs;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        total.attempts++;
        let token, committing = false;
        const cache = new Map(), writes = new Map(), preconditions = new Map();
        let logicalReadBytes = 0;
        const limit = readOnly ? 180 : 20;
        const check = () => {
          const count = new Set([...cache.keys(), ...writes.keys()]).size;
          const size = logicalReadBytes + [...writes.values()].reduce((s, v) => s + bytes(v), 0);
          total.docsRead = Math.max(total.docsRead, cache.size);
          total.docsWritten = Math.max(total.docsWritten, writes.size);
          total.logicalBytes = Math.max(total.logicalBytes, size);
          if (count > limit || size > (readOnly ? 1024 * 1024 : 512 * 1024)) throw error(413, 'v2_transaction_budget_exceeded');
        };
        const remember = (path, value) => {
          if (!cache.has(path)) {
            const size = bytes(value);
            if (size > (path.startsWith('transactions/') ? 128 * 1024 : 16 * 1024)) throw error(413, 'v2_document_budget_exceeded');
            cache.set(path, value); logicalReadBytes += size; check();
          }
          return structuredClone(cache.get(path));
        };
        try {
          // Read-only snapshots avoid read-to-write lock upgrades on hot documents.
          token = (await request(':beginTransaction', { options: { readOnly: {} } }, total)).transaction;
          const tx = {
            async getMany(paths) {
              const missing = [...new Set(paths)].filter(p => !cache.has(p));
              if (cache.size + missing.length > limit) throw error(413, 'v2_transaction_budget_exceeded');
              if (missing.length) {
                const result = await request(':batchGet', { documents: missing.map(name), transaction: token }, total);
                if (!Array.isArray(result) || result.length !== missing.length) throw error(503, 'v2_incomplete_read_set');
                const seen = new Set();
                for (const item of result) {
                  const returnedName = item.found?.name || item.missing;
                  if (!missing.some(p => name(p) === returnedName) || seen.has(returnedName)) throw error(503, 'v2_invalid_read_set');
                  seen.add(returnedName);
                  const path = (item.found?.name || item.missing).slice(prefix.length + 1);
                  if (item.found && !item.found.updateTime) throw error(503, 'v2_missing_document_version');
                  preconditions.set(path, item.found ? { updateTime: item.found.updateTime } : { exists: false });
                  remember(path, item.found ? documentData(item.found) : null);
                }
              }
              return paths.map(p => structuredClone(cache.get(p)));
            },
            async get(path) { return (await this.getMany([path]))[0]; },
            async query(collection, { filters = [], order = 'date', direction = 'DESCENDING', after, limit: pageLimit = 25, fields } = {}) {
              if (!readOnly || !/^[a-zA-Z]+$/.test(collection) || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 26) throw error(400, 'bounded_read_query_required');
              const clauses = filters.map(([field, op, value]) => ({ fieldFilter: { field: { fieldPath: field }, op, value: encode(value) } }));
              const q = { from: [{ collectionId: collection }], limit: pageLimit, orderBy: [{ field: { fieldPath: order }, direction }, { field: { fieldPath: '__name__' }, direction }] };
              if (fields) q.select = { fields: fields.map(fieldPath => ({ fieldPath })) };
              if (clauses.length) q.where = clauses.length === 1 ? clauses[0] : { compositeFilter: { op: 'AND', filters: clauses } };
              if (after) q.startAt = { before: false, values: [encode(after.date), { referenceValue: name(`${collection}/${after.id}`) }] };
              const rows = await request(`/v2/${namespace}:runQuery`, { structuredQuery: q, transaction: token }, total);
              return rows.filter(r => r.document).map(r => {
                const path = r.document.name.slice(prefix.length + 1);
                return remember(path, documentData(r.document));
              });
            },
            set(path, value) {
              name(path);
              if (readOnly || !cache.has(path)) throw error(503, 'write_requires_transactional_read');
              const clean = JSON.parse(JSON.stringify(value));
              if (bytes(clean) > (path.startsWith('transactions/') ? 128 * 1024 : 16 * 1024)) throw error(413, 'v2_document_budget_exceeded');
              writes.set(path, clean); check();
            },
            delete(path) { if (!cache.has(path) || readOnly) throw error(503, 'write_requires_transactional_read'); writes.set(path, null); check(); }
          };
          const result = await callback(tx);
          await request(':rollback', { transaction: token }, total);
          token = undefined;
          if (!readOnly && writes.size) {
            const commit = { writes: [...cache.keys()].map(path => {
              const currentDocument = preconditions.get(path);
              if (!currentDocument) throw error(503, 'v2_missing_document_version');
              if (!writes.has(path)) return { verify: name(path), currentDocument };
              const value = writes.get(path);
              return value === null ? { delete: name(path), currentDocument } : {
                update: { name: name(path), fields: encode(value).mapValue.fields }, currentDocument
              };
            }) };
            total.commitBytes = Math.max(total.commitBytes, bytes(commit));
            committing = true;
            await request(':commit', commit, total);
          }
          total.ok = true;
          return result;
        } catch (e) {
          if (token) await request(':rollback', { transaction: token }, total).catch(() => {});
          // A failed version precondition rejects the WHOLE Commit. Start a fresh
          // snapshot and recompute; unknown commit outcomes still escape for
          // the caller's same-operationId receipt recovery, never blind replay.
          if (e.firestoreStatus !== 'ABORTED' && !(committing &&
            ['FAILED_PRECONDITION', 'ALREADY_EXISTS', 'NOT_FOUND'].includes(e.firestoreStatus))) {
            if (transport && committing && (!e.httpStatus || e.httpStatus >= 500)) throw error(503, 'v2_commit_outcome_unknown_retry_same_key');
            throw e;
          }
          total.conflicts++;
          if (attempt + 1 === maxAttempts || performance.now() - start > 55_000) throw error(503, 'transaction_busy_retry_same_key');
          const wait = retryDelayMs(attempt);
          if (transport && performance.now() + wait >= total.deadlineAt) throw error(503, 'v2_deadline_retry_same_key');
          await delay(wait);
        }
      }
    } finally { delete total.deadlineAt; total.elapsedMs = Math.round(performance.now() - start); onMetric(total); }
  }
  return { run, namespace, name, request, prefix, assertTarget, remote: !!transport };
}
