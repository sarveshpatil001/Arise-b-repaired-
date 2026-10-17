import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { requireActiveUserIfSignedIn } from "../lib/authz";

const DECISION_LIMIT = 120;

export const record = internalMutation({
  args: {
    userId: v.id("users"),
    symbol: v.string(),
    interval: v.string(),
    requestedInterval: v.optional(v.string()),
    mode: v.literal("paper"),
    status: v.string(),
    direction: v.string(),
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
    // Evidence verdict for this decision (outcome, reason codes, quality, ceiling).
    evidence: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, d) => {
    const id = await ctx.db.insert("decisions", { ...d });
    // retention: keep last N per user (ordered by recorded data timestamp)
    const rows = await ctx.db
      .query("decisions")
      .withIndex("userId", (q) => q.eq("userId", d.userId))
      .collect();
    if (rows.length > DECISION_LIMIT) {
      const sorted = rows.sort((a, b) => b.dataTimestamp - a.dataTimestamp);
      const excess = sorted.slice(DECISION_LIMIT);
      for (const r of excess) await ctx.db.delete(r._id);
    }
    return id;
  },
});

/**
 * Finalize a decision's execution linkage AFTER the position mutation succeeded (or
 * failed). The decision is first stored as PENDING_POSITION, so a decision can never
 * be read as FILLED before a position actually exists. The transition is one-way:
 * only a PENDING_POSITION row can be finalized, so a retry cannot rewrite a completed
 * audit record.
 */
export const setExecution = internalMutation({
  args: {
    id: v.id("decisions"),
    userId: v.id("users"),
    execution: v.any(),
    error: v.optional(v.string()),
    /** Set when the linkage failed (e.g. ERROR); omitted on success. */
    status: v.optional(v.string()),
  },
  handler: async (ctx, { id, userId, execution, error, status }) => {
    const doc = await ctx.db.get(id);
    if (!doc || doc.userId !== userId) throw new Error("Not found");
    const current = doc.execution as { status?: string } | undefined;
    if (current?.status !== "PENDING_POSITION") return false;
    await ctx.db.patch(id, {
      execution,
      ...(error !== undefined ? { error } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    return true;
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const viewer = await requireActiveUserIfSignedIn(ctx);
    if (!viewer) return [];
    const rows = await ctx.db
      .query("decisions")
      .withIndex("userId", (q) => q.eq("userId", viewer.userId))
      .collect();
    return rows.sort((a, b) => b.dataTimestamp - a.dataTimestamp).slice(0, limit ?? 40);
  },
});

export const byId = query({
  args: { id: v.id("decisions") },
  handler: async (ctx, { id }) => {
    const viewer = await requireActiveUserIfSignedIn(ctx);
    if (!viewer) return null;
    const doc = await ctx.db.get(id);
    if (!doc || doc.userId !== viewer.userId) return null; // user isolation
    return doc;
  },
});

export const latest = query({
  args: { symbol: v.optional(v.string()) },
  handler: async (ctx, { symbol }) => {
    const viewer = await requireActiveUserIfSignedIn(ctx);
    if (!viewer) return null;
    const rows = await ctx.db
      .query("decisions")
      .withIndex("userId", (q) => q.eq("userId", viewer.userId))
      .collect();
    const sorted = rows.sort((a, b) => b.dataTimestamp - a.dataTimestamp);
    if (symbol) {
      return sorted.find((d) => d.symbol === symbol) ?? null;
    }
    return sorted[0] ?? null;
  },
});
