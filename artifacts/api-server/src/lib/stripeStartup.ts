/**
 * Bounded Stripe start-up and the billing part of `/readyz`.
 *
 * Stripe initialization (sync schema, SDK import, credential lookup, managed
 * webhook, backfill and the service-price catalogue check) used to be awaited
 * inline before the API was marked ready, so a hung step left `/readyz` on
 * "starting" for ever. It now runs as a supervised attempt with a deadline:
 *
 * | Stripe situation                         | /readyz                                   | Billing activation            |
 * |------------------------------------------|-------------------------------------------|-------------------------------|
 * | first attempt running, before deadline   | 503 `starting`                            | blocked                       |
 * | not configured, NODE_ENV != production   | 200 `ok`, `billing.state: "unconfigured"` | blocked                       |
 * | not configured, NODE_ENV == production   | 503 `degraded` + blocker                  | blocked                       |
 * | slow (deadline passed, still running)    | 503 `degraded` + blocker naming the step  | blocked; recovers on success  |
 * | failing (error, unreadable catalogue)    | 503 `degraded` + blocker; retried         | blocked; recovers on success  |
 * | catalogue checked, prices missing/dupes  | 503 `degraded` + blocker; not retried     | per-request price preflight   |
 * | ready                                    | 200 `ok`                                  | per-request price preflight   |
 *
 * "Blocked" means checkout and add-on activation refuse with 503 before any
 * Stripe call while the catalogue is unverified in this process. When the
 * catalogue *was* read, the existing per-request preflight in the billing
 * routes stays the authority on which services may be bought.
 *
 * A timed-out attempt is never run concurrently with a new one: its pending
 * work (webhook find-or-create, backfill, idempotent price creation) must not
 * be duplicated. The supervisor waits for it to settle, then retries failures
 * with back-off. Nothing here logs credentials; blockers and stage names are
 * fixed, non-secret strings.
 */

export type BillingPhase =
  /** This entry point never initializes Stripe (isolated test servers). */
  | "not_managed"
  | "initializing"
  | "ready"
  | "unconfigured"
  | "degraded";

export interface BillingReadiness {
  phase: BillingPhase;
  /** Non-secret reason readiness is withheld, if any. */
  blocker: string | null;
  /** The initialization step currently running (or the one that timed out). */
  stage: string | null;
  /** True once the synced service-price catalogue was actually read. */
  catalogueVerified: boolean;
  /** Number of initialization attempts started. */
  attempts: number;
  /** Whether an initialization attempt is still running. */
  inFlight: boolean;
  /** Whether a failed attempt will be retried automatically. */
  retryScheduled: boolean;
  /** Unconfigured Stripe withholds readiness only when Stripe is required. */
  required: boolean;
}

export interface StripeAttemptResult {
  /** Non-secret readiness blocker, or null when billing is ready. */
  blocker: string | null;
  /**
   * True when the blocker is a verdict on a catalogue that was read (missing or
   * duplicated prices). Retrying will not change it; an administrator must.
   */
  catalogueVerified: boolean;
}

export type StripeCredentialSource = "env" | null;

export interface StripeStartupLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface StripeStartupOptions {
  credentialSource: () => StripeCredentialSource;
  runAttempt: (onStage: (stage: string) => void) => Promise<StripeAttemptResult>;
  /** When true, missing Stripe configuration withholds readiness. */
  required: boolean;
  /** Per-attempt deadline before readiness reports the attempt as stalled. */
  timeoutMs: number;
  /** Back-off between failed attempts; the last value repeats. */
  retryDelaysMs: number[];
  logger: StripeStartupLogger;
  /**
   * Called once, the first time Stripe start-up reads the synced catalogue
   * (ready, or ready apart from missing/duplicated prices).
   */
  onCatalogueVerified?: () => void;
  now?: () => number;
}

export interface StripeStartupHandle {
  /**
   * Resolves when the first attempt settles or its deadline passes, whichever
   * comes first. Never waits on a hung dependency.
   */
  firstSettledOrDeadline: Promise<void>;
  stop(): void;
}

const NOT_MANAGED: BillingReadiness = {
  phase: "not_managed",
  blocker: null,
  stage: null,
  catalogueVerified: false,
  attempts: 0,
  inFlight: false,
  retryScheduled: false,
  required: false,
};

let state: BillingReadiness = { ...NOT_MANAGED };

export function getBillingReadiness(): BillingReadiness {
  return { ...state };
}

/** Test hook: forget any supervisor state. */
export function resetBillingReadinessForTests(): void {
  state = { ...NOT_MANAGED };
}

export const BILLING_UNVERIFIED_ERROR =
  "Billing is temporarily unavailable while the Stripe price catalogue is verified. Please try again shortly.";

/**
 * Whether checkout / add-on activation may proceed to the per-request price
 * preflight. False while the catalogue is unverified in this process.
 */
export function isBillingActivationAllowed(readiness: BillingReadiness = state): boolean {
  return readiness.phase === "not_managed" || isStripeCatalogueVerified(readiness);
}

/**
 * Whether this process's Stripe start-up has read the synced catalogue. Billing
 * jobs that act on subscriptions (reconciliation) require this.
 */
export function isStripeCatalogueVerified(readiness: BillingReadiness = state): boolean {
  if (readiness.phase === "ready") return true;
  return readiness.phase === "degraded" && readiness.catalogueVerified;
}

export interface ReadinessReport {
  httpStatus: 200 | 503;
  body: {
    status: "ok" | "starting" | "degraded";
    blocker?: string;
    billing?: { state: BillingPhase; stage?: string; activationBlocked: boolean; retrying?: boolean };
  };
}

/** Pure mapping from process state to the `/readyz` response. */
export function computeReadiness(coreReady: boolean, billing: BillingReadiness): ReadinessReport {
  if (!coreReady) return { httpStatus: 503, body: { status: "starting" } };
  if (billing.phase === "not_managed") return { httpStatus: 200, body: { status: "ok" } };

  const billingBody = {
    state: billing.phase,
    ...(billing.stage && billing.phase !== "ready" ? { stage: billing.stage } : {}),
    activationBlocked: !isBillingActivationAllowed(billing),
    ...(billing.phase === "degraded" ? { retrying: billing.inFlight || billing.retryScheduled } : {}),
  };
  switch (billing.phase) {
    case "ready":
      return { httpStatus: 200, body: { status: "ok", billing: billingBody } };
    case "initializing":
      return { httpStatus: 503, body: { status: "starting", billing: billingBody } };
    case "unconfigured":
      return billing.required
        ? { httpStatus: 503, body: { status: "degraded", blocker: billing.blocker ?? "Stripe is not configured", billing: billingBody } }
        : { httpStatus: 200, body: { status: "ok", billing: billingBody } };
    case "degraded":
    default:
      return {
        httpStatus: 503,
        body: { status: "degraded", blocker: billing.blocker ?? "Stripe initialization failed", billing: billingBody },
      };
  }
}

export const STRIPE_NOT_CONFIGURED_BLOCKER = "Stripe is not configured (set STRIPE_SECRET_KEY)";
export const STRIPE_INIT_FAILED_BLOCKER = "Stripe service-price catalogue initialization failed";

export function stripeTimeoutBlocker(stage: string | null): string {
  return `Stripe initialization timed out${stage ? ` during ${stage}` : ""}; still waiting for it to finish`;
}

/**
 * Start supervised Stripe initialization. Only one supervisor runs per process.
 */
export function startStripeInitialization(options: StripeStartupOptions): StripeStartupHandle {
  const now = options.now ?? Date.now;
  let stopped = false;
  let verifiedNotified = false;
  const notifyVerified = () => {
    if (verifiedNotified) return;
    verifiedNotified = true;
    options.onCatalogueVerified?.();
  };
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let firstResolve!: () => void;
  const firstSettledOrDeadline = new Promise<void>((resolve) => { firstResolve = resolve; });

  const source = options.credentialSource();
  if (!source) {
    state = {
      ...NOT_MANAGED,
      phase: "unconfigured",
      blocker: options.required ? STRIPE_NOT_CONFIGURED_BLOCKER : null,
      required: options.required,
    };
    const log = options.required ? options.logger.error : options.logger.warn;
    log.call(options.logger, { required: options.required },
      "Stripe is not configured — billing checkout and add-on activation are disabled");
    firstResolve();
    return { firstSettledOrDeadline, stop: () => { stopped = true; } };
  }

  state = { ...NOT_MANAGED, phase: "initializing", required: options.required };

  const scheduleRetry = () => {
    if (stopped) return;
    const delays = options.retryDelaysMs.length ? options.retryDelaysMs : [60_000];
    const delay = delays[Math.min(state.attempts - 1, delays.length - 1)];
    state = { ...state, retryScheduled: true };
    options.logger.warn({ attempt: state.attempts, retryInMs: delay }, "Stripe initialization will be retried");
    retryTimer = setTimeout(() => { retryTimer = null; void runOnce(); }, delay);
    retryTimer.unref?.();
  };

  const runOnce = async () => {
    if (stopped) return;
    const attempt = state.attempts + 1;
    const startedAt = now();
    let stageStartedAt = startedAt;
    // Retries keep reporting the previous degraded state instead of flapping
    // back to "starting".
    state = { ...state, attempts: attempt, inFlight: true, retryScheduled: false, stage: null };
    options.logger.info({ attempt, credentialSource: source }, "Stripe initialization attempt started");

    let timedOut = false;
    const timer = setTimeout(() => {
      if (stopped || !state.inFlight) return;
      timedOut = true;
      state = {
        ...state,
        phase: "degraded",
        blocker: stripeTimeoutBlocker(state.stage),
        catalogueVerified: false,
      };
      options.logger.error(
        { attempt, stage: state.stage, timeoutMs: options.timeoutMs },
        "Stripe initialization exceeded its deadline — readiness degraded; waiting for the stalled step before retrying",
      );
      if (attempt === 1) firstResolve();
    }, options.timeoutMs);

    const onStage = (stage: string) => {
      const t = now();
      if (state.stage) {
        options.logger.info({ attempt, stage: state.stage, ms: t - stageStartedAt }, "Stripe initialization step finished");
      }
      stageStartedAt = t;
      state = { ...state, stage };
      if (timedOut) state = { ...state, blocker: stripeTimeoutBlocker(stage) };
      options.logger.info({ attempt, stage }, "Stripe initialization step started");
    };

    let result: StripeAttemptResult;
    try {
      result = await options.runAttempt(onStage);
    } catch (err) {
      options.logger.error({ err, attempt, stage: state.stage }, "Stripe initialization attempt failed");
      result = { blocker: STRIPE_INIT_FAILED_BLOCKER, catalogueVerified: false };
    }
    clearTimeout(timer);
    if (stopped) return;

    const elapsedMs = now() - startedAt;
    if (result.blocker === null) {
      state = { ...state, phase: "ready", blocker: null, stage: null, catalogueVerified: true, inFlight: false };
      options.logger.info({ attempt, elapsedMs, recoveredAfterTimeout: timedOut }, "Stripe initialization complete — billing ready");
      notifyVerified();
    } else {
      state = {
        ...state,
        phase: "degraded",
        blocker: result.blocker,
        catalogueVerified: result.catalogueVerified,
        inFlight: false,
      };
      options.logger.error({ attempt, elapsedMs, blocker: result.blocker }, "Stripe initialization finished without a verified catalogue");
      // A missing/duplicated-price verdict needs an administrator; retrying
      // the webhook and backfill would not change it.
      if (result.catalogueVerified) notifyVerified();
      else scheduleRetry();
    }
    if (attempt === 1) firstResolve();
  };

  void runOnce();

  return {
    firstSettledOrDeadline,
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}

/** Parse a positive millisecond setting, falling back when unset or invalid. */
export function positiveMsFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
