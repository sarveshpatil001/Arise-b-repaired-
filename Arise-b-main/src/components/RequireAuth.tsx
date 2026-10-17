import { useAuth } from "@/hooks/use-auth";
import { authGateView } from "@/lib/authGate";
import { Button } from "@/components/ui/button";
import { Loader2, Unplug } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useConvexConnectionState } from "convex/react";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const location = useLocation();
  const connection = useConvexConnectionState();
  const [loadingElapsedMs, setLoadingElapsedMs] = useState(0);

  // Track how long this gate has been waiting for auth to resolve. The gate
  // needs wall-clock time as a fallback for connection failures that never
  // accumulate retries (slow DNS, offline, etc.). Updates happen on the
  // interval tick only — no synchronous setState in the effect body.
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(
      () => setLoadingElapsedMs(Date.now() - started),
      1000,
    );
    return () => clearInterval(id);
  }, []);

  const view = authGateView({
    isLoading,
    isAuthenticated,
    hasEverConnected: connection.hasEverConnected,
    connectionRetries: connection.connectionRetries,
    loadingElapsedMs,
  });

  if (view === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (view === "backend-unreachable") {
    return <BackendUnreachable elapsedMs={loadingElapsedMs} />;
  }

  if (view === "sign-in-required") {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  return children;
}

/**
 * Fail-closed diagnostic shown instead of an endless spinner when the Convex
 * backend cannot be reached at all (e.g. `VITE_CONVEX_URL` missing or pointing
 * at an unreachable deployment). Nothing behind this gate is rendered.
 */
function BackendUnreachable({ elapsedMs }: { elapsedMs: number }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg border border-warning/40 bg-card">
        <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2.5">
          <Unplug className="size-4 text-warning" />
          <h1 className="font-terminal text-[12px] font-bold tracking-[0.22em] text-warning">
            ARISE BACKEND NOT CONNECTED
          </h1>
        </div>
        <div className="space-y-4 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            The Terminal cannot open: this app has not reached a Convex
            deployment after {Math.round(elapsedMs / 1000)}s.{" "}
            <span className="font-terminal text-[11px] text-foreground">
              VITE_CONVEX_URL
            </span>{" "}
            is missing, or points at a deployment that is unreachable.
          </p>
          <ol className="list-inside list-decimal space-y-1.5 text-sm text-muted-foreground">
            <li>
              Open your Convex project (or create one) and copy its deployment
              URL — it looks like{" "}
              <span className="font-terminal text-[11px] text-foreground">
                https://your-app.convex.cloud
              </span>
              .
            </li>
            <li>
              Set{" "}
              <span className="font-terminal text-[11px] text-foreground">
                VITE_CONVEX_URL
              </span>{" "}
              in Settings → Environment (it is public configuration, not a
              secret).
            </li>
            <li>Restart the preview — the Terminal will open on sign-in.</li>
          </ol>
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="font-terminal text-[10px] tracking-[0.18em] text-muted-foreground">
              LIVE EXECUTION: DISABLED · PAPER ONLY
            </span>
            <Button
              size="sm"
              variant="outline"
              className="font-terminal text-[10px] tracking-wider"
              onClick={() => window.location.reload()}
            >
              RETRY CONNECTION
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
