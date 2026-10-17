import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireActiveUserIfSignedIn } from "../lib/authz";

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const viewer = await requireActiveUserIfSignedIn(ctx);
    if (!viewer) return [];
    const requested = limit ?? 200;
    const bounded = Number.isFinite(requested)
      ? Math.min(Math.max(Math.floor(requested), 1), 500)
      : 200;
    const rows = await ctx.db
      .query("equityPoints")
      .withIndex("userId_t", (q) => q.eq("userId", viewer.userId))
      .collect();
    return rows.sort((a, b) => a.t - b.t).slice(-bounded);
  },
});
