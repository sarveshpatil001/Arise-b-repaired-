import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Panel, QualityBadge } from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import { useSymbols } from "@/hooks/use-arise";
import { cn } from "@/lib/utils";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleResp {
  symbol: string;
  interval: string;
  source: string;
  fellBack: boolean;
  fallbackFrom: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  bars: Candle[];
}

export default function Markets() {
  const symbols = useSymbols();
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval_, setInterval_] = useState("1h");
  const [data, setData] = useState<CandleResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchCandles = useAction(api.arise.charts.candles);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = (await fetchCandles({ symbol, interval: interval_, limit: 300 })) as unknown as CandleResp;
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load market data");
    } finally {
      setLoading(false);
    }
  }, [symbol, interval_, fetchCandles]);

  useEffect(() => {
    // Kick the fetch off in a task: `load` sets loading state immediately, and
    // doing that synchronously inside the effect would cascade a render.
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const last = data?.bars[data.bars.length - 1];
  const prev = data?.bars[data.bars.length - 2];
  const changePct =
    last && prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const recentHigh = useMemo(
    () => (data && data.bars.length > 0 ? Math.max(...data.bars.slice(-24).map((b) => b.high)) : 0),
    [data],
  );
  const recentLow = useMemo(
    () => (data && data.bars.length > 0 ? Math.min(...data.bars.slice(-24).map((b) => b.low)) : 0),
    [data],
  );

  const [hoverBar, setHoverBar] = useState<Candle | null>(null);
  const cursor = hoverBar ?? last ?? null;

  return (
    <Terminal>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-terminal text-lg font-bold tracking-wider">
            MARKET INTELLIGENCE — {symbol}
          </h1>
          <div className="flex items-center gap-2">
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="h-8 w-40 font-terminal text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="font-terminal text-xs">
                {symbols.map((s) => (
                  <SelectItem key={s.symbol} value={s.symbol}>{s.symbol} · {s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={interval_} onValueChange={setInterval_}>
              <SelectTrigger className="h-8 w-20 font-terminal text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="font-terminal text-xs">
                {["1m", "5m", "15m", "1h", "4h", "1d"].map((iv) => (
                  <SelectItem key={iv} value={iv}>{iv}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="gap-1.5 font-terminal text-[11px]" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} REFRESH
            </Button>
          </div>
        </div>

        {error && (
          <div className="panel border-danger/40 bg-danger/5 px-4 py-3 font-terminal text-xs text-danger">
            DATA UNAVAILABLE — {error}. ARISE never fabricates prices; try another symbol or interval.
          </div>
        )}

        {data && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            {[
              { label: "PRICE", v: (cursor?.close ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 }) },
              { label: "BAR CHANGE", v: `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`, tone: changePct >= 0 ? "up" : "down" },
              { label: "RECENT HIGH", v: recentHigh.toLocaleString("en-US", { maximumFractionDigits: 2 }) },
              { label: "RECENT LOW", v: recentLow.toLocaleString("en-US", { maximumFractionDigits: 2 }) },
              { label: "VOLUME (LAST)", v: (last?.volume ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 }) },
              { label: "SOURCE", v: (data.source ?? "—").toUpperCase() + (data.fellBack ? " *" : "") },
            ].map((s) => (
              <div key={s.label} className="panel px-3 py-2">
                <div className="panel-title text-[9px]">{s.label}</div>
                <div className={cn(
                  "mt-1 font-terminal text-sm font-bold tabular",
                  s.tone === "up" && "text-success",
                  s.tone === "down" && "text-danger",
                )}>
                  {s.v}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
          <div className="xl:col-span-3">
            <Panel
              title={`${symbol} · ${data?.interval ?? interval_} · CANDLES + VOLUME`}
              right={
                data ? (
                  <div className="flex items-center gap-2">
                    {data.fellBack && (
                      <Badge variant="outline" className="border-warning/40 font-terminal text-[9px] text-warning">
                        FALLBACK: {data.fallbackFrom}
                      </Badge>
                    )}
                    <QualityBadge quality="valid" />
                  </div>
                ) : null
              }
            >
              {loading && !data ? (
                <div className="flex h-96 items-center justify-center text-xs text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> LOADING REAL MARKET DATA…
                </div>
              ) : data ? (
                <CandleChart bars={data.bars} onHover={setHoverBar} />
              ) : null}
            </Panel>
          </div>

          <div className="space-y-3">
            <Panel title="MARKET DATA">
              <div className="space-y-2 font-terminal text-[11px]">
                <Row label="SYMBOL" value={symbol} />
                <Row label="INTERVAL" value={data?.interval ?? "—"} />
                <Row label="PROVIDER" value={(data?.source ?? "—").toUpperCase()} />
                <Row
                  label="SPREAD"
                  value={
                    data?.bestBid && data?.bestAsk
                      ? `${(((data.bestAsk - data.bestBid) / data.bestBid) * 100).toFixed(3)}%`
                      : "n/a"
                  }
                />
                <Row label="BID" value={data?.bestBid ? data.bestBid.toLocaleString("en-US") : "—"} />
                <Row label="ASK" value={data?.bestAsk ? data.bestAsk.toLocaleString("en-US") : "—"} />
                <Row label="BARS LOADED" value={String(data?.bars.length ?? 0)} />
                <Row label="FEED NOTE" value={data?.fellBack ? `fallback: ${data.fallbackFrom}` : "direct feed"} />
              </div>
              <p className="mt-3 border-t border-border pt-2 text-[10px] leading-relaxed text-muted-foreground">
                All prices are real, validated, and timestamped. ARISE never fabricates market data.
                Run ANALYZE on the ARISE DECISION screen to populate the specialist consensus for this symbol.
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </Terminal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 pb-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular font-semibold">{value}</span>
    </div>
  );
}

/** Lightweight SVG candlestick chart with volume, crosshair hover, price axis. */
function CandleChart({ bars, onHover }: { bars: Candle[]; onHover: (b: Candle | null) => void }) {
  const view = useMemo(() => bars.slice(-120), [bars]);
  const [geom, setGeom] = useState({ w: 900, h: 400 });
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    if (el && Math.abs(el.clientWidth - geom.w) > 12) {
      setGeom({ w: Math.max(480, el.clientWidth), h: 400 });
    }
  }, [geom.w]);

  const padR = 60;
  const padB = 22;
  const volH = 64;

  const stats = useMemo(() => {
    if (view.length === 0) return null;
    const yMax = Math.max(...view.map((b) => b.high));
    const yMin = Math.min(...view.map((b) => b.low));
    return { yMax, yMin, span: yMax - yMin || 1, maxVol: Math.max(...view.map((b) => b.volume), 1) };
  }, [view]);

  if (!stats || view.length === 0) return <div className="h-96" />;

  const plotH = geom.h - padB - volH;
  const stepX = (geom.w - padR) / view.length;
  const x = (i: number) => (i + 0.5) * stepX;
  const y = (p: number) => 8 + ((stats.yMax - p) / stats.span) * (plotH - 16);
  const bw = Math.max(2, stepX * 0.62);

  const gridLines = 5;
  const priceTicks = Array.from({ length: gridLines }, (_, i) => stats.yMax - (stats.span * i) / (gridLines - 1));
  const fmtTick = (p: number) => (p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toFixed(4));

  return (
    <div ref={wrapRef} className="w-full">
      <svg
        width="100%"
        height={geom.h}
        viewBox={`0 0 ${geom.w} ${geom.h}`}
        onMouseLeave={() => onHover(null)}
        className="block"
      >
        {priceTicks.map((p, i) => (
          <g key={i}>
            <line x1={0} x2={geom.w - padR} y1={y(p)} y2={y(p)} stroke="#1d2632" strokeWidth={1} />
            <text x={geom.w - padR + 8} y={y(p) + 3} fill="#8b98a9" fontSize={10} fontFamily="JetBrains Mono, monospace">
              {fmtTick(p)}
            </text>
          </g>
        ))}
        {view.map((b, i) => {
          const up = b.close >= b.open;
          const color = up ? "#3fb950" : "#f85149";
          const yO = y(b.open);
          const yC = y(b.close);
          const top = Math.min(yO, yC);
          const h = Math.max(1.5, Math.abs(yC - yO));
          return (
            <g key={b.time} onMouseEnter={() => onHover(b)}>
              <rect x={x(i) - stepX / 2} y={0} width={stepX} height={geom.h - padB} fill="transparent" />
              <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth={1} />
              <rect x={x(i) - bw / 2} y={top} width={bw} height={h} fill={up ? "rgba(63,185,80,0.9)" : "rgba(248,81,73,0.9)"} />
              <rect
                x={x(i) - bw / 2}
                y={geom.h - padB - (b.volume / stats.maxVol) * volH}
                width={bw}
                height={(b.volume / stats.maxVol) * volH}
                fill={up ? "rgba(63,185,80,0.35)" : "rgba(248,81,73,0.35)"}
              />
            </g>
          );
        })}
        <line x1={0} x2={geom.w} y1={geom.h - padB} y2={geom.h - padB} stroke="#1d2632" />
      </svg>
    </div>
  );
}
