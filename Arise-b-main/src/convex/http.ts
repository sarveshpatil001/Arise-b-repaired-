import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { stripeWebhook } from "./arise/billing";

const http = httpRouter();

auth.addHttpRoutes(http);

// Stripe billing webhook — signature-verified, idempotent, fail-closed.
http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: stripeWebhook,
});

export default http;
