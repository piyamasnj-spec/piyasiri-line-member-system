// Separate, explicitly invoked integration suite. Never defaults to a remote database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (host !== '127.0.0.1:9000') throw new Error('Start a local demo emulator first; integration is blocked without it');
const base = `http://${host}`;
const rules = JSON.parse(await readFile(new URL('../firebase/database.rules.proposed.json', import.meta.url), 'utf8'));
const request = (path, options = {}) => fetch(`${base}/${path}.json?ns=demo-member-stabilize`, options);
const headers = {
  Authorization: 'Bearer owner',
  'Content-Type': 'application/json'
};
let result = await request('.settings/rules', {
  method: 'PUT',
  headers,
  body: JSON.stringify(rules)
});
assert.equal(result.ok, true, 'emulator rules setup');
result = await request('', {
  method: 'PUT',
  headers,
  body: JSON.stringify({
    customers: {
      fixture: {
        points: 10
      }
    },
    rewards: {
      r: {
        stock: 1
      }
    },
    transactions: {},
    redemptions: {}
  })
});
assert.equal(result.ok, true, 'synthetic fixture only');
let checked = 0;
for (const path of ['', 'customers', 'customers/fixture/points', 'transactions', 'redemptions', 'rewards', 'operationLocks', 'secureOperations', 'security', 'notificationJobs']) {
  assert.equal((await request(path)).status, 401, `anonymous read ${path}`);
  assert.equal((await request(path, {
    method: 'PUT',
    body: JSON.stringify({
      forged: true
    })
  })).status, 401, `anonymous write ${path}`);
  checked += 2;
}
// REST CAS contract against the emulator; auth bypass is server-only.
const snapshot = await request('', {
    headers: {
      ...headers,
      'X-Firebase-ETag': 'true'
    }
  }),
  etag = snapshot.headers.get('etag'),
  root = await snapshot.json();
root.customers.fixture.points = 5;
assert.equal((await request('', {
  method: 'PUT',
  headers: {
    ...headers,
    'if-match': etag
  },
  body: JSON.stringify(root)
})).status, 200);
assert.equal((await request('', {
  method: 'PUT',
  headers: {
    ...headers,
    'if-match': etag
  },
  body: JSON.stringify({
    ...root,
    forged: true
  })
})).status, 412);
console.log(`Emulator rules/CAS checks passed: ${checked + 2}`);
