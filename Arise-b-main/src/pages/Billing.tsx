import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel, StatTile } from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import { useEntitlements, usePlans } from "@/hooks/use-arise";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowUpRight, Check, CreditCard, Settings2 } from "lucide-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router";

export default function Billing() {
  const ents = useEntitlements();
  const plans = usePlans() ?? [];
  const startCheckout = useAction(api.arise.billingFunctions.startCheckout);
  const startPortal = useAction(api.arise.billingFunctions.startPortal);
  const [params] = useSearchParams();

  useEffect(() => {
    if (params.get("checkout") === "success") {
      toast.success("Subscription active — welcome aboard.");
    }
  }, [params]);

  const checkout = async (planKey: string) => {
    try {
      const url = (await startCheckout({ planKey })) as unknown as string;
      window.location.assign(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Checkout failed");
    }
  };

  const portal = async () => {
    try {
      const url = (await startPortal({})) as unknown as string;
      window.location.assign(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open billing portal");
    }
  };

  return (
    <Terminal>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-terminal text-lg font-bold tracking-wider">BILLING & PLAN</h1>
          <Button variant="outline" size="sm" className="gap-1.5 font-terminal text-[11px]" onClick={() => void portal()}>
            <Settings2 className="size-3.5" /> MANAGE BILLING (STRIPE PORTAL)
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="CURRENT PLAN" value={ents?.planName ?? "—"} tone="primary" />
          <StatTile
            label="STATUS"
            // A complimentary (granted) seat is not a Stripe subscription, and the UI
            // must not imply one.
            value={ents?.source === "grant" ? "GRANTED SEAT" : (ents?.status ?? "—").toUpperCase()}
            tone={ents?.active ? "up" : "neutral"}
          />
          <StatTile
            label="ANALYSES TODAY"
            value={ents && ents.remainingToday === -1 ? `${ents.analysesToday} (unlimited)` : `${ents?.analysesToday ?? 0} / ${ents?.analysisLimitPerDay ?? "—"} `}
          />
          <StatTile label="WATCHLIST SLOTS" value={String(ents?.symbolWatchlist ?? "—")} />
        </div>

        <Panel title="PLANS">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {plans.map((p) => {
              const current = ents?.planKey === p.key;
              const isFree = p.priceMonthly === 0;
              return (
                <div
                  key={p.key}
                  className={cn(
                    "panel flex flex-col p-4",
                    p.key === "pro" && "border-primary/50",
                    current && "ring-1 ring-primary/60",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-terminal text-xs font-bold tracking-wider">{p.name}</span>
                    {p.key === "pro" && !current && (
                      <Badge className="bg-primary font-terminal text-[9px] text-white">RECOMMENDED</Badge>
                    )}
                    {current && (
                      <Badge variant="outline" className="border-success/50 font-terminal text-[9px] text-success">
                        CURRENT
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2 font-terminal text-2xl font-bold tabular">
                    {isFree ? "$0" : `$${(p.priceMonthly / 100).toFixed(0)}`}
                    <span className="text-[10px] font-normal text-muted-foreground"> / month</span>
                  </div>
                  <ul className="mt-3 flex-1 space-y-1.5">
                    {p.features.map((f, i) => (
                      <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-muted-foreground">
                        <Check className="mt-0.5 size-3 shrink-0 text-success" /> {f}
                      </li>
                    ))}
                  </ul>
                  <Button
                    className="mt-4 w-full gap-1.5 font-terminal text-[11px]"
                    variant={current ? "outline" : p.key === "pro" ? "default" : "secondary"}
                    disabled={current || isFree}
                    onClick={() => void checkout(p.key)}
                  >
                    {current ? "ACTIVE" : isFree ? "INCLUDED" : (
                      <>
                        UPGRADE <ArrowUpRight className="size-3" />
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="mt-3 border-t border-border pt-2 font-terminal text-[9px] leading-relaxed text-muted-foreground">
            Billing is processed by Stripe. Subscriptions are confirmed by signed Stripe webhooks —
            the application never grants a plan on the basis of an unverified client message.
            Paper trading only: ARISE never connects to brokerage accounts and never holds client funds.
          </p>
        </Panel>

        {!ents?.active && (
          <div className="panel flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
            <CreditCard className="mt-0.5 size-4 shrink-0 text-primary" />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-terminal text-foreground">STARTER (FREE) —</span> five analyses a day,
              one watchlist symbol, and the complete decision pipeline: six agents, MIND debate,
              deterministic risk veto, and paper execution. No card required. Upgrade whenever the
              terminal has earned it.
            </p>
          </div>
        )}
      </div>
    </Terminal>
  );
}
