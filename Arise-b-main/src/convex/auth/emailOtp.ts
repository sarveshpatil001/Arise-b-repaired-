import { Email } from "@convex-dev/auth/providers/Email";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

/** freebuff's dedicated OTP mailer. Enabled by setting EMAIL_OTP_API_KEY. */
const OTP_SERVICE_URL = "https://auth.freebuff.app/send_otp";

/**
 * Vly email gateway — the same REST endpoint `@vly-ai/integrations` uses.
 * It authenticates with the deployment's provisioned VLY_INTEGRATION_KEY, so
 * it works without any extra secret. Used as the fallback transport so email
 * sign-in keeps working before a dedicated OTP mailer key is added.
 */
const EMAIL_GATEWAY_URL = "https://integrations.vly.ai/v1/email/send";
const EMAIL_GATEWAY_FROM = "noreply@project.freebuff.dev";

const REQUEST_TIMEOUT_MS = 15_000;
const CODE_TTL_MINUTES = 15;

function appName(): string {
  return process.env.VLY_APP_NAME || "a freebuff.com application";
}

function buildCodeEmail(name: string, code: string) {
  const text = `Your ${name} sign-in code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`;
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#11161d;border:1px solid #1f2937;border-radius:10px">
      <tr>
        <td style="padding:28px 28px 4px">
          <p style="margin:0;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#8b98a5">${name}</p>
          <h1 style="margin:14px 0 0;font-size:18px;font-weight:600;color:#e6edf3">Your sign-in code</h1>
          <p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#8b98a5">Enter this code to finish signing in. It expires in ${CODE_TTL_MINUTES} minutes.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 28px">
          <div style="font-size:32px;font-weight:700;letter-spacing:.38em;text-align:center;color:#2e7cf6;background:#0d1117;border:1px solid #1f2937;border-radius:8px;padding:16px 18px">${code}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:0 28px 28px">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#5b6774">If you didn't request this code you can safely ignore this email.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { html, text };
}

/** POST JSON and throw an error that names the failing host and its response,
 *  so an OTP delivery problem is never reported as an opaque failure. */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<void> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to send verification email: ${host} is unreachable (${detail}).`);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(
      `Failed to send verification email: ${host} rejected the request ` +
        `(HTTP ${response.status}): ${detail || response.statusText}`,
    );
  }
}

async function sendWithOtpService(to: string, code: string, apiKey: string) {
  await postJson(
    OTP_SERVICE_URL,
    { "x-api-key": apiKey },
    { to, otp: code, appName: appName() },
  );
}

async function sendWithEmailGateway(
  to: string,
  code: string,
  deploymentToken: string,
) {
  const name = appName();
  await postJson(
    EMAIL_GATEWAY_URL,
    {
      authorization: `Bearer ${deploymentToken}`,
      "x-vly-version": "0.1.0",
    },
    {
      to: [to],
      from: EMAIL_GATEWAY_FROM,
      subject: `${code} is your ${name} sign-in code`,
      ...buildCodeEmail(name, code),
    },
  );
}

export const emailOtp = Email({
  id: "email-otp",
  maxAge: 60 * CODE_TTL_MINUTES,
  // This function can be asynchronous
  async generateVerificationToken() {
    const random: RandomReader = {
      read(bytes: Uint8Array) {
        crypto.getRandomValues(bytes);
      },
    };
    const alphabet = "0123456789";
    return generateRandomString(random, alphabet, 6);
  },
  async sendVerificationRequest({ identifier: email, token }) {
    const otpServiceKey = process.env.EMAIL_OTP_API_KEY;
    if (otpServiceKey) {
      await sendWithOtpService(email, token, otpServiceKey);
      return;
    }

    // No dedicated OTP key yet — fall back to the provisioned email
    // integration so sign-in still works.
    const deploymentToken = process.env.VLY_INTEGRATION_KEY;
    if (!deploymentToken) {
      throw new Error(
        "Failed to send verification email: no email transport is configured. " +
          "Add EMAIL_OTP_API_KEY (freebuff OTP mailer) or VLY_INTEGRATION_KEY " +
          "(email integration) in the project's Keys tab.",
      );
    }
    await sendWithEmailGateway(email, token, deploymentToken);
  },
});
