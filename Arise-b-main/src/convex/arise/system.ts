import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { requireActiveUser } from "../lib/authz";

/**
 * Operational event log — platform-wide health telemetry that powers the System page.
 * It is NOT the security audit trail: that is `adminAudit`, which is append-only. This
 * table is a rolling health window with an explicit retention cap.
 *
 * What a non-admin may see is deliberately narrow. Two areas carry per-user detail:
 *   EXECUTION — position id, symbol, qty, entry/exit and P&L (see monitor.ts)
 *   BILLING   — subscription/customer references
 * so those message bodies are replaced with a fixed placeholder unless the viewer is an
 * enabled administrator. Everything else stays visible so the System page keeps working.
 */
const RESTRICTED_AREAS = new Set(["EXECUTION", "BILLING"]);
const RESTRICTED_DETAIL = "detail restricted to administrators";

/** Hard cap on one page of telemetry. */
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
/** Rolling retention for telemetry (a health window, not an audit record). */
const RETENTION = 200;

export const record = internalMutation({
  args: {
    level: v.string(),
    area: v.string(),
    code: v.string(),
    message: v.string(),
    at: v.number(),
  },
  handler: async (ctx, e) => {
    const id = await ctx.db.insert("systemEvents", e);
    // Trim to retention WITHOUT collecting the table: once the row is written, the only
    // rows that can be outside the window are the oldest RETENTION + 1, so the scan is
    // bounded by the cap instead of by the table size.
    const oldest = await ctx.db
      .query("systemEvents")
      .withIndex("at", (q) => q.gte("at", 0))
      .order("asc")
      .take(RETENTION + 1);
    if (oldest.length > RETENTION) {
      for (const row of oldest.slice(0, oldest.length - RETENTION)) {
        await ctx.db.delete(row._id);
      }
    }
    return id;
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const { user } = await requireActiveUser(ctx);
    const isAdmin = user.role === "admin";

    const requested = limit ?? DEFAULT_LIST_LIMIT;
    const capped = Number.isFinite(requested)
      ? Math.max(1, Math.min(Math.floor(requested), MAX_LIST_LIMIT))
      : DEFAULT_LIST_LIMIT;

    // Newest-first and bounded at the database level — the previous implementation
    // collected every event and sliced in memory, so the cost of this query grew with
    // the whole table no matter how small a page the caller asked for.
    const rows = await ctx.db
      .query("systemEvents")
      .withIndex("at", (q) => q.gte("at", 0))
      .order("desc")
      .take(capped);

    // Field projection: exactly what the System page renders, so a column added to this
    // table later cannot start leaking through this query by accident.
    return rows.map((e) => ({
      _id: e._id,
      at: e.at,
      level: e.level,
      area: e.area,
      code: e.code,
      message: isAdmin || !RESTRICTED_AREAS.has(e.area) ? e.message : RESTRICTED_DETAIL,
    }));
  },
});
