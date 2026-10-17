// ARISE admin control plane. Every function is role-guarded; everything is audited.
// Safety constraint honored: administrators can see and stop the system, but the
// deterministic risk engine and pipeline validation remain beyond admin override —
// a halt can only ever make ARISE trade LESS, never more.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalQuery, query, mutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireActiveAdmin } from "../lib/authz";
import { PLAN_MAP } from "./billing";
import { listSymbols } from "../../lib/arise/providers";
import {
  buildAgentRows,
  feedState,
  mergeAuditRows,
  providerStatus,
  symbolFreshness,
} from "../../lib/arise/adminLogic";

// Explicit read ceilings keep admin pages within Convex read budgets. Any aggregate
// that hits a ceiling reports truncation rather than presenting a partial count as exact.
const ADMIN_READ_CAP = 1000;
const ADMIN_EVENT_CAP = 2000;
const ADMIN_AUDIT_CAP = 2000;

// ---------------- helpers ----------------

/** Shared context for role-guarded helpers callable from both queries and mutations. */
type DbCtx = QueryCtx | MutationCtx;

async function requireAdmin(ctx: DbCtx): Promise<{ userId: Id<"users">; email: string | undefined }> {
  // One policy definition for the whole control plane: an active administrator.
  // A disabled account is rejected as disabled (not merely non-admin), so audit and
  // client errors distinguish the two cases consistently with the shared helper.
  const { userId, user } = await requireActiveAdmin(ctx);
  return { userId, email: user.email ?? undefined };
}

/**
 * Append-only admin audit write.
 *
 * This is the SECURITY audit trail (who changed a role, a plan, a platform halt), not an
 * operational log, so nothing is ever deleted to enforce a row cap: silently dropping the
 * oldest entries would erase exactly the records an incident review needs. Retention is
 * therefore "all of it" — the table is low-volume (administrator actions only) and can be
 * archived or exported rather than trimmed. The bounded, high-frequency operational log
 * lives separately in `systemEvents`, which keeps its explicit retention window.
 */
async function audit(
  ctx: MutationCtx,
  p: {
    actorId: Id<"users">;
    actorEmail?: string;
    action: string;
    component: string;
    prevState?: string;
    newState?: string;
    result: string;
  },
) {
  await ctx.db.insert("adminAudit", { at: Date.now(), ...p });
}

// ---------------- platform config (single row) ----------------

async function getOrCreateConfig(ctx: MutationCtx): Promise<Doc<"platformConfig">> {
  const existing = await ctx.db.query("platformConfig").first();
  if (existing) return existing;
  const id = await ctx.db.insert("platformConfig", {
    tradingHalted: false,
    updatedAt: Date.now(),
  });
  const created = await ctx.db.get(id);
  if (!created) throw new Error("PLATFORM_CONFIG_UNAVAILABLE");
  return created;
}

/** Read-only variant for queries — queries must never write. */
type PlatformConfigView = {
  _id: Id<"platformConfig"> | null;
  tradingHalted: boolean;
  haltReason?: string;
  haltedAt?: number;
  updatedAt: number;
};

async function readConfigOrDefault(ctx: DbCtx): Promise<PlatformConfigView> {
  const cfg = await ctx.db.query("platformConfig").first();
  return cfg ?? { _id: null, tradingHalted: false, haltReason: undefined, haltedAt: undefined, updatedAt: 0 };
}

/** Public read: is the platform currently halted? Used by the decide action guard. */
export const platformHaltState = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cfg = await ctx.db.query("platformConfig").first();
    return {
      tradingHalted: cfg?.tradingHalted ?? false,
      haltReason: cfg?.haltReason,
    };
  },
});

/** Action-safe administrator identity (actions cannot read the DB directly). */
export const activeAdminViewer = internalQuery({
  args: {},
  handler: async (ctx) => (await requireAdmin(ctx)).userId,
});

export const setTradingHalt = mutation({
  args: { halted: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, { halted, reason }) => {
    const { userId, email } = await requireAdmin(ctx);
    const cfg = await getOrCreateConfig(ctx);
    const prev = cfg.tradingHalted ? "HALTED" : "RUNNING";
    await ctx.db.patch(cfg._id, {
      tradingHalted: halted,
      haltReason: halted ? (reason ?? "Administrative halt") : undefined,
      haltedBy: halted ? userId : undefined,
      haltedAt: halted ? Date.now() : undefined,
      updatedAt: Date.now(),
    });
    await audit(ctx, {
      actorId: userId,
      actorEmail: email,
      action: halted ? "Trading halted platform-wide" : "Trading halt cleared",
      component: "RISK CONTROL",
      prevState: prev,
      newState: halted ? "HALTED" : "RUNNING",
      result: "SUCCESS",
    });
    await ctx.runMutation(internal.arise.system.record, {
      level: halted ? "WARN" : "INFO",
      area: "SYSTEM",
      code: halted ? "PLATFORM_HALT" : "PLATFORM_RESUME",
      message: halted ? `Platform trading halted: ${reason ?? "administrative halt"}` : "Platform trading resumed",
      at: Date.now(),
    });
    return true;
  },
});

export const platformStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const cfg = await readConfigOrDefault(ctx);
    return {
      tradingHalted: cfg.tradingHalted,
      haltReason: cfg.haltReason,
      haltedAt: cfg.haltedAt,
      updatedAt: cfg.updatedAt,
    };
  },
});

// ---------------- overview ----------------

export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [cfg, users, sessions, decisions, positions, events] = await Promise.all([
      readConfigOrDefault(ctx),
      ctx.db.query("users").take(ADMIN_READ_CAP + 1),
      ctx.db.query("authSessions").take(ADMIN_READ_CAP + 1),
      ctx.db.query("decisions").take(ADMIN_READ_CAP + 1),
      ctx.db.query("positions").take(ADMIN_READ_CAP + 1),
      ctx.db.query("systemEvents").withIndex("at", (q) => q.gte("at", 0)).order("desc").take(ADMIN_EVENT_CAP + 1),
    ]);
    const truncated = {
      users: users.length > ADMIN_READ_CAP,
      sessions: sessions.length > ADMIN_READ_CAP,
      decisions: decisions.length > ADMIN_READ_CAP,
      positions: positions.length > ADMIN_READ_CAP,
      events: events.length > ADMIN_EVENT_CAP,
    };
    users.length = Math.min(users.length, ADMIN_READ_CAP);
    sessions.length = Math.min(sessions.length, ADMIN_READ_CAP);
    decisions.length = Math.min(decisions.length, ADMIN_READ_CAP);
    positions.length = Math.min(positions.length, ADMIN_READ_CAP);
    events.length = Math.min(events.length, ADMIN_EVENT_CAP);
    const activeUsers = users.filter((u) => u.disabled !== true).length;
    const last24h = Date.now() - 24 * 3600 * 1000;
    const decisions24h = decisions.filter((d) => d.dataTimestamp > last24h).length;
    const recentErrors = events
      .filter((e) => e.level === "ERROR")
      .sort((a, b) => b.at - a.at)
      .slice(0, 8);
    return {
      activeUsers,
      totalUsers: users.length,
      activeSessions: sessions.length,
      decisions24h,
      openPositions: positions.filter((p) => p.status === "OPEN").length,
      recentErrors,
      tradingHalted: cfg.tradingHalted,
      haltReason: cfg.haltReason,
      truncated,
      scanCaps: { users: ADMIN_READ_CAP, sessions: ADMIN_READ_CAP, decisions: ADMIN_READ_CAP, positions: ADMIN_READ_CAP, events: ADMIN_EVENT_CAP },
    };
  },
});

// ---------------- user management ----------------

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const users = await ctx.db.query("users").take(501);
    const subs = await ctx.db.query("subscriptions").take(1001);
    const truncated = users.length > 500 || subs.length > 1000;
    const subByUser = new Map(subs.slice(0, 1000).map((s) => [s.userId, s] as const));
    const rows = users.slice(0, 500).map((u) => {
      const s = subByUser.get(u._id);
      return {
        _id: u._id,
        email: u.email ?? u.name ?? "(no email)",
        role: u.role ?? "user",
        disabled: u.disabled === true,
        isAnonymous: u.isAnonymous === true,
        planKey: s && ["active", "trialing"].includes(s.status) ? s.planKey : "free",
        subStatus: s?.status ?? "none",
        joined: u._creationTime,
        lastSeen: undefined as number | undefined,
      };
    });
    return { rows, truncated, scanCaps: { users: 500, subscriptions: 1000 } };
  },
});

export const setUserDisabled = mutation({
  args: { targetUserId: v.id("users"), disabled: v.boolean() },
  handler: async (ctx, { targetUserId, disabled }) => {
    const { userId, email } = await requireAdmin(ctx);
    if (targetUserId === userId) throw new Error("You cannot disable your own account");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    await ctx.db.patch(targetUserId, { disabled });
    await audit(ctx, {
      actorId: userId,
      actorEmail: email,
      action: disabled ? `Disabled user ${target.email ?? targetUserId}` : `Reactivated user ${target.email ?? targetUserId}`,
      component: "USER MANAGEMENT",
      prevState: disabled ? "ACTIVE" : "DISABLED",
      newState: disabled ? "DISABLED" : "ACTIVE",
      result: "SUCCESS",
    });
    return true;
  },
});

export const setUserRole = mutation({
  args: {
    targetUserId: v.id("users"),
    role: v.union(v.literal("admin"), v.literal("operator"), v.literal("analyst"), v.literal("user")),
  },
  handler: async (ctx, { targetUserId, role }) => {
    const { userId, email } = await requireAdmin(ctx);
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    // Removing the last active administrator would close every privileged path with
    // no way back (bootstrap is permanently closed after first use). Refuse instead.
    if (target.role === "admin" && role !== "admin" && target.disabled !== true) {
      const admins = await ctx.db
        .query("users")
        .withIndex("role", (q) => q.eq("role", "admin"))
        .collect();
      if (admins.filter((u) => u.disabled !== true).length <= 1) {
        throw new Error("LAST_ADMIN: the last active administrator cannot be demoted");
      }
    }
    await ctx.db.patch(targetUserId, { role });
    await audit(ctx, {
      actorId: userId,
      actorEmail: email,
      action: `Role changed for ${target.email ?? targetUserId}`,
      component: "USER MANAGEMENT",
      prevState: target.role ?? "user",
      newState: role,
      result: "SUCCESS",
    });
    return true;
  },
});

export const grantPlan = mutation({
  args: { targetUserId: v.id("users"), planKey: v.string() },
  handler: async (ctx, { targetUserId, planKey }) => {
    const { userId, email } = await requireAdmin(ctx);
    // Same server-side plan allowlist as the billing endpoint: an unrecognised key
    // would be stored as an entitlement that silently resolves to free.
    if (!PLAN_MAP.has(planKey)) throw new Error(`Unknown plan: ${planKey}`);
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("userId", (q) => q.eq("userId", targetUserId))
      .first();
    const patch = { planKey, status: "active", updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("subscriptions", {
        userId: targetUserId,
        stripeCustomerId: `manual:${targetUserId}`,
        cancelAtPeriodEnd: false,
        ...patch,
      });
    }
    await audit(ctx, {
      actorId: userId,
      actorEmail: email,
      action: `Plan ${planKey} granted to ${target.email ?? targetUserId}`,
      component: "USER MANAGEMENT",
      prevState: existing?.planKey ?? "free",
      newState: planKey,
      result: "SUCCESS",
    });
    return true;
  },
});

export const recentAdminActivity = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireAdmin(ctx);
    const lim = Math.min(Math.max(Math.floor(limit ?? 10), 1), 100);
    return await ctx.db.query("adminAudit").withIndex("at", (q) => q.gte("at", 0)).order("desc").take(lim);
  },
});

// ---------------- audit log (searchable) ----------------

export const auditLog = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireAdmin(ctx);
    const [admin, sys] = await Promise.all([
      ctx.db.query("adminAudit").withIndex("at", (q) => q.gte("at", 0)).order("desc").take(ADMIN_AUDIT_CAP + 1),
      ctx.db.query("systemEvents").withIndex("at", (q) => q.gte("at", 0)).order("desc").take(ADMIN_EVENT_CAP + 1),
    ]);
    const rows = mergeAuditRows(
      admin.slice(0, ADMIN_AUDIT_CAP).map((a) => ({
        at: a.at,
        actorEmail: a.actorEmail,
        action: a.action,
        component: a.component,
        prevState: a.prevState,
        newState: a.newState,
        result: a.result,
      })),
      sys.slice(0, ADMIN_EVENT_CAP),
      Math.min(Math.max(Math.floor(limit ?? 120), 1), 200),
    );
    return {
      rows,
      truncated: admin.length > ADMIN_AUDIT_CAP || sys.length > ADMIN_EVENT_CAP,
      scanCaps: { adminAudit: ADMIN_AUDIT_CAP, systemEvents: ADMIN_EVENT_CAP },
    };
  },
});

// ---------------- agent monitor ----------------

export const agentMonitor = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [tradeScan, waitScan, vetoScan] = await Promise.all([
      ctx.db.query("decisions").withIndex("status", (q) => q.eq("status", "TRADE")).order("desc").take(ADMIN_READ_CAP + 1),
      ctx.db.query("decisions").withIndex("status", (q) => q.eq("status", "WAIT")).order("desc").take(ADMIN_READ_CAP + 1),
      ctx.db.query("decisions").withIndex("status", (q) => q.eq("status", "VETOED")).order("desc").take(ADMIN_READ_CAP + 1),
    ]);
    const truncated = tradeScan.length > ADMIN_READ_CAP || waitScan.length > ADMIN_READ_CAP || vetoScan.length > ADMIN_READ_CAP;
    const all = [...tradeScan.slice(0, ADMIN_READ_CAP), ...waitScan.slice(0, ADMIN_READ_CAP), ...vetoScan.slice(0, ADMIN_READ_CAP)];
    return { rows: buildAgentRows(all, Date.now()), truncated, perStatusScanCap: ADMIN_READ_CAP };
  },
});

// ---------------- market data management ----------------

export const marketDataStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    // Any completed pipeline run proves the feed is alive — not only executed trades.
    // ERROR runs are excluded on purpose: they usually indicate a data failure.
    const [tradedScan, waitedScan, vetoedScan, eventsScan] = await Promise.all([
      ctx.db.query("decisions").withIndex("status", (q) => q.eq("status", "TRADE")).order("desc").take(ADMIN_READ_CAP + 1),
      ctx.db.query("decisions").withIndex("status", (q) => q.eq("status", "WAIT")).order("desc").take(ADMIN_READ_CAP + 1),
      ctx.db.query("decisions").withIndex("status", (q) => q.eq("status", "VETOED")).order("desc").take(ADMIN_READ_CAP + 1),
      ctx.db.query("systemEvents").withIndex("at", (q) => q.gte("at", 0)).order("desc").take(ADMIN_EVENT_CAP + 1),
    ]);
    const truncated = {
      trades: tradedScan.length > ADMIN_READ_CAP,
      waits: waitedScan.length > ADMIN_READ_CAP,
      vetoes: vetoedScan.length > ADMIN_READ_CAP,
      events: eventsScan.length > ADMIN_EVENT_CAP,
    };
    const traded = tradedScan.slice(0, ADMIN_READ_CAP);
    const waited = waitedScan.slice(0, ADMIN_READ_CAP);
    const vetoedRuns = vetoedScan.slice(0, ADMIN_READ_CAP);
    const events = eventsScan.slice(0, ADMIN_EVENT_CAP);
    const dataEvents = events.filter((e) => e.area === "DATA");
    const now = Date.now();
    const recent = [...traded, ...waited, ...vetoedRuns].sort((a, b) => b.dataTimestamp - a.dataTimestamp);
    const lastFetch = recent[0]?.dataTimestamp;
    const age = lastFetch ? Math.round((now - lastFetch) / 1000) : null;
    const state = feedState(age);
    const symbols = symbolFreshness(recent, now, 12);
    // Each provider row is derived only from decisions that carry that provider's
    // data. A fresh Binance fetch must not make Yahoo look LIVE, and no evidence
    // for a provider is OFFLINE — not a fabricated healthy state.
    const allSymbols = listSymbols();
    return {
      providers: [
        providerStatus({
          name: "BINANCE",
          markets: "Crypto",
          source: "binance",
          symbols: allSymbols.filter((s) => s.assetClass === "crypto").map((s) => s.symbol),
          decisions: recent,
          events: dataEvents,
          now,
        }),
        providerStatus({
          name: "YAHOO FINANCE",
          markets: "Forex",
          source: "yahoo",
          symbols: allSymbols.filter((s) => s.assetClass === "forex").map((s) => s.symbol),
          decisions: recent,
          events: dataEvents,
          now,
        }),
      ],
      state,
      ageSec: age,
      symbols,
      failureCount: dataEvents.length,
      truncated,
      scanCaps: { decisionsPerStatus: ADMIN_READ_CAP, systemEvents: ADMIN_EVENT_CAP },
    };
  },
});
