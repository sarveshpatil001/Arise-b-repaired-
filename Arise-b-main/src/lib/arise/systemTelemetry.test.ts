// ARISE V1 — platform telemetry (system events) access-control tests.
// These run the REAL Convex query against an in-memory backend, so they exercise the
// server-side boundary rather than the System page's rendering:
//   - an unauthenticated caller is refused outright,
//   - a signed-in non-admin gets a bounded, newest-first page with per-user detail
//     (EXECUTION / BILLING message bodies) redacted,
//   - an administrator sees the restricted detail,
//   - the page size is capped server-side and the returned shape is a projection, so a
//     column added to the table later cannot leak through this query by accident,
//   - the telemetry retention trim is bounded by its cap and drops the OLDEST rows.
// No network, no live data.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "@/convex/schema";
import { api, internal } from "@/convex/_generated/api";

const modules = import.meta.glob("../../convex/**/*.ts");

type TestConvex = ReturnType<typeof convexTest>;

function newBackend() {
  return convexTest(schema, modules);
}

async function seedUser(t: TestConvex, opts: { email: string; role?: "admin" | "user" }) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { email: opts.email, role: opts.role }),
  );
}

interface SeedEvent {
  level?: string;
  area: string;
  code: string;
  message: string;
  at: number;
}

async function seedEvents(t: TestConvex, events: SeedEvent[]) {
  return await t.run(async (ctx) => {
    for (const e of events) {
      await ctx.db.insert("systemEvents", {
        level: e.level ?? "INFO",
        area: e.area,
        code: e.code,
        message: e.message,
        at: e.at,
      });
    }
    return events.length;
  });
}

const T0 = 1_800_000_000_000;

const FIXTURE: SeedEvent[] = [
  { level: "ERROR", area: "DATA", code: "PROVIDER_FAILURE", message: "binance timeout", at: T0 - 3_000 },
  { level: "WARN", area: "EXECUTION", code: "STOP_HIT", message: "position 7 closed at 61,240.5 for user 42", at: T0 - 2_000 },
  { level: "INFO", area: "BILLING", code: "PLAN_GRANTED", message: "institutional seat granted to a@example.com", at: T0 - 1_000 },
  { level: "INFO", area: "SYSTEM", code: "BROADCAST", message: "maintenance at 22:00 UTC", at: T0 },
];

describe("system telemetry — authorization", () => {
  it("refuses an unauthenticated caller", async () => {
    const t = newBackend();
    await seedEvents(t, FIXTURE);
    await expect(t.query(api.arise.system.list, { limit: 5 })).rejects.toThrow(/Not authenticated/);
  });

  it("never exposes an error message that names a credential or a secret", async () => {
    // The event log must not become a place where a secret is echoed back. This asserts
    // the projection only — it does not prove no other code path can ever log a value.
    const t = newBackend();
    const user = await seedUser(t, { email: "user@example.com" });
    await seedEvents(t, FIXTURE);
    const rows = await t.withIdentity({ subject: user }).query(api.arise.system.list, { limit: 10 });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("error");
      expect(row).not.toHaveProperty("payload");
    }
  });
});

describe("system telemetry — non-admin view", () => {
  it("redacts per-user EXECUTION and BILLING detail", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "user@example.com" });
    await seedEvents(t, FIXTURE);

    const rows = await t.withIdentity({ subject: user }).query(api.arise.system.list, { limit: 10 });

    const execution = rows.find((r) => r.code === "STOP_HIT");
    const billing = rows.find((r) => r.code === "PLAN_GRANTED");
    const data = rows.find((r) => r.code === "PROVIDER_FAILURE");
    const broadcast = rows.find((r) => r.code === "BROADCAST");

    expect(execution?.message).toBe("detail restricted to administrators");
    expect(billing?.message).toBe("detail restricted to administrators");
    // Operational health stays visible — that is the point of the System page.
    expect(data?.message).toBe("binance timeout");
    expect(broadcast?.message).toBe("maintenance at 22:00 UTC");

    // No other user's identifiers survive anywhere in the payload.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("user 42");
    expect(serialized).not.toContain("a@example.com");
  });

  it("returns newest-first with a bounded page and a fixed field projection", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "user@example.com" });
    await seedEvents(t, FIXTURE);

    const rows = await t.withIdentity({ subject: user }).query(api.arise.system.list, { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].at).toBe(T0);
    expect(rows[1].at).toBe(T0 - 1_000);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].at).toBeGreaterThanOrEqual(rows[i].at);
    }

    // Projection only: the internal columns of the table are not part of the contract.
    expect(Object.keys(rows[0]).sort()).toEqual(["_id", "area", "at", "code", "level", "message"]);
  });

  it("caps the page size regardless of what the caller asks for", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "user@example.com" });
    await seedEvents(
      t,
      Array.from({ length: 220 }, (_, i) => ({
        area: "DATA",
        code: "TICK",
        message: `event ${i}`,
        at: T0 - i * 1_000,
      })),
    );

    const as = t.withIdentity({ subject: user });
    expect((await as.query(api.arise.system.list, { limit: 10_000 })).length).toBe(200);
    expect((await as.query(api.arise.system.list, { limit: 0 })).length).toBe(1);
    expect(
      (await as.query(api.arise.system.list, { limit: Number.NaN })).length,
    ).toBeGreaterThan(0);
  });
});

describe("system telemetry — administrator view", () => {
  it("shows the restricted detail to an enabled administrator", async () => {
    const t = newBackend();
    const admin = await seedUser(t, { email: "root@example.com", role: "admin" });
    await seedEvents(t, FIXTURE);

    const rows = await t.withIdentity({ subject: admin }).query(api.arise.system.list, { limit: 10 });
    expect(rows.find((r) => r.code === "STOP_HIT")?.message).toBe(
      "position 7 closed at 61,240.5 for user 42",
    );
    expect(rows.find((r) => r.code === "PLAN_GRANTED")?.message).toContain("a@example.com");
  });
});

describe("system telemetry — retention", () => {
  it("trims to the retention window, dropping the oldest rows, via a bounded scan", async () => {
    const t = newBackend();
    // RETENTION is 200; write past it through the real internal mutation.
    for (let i = 0; i < 205; i++) {
      await t.mutation(internal.arise.system.record, {
        level: "INFO",
        area: "DATA",
        code: "TICK",
        message: `event ${i}`,
        at: T0 + i * 1_000, // strictly increasing, so the oldest are unambiguous
      });
    }

    const rows = await t.run(async (ctx) => ctx.db.query("systemEvents").collect());
    expect(rows).toHaveLength(200);
    const oldest = rows.sort((a, b) => a.at - b.at)[0];
    // The first five writes (0..4) are gone; the window starts at event 5.
    expect(oldest.message).toBe("event 5");
  });
});
