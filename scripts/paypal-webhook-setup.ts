/**
 * Registers (or updates) the Holdline webhook in the PayPal sandbox REST app — idempotent.
 * Usage: pnpm paypal:webhook:setup https://holdline-web.onrender.com
 * Prints PAYPAL_WEBHOOK_ID (an ID, not a secret) for .env and the Render dashboard.
 */
import { closeDb } from "../src/db/client";
import { getPayPalClient } from "../src/server/paypal";
import { SUBSCRIBED_EVENTS } from "../src/server/paypal/webhook-events";

type Webhook = { id: string; url: string; event_types: { name: string }[] };

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error("usage: pnpm paypal:webhook:setup https://<your-app-host> (the exact public host)");
  const base = arg.replace(/\/+$/, "");
  if (!base.startsWith("https://")) throw new Error(`PayPal requires an https webhook URL (got ${base})`);
  const url = `${base}/api/paypal/webhook`;
  const client = getPayPalClient();

  const { webhooks } = await client.get<{ webhooks: Webhook[] }>("/v1/notifications/webhooks", { op: "webhooks.list" });
  const existing = webhooks.find((w) => w.url === url);
  const wanted = SUBSCRIBED_EVENTS.map((name) => ({ name }));

  if (existing) {
    const have = new Set(existing.event_types.map((e) => e.name));
    const same = have.size === wanted.length && wanted.every((e) => have.has(e.name));
    if (!same) {
      await client.patch(
        `/v1/notifications/webhooks/${existing.id}`,
        [{ op: "replace", path: "/event_types", value: wanted }],
        { op: "webhooks.update" },
      );
      console.log(`updated event types of webhook ${existing.id}`);
    } else {
      console.log(`webhook already registered with all ${wanted.length} events`);
    }
    console.log(`PAYPAL_WEBHOOK_ID=${existing.id}`);
    return;
  }

  const { data } = await client.post<Webhook>(
    "/v1/notifications/webhooks",
    { url, event_types: wanted },
    { op: "webhooks.create", requestId: client.requestId("webhook-create", String(Date.now())) },
  );
  console.log(`created webhook for ${url}`);
  console.log(`PAYPAL_WEBHOOK_ID=${data?.id}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  // The API log writes through the DB pool; close it so the script exits.
  .finally(() => closeDb());
