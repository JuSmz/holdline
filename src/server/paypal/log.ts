import { getDb } from "@/db/client";
import { paypalApiLog } from "@/db/schema";

import type { ApiLogEntry } from "./client";

/** Writes an API log row without blocking or ever failing the PayPal call. */
export function dbApiLogger(entry: ApiLogEntry): void {
  void getDb()
    .insert(paypalApiLog)
    .values(entry)
    .catch((error: unknown) => {
      console.error(`[holdline] paypal_api_log insert failed: ${(error as Error).message}`);
    });
}
