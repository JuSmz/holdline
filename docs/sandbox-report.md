# PayPal sandbox report

What we actually observed against the PayPal **sandbox**. It answers the open risks R1–R3 and R10 from SPEC §27 and holds no secrets. Every row links to a `paypal_api_log` entry or a lab result by its PayPal ID and `debug_id`.

> Status: **template.** It gets filled in during the stage-2/3 sandbox runs.

## Setup

| Item                     | Value                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox business account | US, USD balance (address/country checked in the dashboard)                                                                                                                                                                                              |
| REST app                 | Type _Merchant_, linked to the US business account                                                                                                                                                                                                      |
| Buyers                   | US personal accounts (count)                                                                                                                                                                                                                            |
| Payout receivers         | Maya, Luis (US personal accounts)                                                                                                                                                                                                                       |
| Negative testing enabled | yes/no                                                                                                                                                                                                                                                  |
| Webhook URL              | `https://holdline-web.onrender.com/api/paypal/webhook`                                                                                                                                                                                                  |
| Webhook ID set in Render | yes/no                                                                                                                                                                                                                                                  |
| `LAB_ENABLED` on Render  | set to `true` by hand for the run (the old `false` stays until changed); back to `false` afterwards                                                                                                                                                     |
| Order of steps           | 1) accounts + REST app → 2) `PAYPAL_*` in `.env` and Render → 3) `pnpm paypal:webhook:setup https://holdline-web.onrender.com` → 4) `PAYPAL_WEBHOOK_ID` + `LAB_ENABLED=true` in Render → 5) owner login with Render's `ADMIN_TOKEN` → 6) lab rows below |
| Where webhooks land      | Always the Render DB (the webhook URL is the Render host), even for lab runs started locally                                                                                                                                                            |

## Results

| #   | Check                                                                            | Expected                                                                                                                                  | Observed (status, IDs, debug_id) | Verdict |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------- |
| 1   | Create AUTHORIZE order → approve (v6 popup) → authorize                          | Order `COMPLETED`, authorization `CREATED`, ~29-day `expiration_time`                                                                     |                                  |         |
| 2   | Payee/merchant is the US account; currency USD (R10)                             | Payee email = US business account; capture not held for currency conversion                                                               |                                  |         |
| 3   | Capture full ($25, `final_capture: true`)                                        | Capture `COMPLETED`, authorization `CAPTURED`                                                                                             |                                  |         |
| 4   | Capture $10 with `final_capture: true` (R1, R2)                                  | Partial capture allowed; remainder released (authorization `CAPTURED`/`PARTIALLY_CAPTURED`?)                                              |                                  |         |
| 5   | Void                                                                             | Authorization `VOIDED`                                                                                                                    |                                  |         |
| 6   | Reauthorize inside the 3-day honor period (R3)                                   | 422 `REAUTHORIZATION_TOO_SOON`                                                                                                            |                                  |         |
| 7   | Negative test: authorize with `INSTRUMENT_DECLINED`                              | 422 `INSTRUMENT_DECLINED`, nothing authorized                                                                                             |                                  |         |
| 8   | Verified webhooks arrive on Render                                               | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.AUTHORIZATION.VOIDED`, verified offline |                                  |         |
| 9   | Cert URL host seen in real webhooks                                              | `api.sandbox.paypal.com` (else: API fallback used)                                                                                        |                                  |         |
| 10  | 3 extra authorizations left open for the reauthorization check on or after 10-26 | 3 authorization IDs listed                                                                                                                |                                  |         |

## Reauthorization check (on or after 2026-10-26, stage 6)

| Check                                          | Expected                                               | Observed |
| ---------------------------------------------- | ------------------------------------------------------ | -------- |
| Reauthorize an authorization older than 3 days | New child authorization ID, its own 3-day honor period |          |
| Capture on the child ID                        | `COMPLETED`                                            |          |
| Void the child                                 | 422 `CANNOT_BE_VOIDED`                                 |          |
| Void another parent                            | `VOIDED`                                               |          |
