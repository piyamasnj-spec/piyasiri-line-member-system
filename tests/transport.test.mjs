import test from 'node:test';
import assert from 'node:assert/strict';
import { firebaseRead, firebasePut, databaseUrl, createTransaction } from '../netlify/functions/lib/firebase-rest.mjs';
test('REST transport uses server authorization, ETags and conditional PUT with 412 retry', async () => {
  process.env.FIREBASE_DATABASE_URL = 'http://127.0.0.1:9000';
  process.env.FIREBASE_EMULATOR_MODE = 'true';
  const original = globalThis.fetch,
    calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({
      url,
      options
    });
    return {
      ok: options.method !== 'PUT',
      status: options.method === 'PUT' ? 412 : 200,
      headers: new Headers({
        etag: 'fixture-etag'
      }),
      text: async () => '{"fixture":true}'
    };
  };
  try {
    assert.equal((await firebaseRead('', {
      etag: true
    })).etag, 'fixture-etag');
    assert.equal((await firebasePut('', {
      fixture: true
    }, {
      ifMatch: 'fixture-etag'
    })).conflict, true);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer owner');
    assert.equal(calls[0].options.headers['X-Firebase-ETag'], 'true');
    assert.equal(calls[1].options.headers['if-match'], 'fixture-etag');
    assert.match(calls[0].url, /127\.0\.0\.1:9000\/\.json\?ns=demo-member-stabilize/);
    await assert.rejects(firebasePut('', {}, {}), /conditional_write_required/);
  } finally {
    globalThis.fetch = original;
    delete process.env.FIREBASE_DATABASE_URL;
    delete process.env.FIREBASE_EMULATOR_MODE;
  }
});
test('large root and exhausted CAS conflicts abort without an unsafe write', async () => {
  let writes = 0;
  const tooLarge = createTransaction({
    read: async () => ({
      value: {
        blob: 'x'.repeat(8_000_001)
      },
      etag: 'a'
    }),
    put: async () => {
      writes++;
    }
  });
  await assert.rejects(tooLarge(() => {}), /size_requires_review/);
  assert.equal(writes, 0);
  const busy = createTransaction({
    maxAttempts: 2,
    read: async () => ({
      value: {},
      etag: 'a'
    }),
    put: async () => ({
      written: false
    })
  });
  await assert.rejects(busy(() => {}), /transaction_busy/);
});
test('loopback requires explicit emulator mode; arbitrary targets rejected', () => {
  for (const url of ['http://127.0.0.1:9000', 'https://evil.example', 'https://example.firebaseio.com/?auth=bad']) {
    process.env.FIREBASE_DATABASE_URL = url;
    assert.throws(databaseUrl);
  }
  delete process.env.FIREBASE_DATABASE_URL;
});

test('unexpected array collections fail closed instead of losing UUID-keyed records', async () => {
  let writes = 0;
  const tx = createTransaction({read:async()=>({value:{customers:[]},etag:'a'}),put:async()=>{writes++;return {written:true};}});
  await assert.rejects(tx(root=>{root.customers.fixture={points:10};}),/schema_requires_review/);
  assert.equal(writes,0);
});
