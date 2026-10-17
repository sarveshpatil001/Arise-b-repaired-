import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Activity,
  Brain,
  BrainCircuit,
  CreditCard,
  FlaskConical,
  Home,
  LineChart,
  LogOut,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { StatusChip } from "@/components/arise/shared";
import logo from "@/assets/logo.svg";

const PRIMARY_NAV = [
  { to: "/dashboard", label: "HOME", icon: Home },
  { to: "/dashboard/bots", label: "BOT LAB", icon: FlaskConical },
  { to: "/dashboard/markets", label: "MARKETS", icon: LineChart },
  { to: "/dashboard/intelligence", label: "INTELLIGENCE", icon: Brain },
  { to: "/dashboard/analysis", label: "ANALYSIS", icon: BrainCircuit },
  { to: "/dashboard/trades", label: "TRADES", icon: TrendingUp },
  { to: "/dashboard/risk", label: "RISK", icon: ShieldAlert },
  { to: "/dashboard/billing", label: "BILLING", icon: CreditCard },
  { to: "/dashboard/system", label: "SYSTEM", icon: Activity },
];

export function Terminal({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [clock, setClock] = useState(utcClock());
  const isAdmin = (user as { role?: string } | null | undefined)?.role === "admin";

  useEffect(() => {
    const id = setInterval(() => setClock(utcClock()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-44 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-12 items-center gap-2 border-b border-sidebar-border px-4">
          <img src={logo} alt="" className="size-6" />
          <div className="leading-none">
            <div className="font-terminal text-sm font-bold tracking-[0.28em] text-foreground">ARISE</div>
            <div className="font-terminal text-[7px] tracking-[0.16em] text-muted-foreground">
              BOT TRAINING SYSTEM
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 px-3 py-2 font-terminal text-[11px] font-medium tracking-wider transition-colors",
                  isActive
                    ? "bg-primary/15 text-primary border-l-2 border-primary"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground border-l-2 border-transparent",
                )
              }
            >
              <item.icon className="size-3.5" />
              {item.label}
            </NavLink>
          ))}

          {/* Administrative area — separated from the trading workflow */}
          {isAdmin && (
            <>
              <div className="px-3 pb-1 pt-4 font-terminal text-[8px] tracking-[0.2em] text-muted-foreground/70">
                ADMINISTRATION
              </div>
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 px-3 py-2 font-terminal text-[11px] font-medium tracking-wider transition-colors",
                    isActive
                      ? "bg-warning/10 text-warning border-l-2 border-warning"
                      : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground border-l-2 border-transparent",
                  )
                }
              >
                <ShieldAlert className="size-3.5" />
                ADMIN
              </NavLink>
            </>
          )}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <div className="mb-2 truncate text-[11px] text-muted-foreground">
            {user?.email ?? "guest session"}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 font-terminal text-[10px]"
            onClick={async () => {
              await signOut();
              navigate("/");
            }}
          >
            <LogOut className="size-3" /> SIGN OUT
          </Button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-44">
        {/* Top bar: environment state first — impossible to misread */}
        <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-border bg-background/95 px-3 backdrop-blur">
          <div className="flex items-center gap-2 md:hidden">
            <img src={logo} alt="" className="size-5" />
            <span className="font-terminal text-sm font-bold tracking-[0.25em]">ARISE</span>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <StatusChip state="PAPER" />
            <span className="font-terminal text-[10px] text-muted-foreground">
              LIVE EXECUTION: DISABLED
            </span>
          </div>
          <div className="flex items-center gap-3 font-terminal text-[11px] text-muted-foreground">
            <span className="tabular">{clock} UTC</span>
            <span className="size-1.5 rounded-full bg-success pulse-dot" />
          </div>
        </header>

        {/* Mobile nav */}
        <nav className="flex gap-1 overflow-x-auto border-b border-border bg-sidebar px-2 py-1.5 md:hidden">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "whitespace-nowrap px-3 py-1.5 font-terminal text-[10px] tracking-wider",
                  isActive ? "bg-primary/15 text-primary" : "text-muted-foreground",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
          {isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                cn(
                  "whitespace-nowrap px-3 py-1.5 font-terminal text-[10px] tracking-wider",
                  isActive ? "bg-warning/10 text-warning" : "text-muted-foreground",
                )
              }
            >
              ADMIN
            </NavLink>
          )}
        </nav>

        <main className="flex-1 p-3 md:p-4">{children}</main>
      </div>
    </div>
  );
}

function utcClock(): string {
  return new Date().toISOString().slice(11, 19);
}
