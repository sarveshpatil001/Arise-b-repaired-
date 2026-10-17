/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as arise_admin from "../arise/admin.js";
import type * as arise_analysis from "../arise/analysis.js";
import type * as arise_backtest from "../arise/backtest.js";
import type * as arise_billing from "../arise/billing.js";
import type * as arise_billingFunctions from "../arise/billingFunctions.js";
import type * as arise_charts from "../arise/charts.js";
import type * as arise_decisions from "../arise/decisions.js";
import type * as arise_delta from "../arise/delta.js";
import type * as arise_equity from "../arise/equity.js";
import type * as arise_learning from "../arise/learning.js";
import type * as arise_market from "../arise/market.js";
import type * as arise_monitor from "../arise/monitor.js";
import type * as arise_news from "../arise/news.js";
import type * as arise_system from "../arise/system.js";
import type * as arise_trading from "../arise/trading.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_authz from "../lib/authz.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "arise/admin": typeof arise_admin;
  "arise/analysis": typeof arise_analysis;
  "arise/backtest": typeof arise_backtest;
  "arise/billing": typeof arise_billing;
  "arise/billingFunctions": typeof arise_billingFunctions;
  "arise/charts": typeof arise_charts;
  "arise/decisions": typeof arise_decisions;
  "arise/delta": typeof arise_delta;
  "arise/equity": typeof arise_equity;
  "arise/learning": typeof arise_learning;
  "arise/market": typeof arise_market;
  "arise/monitor": typeof arise_monitor;
  "arise/news": typeof arise_news;
  "arise/system": typeof arise_system;
  "arise/trading": typeof arise_trading;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  crons: typeof crons;
  http: typeof http;
  "lib/authz": typeof lib_authz;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
