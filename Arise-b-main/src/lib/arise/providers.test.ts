// ARISE V1 — provider resampling tests.
// The 4h/1d fallback builds a longer interval from 1h bars. A regression here silently
// relabels hourly data as daily, which corrupts every downstream interval computation
// (staleness, gaps, marks), so the bucket size is asserted explicitly.

import { describe, expect, it, vi } from "vitest";
import axios from "axios";
import {
  BINANCE_HOSTS,
  fetchMarketData,
  isPrimarySeries,
  resampleBars,
  resampleForInterval,
  type MarketFetch,
} from "./providers";
import type { RawBar } from "./validate";

vi.mock("axios", () => ({ default: { get: vi.fn() } }));

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

describe("Yahoo 4h wiring", () => {
  it("aggregates Yahoo's hourly response into real 4h bars", async () => {
    const start = Date.parse("2026-10-01T00:00:00Z");
    const timestamps = Array.from({ length: 8 }, (_, i) => (start + i * HOUR) / 1000);
    const get = axios.get as unknown as { mockResolvedValueOnce: (v: unknown) => void };
    get.mockResolvedValueOnce({
      data: {
        chart: {
          result: [
            {
              timestamp: timestamps,
              meta: { regularMarketPrice: 105 },
              indicators: {
                quote: [
                  {
                    open: timestamps.map(() => 100),
                    high: timestamps.map(() => 106),
                    low: timestamps.map(() => 99),
                    close: timestamps.map(() => 105),
                    volume: timestamps.map(() => 10),
                  },
                ],
              },
            },
          ],
        },
      },
    });

    const out = await fetchMarketData("EURUSD", "4h", 8);
    expect(out.interval).toBe("4h");
    expect(out.data.provider).toBe("yahoo");
    expect(out.data.bars).toHaveLength(2); // never eight hourly bars relabelled as 4h
    expect(out.data.bars[1].time - out.data.bars[0].time).toBe(4 * HOUR);
  });
});

describe("provider provenance", () => {
  function fetch(overrides: Partial<MarketFetch> & { provider?: string; interval?: string } = {}): MarketFetch {
    const { provider = "binance", interval = "1h", ...rest } = overrides;
    return {
      data: { bars: [], bestBid: null, bestAsk: null, provider },
      interval,
      requestedInterval: "1h",
      fellBack: false,
      errors: [],
      ...rest,
    };
  }

  it("does not treat the separate Binance US exchange as Binance spot data", () => {
    // api.binance.us is a different order book. Returning it under provider
    // "binance" would relabel a different market's prices as Binance spot.
    expect(BINANCE_HOSTS.some((h) => h.includes("binance.us"))).toBe(false);
  });

  it("accepts the primary provider at the requested interval", () => {
    expect(isPrimarySeries("BTCUSDT", fetch())).toBe(true);
    expect(isPrimarySeries("EURUSD", fetch({ provider: "yahoo" }))).toBe(true);
  });

  it("accepts a same-provider 4h resample (interval still 4h)", () => {
    expect(
      isPrimarySeries(
        "EURUSD",
        fetch({ provider: "yahoo", interval: "4h", requestedInterval: "4h", fellBack: true, fallbackFrom: "1h (resampled to 4h)" }),
      ),
    ).toBe(true);
  });

  it("refuses the Delta demo fallback for a Binance spot symbol", () => {
    // BTCUSDT is Binance spot; the Delta fallback maps it to BTCUSD, a different
    // instrument. Accepting it would authorize a trade on the wrong price basis.
    expect(
      isPrimarySeries("BTCUSDT", fetch({ provider: "delta", fellBack: true, fallbackFrom: "delta" })),
    ).toBe(false);
  });

  it("refuses an interval fallback that no longer matches the request", () => {
    expect(
      isPrimarySeries("BTCUSDT", fetch({ interval: "15m", requestedInterval: "1h", fellBack: true, fallbackFrom: "15m" })),
    ).toBe(false);
  });
});

describe("interval validation", () => {
  it("refuses an unsupported interval before dispatching a provider request", async () => {
    // Binance's map used to fall back to "1h" silently, returning hourly bars
    // labelled with the caller's unsupported interval.
    await expect(fetchMarketData("BTCUSDT", "2h")).rejects.toThrow(/unsupported interval/);
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
