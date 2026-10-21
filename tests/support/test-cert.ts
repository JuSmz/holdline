import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { signedMessage, type WebhookHeaders } from "@/server/paypal/webhooks";

/**
 * Generates a throwaway RSA key + self-signed cert with openssl at test time.
 * Nothing is committed to the repo (a committed private key would trip the secret scan).
 */
export function makeTestCert(days = 2): { certPem: string; keyPem: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "holdline-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
        "-days",
        String(days),
        "-subj",
        "/CN=messageverificationcerts.sandbox.paypal.com",
      ],
      { stdio: "ignore" },
    );
    return {
      certPem: readFileSync(path.join(dir, "cert.pem"), "utf8"),
      keyPem: readFileSync(path.join(dir, "key.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-test";

export function signWebhook(
  keyPem: string,
  body: Uint8Array,
  webhookId: string,
  overrides: Partial<WebhookHeaders> = {},
) {
  const headers: WebhookHeaders = {
    transmissionId: "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
    transmissionTime: "2026-10-21T18:00:00Z",
    certUrl: CERT_URL,
    authAlgo: "SHA256withRSA",
    transmissionSig: "",
    ...overrides,
  };
  const signer = createSign("sha256");
  signer.update(signedMessage(headers, webhookId, body));
  headers.transmissionSig = overrides.transmissionSig ?? signer.sign(keyPem, "base64");
  return headers;
}

export function headersToRequestInit(h: WebhookHeaders): Record<string, string> {
  return {
    "paypal-transmission-id": h.transmissionId,
    "paypal-transmission-time": h.transmissionTime,
    "paypal-transmission-sig": h.transmissionSig,
    "paypal-cert-url": h.certUrl,
    "paypal-auth-algo": h.authAlgo,
    "content-type": "application/json",
  };
}
