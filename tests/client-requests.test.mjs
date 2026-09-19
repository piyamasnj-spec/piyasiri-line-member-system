import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/secure-api.mjs';
function storage() {
  const m = new Map();
  return {
    getItem: k => m.get(k),
    setItem: (k, v) => m.set(k, v),
    removeItem: k => m.delete(k)
  };
}
test('double click coalesces one client request', async () => {
  let release,
    calls = 0;
  const gate = new Promise(r => release = r),
    store = storage();
  const api = createApi({
    storage: store,
    token: () => 'fixture',
    uuid: () => 'op',
    fetcher: async () => {
      calls++;
      await gate;
      return {
        ok: true,
        json: async () => ({
          ok: true
        })
      };
    }
  });
  const a = api.mutate('reward-redemption', {
      rewardId: 'r'
    }, {
      scope: 'm'
    }),
    b = api.mutate('reward-redemption', {
      rewardId: 'r'
    }, {
      scope: 'm'
    });
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});
test('refresh after response loss retains key and does not debit again', async () => {
  const store = storage(),
    keys = [];
  const before = createApi({
    storage: store,
    token: () => 'fixture',
    uuid: () => 'original-key',
    fetcher: async (u, o) => {
      keys.push(JSON.parse(o.body).operationId);
      throw new TypeError('lost');
    }
  });
  await assert.rejects(before.mutate('reward-redemption', {
    rewardId: 'r'
  }, {
    scope: 'm'
  }));
  const after = createApi({
    storage: store,
    token: () => 'fixture',
    uuid: () => 'wrong-new-key',
    fetcher: async (u, o) => {
      keys.push(JSON.parse(o.body).operationId);
      return {
        ok: true,
        json: async () => ({
          ok: true
        })
      };
    }
  });
  await after.mutate('reward-redemption', {
    rewardId: 'r'
  }, {
    scope: 'm'
  });
  assert.deepEqual(keys, ['original-key', 'original-key']);
});
test('failed state refresh preserves successful operation key for recovery', async () => {
  const store = storage(),
    keys = [];
  let n = 0;
  const api = createApi({
    storage: store,
    token: () => 'fixture',
    uuid: () => String(++n),
    fetcher: async (u, o) => {
      keys.push(JSON.parse(o.body).operationId);
      return {
        ok: true,
        json: async () => ({
          ok: true
        })
      };
    }
  });
  await assert.rejects(api.mutate('reward-redemption', {
    rewardId: 'r'
  }, {
    scope: 'm',
    afterSuccess: async () => {
      throw new Error('reload failed');
    }
  }));
  await api.mutate('reward-redemption', {
    rewardId: 'r'
  }, {
    scope: 'm'
  });
  assert.equal(keys[0], keys[1]);
});
