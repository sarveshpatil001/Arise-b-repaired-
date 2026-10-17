// ARISE V1 — email OTP sign-in transport tests.
// Email sign-in previously failed with an opaque error whenever the mailer was
// misconfigured, so these tests pin *which* transport is used for a given
// environment and that a rejected request reports the failing host, the HTTP
// status and the response body instead of a generic message.
//
// Lives outside src/convex/ on purpose: the Convex bundler walks that directory
// and has no test-file exclusion, so a test there could be bundled into the
// deployment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailOtp } from "@/convex/auth/emailOtp";

type ProviderConfig = {
  maxAge: number;
  generateVerificationToken: () => Promise<string>;
  sendVerificationRequest: (params: {
    identifier: string;
    token: string;
  }) => Promise<void>;
};

const config = emailOtp.options as unknown as ProviderConfig;

const OTP_URL = "https://auth.freebuff.app/send_otp";
const GATEWAY_URL = "https://integrations.vly.ai/v1/email/send";

type Call = { url: string; headers: Record<string, string>; body: unknown };

/** Stub the global fetch, recording every call. Rejects when given an Error. */
function stubFetch(response: Response | Error): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    (url: string, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response.clone());
    },
  );
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const send = (overrides: Partial<{ identifier: string; token: string }> = {}) =>
  config.sendVerificationRequest({
    identifier: "trader@example.com",
    token: "123456",
    ...overrides,
  });

const ENV_KEYS = ["EMAIL_OTP_API_KEY", "VLY_INTEGRATION_KEY", "VLY_APP_NAME"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("generateVerificationToken", () => {
  it("returns a 6 digit code", async () => {
    const token = await config.generateVerificationToken();
    expect(token).toMatch(/^\d{6}$/);
  });

  it("keeps a 15 minute lifetime", () => {
    expect(config.maxAge).toBe(15 * 60);
  });
});

describe("sendVerificationRequest", () => {
  it("uses the freebuff OTP mailer when EMAIL_OTP_API_KEY is set", async () => {
    process.env.EMAIL_OTP_API_KEY = "otp-key";
    process.env.VLY_INTEGRATION_KEY = "sk_also_set";
    process.env.VLY_APP_NAME = "ARISE";
    const calls = stubFetch(jsonResponse(200, { ok: true }));

    await send();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OTP_URL);
    expect(calls[0].headers["x-api-key"]).toBe("otp-key");
    expect(calls[0].body).toEqual({
      to: "trader@example.com",
      otp: "123456",
      appName: "ARISE",
    });
  });

  it("falls back to the email gateway when no OTP key is configured", async () => {
    process.env.VLY_INTEGRATION_KEY = "sk_deployment_token";
    const calls = stubFetch(jsonResponse(200, { id: "abc", status: "sent" }));

    await send({ token: "654321" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(GATEWAY_URL);
    expect(calls[0].headers.authorization).toBe("Bearer sk_deployment_token");
    const body = calls[0].body as {
      to: string[];
      from: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(body.to).toEqual(["trader@example.com"]);
    expect(body.from).toBe("noreply@project.freebuff.dev");
    expect(body.subject).toContain("654321");
    expect(body.html).toContain("654321");
    expect(body.text).toContain("654321");
  });

  it("reports which host rejected the request, with its status and body", async () => {
    process.env.EMAIL_OTP_API_KEY = "revoked-key";
    stubFetch(jsonResponse(401, { message: "Unauthorized" }));

    await expect(send()).rejects.toThrow(
      /auth\.freebuff\.app rejected the request \(HTTP 401\): .*Unauthorized/,
    );
  });

  it("reports gateway rejection the same way", async () => {
    process.env.VLY_INTEGRATION_KEY = "sk_bad";
    stubFetch(
      jsonResponse(400, {
        error: "Invalid `to` field. Please use our testing email address.",
      }),
    );

    await expect(send()).rejects.toThrow(
      /integrations\.vly\.ai rejected the request \(HTTP 400\): .*Invalid `to` field/,
    );
  });

  it("reports an unreachable mailer instead of a silent failure", async () => {
    process.env.EMAIL_OTP_API_KEY = "otp-key";
    stubFetch(new Error("getaddrinfo ENOTFOUND auth.freebuff.app"));

    await expect(send()).rejects.toThrow(
      /auth\.freebuff\.app is unreachable \(getaddrinfo ENOTFOUND/,
    );
  });

  it("names both env vars when no transport is configured", async () => {
    stubFetch(jsonResponse(200, {}));

    await expect(send()).rejects.toThrow(
      /EMAIL_OTP_API_KEY[\s\S]*VLY_INTEGRATION_KEY[\s\S]*Keys tab/,
    );
  });
});
