import assert from "node:assert/strict";
import test from "node:test";

import {
  establishLiffIdentity,
  LIFF_LOGIN_PENDING_KEY,
  LIFF_ROUTE_STORAGE_KEY,
  LiffInitializationError,
  resolveLiffId,
  saveLiffRoute,
  SUPPORTED_LIFF_ROUTES
} from "../src/liff-login-flow.mjs";

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    snapshot: () => Object.fromEntries(values)
  };
}

function locationFor(hash = "#member") {
  return {
    origin: "https://preview.example.netlify.app",
    pathname: "/",
    search: "",
    hash
  };
}

test("LIFF init success returns the authenticated profile without login redirect", async () => {
  let initCalls = 0;
  let loginCalls = 0;
  const liff = {
    init: async ({ liffId }) => {
      initCalls += 1;
      assert.equal(liffId, "test-liff-id");
    },
    isLoggedIn: () => true,
    getProfile: async () => ({ userId: "U-member", displayName: "Member" }),
    login: () => { loginCalls += 1; }
  };

  const result = await establishLiffIdentity({
    liff,
    liffId: "test-liff-id",
    storage: memoryStorage(),
    locationLike: locationFor("#history"),
    retryDelayMs: 0
  });

  assert.equal(result.status, "ready");
  assert.equal(result.profile.userId, "U-member");
  assert.equal(result.restoredRoute, "#history");
  assert.equal(initCalls, 1);
  assert.equal(loginCalls, 0);
});

test("LIFF init failure is surfaced and never continues to profile or guest fallback", async () => {
  let profileCalls = 0;
  const liff = {
    init: async () => { throw new Error("invalid LIFF configuration"); },
    isLoggedIn: () => true,
    getProfile: async () => { profileCalls += 1; }
  };

  await assert.rejects(
    establishLiffIdentity({
      liff,
      liffId: "test-liff-id",
      storage: memoryStorage(),
      locationLike: locationFor(),
      maxAttempts: 2,
      retryDelayMs: 0
    }),
    error => {
      assert.ok(error instanceof LiffInitializationError);
      assert.equal(error.networkFailure, false);
      assert.equal(error.attempts, 1);
      return true;
    }
  );
  assert.equal(profileCalls, 0);
});

test("network failure retries once and succeeds within the bounded attempt limit", async () => {
  let initCalls = 0;
  const liff = {
    init: async () => {
      initCalls += 1;
      if (initCalls === 1) throw new TypeError("Failed to fetch");
    },
    isLoggedIn: () => true,
    getProfile: async () => ({ userId: "U-member", displayName: "Member" })
  };

  const result = await establishLiffIdentity({
    liff,
    liffId: "test-liff-id",
    storage: memoryStorage(),
    locationLike: locationFor(),
    maxAttempts: 2,
    retryDelayMs: 0
  });

  assert.equal(result.status, "ready");
  assert.equal(result.attempts, 2);
  assert.equal(initCalls, 2);
});

test("network retry stops after the configured maximum attempts", async () => {
  let initCalls = 0;
  const liff = {
    init: async () => {
      initCalls += 1;
      throw new TypeError("Failed to fetch");
    }
  };

  await assert.rejects(
    establishLiffIdentity({
      liff,
      liffId: "test-liff-id",
      storage: memoryStorage(),
      locationLike: locationFor(),
      maxAttempts: 2,
      retryDelayMs: 0
    }),
    error => {
      assert.ok(error instanceof LiffInitializationError);
      assert.equal(error.networkFailure, true);
      assert.equal(error.attempts, 2);
      return true;
    }
  );
  assert.equal(initCalls, 2);
});

test("login callback restores and clears every supported customer hash", async () => {
  for (const route of SUPPORTED_LIFF_ROUTES) {
    const storage = memoryStorage();
    saveLiffRoute(storage, route);
    storage.setItem(LIFF_LOGIN_PENDING_KEY, String(Date.now()));
    const liff = {
      init: async () => {},
      isLoggedIn: () => true,
      getProfile: async () => ({ userId: "U-member", displayName: "Member" })
    };

    const result = await establishLiffIdentity({
      liff,
      liffId: "test-liff-id",
      storage,
      locationLike: locationFor(""),
      retryDelayMs: 0
    });

    assert.equal(result.restoredRoute, route);
    assert.equal(storage.getItem(LIFF_ROUTE_STORAGE_KEY), null);
    assert.equal(storage.getItem(LIFF_LOGIN_PENDING_KEY), null);
  }
});

test("normal page load without a saved route keeps a valid hash or defaults to member", async () => {
  const liff = {
    init: async () => {},
    isLoggedIn: () => true,
    getProfile: async () => ({ userId: "U-member", displayName: "Member" })
  };

  const profileResult = await establishLiffIdentity({
    liff,
    liffId: "test-liff-id",
    storage: memoryStorage(),
    locationLike: locationFor("#profile"),
    retryDelayMs: 0
  });
  const defaultResult = await establishLiffIdentity({
    liff,
    liffId: "test-liff-id",
    storage: memoryStorage(),
    locationLike: locationFor(""),
    retryDelayMs: 0
  });

  assert.equal(profileResult.restoredRoute, "#profile");
  assert.equal(defaultResult.restoredRoute, "#member");
});

test("login saves the route and a fresh pending marker prevents redirect loops", async () => {
  const storage = memoryStorage();
  let loginCalls = 0;
  const liff = {
    init: async () => {},
    isLoggedIn: () => false,
    getProfile: async () => { throw new Error("profile must not load before login"); },
    login: options => {
      loginCalls += 1;
      assert.equal(options.redirectUri, "https://preview.example.netlify.app/");
    }
  };

  const first = await establishLiffIdentity({
    liff,
    liffId: "test-liff-id",
    storage,
    locationLike: locationFor("#promotions"),
    retryDelayMs: 0,
    now: 1000
  });
  assert.equal(first.status, "redirecting");
  assert.equal(storage.getItem(LIFF_ROUTE_STORAGE_KEY), "#promotions");

  await assert.rejects(
    establishLiffIdentity({
      liff,
      liffId: "test-liff-id",
      storage,
      locationLike: locationFor("#promotions"),
      retryDelayMs: 0,
      now: 1100
    }),
    error => error instanceof LiffInitializationError && error.code === "LIFF_REDIRECT_LOOP"
  );
  assert.equal(loginCalls, 1);
});

test("Production LIFF ID is isolated from previews without a configured Test LIFF ID", () => {
  const config = {
    productionHostname: "piyasiri-line-member-system.netlify.app",
    productionId: "production-liff-id",
    testId: ""
  };
  assert.equal(resolveLiffId({ hostname: config.productionHostname, ...config }), "production-liff-id");
  assert.equal(resolveLiffId({ hostname: config.productionHostname, ...config, testId: "test-liff-id" }), "production-liff-id");
  assert.equal(resolveLiffId({ hostname: "deploy-preview-5--piyasiri-line-member-system.netlify.app", ...config }), "");
  assert.equal(resolveLiffId({ hostname: "deploy-preview-5--piyasiri-line-member-system.netlify.app", ...config, testId: "test-liff-id" }), "test-liff-id");
});
