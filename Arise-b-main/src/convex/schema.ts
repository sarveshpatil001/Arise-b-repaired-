import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  OPERATOR: "operator",
  ANALYST: "analyst",
  USER: "user",
  MEMBER: "member", // legacy alias retained for existing rows
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.OPERATOR),
  v.literal(ROLES.ANALYST),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    users: defineTable({
      name: v.optional(v.string()),
      image: v.optional(v.string()),
      email: v.optional(v.string()),
      emailVerificationTime: v.optional(v.number()),
      isAnonymous: v.optional(v.boolean()),
      role: v.optional(roleValidator), // admin | operator | analyst | user
      disabled: v.optional(v.boolean()), // admin can block access
      stripeCustomerId: v.optional(v.string()),
    })
      .index("email", ["email"])
      // Lets "does any admin exist?" be an indexed lookup instead of a table scan, and
      // gives admin listings a stable order.
      .index("role", ["role"]),

    // One-time admin bootstrap marker. Written in the SAME transaction that grants the
    // first admin role, so bootstrap can never be re-opened — not by a repeated request
    // and not by deleting every admin account and replaying the setup code.
    bootstrapState: defineTable({
      key: v.literal("admin"),
      completedAt: v.number(),
      completedBy: v.optional(v.id("users")),
    }).index("key", ["key"]),

    // ---------------- ARISE V1 ----------------

    paperAccounts: defineTable({
      userId: v.id("users"),
      balance: v.number(),
      equityHighWaterMark: v.number(),
      dayStartEquity: v.number(),
      dayKey: v.string(), // UTC YYYY-MM-DD for daily-loss accounting
      emergencyStop: v.boolean(),
      startingBalance: v.number(),
    }).index("userId", ["userId"]),

    decisions: defineTable({
      userId: v.id("users"),
      symbol: v.string(),
      interval: v.string(),
      requestedInterval: v.optional(v.string()),
      mode: v.literal("paper"),
      status: v.string(), // TRADE | WAIT | VETOED | ERROR
      direction: v.string(), // LONG | SHORT | FLAT
      confidence: v.number(),
      regime: v.string(),
      thesis: v.string(),
      recommendedAction: v.string(),
      dataQuality: v.string(),
      dataAgeSec: v.number(),
      dataSource: v.string(),
      dataTimestamp: v.number(),
      mind: v.any(),
      agents: v.any(),
      features: v.optional(v.any()),
      snapshotMeta: v.optional(v.any()),
      risk: v.optional(v.any()),
      plan: v.optional(v.any()),
      execution: v.optional(v.any()),
      // Deterministic evidence verdict: outcome, reason codes, evidence quality,
      // the confidence ceiling it imposed, and every unresolved unknown.
      evidence: v.optional(v.any()),
      error: v.optional(v.string()),
    })
      .index("userId", ["userId"])
      .index("userId_symbol", ["userId", "symbol"])
      .index("status", ["status"]),

    positions: defineTable({
      userId: v.id("users"),
      decisionId: v.id("decisions"),
      symbol: v.string(),
      side: v.string(), // LONG | SHORT
      qty: v.number(),
      entryPrice: v.number(),
      stopLoss: v.number(),
      takeProfit: v.number(),
      entryFee: v.number(),
      status: v.string(), // OPEN | CLOSED
      openedAt: v.number(),
      closedAt: v.optional(v.number()),
      exitPrice: v.optional(v.number()),
      exitReason: v.optional(v.string()),
      pnl: v.optional(v.number()),
      exitFee: v.optional(v.number()),
      thesis: v.optional(v.string()),
      riskDecision: v.optional(v.string()),
      maxLossQuote: v.optional(v.number()),
      // Durable execution idempotency key (userId+symbol+interval+bar time). Unlike
      // the paper broker's in-memory set — which is useless because a new broker is
      // constructed per request — this survives retries and concurrent calls.
      idemKey: v.optional(v.string()),
    })
      .index("userId", ["userId"])
      .index("userId_status", ["userId", "status"])
      .index("userId_symbol", ["userId", "symbol"])
      .index("decisionId", ["decisionId"])
      .index("status", ["status"]) // cross-user OPEN scan for the background monitor
      .index("idemKey", ["idemKey"]), // duplicate-execution guard

    equityPoints: defineTable({
      userId: v.id("users"),
      t: v.number(),
      equity: v.number(),
      cash: v.number(),
      drawdownPct: v.number(),
    }).index("userId_t", ["userId", "t"]),

    // Fixed-window quota for authenticated chart proxy requests. One row per user is
    // reused across windows so callers cannot grow this table with arbitrary keys.
    candleRequestLimits: defineTable({
      userId: v.id("users"),
      windowStart: v.number(),
      count: v.number(),
    }).index("userId", ["userId"]),

    // Same fixed-window design for the news proxy: one row per user, so the table
    // cannot be grown with arbitrary keys and the quota check is concurrency-safe
    // (Convex serializes writes to the single row).
    newsRequestLimits: defineTable({
      userId: v.id("users"),
      windowStart: v.number(),
      count: v.number(),
    }).index("userId", ["userId"]),

    systemEvents: defineTable({
      level: v.string(), // INFO | WARN | ERROR
      area: v.string(), // DATA | AI | RISK | EXECUTION | SYSTEM | BILLING
      code: v.string(),
      message: v.string(),
      at: v.number(),
    }).index("at", ["at"]),

    // ---------------- Billing (Stripe) ----------------

    plans: defineTable({
      key: v.string(), // free | pro | institutional
      name: v.string(),
      priceMonthly: v.number(), // cents USD
      analysisLimitPerDay: v.number(), // -1 = unlimited
      symbolWatchlist: v.number(), // max concurrently analyzed symbols
      stripePriceId: v.optional(v.string()),
      features: v.array(v.string()),
      sortOrder: v.number(),
    }).index("key", ["key"]),

    subscriptions: defineTable({
      userId: v.id("users"),
      stripeCustomerId: v.string(),
      stripeSubscriptionId: v.optional(v.string()),
      stripeCheckoutSessionId: v.optional(v.string()),
      planKey: v.string(),
      status: v.string(), // trialing | active | past_due | canceled | incomplete
      currentPeriodEnd: v.optional(v.number()),
      cancelAtPeriodEnd: v.boolean(),
      updatedAt: v.number(),
    })
      .index("userId", ["userId"])
      .index("stripeCustomerId", ["stripeCustomerId"]),

    // Complimentary / institutional seats provisioned out of band (founder, design
    // partners, institutional agreements). Matched to a signed-in account by the
    // account's OWN email on the server, never by a value supplied by the client, and
    // independent of Stripe — so a seat granted before sign-up applies from the
    // account's first request. An active paid subscription always takes precedence.
    planGrants: defineTable({
      email: v.string(), // lowercased
      planKey: v.string(),
      note: v.optional(v.string()),
      grantedBy: v.optional(v.string()),
      grantedAt: v.number(),
      revokedAt: v.optional(v.number()),
      // Set when the matching account already existed at grant time.
      appliedUserId: v.optional(v.id("users")),
    })
      .index("email", ["email"])
      .index("planKey", ["planKey"]),

    // Stripe webhook event log with an explicit processing state machine. The mere
    // EXISTENCE of a row is never treated as success — only `processed: true` /
    // status PROCESSED is. PROCESSING rows can be re-claimed once their lease goes
    // stale (a delivery that died mid-flight), and FAILED rows are retryable so a
    // transient failure never silently drops a subscription change.
    stripeEvents: defineTable({
      stripeEventId: v.string(), // idempotency key from the provider
      type: v.string(),
      payload: v.optional(v.string()),
      receivedAt: v.number(),
      processed: v.boolean(),
      error: v.optional(v.string()),
      status: v.optional(v.string()), // PROCESSING | PROCESSED | FAILED
      attempts: v.optional(v.number()),
      lastAttemptAt: v.optional(v.number()),
      completedAt: v.optional(v.number()),
    })
      .index("stripeEventId", ["stripeEventId"])
      .index("status", ["status"]),

    analysisUsage: defineTable({
      userId: v.id("users"),
      dayKey: v.string(), // UTC YYYY-MM-DD
      count: v.number(),
    }).index("userId_day", ["userId", "dayKey"]),

    // ---------------- Admin control plane ----------------

    // Single-row platform configuration (deterministic operational state).
    platformConfig: defineTable({
      tradingHalted: v.boolean(), // platform-wide stop: no new decisions/trades
      haltReason: v.optional(v.string()),
      haltedBy: v.optional(v.id("users")),
      haltedAt: v.optional(v.number()),
      updatedAt: v.number(),
    }),

    // Background position monitor state (single row, key = "monitor").
    // Lease (`runningClaim`) prevents overlapping runs; recentTicks feeds health.
    monitorState: defineTable({
      key: v.literal("monitor"),
      lastTickAt: v.number(),
      lastRun: v.optional(
        v.object({
          at: v.number(),
          evaluated: v.number(),
          closed: v.number(),
          skipped: v.number(),
          ok: v.boolean(),
          details: v.optional(v.string()),
        }),
      ),
      recentTicks: v.array(
        v.object({
          at: v.number(),
          evaluated: v.number(),
          closed: v.number(),
          skipped: v.number(),
          ok: v.boolean(),
        }),
      ),
      runningClaim: v.optional(v.object({ at: v.number() })),
      // Pagination cursor for the OPEN-position scan. Without it the monitor would
      // re-read the same first 25 OPEN positions every tick and starve the rest.
      openCursor: v.optional(v.string()),
    }).index("key", ["key"]),

    // ---------------- Bot Training System ----------------
    // User-owned trading bots under test. Strategies are allow-listed IDs only.
    bots: defineTable({
      userId: v.id("users"),
      name: v.string(),
      strategyId: v.string(), // sma-cross | rsi-mean | arise-momentum | buy-hold
      description: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("userId", ["userId"])
      .index("userId_name", ["userId", "name"]),

    // Deterministic backtest runs. All inputs stored for reproducibility.
    backtestRuns: defineTable({
      userId: v.id("users"),
      botId: v.id("bots"),
      botName: v.string(),
      strategyId: v.string(),
      symbol: v.string(),
      interval: v.string(),
      requestedInterval: v.optional(v.string()),
      dataKind: v.string(), // REAL | SYNTHETIC
      dataSource: v.string(),
      barCount: v.number(),
      seed: v.number(),
      feeBps: v.number(),
      slippageBps: v.number(),
      positionPct: v.number(),
      stopPct: v.number(),
      targetPct: v.number(),
      inSamplePct: v.number(),
      stress: v.string(), // none | gap-down | vol-spike | low-liquidity | high-cost
      status: v.string(), // COMPLETED | FAILED | INSUFFICIENT_DATA
      metrics: v.any(),
      fitness: v.any(),
      // Deterministic strategy-fitness gate report (thresholds, blockers, score)
      // from src/lib/arise/strategyFitness.ts. Stored beside the legacy score so a
      // promotion decision can cite the exact gate that blocked it.
      fitnessGates: v.optional(v.any()),
      // Walk-forward evidence (folds, selected params, OOS aggregates, refusals) from
      // src/lib/arise/walkForward.ts — the out-of-sample record behind the gates.
      walkForward: v.optional(v.any()),
      equityCurve: v.any(),
      trades: v.any(),
      error: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("userId", ["userId"])
      .index("userId_bot", ["userId", "botId"]),

    // Controlled-learning proposals (mandate §6.L). A row here is a *record*, never
    // an authorization: every transition goes through `arise/learning.ts`, which
    // re-runs the pure policy in src/lib/arise/learning.ts. Forbidden targets
    // (risk limits, execution mode, security policy, secrets) cannot be stored as a
    // valid proposal, and only a privileged actor can approve or apply one.
    learningProposals: defineTable({
      proposalId: v.string(),
      createdBy: v.id("users"),
      createdByEmail: v.optional(v.string()),
      createdAt: v.number(),
      at: v.number(), // last state change (ordering key)
      trigger: v.string(),
      target: v.string(),
      currentValue: v.any(),
      proposedValue: v.any(),
      previousValue: v.optional(v.any()),
      rationale: v.string(),
      evidence: v.array(v.string()),
      expectedEffect: v.string(),
      riskOfChange: v.string(),
      evaluationPlan: v.string(),
      status: v.string(), // PROPOSED|EVALUATING|APPROVED|REJECTED|APPLIED|ROLLED_BACK
      violations: v.optional(v.any()),
      // Reference to the isolated evaluation that had to complete and pass before
      // APPLIED (e.g. a walk-forward run id).
      evaluation: v.optional(v.any()),
      decidedBy: v.optional(v.string()),
      appliedAt: v.optional(v.number()),
      rolledBackAt: v.optional(v.number()),
    })
      .index("proposalId", ["proposalId"])
      .index("status", ["status"])
      .index("at", ["at"]),

    // ---------------- Analysis section (append-only) ----------------
    // Immutable snapshot of each saved analysis. The original prediction is copied
    // here when it is first saved and is never updated: later analyses, monitoring
    // events and paper trades cannot rewrite history. Monitoring/paper outcomes live
    // on `positions`; this table keeps what was actually predicted and on what evidence.
    analysisRecords: defineTable({
      userId: v.id("users"),
      decisionId: v.id("decisions"),
      createdAt: v.number(),
      symbol: v.string(),
      interval: v.string(),
      status: v.string(), // TRADE | WAIT | VETOED | ERROR (as recorded)
      direction: v.string(), // LONG | SHORT | FLAT
      confidence: v.number(),
      thesis: v.string(),
      recommendedAction: v.string(),
      dataQuality: v.string(),
      dataSource: v.string(),
      dataTimestamp: v.number(),
      snapshotMeta: v.optional(v.any()),
      plan: v.optional(v.any()),
      risk: v.optional(v.any()),
      evidence: v.optional(v.any()),
      minds: v.optional(v.any()),
      agents: v.optional(v.any()),
      features: v.optional(v.any()),
      // Deterministic trade-plan card derived at save time (entry range, TP1/2/3,
      // R:R, entry window, holding estimate). Derived values are labelled as such.
      tradeCard: v.any(),
      // Strategy attribution when a Strategy Arena run informed the record; null when
      // the decision came from the existing pipeline alone.
      strategy: v.optional(v.any()),
      // News context at analysis time (headline assessment / catalysts), never invented.
      news: v.optional(v.any()),
      modelVersion: v.string(),
    })
      .index("userId", ["userId"])
      .index("userId_createdAt", ["userId", "createdAt"])
      .index("userId_symbol", ["userId", "symbol"])
      .index("decisionId", ["decisionId"]),

    // Append-only administrative audit trail.
    adminAudit: defineTable({
      at: v.number(),
      actorId: v.id("users"),
      actorEmail: v.optional(v.string()),
      action: v.string(),
      component: v.string(),
      prevState: v.optional(v.string()),
      newState: v.optional(v.string()),
      result: v.string(), // SUCCESS | FAILED
    }).index("at", ["at"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
