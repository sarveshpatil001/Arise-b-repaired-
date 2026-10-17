// ARISE — NEWS WIRE panel.
// Fetches the real public publisher feeds through the Convex news action and renders
// the deterministic assessment (src/lib/arise/news.ts): status, weighted sentiment,
// per-headline citations and per-feed health. When there is no usable coverage the
// panel says so explicitly — it never shows an invented sentiment.

import { useAction } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfidenceBar, Panel, StatusDot } from "@/components/arise/shared";
import { cn } from "@/lib/utils";
import { Newspaper, RefreshCw } from "lucide-react";

interface NewsItemPayload {
  title: string;
  url: string;
  source: string;
  ageSec: number;
  sentiment: number;
  relevance: number;
}

interface NewsAssessmentPayload {
  status: string;
  signal: string;
  score: number | null;
  confidence: number;
  fetchedCount: number;
  relevantCount: number;
  freshCount: number;
  drivers: string[];
  evidence: string[];
  risks: string[];
  notes: string[];
  items: NewsItemPayload[];
  modelVersion: string;
}

interface FeedStatusPayload {
  id: string;
  name: string;
  ok: boolean;
  itemCount: number;
  error: string | null;
}

interface NewsResult {
  assessment: NewsAssessmentPayload;
  feeds: FeedStatusPayload[];
  fetchedAt: number;
}

const STATUS_TONE: Record<string, string> = {
  AVAILABLE: "border-success/50 text-success",
  STALE: "border-warning/50 text-warning",
  UNAVAILABLE: "border-danger/50 text-danger",
};

function ageLabel(ageSec: number): string {
  return ageSec < 3600 ? `${Math.max(1, Math.round(ageSec / 60))}m` : `${(ageSec / 3600).toFixed(1)}h`;
}

export function NewsWire({ symbol }: { symbol: string }) {
  const scan = useAction(api.arise.news.assess);
  const [result, setResult] = useState<NewsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = (await scan({ symbol })) as unknown as NewsResult;
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "News scan failed");
    } finally {
      setBusy(false);
    }
  }, [scan, symbol]);

  useEffect(() => {
    // Deferred kickoff: the scan sets state immediately, and doing that synchronously
    // inside the effect would cascade a render.
    const id = setTimeout(() => void run(), 0);
    return () => clearTimeout(id);
  }, [run]);

  const a = result?.assessment;
  const feeds = result?.feeds ?? [];
  const healthy = feeds.filter((f) => f.ok).length;

  return (
    <Panel
      title="NEWS WIRE — REAL PUBLISHER FEEDS"
      right={
        <div className="flex items-center gap-2">
          {a && (
            <Badge variant="outline" className={cn("font-terminal text-[9px]", STATUS_TONE[a.status])}>
              {a.status}
            </Badge>
          )}
          {feeds.length > 0 && (
            <Badge variant="outline" className="font-terminal text-[9px]">
              FEEDS {healthy}/{feeds.length}
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 font-terminal text-[9px]"
            disabled={busy}
            onClick={() => void run()}
          >
            <RefreshCw className={cn("size-3", busy && "animate-spin")} />
            {busy ? "SCANNING" : "RESCAN"}
          </Button>
        </div>
      }
    >
      {error && <p className="text-[11px] text-danger">{error}</p>}

      {!error && !a && (
        <p className="text-[11px] text-muted-foreground">
          <Newspaper className="mr-1.5 inline size-3.5" />
          Scanning public publisher feeds for {symbol}…
        </p>
      )}

      {a && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="SIGNAL" value={a.signal} />
            <Metric
              label="SENTIMENT"
              value={a.score === null ? "—" : `${a.score >= 0 ? "+" : ""}${a.score.toFixed(2)}`}
              tone={a.score === null ? "muted" : a.score >= 0 ? "up" : "down"}
            />
            <Metric label="FRESH HEADLINES" value={`${a.freshCount} / ${a.fetchedCount}`} />
            <Metric label="MODEL" value={a.modelVersion} />
          </div>

          <div>
            <div className="panel-title mb-1 text-[9px]">CONFIDENCE</div>
            <ConfidenceBar value={a.confidence} />
          </div>

          {a.score === null && (
            <p className="border border-warning/40 bg-warning/5 p-2 text-[10px] leading-relaxed text-warning">
              No usable news coverage — ARISE reports this instead of guessing. The news layer
              contributes zero directional weight and headline risk is unmeasured.
            </p>
          )}

          {a.drivers.length > 0 && <Detail title="TOP DRIVERS (CITED)" items={a.drivers} tone="text-foreground/90" />}
          {a.risks.length > 0 && <Detail title="CONTRARY / UNMEASURED RISK" items={a.risks} tone="text-warning" />}
          {a.notes.length > 0 && <Detail title="COVERAGE NOTES" items={a.notes} tone="text-muted-foreground" />}

          {a.items.length > 0 && (
            <div className="border-t border-border pt-2">
              <div className="panel-title mb-1 text-[9px]">HEADLINES USED</div>
              <ul className="space-y-1">
                {a.items.slice(0, 8).map((i, idx) => (
                  <li key={idx} className="flex items-start justify-between gap-3">
                    <span className="text-[10px] leading-relaxed">
                      {i.url ? (
                        <a
                          href={i.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline decoration-border hover:text-primary"
                        >
                          {i.title}
                        </a>
                      ) : (
                        i.title
                      )}
                      <span className="text-muted-foreground"> — {i.source}, {ageLabel(i.ageSec)} old</span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-terminal text-[10px] tabular",
                        i.sentiment > 0.2 ? "text-success" : i.sentiment < -0.2 ? "text-danger" : "text-muted-foreground",
                      )}
                    >
                      {i.sentiment >= 0 ? "+" : ""}
                      {i.sentiment.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feeds.length > 0 && (
            <div className="border-t border-border pt-2">
              <div className="panel-title mb-1 text-[9px]">FEED HEALTH</div>
              <div className="flex flex-wrap gap-1.5">
                {feeds.map((f) => (
                  <span
                    key={f.id}
                    title={f.error ?? `${f.itemCount} items`}
                    className="inline-flex items-center gap-1.5 border border-border bg-secondary px-1.5 py-0.5 font-terminal text-[9px]"
                  >
                    <StatusDot tone={f.ok ? "success" : "warning"} />
                    {f.name}
                    <span className="text-muted-foreground">{f.ok ? f.itemCount : "DOWN"}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <p className="border-t border-border pt-2 font-terminal text-[9px] leading-relaxed text-muted-foreground">
            Deterministic lexicon scoring over real headlines (no LLM, no synthesis). Undated items are
            excluded; items beyond the freshness horizon make the assessment STALE. Feed outages reduce
            coverage and are disclosed — they are never filled with invented news.
          </p>
        </div>
      )}
    </Panel>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "muted" }) {
  return (
    <div className="border border-border bg-secondary/40 p-2">
      <div className="panel-title text-[9px]">{label}</div>
      <div
        className={cn(
          "font-terminal text-sm font-bold tabular",
          tone === "up" && "text-success",
          tone === "down" && "text-danger",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Detail({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div>
      <div className="panel-title mb-1 text-[9px]">{title}</div>
      <ul className="space-y-0.5">
        {items.map((e, i) => (
          <li key={i} className={cn("text-[10px] leading-relaxed", tone)}>• {e}</li>
        ))}
      </ul>
    </div>
  );
}
