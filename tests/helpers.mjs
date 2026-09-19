import { createTransaction } from '../netlify/functions/lib/firebase-rest.mjs';
export const subject = 'U' + 'a'.repeat(32);
export const actor = {
  role: 'member',
  sub: subject
};
export const admin = {
  role: 'admin',
  sub: 'admin',
  sid: '00000000-0000-4000-8000-000000000001',
  exp: Math.floor(Date.now() / 1000) + 1700
};
export function fixture(overrides = {}) {
  let state = {
    customers: {
      m: {
        id: 'm',
        lineUserId: subject,
        phone: '0812345678',
        points: 10,
        totalSpend: 0
      }
    },
    rewards: {
      r: {
        id: 'r',
        name: 'Fixture',
        points: 5,
        stock: 2,
        active: true
      }
    },
    transactions: {},
    redemptions: {},
    security: {
      adminSessions: {
        [admin.sid]: {
          exp: admin.exp,
          revoked: false
        }
      }
    },
    unrelated: {
      preserved: true
    },
    ...overrides
  };
  let version = 0,
    lose = false,
    fail = false,
    conflicts = 0;
  const read = async path => ({
    value: structuredClone(path ? path.split('/').reduce((v, k) => v?.[k], state) : state),
    etag: String(version)
  });
  const put = async (path, next, {
    ifMatch
  }) => {
    if (ifMatch !== String(version)) {
      conflicts++;
      return {
        written: false
      };
    }
    if (fail) {
      fail = false;
      throw new Error('write failed before commit');
    }
    state = structuredClone(next);
    version++;
    if (lose) {
      lose = false;
      throw new Error('response lost after commit');
    }
    return {
      written: true
    };
  };
  return {
    read,
    tx: createTransaction({
      read,
      put,
      maxAttempts: 30
    }),
    get state() {
      return structuredClone(state);
    },
    get conflicts() {
      return conflicts;
    },
    loseResponse() {
      lose = true;
    },
    failWrite() {
      fail = true;
    }
  };
}
export const event = (body, headers = {}) => ({
  httpMethod: 'POST',
  headers,
  body: JSON.stringify(body)
});
export const parsed = r => ({
  ...JSON.parse(r.body),
  status: r.statusCode
});
