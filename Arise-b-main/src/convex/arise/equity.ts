import { v } from "convex/values";
import { query } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("equityPoints")
      .withIndex("userId_t", (q) => q.eq("userId", userId))
      .collect();
    return rows.sort((a, b) => a.t - b.t).slice(-1 * (limit ?? 200));
  },
});
