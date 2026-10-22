import { expect, test } from "@playwright/test";

// The dev server compiles each route on first request and reloads open pages while it does: compile the
// pages of the flow before the browser uses them, so clicks don't race a reload.
test.beforeAll(async ({ request }) => {
  for (const path of ["/", "/try", "/try/chat", "/dashboard", "/api/health"]) await request.get(path);
});

/**
 * The whole demo in mock mode (fake PayPal, fake Gemini): start a demo copy, chat to a booking, approve
 * the hold in the pay panel, see the agent's confirmation, then finish the job as the owner and watch
 * the money move to "Paid out" without reloading.
 */
test("chat happy path: booking → hold approved → agent confirms → owner charges → paid out", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try the live demo" }).first().click();
  await page.getByRole("button", { name: "Start the demo" }).click();
  await expect(page.getByTestId("demo-badge")).toContainText("Your private demo copy");

  // Step 1: the chat starts with the first message (no form).
  await page.getByRole("link", { name: /Start chatting/ }).click();
  await expect(page.getByText(/^Hi Sam!/)).toBeVisible();
  await page.getByRole("button", { name: "My kitchen drain is blocked" }).click();
  await expect(page.getByText(/Drain cleaning is \$149\.00\. The next times are/)).toBeVisible();
  await page.getByRole("button", { name: /CT$/ }).first().click();

  // Step 2: the pay panel shows the DB price and the sandbox buyer.
  const panel = page.getByRole("region", { name: "Approve the PayPal hold" });
  await expect(panel).toContainText("$149.00");
  await expect(panel).toContainText("buyer-e2e@personal.example.com");
  await panel.getByRole("button", { name: "Approve with PayPal (sandbox)" }).click();
  await expect(page.getByRole("region", { name: "Hold approved" })).toBeVisible();
  await expect(page.getByText(/^Got it — PayPal confirmed the \$149 hold\./)).toBeVisible();

  // The agent answers from the database, not from the chat's own claims.
  await page.getByLabel("Message").fill("Did the payment go through?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/^Yes — PayPal confirmed the hold/)).toBeVisible();

  // Step 3: one primary action leads to the owner, and one charges the job.
  await page.getByRole("link", { name: /See it as the owner/ }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.getByRole("button", { name: "Job done" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("$149.00");
  await dialog.getByRole("button", { name: "Charge $149.00" }).click();

  // The payout goes out right after the capture; the open booking sheet updates itself.
  await expect(page.getByTestId("sheet-status")).toContainText("Paid out", { timeout: 20_000 });
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Bookings" }).click();
  const row = page.locator("[data-testid^='booking-HL-']").filter({ hasNotText: "Sample" }).first();
  await expect(row.getByTestId("status")).toHaveText(/Paid out/);

  await page.getByRole("tab", { name: "Outbox" }).click();
  await expect(page.getByText("Approve your appointment hold")).toBeVisible();
});
