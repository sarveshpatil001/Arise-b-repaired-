import { motion } from "framer-motion";
import {
  ArrowRight, Brain, Check, CircuitBoard, FileSearch, Gauge,
  LineChart, Lock, ShieldCheck, Zap,
} from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import logo from "@/assets/logo.svg";

const AGENTS = [
  { name: "QUANT AI", desc: "Statistical drift, momentum scores, z-score extension.", icon: Gauge },
  { name: "TECHNICAL AI", desc: "Market structure, EMA alignment, MACD and RSI confluence.", icon: LineChart },
  { name: "REGIME AI", desc: "Classifies trending, ranging, and volatile conditions.", icon: Zap },
  { name: "ANOMALY AI", desc: "Flags abnormal volume, spread, and volatility behavior.", icon: ShieldCheck },
];

const PIPELINE = [
  { step: "01", title: "Analyze", desc: "Live crypto and FX prices from public exchange APIs. Every bar validated before use." },
  { step: "02", title: "Measure", desc: "A deterministic quant engine computes trend, momentum, volatility, and liquidity." },
  { step: "03", title: "Debate", desc: "Six specialized agents analyze the same evidence from independent perspectives." },
  { step: "04", title: "Challenge", desc: "The MIND layer hunts for contradictions, discounts correlated opinions, calibrates confidence." },
  { step: "05", title: "Risk-check", desc: "A deterministic risk engine holds final authority. Twelve rules. No exceptions. No AI override." },
  { step: "06", title: "Decide", desc: "One BUY / SELL / WAIT verdict with entry, stop, target — routed to audited paper execution." },
];

const PRINCIPLES = [
  {
    icon: Brain,
    title: "ANALYSIS IS NOT AUTHORITY",
    desc: "Agents recommend. The risk engine permits. The two responsibilities never mix.",
  },
  {
    icon: Gauge,
    title: "DETERMINISTIC WHERE IT COUNTS",
    desc: "Every number comes from tested mathematics. No language model invents a price, an indicator, or a fill.",
  },
  {
    icon: ShieldCheck,
    title: "\"WAIT\" IS A REAL ANSWER",
    desc: "Stale data, wide spreads, or agent disagreement produce a no-trade — by design, not by accident.",
  },
];

const PRICING = [
  {
    key: "free",
    name: "Starter",
    price: "$0",
    cadence: "forever",
    blurb: "For evaluating the engine.",
    features: [
      "5 market analyses per day",
      "1 watchlist symbol",
      "Full BUY / SELL / WAIT verdicts",
      "MIND debate and risk checks",
      "Paper trading execution",
    ],
    cta: "START FREE",
    highlight: false,
  },
  {
    key: "pro",
    name: "Pro Trader",
    price: "$49",
    cadence: "per month",
    blurb: "For serious independent traders.",
    features: [
      "Unlimited analyses",
      "25 watchlist symbols, crypto and FX",
      "Full evidence drill-down on every agent",
      "Complete decision audit trail",
      "Fees and slippage modeled on every fill",
    ],
    cta: "GO PRO",
    highlight: true,
  },
  {
    key: "institutional",
    name: "Institutional",
    price: "$199",
    cadence: "per month",
    blurb: "For funds and research desks.",
    features: [
      "Everything in Pro",
      "100 watchlist symbols",
      "Compliance-ready decision exports",
      "Early access to new agents",
      "Priority support",
    ],
    cta: "SCALE UP",
    highlight: false,
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <img src={logo} alt="" className="size-7" />
            <div className="leading-none">
              <div className="font-terminal text-base font-bold tracking-[0.28em]">ARISE</div>
              <div className="font-terminal text-[8px] tracking-[0.18em] text-muted-foreground">
                MULTI-AI QUANTITATIVE & ALGORITHMIC TRADING SYSTEM
              </div>
            </div>
            <Badge variant="outline" className="ml-2 hidden border-primary/40 font-terminal text-[10px] text-primary sm:inline-flex">
              PAPER TRADING
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/auth">
              <Button variant="ghost" size="sm" className="font-terminal text-xs">SIGN IN</Button>
            </Link>
            <Link to="/auth?returnTo=%2Fdashboard">
              <Button size="sm" className="font-terminal text-xs">OPEN TERMINAL</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero — compact, data-first */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="grid-bg absolute inset-0" />
        <div className="absolute inset-x-0 top-0 h-px scan-line" />
        <div className="relative mx-auto max-w-6xl px-4 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="grid grid-cols-1 items-start gap-10 lg:grid-cols-5"
          >
            <div className="lg:col-span-3">
              <div className="mb-5 flex items-center gap-2">
                <CircuitBoard className="size-3.5 text-primary" />
                <span className="font-terminal text-[11px] tracking-[0.2em] text-muted-foreground">
                  MARKET INTELLIGENCE · CRYPTO + FOREX · PAPER TRADING
                </span>
              </div>
              <h1 className="font-terminal text-3xl font-bold leading-[1.1] tracking-tight md:text-5xl">
                Test your trading bot before you trust it.
                <br />
                <span className="text-primary">Evidence, not promises.</span>
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
                Six specialized analytical agents examine live market data from independent perspectives. A reasoning
                layer challenges every conclusion. A deterministic risk engine holds veto power over the final call.
                The result is one auditable decision — <span className="text-success">BUY</span>,{" "}
                <span className="text-danger">SELL</span>, or <span className="text-warning">WAIT</span> — with the
                reasoning, the disagreement, and the invalidation conditions attached.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link to="/auth?returnTo=%2Fdashboard">
                  <Button size="lg" className="gap-2 font-terminal">
                    OPEN THE TERMINAL <ArrowRight className="size-4" />
                  </Button>
                </Link>
                <Link to="/auth">
                  <Button size="lg" variant="outline" className="font-terminal">
                    SIGN IN
                  </Button>
                </Link>
              </div>
              <div className="mt-6 flex flex-wrap gap-x-5 gap-y-1 font-terminal text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1.5"><Lock className="size-3" /> Live execution disabled — simulation only</span>
                <span className="flex items-center gap-1.5"><FileSearch className="size-3" /> Every decision fully auditable</span>
                <span className="flex items-center gap-1.5"><Check className="size-3" /> No card required for Starter</span>
              </div>
            </div>

            {/* Decision specimen — what the product actually outputs */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="panel p-4 lg:col-span-2"
            >
              <div className="panel-title mb-3">ARISE DECISION — SPECIMEN</div>
              <div className="flex items-baseline justify-between">
                <span className="font-terminal text-2xl font-bold text-success">BUY</span>
                <span className="font-terminal text-xs tabular text-muted-foreground">CONFIDENCE 78%</span>
              </div>
              <div className="mt-3 space-y-1.5 font-terminal text-[10px]">
                <div className="flex justify-between border-b border-border/50 pb-1.5">
                  <span className="text-muted-foreground">REGIME</span>
                  <span>BULLISH TREND</span>
                </div>
                <div className="flex justify-between border-b border-border/50 pb-1.5">
                  <span className="text-muted-foreground">RISK STATUS</span>
                  <span className="text-success">PASS · 12/12 CHECKS</span>
                </div>
                <div className="flex justify-between border-b border-border/50 pb-1.5">
                  <span className="text-muted-foreground">MIND AI</span>
                  <span>2/3 SPECIALISTS AGREE</span>
                </div>
                <div className="flex justify-between border-b border-border/50 pb-1.5">
                  <span className="text-muted-foreground">PAPER TRADE</span>
                  <span className="tabular">ENTRY · STOP · TARGET 2R</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">INVALIDATION</span>
                  <span className="text-warning">CLOSE BELOW STOP</span>
                </div>
              </div>
              <p className="mt-3 border-t border-border pt-2 text-[9px] leading-relaxed text-muted-foreground">
                Every verdict ships with its evidence, its dissent, and the exact conditions that would cancel it.
              </p>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Agents */}
      <section className="border-b border-border py-14">
        <div className="mx-auto max-w-6xl px-4">
          <div className="panel-title mb-2">SIX SPECIALISTS · ONE VERDICT</div>
          <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
            Each agent owns a narrow question and answers only from validated data — never from memory, never from
            sentiment, never from invention.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {AGENTS.map((a, i) => (
              <motion.div
                key={a.name}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                className="panel p-4 transition-colors hover:border-primary/40"
              >
                <a.icon className="size-5 text-primary" />
                <div className="mt-3 font-terminal text-xs font-semibold tracking-wider">{a.name}</div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{a.desc}</div>
              </motion.div>
            ))}
          </div>
          <p className="mt-4 font-terminal text-[11px] text-muted-foreground">
            + PORTFOLIO AI — whole-book exposure · RISK AI — advisory only, never final authority
          </p>
        </div>
      </section>

      {/* Pipeline */}
      <section className="border-b border-border py-14">
        <div className="mx-auto max-w-6xl px-4">
          <div className="panel-title mb-6">HOW A DECISION IS REACHED</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {PIPELINE.map((p, i) => (
              <motion.div
                key={p.step}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.04 }}
                className="panel flex gap-4 p-5"
              >
                <div className="font-terminal text-2xl font-bold text-primary/40">{p.step}</div>
                <div>
                  <div className="font-terminal text-sm font-semibold">{p.title}</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.desc}</div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Principles */}
      <section className="border-b border-border py-12">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-4 md:grid-cols-3">
          {PRINCIPLES.map((p) => (
            <div key={p.title} className="flex gap-3">
              <p.icon className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <div className="font-terminal text-sm font-semibold">{p.title}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-b border-border py-14">
        <div className="mx-auto max-w-6xl px-4">
          <div className="panel-title mb-2">PRICING</div>
          <p className="mb-8 max-w-2xl text-sm text-muted-foreground">
            Straightforward monthly plans. Cancel anytime through the customer portal. Every plan runs the full
            decision pipeline — paid tiers add depth, symbols, and throughput.
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {PRICING.map((p, i) => (
              <motion.div
                key={p.key}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                className={`panel flex flex-col p-5 ${p.highlight ? "border-primary/60" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-terminal text-xs font-bold tracking-wider">{p.name}</span>
                  {p.highlight && <Badge className="bg-primary font-terminal text-[9px] text-white">MOST POPULAR</Badge>}
                </div>
                <div className="mt-3 font-terminal text-3xl font-bold tabular">
                  {p.price}
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">{p.cadence}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">{p.blurb}</div>
                <ul className="mt-4 flex-1 space-y-2">
                  {p.features.map((f, j) => (
                    <li key={j} className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                      <Check className="mt-0.5 size-3.5 shrink-0 text-success" /> {f}
                    </li>
                  ))}
                </ul>
                <Link to={`/auth?returnTo=${encodeURIComponent(p.key === "free" ? "/dashboard" : "/dashboard/billing")}`} className="mt-5">
                  <Button
                    className="w-full font-terminal text-[11px]"
                    variant={p.highlight ? "default" : "outline"}
                  >
                    {p.cta}
                  </Button>
                </Link>
              </motion.div>
            ))}
          </div>
          <p className="mt-4 font-terminal text-[10px] text-muted-foreground">
            No trading decision is guaranteed. Decision confidence reflects agreement and evidence quality, not outcome.
          </p>
        </div>
      </section>

      {/* Final CTA — compact */}
      <section className="border-b border-border py-14">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-4 md:flex-row md:items-center">
          <div>
            <h2 className="font-terminal text-xl font-bold tracking-tight md:text-2xl">
              Stop guessing. <span className="text-primary">Start examining.</span>
            </h2>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Free tier, no card, full pipeline. See exactly what ARISE would do — and exactly why.
            </p>
          </div>
          <Link to="/auth?returnTo=%2Fdashboard" className="shrink-0">
            <Button size="lg" className="gap-2 font-terminal">
              OPEN THE TERMINAL <ArrowRight className="size-4" />
            </Button>
          </Link>
        </div>
      </section>

      <footer className="py-6">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 font-terminal text-[10px] text-muted-foreground sm:flex-row">
          <span>ARISE — MULTI-AI QUANTITATIVE & ALGORITHMIC TRADING SYSTEM</span>
          <span>PAPER TRADING ONLY · NO INVESTMENT ADVICE · LIVE EXECUTION DISABLED</span>
        </div>
      </footer>
    </div>
  );
}
