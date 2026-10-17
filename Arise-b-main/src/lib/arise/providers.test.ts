// ARISE V1 — provider resampling tests.
// The 4h/1d fallback builds a longer interval from 1h bars. A regression here silently
// relabels hourly data as daily, which corrupts every downstream interval computation
// (staleness, gaps, marks), so the bucket size is asserted explicitly.

import { describe, expect, it } from "vitest";
import { resampleBars, resampleForInterval } from "./providers";
import type { RawBar } from "./validate";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const BASE = Date.parse("2026-10-14T00:00:00Z");

function bar(time: number, o: number, h: number, l: number, c: number, v: number): RawBar {
  return { time, open: o, high: h, low: l, close: c, volume: v };
}

/** Six consecutive hourly bars with distinct values so aggregation is detectable. */
function hourly(): RawBar[] {
  return [
    bar(BASE + 0 * HOUR, 100, 105, 99, 104, 10),
    bar(BASE + 1 * HOUR, 104, 108, 103, 107, 20),
    bar(BASE + 2 * HOUR, 107, 109, 95, 96, 30),
    bar(BASE + 3 * HOUR, 96, 101, 94, 100, 40),
    bar(BASE + 4 * HOUR, 100, 102, 98, 101, 50),
    bar(BASE + 5 * HOUR, 101, 103, 90, 92, 60),
  ];
}

describe("resampleBars (4h/1d fallback aggregation)", () => {
  it("builds 4h buckets on epoch-aligned boundaries", () => {
    const out = resampleBars(hourly(), 4 * HOUR);
    expect(out.map((b) => b.time)).toEqual([BASE, BASE + 4 * HOUR]);
    expect(out[0].open).toBe(100); // first bar's open
    expect(out[0].high).toBe(109); // max over the bucket
    expect(out[0].low).toBe(94); // min over the bucket
    expect(out[0].close).toBe(100); // last close in the bucket
    expect(out[0].volume).toBe(100); // 10+20+30+40
  });

  it("rolls a partially filled trailing bucket instead of dropping it", () => {
    const out = resampleBars(hourly(), 4 * HOUR);
    expect(out[1].open).toBe(100);
    expect(out[1].close).toBe(92);
    expect(out[1].volume).toBe(110); // 50+60
  });

  it("builds daily buckets exactly one day apart — never hourly bars relabelled", () => {
    const out = resampleBars(hourly(), DAY);
    expect(out).toHaveLength(1);
    expect(out[0].time).toBe(BASE);
  });

  it("separates hourly bars that straddle a UTC day boundary into two day buckets", () => {
    const straddling = [
      bar(BASE + 21 * HOUR, 100, 101, 99, 100, 1),
      bar(BASE + 22 * HOUR, 100, 102, 99, 101, 2),
      bar(BASE + 23 * HOUR, 101, 103, 100, 102, 3),
      bar(BASE + 24 * HOUR, 102, 104, 101, 103, 4),
    ];
    const out = resampleBars(straddling, DAY);
    expect(out).toHaveLength(2);
    expect(out[0].time).toBe(BASE);
    expect(out[1].time).toBe(BASE + DAY);
    // The regression this guards: treating these as one bucket would give a 3h spread.
    expect(out[1].time - out[0].time).toBe(DAY);
    expect(out[0].volume).toBe(6);
    expect(out[1].volume).toBe(4);
  });

  it("aligns a bucket that starts mid-window", () => {
    const out = resampleBars([bar(BASE + 5 * HOUR + 30 * 60_000, 1, 2, 1, 2, 5)], 4 * HOUR);
    expect(out[0].time).toBe(BASE + 4 * HOUR);
  });

  it("preserves ordering and bar count when the interval already matches the bucket", () => {
    const out = resampleBars(hourly(), HOUR);
    expect(out).toHaveLength(6);
    expect(out.map((b) => b.time)).toEqual(hourly().map((b) => b.time));
  });
});

describe("resampleForInterval — the 4h/1d fallback wiring", () => {
  it("picks the 4h bucket for a 4h request", () => {
    const out = resampleForInterval(hourly(), "4h");
    const gaps = out.slice(1).map((b, i) => b.time - out[i].time);
    expect(gaps.every((g) => g % (4 * HOUR) === 0)).toBe(true);
    expect(out[0].time % (4 * HOUR)).toBe(0);
  });

  it("picks the daily bucket for a 1d request — the old relabel bug is gone", () => {
    // Four hourly bars one hour apart must NOT come back as four hourly bars.
    const four = hourly().slice(0, 4);
    const out = resampleForInterval(four, "1d");
    expect(out).toHaveLength(1);
    expect(out[0].time).toBe(BASE);
    expect(out[0].time % DAY).toBe(0);
    expect(out[0].volume).toBe(100);
  });
});
