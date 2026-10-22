import { expect, test } from "@playwright/test";

/**
 * The stage-7 done path in mock mode: start a demo copy, chat to a booking, approve the hold in the
 * (fake) PayPal panel, see the agent's confirmation, then finish the job as the owner.
 */
test("chat happy path: booking → hold approved → agent confirms → owner captures", async ({ page }) => {
  await page.goto("/try");
  await page.getByRole("button", { name: "Start the demo" }).click();
  await expect(page.getByTestId("demo-badge")).toContainText("Your private demo copy");

  await page.getByRole("link", { name: /Chat/ }).click();
  await page.getByRole("button", { name: "Start the chat" }).click();
  await expect(page.getByText(/^Hi Sam!/)).toBeVisible();

  await page.getByRole("button", { name: "My kitchen drain is blocked" }).click();
  await expect(page.getByText(/Drain cleaning is \$149\.00\. The next times are/)).toBeVisible();

  // A slot chip (label ends in CT) books it.
  await page.getByRole("button", { name: /CT$/ }).first().click();
  const panel = page.getByRole("region", { name: "Approve the PayPal hold" });
  await expect(panel).toContainText("$149.00 hold");
  await expect(panel).toContainText("buyer-e2e@personal.example.com");

  await panel.getByRole("button", { name: "Approve with PayPal (sandbox mock)" }).click();
  await expect(page.getByText("Hold approved")).toBeVisible();
  await expect(page.getByText(/^Got it — PayPal confirmed the \$149 hold\./)).toBeVisible();

  await page.getByRole("button", { name: "Did the payment go through?" }).click();
  await expect(page.getByText(/^Yes — PayPal confirmed the hold/)).toBeVisible();

  await page.goto("/dashboard");
  const row = page.locator("tr", { hasText: "Drain cleaning" }).filter({ hasNotText: "Sample" }).first();
  await expect(row.getByTestId("status")).toHaveText("authorized");
  page.once("dialog", (dialog) => void dialog.accept());
  await row.getByRole("button", { name: "Job done" }).click();
  await expect(row.getByTestId("status")).toHaveText(/captured|paid_out/);
  await expect(page.getByText(/Approve your appointment hold/)).toBeVisible();
});
