// ARISE V1 — news layer tests.
// The news layer is pure and fail-closed: real feed items in, deterministic
// assessment out. With no usable news it must fabricate nothing — no sentiment,
// no confidence, and zero influence on the decision pipeline.

import { describe, expect, it } from "vitest";
import {
  BULLISH_TERMS,
  BEARISH_TERMS,
  NEWS_POLICY,
  NEWS_SOURCES,
  assessNews,
  createNewsPolicy,
  newsAI,
  parseFeedXml,
  sourcesFor,
  type NewsPolicy,
  type RawNewsItem,
} from "./news";

const NOW = Date.parse("2026-10-14T12:00:00Z");

const SOURCE_T1 = { id: "wire", name: "Wire Desk", tier: 1 as const };
const SOURCE_T3 = { id: "agg", name: "Aggregator", tier: 3 as const };

function item(over: Partial<RawNewsItem>): RawNewsItem {
  return {
    title: "Bitcoin market update",
    url: "https://example.com/x",
    source: "Wire Desk",
    sourceId: "wire",
    tier: 1,
    publishedAt: NOW - 60_000,
    categories: [],
    summary: "",
    ...over,
  };
}

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Sample Feed</title>
  <item>
    <title>Bitcoin surges past record high as ETF inflows climb</title>
    <link>https://example.com/a</link>
    <pubDate>Tue, 14 Oct 2026 10:00:00 GMT</pubDate>
    <category>Markets</category>
    <description><![CDATA[<p>Bitcoin &amp; ether rally; analysts raise targets.</p>]]></description>
  </item>
  <item>
    <title>Exchange hack: funds drained</title>
    <link>https://example.com/b</link>
    <pubDate>Tue, 14 Oct 2026 11:00:00 GMT</pubDate>
    <category>Security</category>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Sample Atom</title>
  <entry>
    <title>Solana team faces probe over token sale</title>
    <link rel="self" href="https://example.org/feed/sol-probe"/>
    <link rel="alternate" href="https://example.org/sol-probe"/>
    <published>2026-10-14T09:30:00Z</published>
    <category term="Regulation"/>
  </entry>
</feed>`;

describe("parseFeedXml", () => {
  it("parses RSS 2.0 items, decoding CDATA and entities", () => {
    const { items } = parseFeedXml(RSS, SOURCE_T1);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Bitcoin surges past record high as ETF inflows climb");
    expect(items[0].url).toBe("https://example.com/a");
    expect(items[0].publishedAt).toBe(Date.parse("Tue, 14 Oct 2026 10:00:00 GMT"));
    expect(items[0].categories).toContain("Markets");
    expect(items[0].summary).toContain("Bitcoin & ether rally");
    expect(items[0].source).toBe("Wire Desk");
  });

  it("parses Atom entries, preferring the alternate link", () => {
    const { items } = parseFeedXml(ATOM, SOURCE_T1);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Solana team faces probe over token sale");
    expect(items[0].url).toBe("https://example.org/sol-probe");
    expect(items[0].publishedAt).toBe(Date.parse("2026-10-14T09:30:00Z"));
    expect(items[0].categories).toContain("Regulation");
  });

  it("never invents a timestamp when the feed omits or corrupts the date", () => {
    const xml = `<rss><channel><item><title>No date here</title><link>https://example.com/c</link></item>
      <item><title>Bad date</title><link>https://example.com/d</link><pubDate>not-a-date</pubDate></item></channel></rss>`;
    const { items } = parseFeedXml(xml, SOURCE_T1);
    expect(items[0].publishedAt).toBeNull();
    expect(items[1].publishedAt).toBeNull();
  });

  it("rejects DOCTYPE/ENTITY declarations instead of expanding them", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "boom">]><rss><channel>
      <item><title>&x;</title><link>https://example.com/e</link></item></channel></rss>`;
    const { items, notes } = parseFeedXml(xml, SOURCE_T1);
    expect(items).toHaveLength(0);
    expect(notes.join(" ")).toMatch(/DOCTYPE|ENTITY/i);
  });

  it("refuses an unbounded document", () => {
    const { items, notes } = parseFeedXml(`<rss><channel>${"x".repeat(600_000)}</channel></rss>`, SOURCE_T1);
    expect(items).toHaveLength(0);
    expect(notes.join(" ")).toMatch(/too large/i);
  });

  it("caps the number of items taken from one feed", () => {
    const many = Array.from(
      { length: 120 },
      (_, i) => `<item><title>Headline ${i}</title><link>https://example.com/${i}</link><pubDate>Tue, 14 Oct 2026 10:00:00 GMT</pubDate></item>`,
    ).join("");
    const { items } = parseFeedXml(`<rss><channel>${many}</channel></rss>`, SOURCE_T1);
    expect(items.length).toBeLessThanOrEqual(NEWS_POLICY.maxItemsPerFeed);
  });
});

describe("assessNews — fail closed, never fabricated", () => {
  it("reports UNAVAILABLE with a null score when no items were fetched", () => {
    const a = assessNews([], { symbol: "BTCUSDT", assetClass: "crypto", now: NOW });
    expect(a.status).toBe("UNAVAILABLE");
    expect(a.score).toBeNull();
    expect(a.confidence).toBe(0);
    expect(a.drivers).toHaveLength(0);
  });

  it("reports UNAVAILABLE when nothing in the feeds concerns the symbol", () => {
    const a = assessNews(
      [item({ title: "Wheat futures steady in Chicago", summary: "Grain desk commentary" })],
      { symbol: "BTCUSDT", assetClass: "crypto", now: NOW },
    );
    expect(a.status).toBe("UNAVAILABLE");
    expect(a.score).toBeNull();
  });

  it("goes STALE (not stale-by-guess) when coverage exists but is too old", () => {
    const a = assessNews(
      [item({ title: "Bitcoin rally stalls", publishedAt: NOW - 20 * 3600 * 1000 })],
      { symbol: "BTCUSDT", assetClass: "crypto", now: NOW },
    );
    expect(a.status).toBe("STALE");
    expect(a.score).toBeNull();
    expect(a.confidence).toBe(0);
  });

  it("excludes undated items from sentiment rather than assuming freshness", () => {
    const a = assessNews(
      [item({ title: "Bitcoin surges to new high", publishedAt: null })],
      { symbol: "BTCUSDT", assetClass: "crypto", now: NOW },
    );
    expect(a.status).toBe("UNAVAILABLE");
    expect(a.score).toBeNull();
  });

  it("scores bullish vs bearish coverage in the right direction", () => {
    const bull = assessNews(
      [item({ title: "Bitcoin surges as ETF inflows climb to record" })],
      { symbol: "BTCUSDT", assetClass: "crypto", now: NOW },
    );
    const bear = assessNews(
      [item({ title: "Bitcoin plunges after exchange hack and probe" })],
      { symbol: "BTCUSDT", assetClass: "crypto", now: NOW },
    );
    expect(bull.status).toBe("AVAILABLE");
    expect(bull.score).toBeGreaterThan(0.35);
    expect(bear.score).toBeLessThan(-0.35);
    expect(bull.score).toBeGreaterThan(bear.score!);
  });

  it("weights fresher headlines above older ones", () => {
    const a = assessNews(
      [
        item({ title: "Bitcoin gains on adoption news", publishedAt: NOW - 60_000 }),
        item({
          title: "Bitcoin plunges in broad selloff",
          publishedAt: NOW - 12 * 3600 * 1000,
          url: "https://example.com/old",
        }),
      ],
      { symbol: "BTCUSDT", assetClass: "crypto", now: NOW },
    );
    expect(a.score).toBeGreaterThan(0);
  });

  it("weights a tier-1 source above a tier-3 aggregator", () => {
    const items = [
      item({ title: "Bitcoin surge continues", source: SOURCE_T1.name, sourceId: SOURCE_T1.id, tier: SOURCE_T1.tier }),
      item({
        title: "Bitcoin plunge predicted",
        source: SOURCE_T3.name,
        sourceId: SOURCE_T3.id,
        tier: SOURCE_T3.tier,
        url: "https://example.com/z",
      }),
    ];
    const a = assessNews(items, { symbol: "BTCUSDT", assetClass: "crypto", now: NOW });
    expect(a.score).toBeGreaterThan(0);
  });

  it("cites only real headlines, and cites them in full", () => {
    const headline = "Bitcoin surges as ETF inflows climb to record";
    const a = assessNews([item({ title: headline, url: "https://example.com/cited" })], {
      symbol: "BTCUSDT",
      assetClass: "crypto",
      now: NOW,
    });
    expect(a.drivers.join(" ")).toContain(headline);
    expect(a.drivers.join(" ")).toContain("Wire Desk");
    expect(a.items[0].url).toBe("https://example.com/cited");
  });

  it("is deterministic for identical input", () => {
    const items = [item({}), item({ title: "Ethereum upgrade boosts sentiment", url: "https://example.com/eth" })];
    const opts = { symbol: "BTCUSDT", assetClass: "crypto" as const, now: NOW };
    expect(JSON.stringify(assessNews(items, opts))).toBe(JSON.stringify(assessNews(items, opts)));
  });

  it("raises confidence as relevant fresh coverage grows", () => {
    const one = assessNews([item({})], { symbol: "BTCUSDT", assetClass: "crypto", now: NOW });
    const many = assessNews(
      ["surges", "gains", "rally", "record high"].map((w, i) =>
        item({ title: `Bitcoin ${w} in session ${i}`, url: `https://example.com/n${i}` }),
      ),
      { symbol: "BTCUSDT", assetClass: "crypto", now: NOW },
    );
    expect(many.confidence).toBeGreaterThan(one.confidence);
  });

  it("does not read conflicting coverage as confident", () => {
    const titles = ["surges", "rally", "record high", "gains"];
    const opposite = ["plunges", "crash", "selloff", "hack"];
    const aligned = assessNews(
      titles.map((w, i) => item({ title: "Bitcoin " + w + " in session " + i, url: "https://example.com/a" + i })),
      { symbol: "BTCUSDT", assetClass: "crypto", now: NOW },
    );
    const conflicted = assessNews(
      titles.map((w, i) =>
        item({
          title: "Bitcoin " + w + " then " + opposite[i],
          url: "https://example.com/b" + i,
        }),
      ),
      { symbol: "BTCUSDT", assetClass: "crypto", now: NOW },
    );
    expect(conflicted.freshCount).toBe(aligned.freshCount);
    expect(conflicted.confidence).toBeLessThan(aligned.confidence);
  });
});

describe("newsAI — zero influence when there is no news", () => {
  it("emits NEUTRAL with zero confidence for an unavailable assessment", () => {
    const a = assessNews([], { symbol: "BTCUSDT", assetClass: "crypto", now: NOW });
    const analysis = newsAI(a, "valid", NOW);
    expect(analysis.agent).toBe("news_ai");
    expect(analysis.signal).toBe("NEUTRAL");
    expect(analysis.confidence).toBe(0);
    expect(analysis.summary).toMatch(/unavailable/i);
    expect(analysis.evidence.join(" ")).toMatch(/no fabricated|not fabricated|unavailable/i);
  });

  it("carries a directional signal only when fresh, relevant news exists", () => {
    const a = assessNews([item({ title: "Bitcoin surges as ETF inflows climb to record" })], {
      symbol: "BTCUSDT",
      assetClass: "crypto",
      now: NOW,
    });
    const analysis = newsAI(a, "valid", NOW);
    expect(analysis.signal).toBe("LONG");
    expect(analysis.confidence).toBeGreaterThan(0);
    expect(analysis.evidence.length).toBeGreaterThan(0);
  });
});

describe("policy and source registry", () => {
  it("only ever narrows freshness windows through the factory", () => {
    const p: NewsPolicy = createNewsPolicy({ maxAgeSec: 900 });
    expect(p.maxAgeSec).toBe(900);
    expect(p.halfLifeSec).toBe(NEWS_POLICY.halfLifeSec);
    expect(createNewsPolicy({ maxAgeSec: -5 }).maxAgeSec).toBeGreaterThan(0);
  });

  it("exposes only https keyless publisher feeds", () => {
    for (const s of NEWS_SOURCES) {
      expect(s.url.startsWith("https://")).toBe(true);
      expect(s.tier).toBeGreaterThanOrEqual(1);
      expect(s.tier).toBeLessThanOrEqual(3);
      expect(s.assetClasses.length).toBeGreaterThan(0);
    }
  });

  it("selects feeds per asset class, always with both crypto and forex coverage", () => {
    expect(sourcesFor("crypto").every((s) => s.assetClasses.includes("crypto"))).toBe(true);
    expect(sourcesFor("forex").some((s) => s.assetClasses.includes("forex"))).toBe(true);
  });

  it("keeps both sentiment lexicons populated and signed", () => {
    expect(Object.values(BULLISH_TERMS).every((v) => v > 0)).toBe(true);
    expect(Object.values(BEARISH_TERMS).every((v) => v < 0)).toBe(true);
  });
});
