import { syntheticNamespace } from '../netlify/functions/lib/v2/remote.mjs';

// Operator API only, no HTTP entrypoint and no auto-executing CLI. No project-wide deletion.
export async function cleanupSynthetic(store, { namespace, dryRun = true, confirm, maxDocuments = 10_000 } = {}) {
  store.assertTarget();
  if (!syntheticNamespace(namespace) || namespace !== store.namespace || (!dryRun && confirm !== namespace) ||
      typeof dryRun !== 'boolean' || !Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 10_000) throw Error('v2_cleanup_guard');
  const root = store.prefix, control = `${root}/control/writer`, started = performance.now();
  let calls = 0, visited = 0, deleted = 0, heldControl;
  const scoped = name => typeof name === 'string' && (name === root || name.startsWith(root + '/')) &&
    name.slice(root.length).split('/').every(p => !p || /^[a-zA-Z0-9_-]+$/.test(p));
  async function call(suffix, body, options) {
    store.assertTarget();
    if (++calls > 2000 || performance.now() - started > 60_000) throw Error('v2_cleanup_budget_exceeded');
    return store.request(suffix, body, undefined, options);
  }
  const suffix = name => { if (!scoped(name)) throw Error('v2_cleanup_path_denied'); return name.slice(name.indexOf('/documents') + '/documents'.length); };
  if (!dryRun) {
    // All application writers verify this version at atomic commit, including in-flight writers.
    await store.run(async tx => {
      const c = await tx.get('control/writer');
      if (c) tx.set('control/writer', { ...c, writesEnabled: false });
    }, { label: 'cleanup-disable-writer' });
  }
  let batch = [];
  async function flush() {
    if (!batch.length) return;
    await call(':commit', { writes: batch.map(d => ({ delete: d.name, currentDocument: { updateTime: d.updateTime } })) });
    deleted += batch.length; batch = [];
  }
  async function scan(name, depth, remove) {
    if (depth > 8) throw Error('v2_cleanup_depth_exceeded');
    let collectionToken;
    do {
      const page = await call(`${suffix(name)}:listCollectionIds`, { pageSize: 50, ...(collectionToken ? { pageToken: collectionToken } : {}) });
      for (const collection of page.collectionIds || []) {
        if (!/^[a-zA-Z0-9_-]+$/.test(collection)) throw Error('v2_cleanup_collection_denied');
        let token;
        do {
          const query = new URLSearchParams({ pageSize: '50', showMissing: 'true', ...(token ? { pageToken: token } : {}) });
          const rows = await call(`${suffix(name)}/${collection}?${query}`, {}, { method: 'GET' });
          for (const doc of rows.documents || []) {
            if (!scoped(doc.name) || !doc.name.startsWith(`${name}/${collection}/`) || doc.name.slice(`${name}/${collection}/`.length).includes('/')) throw Error('v2_cleanup_path_denied');
            if (++visited > maxDocuments) throw Error('v2_cleanup_document_budget_exceeded');
            await scan(doc.name, depth + 1, remove);
            if (doc.updateTime) {
              count++;
              if (remove) {
                if (doc.name === control) heldControl = doc;
                else { batch.push(doc); if (batch.length === 50) await flush(); }
              }
            }
          }
          if (rows.nextPageToken && rows.nextPageToken === token) throw Error('v2_cleanup_pagination_stalled');
          token = rows.nextPageToken;
        } while (token);
      }
      if (page.nextPageToken && page.nextPageToken === collectionToken) throw Error('v2_cleanup_pagination_stalled');
      collectionToken = page.nextPageToken;
    } while (collectionToken);
  }
  let count = 0;
  await scan(root, 0, !dryRun);
  const parent = await call(':batchGet', { documents: [root] });
  const rootDoc = parent.find(row => row.found)?.found;
  if (rootDoc) {
    if (rootDoc.name !== root || !rootDoc.updateTime) throw Error('v2_cleanup_root_guard');
    count++; if (!dryRun) batch.push(rootDoc);
  }
  if (dryRun) return { dryRun: true, documents: count, deleted: 0, namespace };
  await flush();
  if (heldControl) { batch.push(heldControl); await flush(); }
  count = 0; visited = 0;
  await scan(root, 0, false);
  const remainingParent = await call(':batchGet', { documents: [root] });
  if (remainingParent.some(row => row.found)) count++;
  if (count) throw Error('v2_cleanup_verification_failed');
  return { dryRun: false, deleted, remaining: 0, namespace };
}
