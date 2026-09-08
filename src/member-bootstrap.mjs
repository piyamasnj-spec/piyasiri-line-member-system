import { resolveCustomerRoute } from "./customer-routes.mjs";

export const MEMBER_BOOTSTRAP_STATUS = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  ERROR: "error"
});

export class MemberBootstrapError extends Error {
  constructor(message, { cause, code = "MEMBER_LOOKUP_FAILED" } = {}) {
    super(message, { cause });
    this.name = "MemberBootstrapError";
    this.code = code;
  }
}

function normalizeRoute(hash) {
  const route = resolveCustomerRoute(hash || "#member");
  return route.valid ? route.hash : "#member";
}

export function memberViewMode({ status, customer }) {
  if ([MEMBER_BOOTSTRAP_STATUS.IDLE, MEMBER_BOOTSTRAP_STATUS.LOADING].includes(status)) return "loading";
  if (status === MEMBER_BOOTSTRAP_STATUS.ERROR) return "error";
  return customer ? "member" : "guest";
}

export function createMemberBootstrapCoordinator(initialHash = "#member") {
  let generation = 0;
  let status = MEMBER_BOOTSTRAP_STATUS.IDLE;
  let requestedHash = normalizeRoute(initialHash);
  let payload = null;
  let error = null;

  const snapshot = () => ({ generation, status, requestedHash, payload, error });

  return {
    begin(hash = requestedHash) {
      generation += 1;
      status = MEMBER_BOOTSTRAP_STATUS.LOADING;
      requestedHash = normalizeRoute(hash);
      payload = null;
      error = null;
      return snapshot();
    },
    requestRoute(hash) {
      requestedHash = normalizeRoute(hash);
      return snapshot();
    },
    complete(runGeneration, nextPayload) {
      if (runGeneration !== generation || status !== MEMBER_BOOTSTRAP_STATUS.LOADING) {
        return { ...snapshot(), stale: true };
      }
      status = MEMBER_BOOTSTRAP_STATUS.READY;
      payload = nextPayload;
      error = null;
      return snapshot();
    },
    fail(runGeneration, nextError) {
      if (runGeneration !== generation || status !== MEMBER_BOOTSTRAP_STATUS.LOADING) {
        return { ...snapshot(), stale: true };
      }
      status = MEMBER_BOOTSTRAP_STATUS.ERROR;
      payload = null;
      error = nextError;
      return snapshot();
    },
    snapshot
  };
}

export async function loadMemberBootstrapData({
  lineUserId,
  loadCustomers,
  loadSupplementalState,
  onPhase = () => {}
}) {
  if (!lineUserId) {
    throw new MemberBootstrapError("LINE profile is required before member lookup", {
      code: "LINE_PROFILE_REQUIRED"
    });
  }
  if (typeof loadCustomers !== "function" || typeof loadSupplementalState !== "function") {
    throw new MemberBootstrapError("Member data loaders are not configured", {
      code: "MEMBER_LOADER_MISSING"
    });
  }

  try {
    onPhase("member-lookup-start");
    const customers = await loadCustomers();
    const customer = customers.find(item => item.lineUserId === lineUserId) || null;
    onPhase(customer ? "member-found" : "member-not-found");
    const supplemental = await loadSupplementalState();
    const state = {
      customers,
      transactions: supplemental.transactions || [],
      pendingPurchases: supplemental.pendingPurchases || [],
      redemptions: supplemental.redemptions || [],
      rewards: supplemental.rewards || []
    };
    onPhase("member-data-ready");
    return { state, customer };
  } catch (error) {
    if (error instanceof MemberBootstrapError) throw error;
    throw new MemberBootstrapError("Unable to load member data", { cause: error });
  }
}
