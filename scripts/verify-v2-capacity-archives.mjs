// Streaming archive validation only; never connects to a database.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { freemem } from 'node:os';
import { createInterface } from 'node:readline';

const directory = new URL('../../emulator-runtime/v2-capacity-data/', import.meta.url);
const results = [];
for (const name of ['5000-normal', '5000-stress', '10000-normal', '10000-stress']) {
  const manifest = JSON.parse(await readFile(new URL(`${name}.manifest.json`, directory)));
  assert.equal(manifest.synthetic, true);
  const source = createReadStream(new URL(`${name}.jsonl.gz`, directory));
  const unzip = createGunzip();
  source.on('error', error => unzip.destroy(error));
  source.pipe(unzip);
  const hash = createHash('sha256');
  let bytes = 0, documents = 0, maxDocumentBytes = 0, peakRss = 0, lastPath;
  const collections = {}, balances = new Map(), ledger = new Map();
  unzip.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
  const lines = createInterface({ input: unzip, crlfDelay: Infinity });
  // readline does not forward input stream failures automatically.
  const streamDone = new Promise((resolve, reject) => { unzip.on('end', resolve); unzip.on('error', reject); });
  streamDone.catch(() => lines.close());
  for await (const line of lines) {
    const { path, data } = JSON.parse(line);
    const collection = path.split('/')[0]; lastPath = path;
    collections[collection] = (collections[collection] || 0) + 1;
    maxDocumentBytes = Math.max(maxDocumentBytes, Buffer.byteLength(JSON.stringify(data)));
    if (collection === 'customers') balances.set(data.id, data.points);
    if (collection === 'transactions') {
      const delta = data.type === 'earn' ? data.points : -data.points;
      ledger.set(data.customerId, (ledger.get(data.customerId) || 0) + delta);
    }
    if (++documents % 100000 === 0) {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      assert.ok(peakRss < 768 * 1024 ** 2 && freemem() > 1536 * 1024 ** 2, 'streaming memory safety guard');
    }
  }
  await streamDone; // Includes gzip trailer/CRC validation.
  assert.equal(lastPath, 'control/writer');
  assert.equal(documents, manifest.documents);
  assert.equal(bytes, manifest.jsonlBytes);
  assert.equal(hash.digest('hex'), manifest.sha256Uncompressed);
  assert.deepEqual(collections, manifest.collections);
  assert.equal(balances.size, manifest.options.members);
  for (const [id, points] of balances) assert.equal(points, 10000 + (ledger.get(id) || 0));
  const result = { name, documents, jsonlBytes: bytes, collections, maxDocumentBytes, peakRss, gzipHashCountsAndBalances: 'PASS', databaseLoaded: false };
  results.push(result); console.log(JSON.stringify(result));
  await writeFile(new URL('../../../outputs/v2-capacity-archive-verification.json', import.meta.url), JSON.stringify(results, null, 2));
}
