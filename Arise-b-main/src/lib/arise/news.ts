// ARISE V1 — NEWS layer (deterministic, auditable, fail-closed).
//
// PURPOSE. ARISE is not allowed to invent market context. This module turns *real*
// publisher headlines (fetched by src/convex/arise/news.ts from public, keyless RSS
// feeds) into a bounded, reproducible news assessment: per-symbol relevance, a
// recency- and source-tier-weighted sentiment score, and citations back to the
// exact headline that produced it.
//
// DESIGN RULES (enforced here, not by convention):
//  1. NO FABRICATION. Zero usable items ⇒ status UNAVAILABLE, score null, confidence 0.
//     The news layer never returns a guess, a default sentiment, or a synthetic feed.
//  2. NO UNDATED DATA. An item without a parseable timestamp is excluded: age cannot
//     be assumed, and an assumed age would be fabricated recency.
//  3. NO LLM. Sentiment comes from a fixed, exported lexicon (`news-v1`), so the same
//     input always yields the same output and every score is explainable.
//  4. RELEVANCE BEFORE SENTIMENT. An item only counts if it mentions the symbol (or,
//     at lower weight, macro drivers); unrelated headlines cannot move the score.
//  5. NO TRADE BLOCKER. Absent news is *not* a veto — the deterministic core keeps
//     working, and the news agent contributes exactly zero directional influence
//     (signal NEUTRAL, confidence 0). Blindness is reported, never traded on.
//
// This module is pure: no network, no Convex, no clock reads (callers pass `now`).

import { clamp } from "./math";
import { hasPolicyOverrideAttempt, sanitizeUntrusted } from "./untrusted";
import type { AgentAnalysis, AssetClass, DataQuality } from "./types";

export const NEWS_MODEL_VERSION = "news-v1";

/** Asset classes the news registry can serve (identical to the domain AssetClass). */
export type NewsAssetClass = AssetClass;

export type NewsTier = 1 | 2 | 3;

export interface NewsPolicy {
  /** Maximum age of an item used for live sentiment. */
  maxAgeSec: number;
  /** Beyond this age coverage is STALE (still real, but unusable for a decision). */
  staleAfterSec: number;
  /** Recency half-life: an item this old carries half the weight of a fresh one. */
  halfLifeSec: number;
  /** Maximum items carried into an assessment. */
  maxItems: number;
  /** Maximum items accepted from a single feed. */
  maxItemsPerFeed: number;
  /** Minimum relevant items before an assessment may be AVAILABLE. */
  minRelevant: number;
}

export const NEWS_POLICY: NewsPolicy = {
  maxAgeSec: 6 * 3600,
  staleAfterSec: 24 * 3600,
  halfLifeSec: 6 * 3600,
  maxItems: 12,
  maxItemsPerFeed: 40,
  minRelevant: 1,
};

/** Builds a news policy. Invalid overrides fall back to the base policy — a policy
 *  can never be widened into "use anything forever". */
export function createNewsPolicy(overrides: Partial<NewsPolicy> = {}): NewsPolicy {
  const merged = { ...NEWS_POLICY, ...overrides };
  const pos = (v: number | undefined, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  const count = (v: number | undefined, fallback: number) =>
    Math.max(1, Math.floor(pos(v, fallback)));
  return {
    maxAgeSec: pos(merged.maxAgeSec, NEWS_POLICY.maxAgeSec),
    staleAfterSec: pos(merged.staleAfterSec, NEWS_POLICY.staleAfterSec),
    halfLifeSec: pos(merged.halfLifeSec, NEWS_POLICY.halfLifeSec),
    maxItems: count(merged.maxItems, NEWS_POLICY.maxItems),
    maxItemsPerFeed: count(merged.maxItemsPerFeed, NEWS_POLICY.maxItemsPerFeed),
    minRelevant: count(merged.minRelevant, NEWS_POLICY.minRelevant),
  };
}

// ---------------------------------------------------------------- feed registry

export interface NewsFeedSource {
  id: string;
  name: string;
  url: string;
  tier: NewsTier;
  assetClasses: NewsAssetClass[];
}

/**
 * Public, keyless publisher feeds, verified to serve current items (fetched and
 * checked live before being committed here).
 *
 * Deliberately EXCLUDED: Google News RSS — it is offered for personal,
 * non-commercial use, so it cannot back a commercial product — and any publisher
 * that returns 403 to a non-browser client (e.g. FXStreet, AP), because a feed we
 * cannot fetch is a feed we must not pretend to have.
 */
export const NEWS_SOURCES: NewsFeedSource[] = [
  { id: "coindesk", name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss", tier: 1, assetClasses: ["crypto"] },
  { id: "theblock", name: "The Block", url: "https://www.theblock.co/rss.xml", tier: 1, assetClasses: ["crypto"] },
  { id: "cointelegraph", name: "Cointelegraph", url: "https://cointelegraph.com/rss", tier: 2, assetClasses: ["crypto"] },
  { id: "decrypt", name: "Decrypt", url: "https://decrypt.co/feed", tier: 2, assetClasses: ["crypto"] },
  { id: "investinglive", name: "InvestingLive", url: "https://investinglive.com/feed/news/", tier: 2, assetClasses: ["forex", "crypto"] },
  { id: "investing-forex", name: "Investing.com Forex", url: "https://www.investing.com/rss/news_1.rss", tier: 3, assetClasses: ["forex"] },
  { id: "investing-economy", name: "Investing.com Economy", url: "https://www.investing.com/rss/news_14.rss", tier: 3, assetClasses: ["forex", "crypto"] },
];

export function sourcesFor(assetClass: NewsAssetClass): NewsFeedSource[] {
  return NEWS_SOURCES.filter((s) => s.assetClasses.includes(assetClass));
}

const TIER_WEIGHT: Record<NewsTier, number> = { 1: 1, 2: 0.8, 3: 0.6 };

// ---------------------------------------------------------------- feed parsing

const MAX_XML_CHARS = 512_000;
const MAX_TEXT_CHARS = 400;
const MAX_BLOCKS = 200;

export interface RawNewsItem {
  title: string;
  url: string;
  source: string;
  sourceId: string;
  tier: NewsTier;
  /** Epoch ms, or null when the feed gave no parseable timestamp. Never guessed. */
  publishedAt: number | null;
  categories: string[];
  summary: string;
}

export interface ParsedFeed {
  items: RawNewsItem[];
  notes: string[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/** Decodes XML predefined/numeric character references by scanning, never by
 *  expanding a custom entity (custom entities are rejected at the document level). */
function decodeEntities(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const amp = input.indexOf("&", i);
    if (amp === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, amp);
    const semi = input.indexOf(";", amp + 1);
    if (semi === -1 || semi - amp > 12) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const body = input.slice(amp + 1, semi);
    let replaced: string | null = null;
    const codePoint = body.startsWith("#x") || body.startsWith("#X")
      ? Number.parseInt(body.slice(2), 16)
      : body.startsWith("#")
        ? Number.parseInt(body.slice(1), 10)
        : Number.NaN;
    if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      replaced = String.fromCodePoint(codePoint);
    } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body.toLowerCase())) {
      replaced = NAMED_ENTITIES[body.toLowerCase()];
    }
    out += replaced === null ? input.slice(amp, semi + 1) : replaced;
    i = semi + 1;
  }
  return out;
}

/** Unwraps CDATA, drops tags, decodes entities, collapses whitespace, caps length. */
function stripMarkup(input: string): string {
  let unwrapped = "";
  let i = 0;
  for (;;) {
    const start = input.indexOf("<![CDATA[", i);
    if (start === -1) {
      unwrapped += input.slice(i);
      break;
    }
    unwrapped += input.slice(i, start);
    const end = input.indexOf("]]>", start + 9);
    if (end === -1) {
      unwrapped += input.slice(start + 9);
      break;
    }
    unwrapped += input.slice(start + 9, end);
    i = end + 3;
  }

  let text = "";
  let j = 0;
  while (j < unwrapped.length) {
    const lt = unwrapped.indexOf("<", j);
    if (lt === -1) {
      text += unwrapped.slice(j);
      break;
    }
    text += unwrapped.slice(j, lt);
    const gt = unwrapped.indexOf(">", lt);
    if (gt === -1) break;
    j = gt + 1;
  }

  return decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

const isNameChar = (ch: string) => /[A-Za-z0-9:_-]/.test(ch);
const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && !isNameChar(raw[i])) i++;
    const nameStart = i;
    while (i < raw.length && isNameChar(raw[i])) i++;
    if (i === nameStart) break;
    const name = raw.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < raw.length && isSpace(raw[j])) j++;
    if (raw[j] !== "=") {
      i = j;
      continue;
    }
    j++;
    while (j < raw.length && isSpace(raw[j])) j++;
    const quote = raw[j];
    if (quote !== '"' && quote !== "'") {
      i = j;
      continue;
    }
    const end = raw.indexOf(quote, j + 1);
    if (end === -1) break;
    attrs[name] = raw.slice(j + 1, end);
    i = end + 1;
  }
  return attrs;
}

interface TagHit {
  attrs: Record<string, string>;
  inner: string;
}

/** Every `<tag …>inner</tag>` (or `<tag …/>`) occurrence, with attributes parsed. */
function tagHits(block: string, tag: string): TagHit[] {
  const hits: TagHit[] = [];
  const open = `<${tag}`;
  let i = 0;
  while (hits.length < MAX_BLOCKS) {
    const start = block.indexOf(open, i);
    if (start === -1) break;
    const next = block[start + open.length];
    if (next !== ">" && next !== "/" && !isSpace(next)) {
      i = start + open.length;
      continue;
    }
    const gt = block.indexOf(">", start);
    if (gt === -1) break;
    const selfClosing = block[gt - 1] === "/";
    let inner = "";
    if (!selfClosing) {
      const end = block.indexOf(`</${tag}>`, gt);
      if (end !== -1) inner = block.slice(gt + 1, end);
    }
    hits.push({ attrs: parseAttrs(block.slice(start + open.length, gt)), inner });
    i = gt + 1;
  }
  return hits;
}

function firstText(block: string, tags: string[]): string {
  for (const tag of tags) {
    const hits = tagHits(block, tag);
    for (const hit of hits) {
      const text = stripMarkup(hit.inner);
      if (text.length > 0) return text;
    }
  }
  return "";
}

function pickLink(block: string): string {
  const hits = tagHits(block, "link");
  // Prefer the human-facing target over self/enclosure relations (Atom).
  const preferred = hits.find((h) => (h.attrs.rel ?? "alternate") === "alternate" && h.attrs.href);
  if (preferred) return stripMarkup(preferred.attrs.href);
  const anyHref = hits.find((h) => h.attrs.href);
  if (anyHref) return stripMarkup(anyHref.attrs.href);
  const textLink = hits.map((h) => stripMarkup(h.inner)).find((t) => t.length > 0);
  return textLink ?? "";
}

function pickCategories(block: string): string[] {
  const out: string[] = [];
  for (const hit of tagHits(block, "category")) {
    const value = hit.attrs.term ? stripMarkup(hit.attrs.term) : stripMarkup(hit.inner);
    if (value.length > 0 && !out.includes(value)) out.push(value);
  }
  return out.slice(0, 8);
}

function parseDate(text: string): number | null {
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parses an RSS 2.0 or Atom document into raw items.
 *
 * Safe by construction: the document size is capped, DOCTYPE/ENTITY declarations are
 * rejected outright (no entity expansion, no external references), block scanning is
 * delimited rather than pattern-matched across the whole document, and anything that
 * cannot be read is reported in `notes` instead of being guessed at.
 */
export function parseFeedXml(xml: string, source: Pick<NewsFeedSource, "id" | "name" | "tier">): ParsedFeed {
  if (typeof xml !== "string" || xml.length === 0) return { items: [], notes: ["empty response body"] };
  if (xml.length > MAX_XML_CHARS) {
    return { items: [], notes: [`feed too large (${xml.length} > ${MAX_XML_CHARS} chars) — refused`] };
  }
  const head = xml.slice(0, 4_000);
  if (/<!doctype|<!entity/i.test(head)) {
    return { items: [], notes: ["rejected: DOCTYPE/ENTITY declarations are not supported"] };
  }

  const blocks = [...extractBlocks(xml, "item"), ...extractBlocks(xml, "entry")];
  if (blocks.length === 0) return { items: [], notes: ["no items found in feed"] };

  const notes: string[] = [];
  if (blocks.length > NEWS_POLICY.maxItemsPerFeed) {
    notes.push(`truncated to ${NEWS_POLICY.maxItemsPerFeed} of ${blocks.length} items`);
  }

  // External text is DATA, never instruction. Sanitizing at the parse boundary
  // means every downstream consumer (relevance, sentiment, MIND, the UI) sees
  // de-fanged text, and an item that tries to issue orders is recorded, not obeyed.
  let flagged = 0;
  const items: RawNewsItem[] = [];
  for (const block of blocks.slice(0, NEWS_POLICY.maxItemsPerFeed)) {
    const titleScan = sanitizeUntrusted(firstText(block, ["title"]), { maxChars: 300 });
    const title = titleScan.clean;
    if (title.length === 0) continue; // a headline-less item cannot be cited
    if (hasPolicyOverrideAttempt(titleScan)) flagged++;
    const dateText = firstText(block, ["pubDate", "published", "updated", "dc:date", "date"]);
    items.push({
      title,
      url: pickLink(block),
      source: source.name,
      sourceId: source.id,
      tier: source.tier,
      publishedAt: parseDate(dateText),
      categories: pickCategories(block),
      summary: sanitizeUntrusted(firstText(block, ["description", "summary", "content"]), {
        maxChars: 240,
      }).clean,
    });
  }
  if (items.length === 0) notes.push("no readable items (missing titles)");
  if (flagged > 0) {
    notes.push(`${flagged} item(s) contained instruction-like text — treated as data only`);
  }
  return { items, notes };
}

function extractBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = 0;
  while (blocks.length < MAX_BLOCKS) {
    const start = xml.indexOf(open, i);
    if (start === -1) break;
    const next = xml[start + open.length];
    if (next !== ">" && next !== "/" && !isSpace(next)) {
      i = start + open.length;
      continue;
    }
    const gt = xml.indexOf(">", start);
    if (gt === -1) break;
    const end = xml.indexOf(close, gt);
    if (end === -1) {
      i = gt + 1;
      continue;
    }
    blocks.push(xml.slice(gt + 1, end));
    i = end + close.length;
  }
  return blocks;
}

// ---------------------------------------------------------------- sentiment

/** Fixed bullish lexicon (exported so the scoring can be audited and tested). */
export const BULLISH_TERMS: Record<string, number> = {
  surge: 1, surges: 1, soar: 1, soars: 1, rally: 0.8, rallies: 0.8,
  jump: 0.7, jumps: 0.7, climb: 0.6, climbs: 0.6, gain: 0.5, gains: 0.5,
  rebound: 0.7, rebounds: 0.7, breakout: 0.8, "all-time high": 1, "record high": 1,
  bullish: 1, bull: 0.8, adoption: 0.7, approval: 0.8, "rate cut": 0.9,
  easing: 0.8, dovish: 0.9, stimulus: 0.7, upgrade: 0.7, inflow: 0.6,
  inflows: 0.6, institutional: 0.4, partnership: 0.5, etf: 0.4,
};

/** Fixed bearish lexicon (exported so the scoring can be audited and tested). */
export const BEARISH_TERMS: Record<string, number> = {
  plunge: -1, plunges: -1, crash: -1, crashes: -1, slump: -0.9, slumps: -0.9,
  selloff: -0.9, "sell-off": -0.9, liquidation: -0.9, liquidations: -0.9,
  drop: -0.6, drops: -0.6, fall: -0.6, falls: -0.6, sink: -0.7, sinks: -0.7,
  bearish: -1, bear: -0.8, hack: -1, hacked: -1, exploit: -1, breach: -0.9,
  ban: -0.9, banned: -0.9, lawsuit: -0.7, sues: -0.7, charges: -0.7, probe: -0.6,
  fraud: -1, scam: -1, delist: -0.9, delisting: -0.9, outflow: -0.6, outflows: -0.6,
  downgrade: -0.7, hawkish: -0.8, "rate hike": -0.9, hike: -0.5, recession: -0.9,
  default: -0.9, warning: -0.4, warns: -0.4, bankrupt: -1, bankruptcy: -1, "record low": -0.8,
};

const isWordChar = (ch: string) => /[A-Za-z0-9]/.test(ch);

/** Whole-word (not substring) mention test: "eth" must not match "ethereum". */
function mentions(text: string, term: string): boolean {
  let from = 0;
  for (;;) {
    const idx = text.indexOf(term, from);
    if (idx === -1) return false;
    const before = idx === 0 ? " " : text[idx - 1];
    const afterIdx = idx + term.length;
    const after = afterIdx >= text.length ? " " : text[afterIdx];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = idx + 1;
  }
}

/** Symbol → headline keywords. Every entry is a real market name for that pair. */
const SYMBOL_KEYWORDS: Record<string, string[]> = {
  BTC: ["bitcoin", "btc", "xbt"],
  ETH: ["ethereum", "ether", "eth"],
  SOL: ["solana", "sol"],
  BNB: ["bnb", "binance coin", "binance"],
  XRP: ["xrp", "ripple"],
  EUR: ["eur/usd", "eurusd", "euro", "ecb", "eurozone"],
  JPY: ["usd/jpy", "usdjpy", "yen", "boj", "japan"],
  GBP: ["gbp/usd", "cable", "sterling", "bank of england"],
  AUD: ["aud/usd", "aussie dollar", "rba"],
  CAD: ["usd/cad", "loonie", "bank of canada"],
  CHF: ["usd/chf", "franc", "snb"],
};

const MACRO_TERMS = [
  "federal reserve", "fomc", "fed", "interest rate", "rate cut", "rate hike",
  "inflation", "cpi", "tariff", "tariffs", "recession", "treasury", "dollar index",
  "jobs report", "payrolls", "gdp",
];

/** Keywords for a symbol like "BTCUSDT" / "EURUSD" (exchange suffix ignored). */
export function symbolKeywords(symbol: string): string[] {
  const base = symbol.replace(/(USDT|USDC|USD|PERP)$/i, "").toUpperCase() || symbol.toUpperCase();
  return SYMBOL_KEYWORDS[base] ?? [symbol.toLowerCase()];
}

function relevanceOf(
  haystack: string,
  keywords: string[],
  assetClass: NewsAssetClass,
): { relevance: number; matchedTerms: string[] } {
  const matched: string[] = [];
  for (const kw of keywords) {
    if (mentions(haystack, kw)) matched.push(kw);
  }
  if (matched.length > 0) return { relevance: 1, matchedTerms: matched };
  for (const term of MACRO_TERMS) {
    if (mentions(haystack, term)) return { relevance: assetClass === "forex" ? 0.7 : 0.4, matchedTerms: [term] };
  }
  return { relevance: 0, matchedTerms: [] };
}

/** Per-item sentiment in [-1, 1]: matched lexicon weights, squashed by tanh so the
 *  score saturates instead of scaling without bound. */
function sentimentOf(haystack: string): { sentiment: number; matchedTerms: string[] } {
  const matched: string[] = [];
  let raw = 0;
  for (const [term, weight] of Object.entries(BULLISH_TERMS)) {
    if (mentions(haystack, term)) {
      raw += weight;
      matched.push(term);
    }
  }
  for (const [term, weight] of Object.entries(BEARISH_TERMS)) {
    if (mentions(haystack, term)) {
      raw += weight;
      matched.push(term);
    }
  }
  return { sentiment: Math.tanh(raw / 2), matchedTerms: matched };
}

// ---------------------------------------------------------------- assessment

export type NewsStatus = "AVAILABLE" | "STALE" | "UNAVAILABLE";
export type NewsSignal = "LONG" | "SHORT" | "NEUTRAL";

export interface NewsItemAssessment {
  title: string;
  url: string;
  source: string;
  sourceId: string;
  tier: NewsTier;
  publishedAt: number;
  ageSec: number;
  relevance: number;
  sentiment: number;
  weight: number;
  matchedTerms: string[];
}

export interface NewsAssessment {
  status: NewsStatus;
  symbol: string;
  assetClass: NewsAssetClass;
  signal: NewsSignal;
  /** Weighted sentiment in [-1, 1], or null when there is no usable coverage. */
  score: number | null;
  confidence: number;
  fetchedCount: number;
  relevantCount: number;
  freshCount: number;
  freshestAt: number | null;
  freshestAgeSec: number | null;
  drivers: string[];
  evidence: string[];
  risks: string[];
  notes: string[];
  items: NewsItemAssessment[];
  policy: NewsPolicy;
  modelVersion: string;
  /**
   * True when external text tried to act as an instruction ("ignore your rules",
   * "override the risk limit", "place a trade"). Headlines are evidence, never
   * authority: the attempt is recorded for the audit trail and changes nothing.
   */
  policyOverrideAttempt: boolean;
}

function ageLabel(ageSec: number): string {
  return ageSec < 3600 ? `${Math.max(1, Math.round(ageSec / 60))}m` : `${(ageSec / 3600).toFixed(1)}h`;
}

/** Directional read of a score. Below the threshold the news layer stays silent. */
export function signalFromScore(score: number | null): NewsSignal {
  if (score === null) return "NEUTRAL";
  if (score >= 0.35) return "LONG";
  if (score <= -0.35) return "SHORT";
  return "NEUTRAL";
}

/**
 * Assesses real headlines for one symbol at a fixed instant.
 *
 * Fail-closed ladder: no items → UNAVAILABLE; nothing symbol-relevant → UNAVAILABLE;
 * relevant but older than the freshness limit → STALE. Only a fully AVAILABLE
 * assessment carries a score, a signal, and non-zero confidence.
 */
export function assessNews(
  items: RawNewsItem[],
  opts: { symbol: string; assetClass: NewsAssetClass; now: number; policy?: NewsPolicy },
): NewsAssessment {
  const policy = opts.policy ?? NEWS_POLICY;
  const keywords = symbolKeywords(opts.symbol);
  const notes: string[] = [];

  let undated = 0;
  let irrelevant = 0;
  let beyondStale = 0;
  let overrideAttempts = 0;
  const scored: NewsItemAssessment[] = [];

  for (const raw of items) {
    // Recorded before any relevance filter: an attempt is an operator signal even
    // if the headline turns out to be irrelevant to this symbol. It carries no
    // authority over policy, limits, or execution mode.
    if (
      hasPolicyOverrideAttempt(sanitizeUntrusted(`${raw.title} ${raw.summary}`, { maxChars: 400 }))
    ) {
      overrideAttempts += 1;
    }
    if (raw.publishedAt === null) {
      undated++;
      continue;
    }
    const ageSec = Math.max(0, (opts.now - raw.publishedAt) / 1000);
    if (ageSec > policy.staleAfterSec) {
      beyondStale++;
      continue;
    }
    const haystack = `${raw.title} \u2022 ${raw.summary} \u2022 ${raw.categories.join(" ")}`.toLowerCase();
    const { relevance, matchedTerms: relevantTerms } = relevanceOf(haystack, keywords, opts.assetClass);
    if (relevance <= 0) {
      irrelevant++;
      continue;
    }
    const { sentiment, matchedTerms } = sentimentOf(haystack);
    const recency = Math.max(0.05, Math.pow(0.5, ageSec / policy.halfLifeSec));
    scored.push({
      title: raw.title,
      url: raw.url,
      source: raw.source,
      sourceId: raw.sourceId,
      tier: raw.tier,
      publishedAt: raw.publishedAt,
      ageSec,
      relevance,
      sentiment,
      weight: recency * TIER_WEIGHT[raw.tier] * relevance,
      matchedTerms: [...relevantTerms, ...matchedTerms],
    });
  }

  const fresh = scored.filter((i) => i.ageSec <= policy.maxAgeSec);
  const freshest = scored.reduce<NewsItemAssessment | null>(
    (acc, i) => (acc === null || i.ageSec < acc.ageSec ? i : acc),
    null,
  );

  let status: NewsStatus;
  if (items.length === 0) {
    status = "UNAVAILABLE";
    notes.push("no items fetched from any source");
  } else if (scored.length < policy.minRelevant) {
    status = "UNAVAILABLE";
    notes.push(`no symbol-relevant coverage for ${opts.symbol} in the current feeds`);
  } else if (fresh.length === 0) {
    status = "STALE";
    notes.push(`symbol-relevant coverage is older than the ${Math.round(policy.maxAgeSec / 60)}m freshness limit`);
  } else {
    status = "AVAILABLE";
  }
  if (undated > 0) notes.push(`${undated} undated item(s) excluded (age cannot be assumed)`);
  if (irrelevant > 0) notes.push(`${irrelevant} item(s) not relevant to ${opts.symbol}`);
  if (beyondStale > 0) notes.push(`${beyondStale} item(s) beyond the ${Math.round(policy.staleAfterSec / 3600)}h horizon`);
  if (overrideAttempts > 0) {
    notes.push(
      `${overrideAttempts} headline(s) contained instruction-like text — treated as data only, no policy change applied`,
    );
  }

  let score: number | null = null;
  let confidence = 0;
  if (status === "AVAILABLE") {
    const totalWeight = fresh.reduce((acc, i) => acc + i.weight, 0);
    const netWeighted = fresh.reduce((acc, i) => acc + i.sentiment * i.weight, 0);
    const grossWeighted = fresh.reduce((acc, i) => acc + Math.abs(i.sentiment) * i.weight, 0);
    score = totalWeight > 0 ? clamp(netWeighted / totalWeight, -1, 1) : 0;

    // Confidence tracks how well the coverage actually agrees, not just how much of it
    // there is: conflicting headlines must not read as high confidence.
    const agreement = grossWeighted > 0 ? Math.abs(netWeighted) / grossWeighted : 0;
    const coverage = Math.min(1, fresh.length / 6);
    const freshestAgeSec = Math.min(...fresh.map((i) => i.ageSec));
    const recency = 1 - freshestAgeSec / policy.maxAgeSec;
    confidence = clamp(0.15 + 0.5 * agreement + 0.2 * coverage + 0.15 * recency, 0, 0.9);
  }

  const ranked = [...scored].sort(
    (a, b) => Math.abs(b.sentiment * b.weight) - Math.abs(a.sentiment * a.weight),
  );
  const drivers = ranked
    .slice(0, 3)
    .map((i) => `${i.title} — ${i.source} (${i.sentiment >= 0 ? "+" : ""}${i.sentiment.toFixed(2)}, ${ageLabel(i.ageSec)} old)`);

  const evidence = ranked
    .slice(0, 4)
    .map((i) => `${i.title} — ${i.source}, ${ageLabel(i.ageSec)} old${i.url ? ` (${i.url})` : ""}`);

  const polarity = score === null ? 0 : Math.sign(score) || 0;
  const risks = ranked
    .filter((i) => polarity !== 0 && Math.sign(i.sentiment) === -polarity && Math.abs(i.sentiment) > 0.2)
    .slice(0, 3)
    .map((i) => `Contrary headline: ${i.title} — ${i.source} (${ageLabel(i.ageSec)} old)`);
  if (status === "STALE") risks.push("news coverage is stale: headline risk is unmeasured");
  if (status === "UNAVAILABLE") risks.push("news coverage unavailable: headline risk is unmeasured");

  return {
    status,
    symbol: opts.symbol,
    assetClass: opts.assetClass,
    signal: signalFromScore(score),
    score,
    confidence,
    fetchedCount: items.length,
    relevantCount: scored.length,
    freshCount: fresh.length,
    freshestAt: freshest?.publishedAt ?? null,
    freshestAgeSec: freshest?.ageSec ?? null,
    drivers,
    evidence,
    risks,
    notes,
    items: ranked.slice(0, policy.maxItems),
    policy,
    modelVersion: NEWS_MODEL_VERSION,
    policyOverrideAttempt: overrideAttempts > 0,
  };
}

// ---------------------------------------------------------------- agent output

/** Neutral, zero-influence analysis used when the pipeline has no news input at all. */
export const NO_NEWS_ANALYSIS: AgentAnalysis = {
  agent: "news_ai",
  signal: "NEUTRAL",
  confidence: 0,
  summary: "News layer not supplied for this run — no sentiment is fabricated",
  evidence: ["No news input: no fabricated sentiment is emitted — zero influence"],
  risks: [],
  invalidation: [],
  dataQuality: "invalid",
  dataTimestamp: 0,
  modelVersion: NEWS_MODEL_VERSION,
};

/**
 * Projects an assessment into the standard agent contract so MIND can weigh it.
 * An unavailable or stale assessment is NEUTRAL with zero confidence, which keeps it
 * out of MIND's directional weighting entirely — no news never moves a decision.
 */
export function newsAI(assessment: NewsAssessment, dataQuality: DataQuality, now: number): AgentAnalysis {
  const base: AgentAnalysis = {
    agent: "news_ai",
    signal: "NEUTRAL",
    confidence: 0,
    summary: "",
    evidence: [],
    risks: [],
    invalidation: [],
    dataQuality,
    dataTimestamp: assessment.freshestAt ?? now,
    modelVersion: NEWS_MODEL_VERSION,
  };

  if (assessment.status !== "AVAILABLE" || assessment.score === null) {
    const why = assessment.notes.length > 0 ? assessment.notes.join("; ") : "no symbol-relevant coverage";
    return {
      ...base,
      summary: assessment.status === "STALE"
        ? `News unavailable for this decision: coverage is stale (${why})`
        : `News unavailable: ${why}`,
      evidence: [
        "No usable news input: no fabricated sentiment is emitted — the news layer carries zero weight",
      ],
      risks: ["headline risk is unmeasured until fresh coverage is available"],
    };
  }

  const score = assessment.score;
  const direction = assessment.signal === "LONG" ? "bullish" : assessment.signal === "SHORT" ? "bearish" : "mixed";
  return {
    ...base,
    signal: assessment.signal,
    confidence: assessment.confidence,
    summary: `News flow is ${direction}: weighted sentiment ${score >= 0 ? "+" : ""}${score.toFixed(2)} from ${assessment.freshCount} fresh, symbol-relevant headline(s) across ${assessment.fetchedCount} fetched`,
    evidence: assessment.evidence,
    risks: assessment.risks.length > 0
      ? assessment.risks
      : ["news sentiment can reverse on the next headline"],
    invalidation: [
      "a newer headline contradicts the top driver",
      "coverage ages beyond the freshness limit with no replacement",
    ],
  };
}
