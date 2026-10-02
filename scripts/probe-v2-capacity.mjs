import { capacityDocuments } from './v2-capacity-envelope.mjs';
import { createStore, encode } from '../netlify/functions/lib/v2/firestore.mjs';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeFile } from 'node:fs/promises';
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085' || !/^\d+$/.test(process.env.V2_EMULATOR_PID || '')) throw Error('explicit local emulator host/PID required');
Object.assign(process.env, { FIRESTORE_V2_MODE: 'emulator', FIRESTORE_V2_PROJECT: 'demo-member-v2', CONTEXT: 'test' });
const options = { members: 5000, days: 1095, earnPerDay: 500, redeemPerDay: 50 };
const store = createStore({ namespace: `synthetic-resource-probe-${Date.now()}` }), samples = [];
const output = new URL('../../../outputs/v2-capacity-resource-probe.json', import.meta.url);
let documents = 0, batch = [], stopReason = null;
const memory = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p=Get-Process -Id ${process.env.V2_EMULATOR_PID}; @{privateBytes=$p.PrivateMemorySize64;workingSetBytes=$p.WorkingSet64}|ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
async function checkpoint() {
  const sample = { documents, ...memory(), freeSystemBytes: freemem(), at: new Date().toISOString() }; samples.push(sample);
  // Stop before heap exhaustion or starving the owner's desktop. No claim that a
  // partial load certifies capacity; the control/writer document remains absent.
  if (sample.privateBytes > 1400 * 1024 ** 2 || sample.workingSetBytes > 1536 * 1024 ** 2 || sample.freeSystemBytes < 1536 * 1024 ** 2) stopReason = 'local_resource_guard';
  await writeFile(output, JSON.stringify({ options, namespace: store.namespace, documents, stopReason, samples, financialWorkloadRun: false }, null, 2));
  console.log(JSON.stringify(sample));
}
await checkpoint();
for (const [path, data] of capacityDocuments(options)) {
  if (stopReason) break;
  batch.push({ update: { name: store.name(path), fields: encode(data).mapValue.fields }, currentDocument: { exists: false } });
  if (batch.length === 200) {
    await store.request(':commit', { writes: batch }); documents += batch.length; batch = [];
    if (documents % 10000 === 0) await checkpoint();
  }
}
if (!stopReason && batch.length) { await store.request(':commit', { writes: batch }); documents += batch.length; }
await checkpoint();
console.log(JSON.stringify({ documents, stopReason, complete: !stopReason }));
