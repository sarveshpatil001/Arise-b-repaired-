// ARISE V1 — controlled learning & improvement panel (mandate §6.L, §10).
//
// What this panel is for: showing an operator exactly where the learning layer
// stands — what was proposed, what was REFUSED and by which rule, and which
// transitions are still reachable. A proposal is never presented as a change:
// only a row whose status is APPLIED has altered system state.
//
// The mutation surface is operator/admin only and enforces the rules server-side
// (forbidden targets, safety-limit direction, privileged approval, and a completed
// *passing* evaluation before APPLIED). This component can only ask; it cannot
// authorize. Nothing here decides policy.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, StatTile } from "./shared";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { Lock, RotateCcw, ShieldAlert } from "lucide-react";

/** Statuses are the learning state machine, not trading states — kept local so the
 *  shared system-state vocabulary is not stretched to cover them. */
const STATUS_TONE: Record<string, string> = {
  PROPOSED: "border-primary/40 bg-primary/10 text-primary",
  EVALUATING: "border-warning/40 bg-warning/10 text-warning",
  APPROVED: "border-primary/40 bg-primary/10 text-primary",
  APPLIED: "border-success/40 bg-success/10 text-success",
  REJECTED: "border-danger/40 bg-danger/10 text-danger",
  ROLLED_BACK: "border-border text-muted-foreground",
};

const STATUS_ORDER = [
  "PROPOSED",
  "EVALUATING",
  "APPROVED",
  "APPLIED",
  "REJECTED",
  "ROLLED_BACK",
] as const;

/** Reachable next states, mirroring TRANSITIONS in src/lib/arise/learning.ts. The
 *  server is the authority; this only avoids offering impossible buttons. */
const NEXT_STATES: Record<string, ("EVALUATING" | "APPROVED" | "REJECTED" | "APPLIED")[]> = {
  PROPOSED: ["EVALUATING", "REJECTED"],
  EVALUATING: ["APPROVED", "REJECTED"],
  APPROVED: ["APPLIED", "REJECTED"],
  APPLIED: [],
  REJECTED: [],
  ROLLED_BACK: [],
};

const MAX_ROWS = 20;

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function fmtUtc(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(5, 16);
}

interface ProposalRow {
  proposalId: string;
  createdAt: number;
  at: number;
  trigger: string;
  target: string;
  currentValue: unknown;
  proposedValue: unknown;
  previousValue: unknown;
  rationale: string;
  evidence: string[];
  expectedEffect: string;
  riskOfChange: string;
  evaluationPlan: string;
  status: string;
  violations: { code: string; detail: string }[];
  decidedBy: string | null;
  appliedAt: number | null;
  rolledBackAt: number | null;
  evaluation: { completedAt?: number; passed?: boolean; reference?: string } | null;
}

export function LearningPanel() {
  const { user } = useAuth();
  const role = (user as { role?: string } | null | undefined)?.role;
  // The server requires operator|admin for every learning query/mutation. Skip the
  // subscription for anyone else rather than firing a call that would throw.
  const privileged = role === "admin" || role === "operator";

  const data = useQuery(api.arise.learning.list, privileged ? { limit: MAX_ROWS } : "skip");
  const advance = useMutation(api.arise.learning.advance);
  const rollback = useMutation(api.arise.learning.rollback);

  const [busy, setBusy] = useState<string | null>(null);
  // Per-proposal evaluation evidence, required before APPLIED may be requested.
  const [evalRef, setEvalRef] = useState<Record<string, string>>({});
  const [evalPassed, setEvalPassed] = useState<Record<string, boolean>>({});

  // Hooks above, early return below — never the other way round.
  if (!privileged) {
    return (
      <Panel title="LEARNING & IMPROVEMENT">
        <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
          <Lock className="size-3.5" />
          <span>
            Controlled-learning proposals are an operational control plane. An
            operator or administrator session is required to read them.
          </span>
        </div>
      </Panel>
    );
  }

  const proposals = (data?.proposals ?? []) as unknown as ProposalRow[];
  const summary = data?.summary;

  async function run(
    proposalId: string,
    next: "EVALUATING" | "APPROVED" | "REJECTED" | "APPLIED",
  ) {
    setBusy(proposalId);
    try {
      let evaluation: { passed?: boolean; reference?: string } | undefined;
      if (next === "APPLIED") {
        const reference = (evalRef[proposalId] ?? "").trim();
        if (reference.length === 0 || evalPassed[proposalId] !== true) {
          toast.error(
            "An applied change needs a completed, passing evaluation: give its reference and confirm the result.",
          );
          return;
        }
        // No client timestamp: the server stamps `completedAt` when it records the
        // confirmation, so an operator cannot backdate an evaluation.
        evaluation = { passed: true, reference };
      }
      const res = await advance({ proposalId, next, evaluation });
      if (res.ok) {
        toast.success(`${proposalId} → ${res.status}`);
      } else {
        toast.error(`Refused: ${res.violations.join(", ") || "policy violation"}`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onRollback(proposalId: string) {
    setBusy(proposalId);
    try {
      const res = await rollback({ proposalId });
      if (res.ok) toast.success(`${proposalId} → ${res.status}`);
      else toast.error(`Refused: ${res.violations.join(", ") || "policy violation"}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="LEARNING & IMPROVEMENT — PROPOSALS"
      right={
        <Badge variant="outline" className="font-terminal text-[9px]">
          {data?.total ?? 0} RECORDED
        </Badge>
      }
    >
      {data === undefined ? (
        <div className="py-4 text-center font-terminal text-[11px] text-muted-foreground">
          LOADING…
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
            {STATUS_ORDER.map((s) => (
              <StatTile
                key={s}
                label={s}
                value={String(summary?.counts?.[s] ?? 0)}
                tone={
                  s === "APPLIED"
                    ? "up"
                    : s === "REJECTED"
                      ? "down"
                      : s === "EVALUATING"
                        ? "neutral"
                        : undefined
                }
              />
            ))}
          </div>

          <p className="border-t border-border pt-2 font-terminal text-[9px] text-muted-foreground">
            A PROPOSAL IS NOT A CHANGE. Only an APPLIED row has altered system state, and
            reaching APPLIED requires a privileged actor plus a completed, passing
            evaluation. Risk limits, execution mode, security policy and secrets can never
            be proposed at all — refused attempts are recorded below rather than dropped.
          </p>

          {proposals.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No learning proposal has been recorded. Proposals appear here when the system
              derives one from measured evidence (a paper result, a calibration miss, a
              backtest-versus-forward divergence) — and each one must be evaluated and
              approved by a human before it can take effect.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-terminal text-[11px]">
                <thead>
                  <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                    <th className="py-1.5 pr-3">ID / TIME</th>
                    <th className="py-1.5 pr-3">STATUS</th>
                    <th className="py-1.5 pr-3">TARGET</th>
                    <th className="py-1.5 pr-3">CHANGE</th>
                    <th className="py-1.5 pr-3">TRIGGER</th>
                    <th className="py-1.5">ACTION / REFUSAL</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((p) => {
                    const nextStates = NEXT_STATES[p.status] ?? [];
                    const isBusy = busy === p.proposalId;
                    return (
                      <tr key={p.proposalId} className="border-b border-border/40 align-top">
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          <div className="font-semibold text-foreground">{p.proposalId}</div>
                          <div>{fmtUtc(p.at)}</div>
                        </td>
                        <td className="py-1.5 pr-3">
                          <Badge
                            variant="outline"
                            className={cn(
                              "font-terminal text-[9px]",
                              STATUS_TONE[p.status] ?? STATUS_TONE.ROLLED_BACK,
                            )}
                          >
                            {p.status}
                          </Badge>
                          {p.appliedAt ? (
                            <div className="mt-1 text-[9px] text-success">
                              applied {fmtUtc(p.appliedAt)}
                            </div>
                          ) : null}
                          {p.rolledBackAt ? (
                            <div className="mt-1 text-[9px] text-muted-foreground">
                              rolled back {fmtUtc(p.rolledBackAt)}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-3">{p.target}</td>
                        <td className="py-1.5 pr-3">
                          <span className="text-muted-foreground">{fmtValue(p.currentValue)}</span>
                          <span className="px-1 text-muted-foreground">→</span>
                          <span className="font-semibold">{fmtValue(p.proposedValue)}</span>
                          {p.status === "APPLIED" || p.status === "ROLLED_BACK" ? (
                            <div className="text-[9px] text-muted-foreground">
                              in force before: {fmtValue(p.previousValue)}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-3 text-[10px] text-muted-foreground">
                          {p.trigger}
                        </td>
                        <td className="py-1.5">
                          {p.violations.length > 0 ? (
                            <div className="mb-1.5 space-y-0.5">
                              {p.violations.map((v) => (
                                <div
                                  key={v.code}
                                  className="flex items-start gap-1 text-[9px] text-danger"
                                  title={v.detail}
                                >
                                  <ShieldAlert className="mt-0.5 size-3 shrink-0" />
                                  <span className="font-semibold">{v.code}</span>
                                </div>
                              ))}
                            </div>
                          ) : null}

                          {nextStates.includes("APPLIED") ? (
                            <div className="mb-1.5 space-y-1">
                              <Input
                                value={evalRef[p.proposalId] ?? ""}
                                onChange={(e) =>
                                  setEvalRef((prev) => ({
                                    ...prev,
                                    [p.proposalId]: e.target.value,
                                  }))
                                }
                                placeholder="evaluation reference"
                                className="h-7 font-terminal text-[10px]"
                              />
                              <label className="flex items-center gap-1 text-[9px] text-muted-foreground">
                                <input
                                  type="checkbox"
                                  checked={evalPassed[p.proposalId] === true}
                                  onChange={(e) =>
                                    setEvalPassed((prev) => ({
                                      ...prev,
                                      [p.proposalId]: e.target.checked,
                                    }))
                                  }
                                />
                                isolated evaluation completed AND passed
                              </label>
                            </div>
                          ) : null}

                          <div className="flex flex-wrap gap-1">
                            {nextStates
                              .filter((n) => n !== "APPLIED")
                              .map((n) => (
                                <Button
                                  key={n}
                                  size="sm"
                                  variant="outline"
                                  disabled={isBusy}
                                  onClick={() => run(p.proposalId, n)}
                                  className={cn(
                                    "h-6 font-terminal text-[9px]",
                                    n === "REJECTED" && "border-danger/40 text-danger",
                                  )}
                                >
                                  {n}
                                </Button>
                              ))}
                            {nextStates.includes("APPLIED") ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isBusy}
                                onClick={() => run(p.proposalId, "APPLIED")}
                                className="h-6 border-success/40 font-terminal text-[9px] text-success"
                              >
                                APPLIED
                              </Button>
                            ) : null}
                            {p.status === "APPLIED" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isBusy}
                                onClick={() => onRollback(p.proposalId)}
                                className="h-6 gap-1 font-terminal text-[9px]"
                              >
                                <RotateCcw className="size-3" /> ROLLBACK
                              </Button>
                            ) : null}
                            {nextStates.length === 0 && p.status !== "APPLIED" ? (
                              <span className="font-terminal text-[9px] text-muted-foreground">
                                terminal — no further transition
                              </span>
                            ) : null}
                          </div>

                          {p.evaluation?.reference ? (
                            <div className="mt-1 text-[9px] text-muted-foreground">
                              evaluation: {p.evaluation.reference}
                              {p.evaluation.passed === false ? " (failed)" : ""}
                            </div>
                          ) : null}
                          {p.decidedBy ? (
                            <div className="mt-1 text-[9px] text-muted-foreground">
                              decided by {p.decidedBy}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {(summary?.rejected ?? []).length > 0 ? (
            <div className="border-t border-border pt-2">
              <div className="panel-title text-[9px]">REFUSED CHANGES</div>
              <ul className="mt-1 space-y-0.5">
                {(summary?.rejected ?? []).map((r) => (
                  <li key={r.id} className="font-terminal text-[10px] text-muted-foreground">
                    <span className="text-danger">{r.violations.join(", ")}</span>
                    {" — "}
                    {r.target} ({r.id})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
