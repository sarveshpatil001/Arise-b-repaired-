// ARISE V1 — Convex scheduled functions.
// The background position monitor runs every 2 minutes, independent of any
// user interaction. It only touches PAPER positions (live trading stays off).
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "position-monitor",
  { minutes: 2 },
  internal.arise.monitor.guardedTick,
);

export default crons;
