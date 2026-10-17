import { cn } from "@/lib/utils";

export function Panel({ title, right, children, className }: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel", className)}>
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="panel-title">{title}</h2>
        {right}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function StatTile({ label, value, sub, tone }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "up" | "down" | "neutral" | "primary";
}) {
  return (
    <div className="panel px-3 py-2.5">
      <div className="panel-title text-[9px]">{label}</div>
      <div
        className={cn(
          "mt-1 font-terminal text-lg font-bold tabular leading-none",
          tone === "up" && "text-success",
          tone === "down" && "text-danger",
          tone === "primary" && "text-primary",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-1 text-[10px] text-muted-foreground tabular">{sub}</div> : null}
    </div>
  );
}

const TONE_CLASS: Record<string, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  primary: "bg-primary",
  muted: "bg-muted-foreground",
};

export function StatusDot({ tone = "muted", pulse }: { tone?: keyof typeof TONE_CLASS; pulse?: boolean }) {
  return (
    <span
      className={cn("inline-block size-2 rounded-full", TONE_CLASS[tone], pulse && "pulse-dot")}
    />
  );
}

export function ConfidenceBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const tone = pct >= 70 ? "bg-success" : pct >= 45 ? "bg-warning" : "bg-muted-foreground";
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1 flex-1 overflow-hidden rounded-sm bg-secondary">
        <div className={cn("h-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-terminal text-[10px] tabular text-muted-foreground">{pct}%</span>
    </div>
  );
}

const SIGNAL_TONE: Record<string, string> = {
  LONG: "text-success border-success/40 bg-success/10",
  SHORT: "text-danger border-danger/40 bg-danger/10",
  NEUTRAL: "text-muted-foreground border-border bg-secondary",
  RISK_FLAG: "text-danger border-danger/40 bg-danger/10",
  CAUTION: "text-warning border-warning/40 bg-warning/10",
  BUY: "text-success border-success/40 bg-success/10",
  SELL: "text-danger border-danger/40 bg-danger/10",
  WAIT: "text-warning border-warning/40 bg-warning/10",
  PASS: "text-success border-success/40 bg-success/10",
  VETO: "text-danger border-danger/40 bg-danger/10",
};

export function SignalChip({ signal, className }: { signal: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center border px-1.5 py-0.5 font-terminal text-[10px] font-semibold tracking-wider",
        SIGNAL_TONE[signal] ?? SIGNAL_TONE.NEUTRAL,
        className,
      )}
    >
      {signal}
    </span>
  );
}

// Standardized system states — one vocabulary across every screen.
export type SystemState =
  | "ONLINE" | "DEGRADED" | "OFFLINE"
  | "HEALTHY" | "WARNING" | "ERROR"
  | "STALE" | "BLOCKED"
  | "PASS" | "VETO"
  | "READY" | "RUNNING" | "COMPLETED"
  | "LIVE" | "DELAYED" | "HALTED"
  | "PAPER";

const STATE_TONE: Record<SystemState, string> = {
  ONLINE: "text-success border-success/40 bg-success/10",
  HEALTHY: "text-success border-success/40 bg-success/10",
  PASS: "text-success border-success/40 bg-success/10",
  READY: "text-success border-success/40 bg-success/10",
  RUNNING: "text-success border-success/40 bg-success/10",
  LIVE: "text-success border-success/40 bg-success/10",
  COMPLETED: "text-success border-success/40 bg-success/10",
  DEGRADED: "text-warning border-warning/40 bg-warning/10",
  WARNING: "text-warning border-warning/40 bg-warning/10",
  STALE: "text-warning border-warning/40 bg-warning/10",
  DELAYED: "text-warning border-warning/40 bg-warning/10",
  OFFLINE: "text-danger border-danger/40 bg-danger/10",
  ERROR: "text-danger border-danger/40 bg-danger/10",
  BLOCKED: "text-danger border-danger/40 bg-danger/10",
  VETO: "text-danger border-danger/40 bg-danger/10",
  HALTED: "text-danger border-danger/40 bg-danger/10",
  PAPER: "text-primary border-primary/40 bg-primary/10",
};

export function StatusChip({ state, className }: { state: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border px-1.5 py-0.5 font-terminal text-[10px] font-semibold tracking-wider",
        STATE_TONE[state as SystemState] ?? SIGNAL_TONE.NEUTRAL,
        className,
      )}
    >
      {state}
    </span>
  );
}

export function QualityBadge({ quality }: { quality: string }) {
  const tone =
    quality === "valid" ? "success" : quality === "degraded" ? "warning" : "danger";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border px-1.5 py-0.5 font-terminal text-[9px] tracking-wider",
        tone === "success" && "border-success/40 bg-success/10 text-success",
        tone === "warning" && "border-warning/40 bg-warning/10 text-warning",
        tone === "danger" && "border-danger/40 bg-danger/10 text-danger",
      )}
    >
      DATA: {quality.toUpperCase()}
    </span>
  );
}
