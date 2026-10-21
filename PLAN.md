# Holdline — Build plan

The work is built in small stages. **Every stage ends the same way:**

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` are green. From stage 7 on, `pnpm test:e2e` is green too.
2. A local commit.
3. A short report to the user.
4. **Then I wait for the user's OK.**
   - **Exception agreed on 2026-10-20:** stages 5 and 6 are pure code (no push, no cost, nothing for the user to do). They run back to back with one report at the end of stage 6.

**Pushing** to GitHub, which triggers the Render deploy, happens only on the user's explicit request, one approval per push. I batch fixes so there are few pushes.

**Paid API calls** happen only after an explicit "yes" for exactly that call. I name the model, the number of calls and the estimated cost first.

**Dates are targets.** Submission closes **Thu 2026-11-12, 21:00 CET**. Our own submit date is **11-11**. Feature freeze is **11-07**.

| #   | Stage                                                                                  | Target               | Why here                                                               |
| --- | -------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| 0   | Spec and plan                                                                          | 10-20                | —                                                                      |
| 1   | Skeleton and first Render deploy                                                       | 10-21                | Gets the public URL that the webhooks need                             |
| 2   | PayPal spike A: Orders and Payments, webhooks                                          | 10-22/23             | The authorize, capture and void facts the design rests on              |
| 3   | PayPal spike B: Payouts, Invoicing, sandbox report                                     | 10-23/24             | Covers the remaining money APIs early                                  |
| 4   | **Voice spike (Vapi)**: proxy call, `say` mid-call, silence, model choice              | 10-24/25             | Tests the riskiest unknowns early instead of on 11-02                  |
| 5   | Domain model and state machine                                                         | 10-26                |                                                                        |
| 6   | Payment service, webhooks and jobs, plus the real-sandbox reauthorization check        | 10-28                |                                                                        |
| 7   | **Vertical slice**: chat and web call → booking → pay → agent confirms → owner buttons | 11-01                | The video moment works end to end. **Fallback video take afterwards.** |
| 8   | Voice and email for production: phone path, claims, caps, live Resend                  | 11-03                |                                                                        |
| 9   | `/try` polish and dashboard                                                            | 11-05                |                                                                        |
| 10  | Bryntum Scheduler (trial started **≥ 11-01**)                                          | 11-06                |                                                                        |
| 11  | Hardening, then **feature freeze 11-07**                                               | 11-07                |                                                                        |
| 12  | Launch kit: README, final video (by 11-09), Devpost text, final deploy                 | 11-09 → submit 11-11 |                                                                        |

---

## Your setup checklist

Do these early. None of them depend on code, and several take time to become active.

| When               | What                                                                                                                                     | Notes                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Stage 1            | Claim the Render hackathon credit ($50)                                                                                                  | Link from the Devpost resources                                                                                             |
| Stage 1            | Create the GitHub repo                                                                                                                   | Either run `gh auth login` so I create it, or create it yourself and send me the URL. It can stay private until submission. |
| Before stage 2     | **PayPal sandbox, in this order:**                                                                                                       | All of these are sandbox accounts.                                                                                          |
|                    | 1. US business account                                                                                                                   | With a large USD balance. Enable partial capture if the setting exists.                                                     |
|                    | 2. 4–6 US personal buyer accounts                                                                                                        | For judges. Their logins are shown publicly, which is fine for sandbox.                                                     |
|                    | 3. 2 US personal accounts for Maya and Luis                                                                                              | Payout receivers                                                                                                            |
|                    | 4. **Then** the REST app, type **Merchant**, linked to that US business account                                                          | Enable negative testing on the business account (optional)                                                                  |
| Before stage 4     | **Vapi:** account and private key, then delete the public key or restrict it to no assistants                                            |                                                                                                                             |
| Before stage 4     | **Vapi budget decision**                                                                                                                 | Amount, **auto-reload off**, and the split into a development and a judging budget                                          |
| Before stage 4     | Vapi free US number (optional)                                                                                                           | US bonus only                                                                                                               |
| Before stage 7     | **Gemini:** AI Studio project with billing, an API key, and a **monthly spend cap or prepay**                                            |                                                                                                                             |
| Before stage 8     | **Resend:** account, domain `mail.<your-domain>` with the DNS records I'll give you (SPF/DKIM/DMARC), webhook for bounces and complaints | Start DNS early: propagation takes time                                                                                     |
| Any time           | Ask Bryntum in the hackathon Discord how the 45-day npm trial clock is counted                                                           |                                                                                                                             |
| Stage 10 (≥ 11-01) | Start the Bryntum trial                                                                                                                  |                                                                                                                             |
| Optional           | Node 24 locally (`brew install node@24`) to match Render; an HTTPS tunnel for local webhook tests                                        | Your decision. Not required.                                                                                                |

You enter every secret yourself: in `.env` locally, and by hand in the Render dashboard. I only name the variable and where it comes from.

---

## Stage 0: Spec and plan _(this commit)_

- `SPEC.md` v0.2, revised after the multi-lens review, and `PLAN.md`. `git init` and the first local commit.
- **Done when:** you have reviewed both and approved stage 1.

## Stage 1: Skeleton and first Render deploy

**Build**

- **Scaffold:**
  - Command: `pnpm create next-app@16.4.2 --ts --tailwind --eslint --app --src-dir --use-pnpm --no-cache-components --no-agent-feedback`.
  - Check that `cacheComponents` and `partialPrefetching` are both absent.
  - Pin `next@16.4.2`, `typescript@6.0.3` and `@types/node@24.19.2` (all versions pinned exactly).
  - Set `"types": ["node"]` and `engines >=24 <27`.
  - Pin `.node-version` to `24.21.0`.
  - Keep the `packageManager` field. Commit `pnpm-workspace.yaml` with `allowBuilds`.
- **UI base:** shadcn/ui init, design tokens (black and white, `#0A5CFF` accent), Geist (self-hosted via the `geist` package), the base layout and the footer "Not affiliated with PayPal". A landing placeholder with the wordmark.
- **Database:**
  - Drizzle 0.45 with postgres.js (pool max 5) and a `force-dynamic` layout pattern.
  - First migration: `workspaces` and `app_meta`.
  - `scripts/migrate.ts` (the same migrator for prod and tests) and an idempotent `scripts/seed.ts` that inserts the main workspace if it is missing.
- **Config:** zod env schema with capability flags, the fatal sandbox guard, `APP_URL ?? RENDER_EXTERNAL_URL`, and secret length checks.
- **Endpoints:**
  - `/api/health`: version, `RENDER_GIT_COMMIT`, DB ping, `lastTickAt`.
  - `/api/jobs/tick`: Bearer check; for now it only records the heartbeat.
  - A temporary **XFF probe** (`/api/probe/forwarded`) that echoes the caller's forwarding headers, to check Render's `X-Forwarded-For` behavior with a forged header (R16). **Deleted in stage 2.**
- **Tooling:** ESLint (flat config), Prettier, Vitest projects `unit` and `integration` (with globalSetup running the migrator against local Postgres 18), and the scripts `lint`, `typecheck`, `test` and `build`.
- **Deploy and repo files:**
  - `render.yaml` as in SPEC §26: web, Postgres and cron with `fromService` wiring. **Every future `sync: false` key is declared now.**
  - `.env.example`, `.gitignore`, `LICENSE` (MIT), a README skeleton.
  - GitHub Actions: lint, typecheck, test with a `postgres:18` service, build, `pnpm audit` and gitleaks.
- **`docs/video-shotlist.md`:** the first draft of the 2:45 storyboard. The screens are designed around it.
- **Fresh-clone check before the push:** `pnpm install --frozen-lockfile && pnpm build`.

**Tests:** config check (sandbox guard, missing or short secrets, mock refused on Render), health route (DB up and down), cron auth.

**What you do:** claim the credit, create the GitHub repo, **OK the first push**, then Render → New → Blueprint → choose the repo and leave the later secrets empty.

**Done when:**

- `https://<app>.onrender.com/api/health` returns `{ ok: true, db: "up" }`, **and `lastTickAt` is under 10 minutes old**, which proves the cron reaches the web service over the private network.
- The XFF result is recorded.

## Stage 2: PayPal spike A (Orders, Payments, webhooks)

**Build**

- **Housekeeping:** delete the stage-1 XFF probe (`/api/probe/forwarded`) and put the recorded result into the client-IP helper.
- **`src/server/paypal`:**
  - client: OAuth cache, `post()` that **requires** a request ID, `APP_INSTANCE_ID` prefixes, a 15 s timeout, retries with the same ID (including 409 in progress), `PayPalApiError`, the "already done" mapping, and `paypal_api_log`
  - `orders.ts` and `payments.ts`
- **`webhooks.ts` and `/api/paypal/webhook`:** offline verification (SPEC §11: cert URL checks, unsigned CRC32 over the bytes, size limit, nothing stored on failure). Only verified events are stored.
- **`scripts/paypal-webhook-setup.ts`:** registers the event list idempotently and prints `PAYPAL_WEBHOOK_ID`.
- **`/lab/paypal`** (needs `LAB_ENABLED` and the owner session):
  - a v6 `PayPalOneTimePaymentButton` with an explicit `presentationMode: "popup"` that creates and approves an AUTHORIZE order (amount set by the server)
  - buttons: Capture full, Capture partial + `final_capture` (then a GET), Void, Reauthorize (expects `REAUTHORIZATION_TOO_SOON`), Negative test (declined via `PayPal-Mock-Response`)
  - **Create 3 extra authorizations and leave them open** for the real reauthorization check on or after 10-26
  - the result of each call: status, IDs, `debug_id`
- **Payee check (R10):** the lab shows whether the order's payee email equals `PAYPAL_BUSINESS_EMAIL`; the account country is checked in the Developer Dashboard; the capture's `seller_receivable_breakdown` must be plain USD (no exchange rate, not `PENDING`).

**Tests (unit, mocked fetch)**

- request-ID spy and prefixes
- retries reuse the same ID; 409 handling; error mapping; OAuth cache
- signature verification: generated test cert; tampered body; look-alike host; userinfo URL; wrong path; wrong webhook ID; oversized body
- route test: a forged event returns 400 and stores nothing

**What you do:** the PayPal accounts in the order of the checklist; `PAYPAL_*` into `.env` and Render; **OK the push**. Then approve with a sandbox buyer in the lab: you enter the sandbox login unless you tell me otherwise.

**Done when:**

- authorize, full capture, partial capture + final and void have all succeeded in the sandbox
- the partial-capture setting and the remainder behavior are recorded (R1, R2)
- a verified webhook has arrived on Render
- 3 open authorizations exist

## Stage 3: PayPal spike B (Payouts, Invoicing, report)

**Build**

- **`payouts.ts`:** create, get batch and item, cancel unclaimed, and recovery from a duplicate `sender_batch_id`.
- **`invoicing.ts`:** create with our own `invoice_number`, send, get, search by number, cancel. `allow_tip: false` and partial payment off.
- **`scripts/sandbox-smoke.ts`:** a $1 payout to Maya (polled to SUCCESS), a duplicate-sender_batch_id probe, then create and send an invoice and look it up by number. Includes payout negative tests through `items[0].note` codes.
- Lab buttons for both.
- **`docs/sandbox-report.md`:** what we actually saw (no secrets). Answers R1–R3 and R10 so far, and lists the webhooks that arrived.

**Tests:** payout ID derivation and duplicate recovery; invoice payload (required fields, totals, number ≤ 25 characters); recovery through search.

**Done when:** in the sandbox the payout reached `SUCCESS`, the invoice was sent and paid by the buyer, the `INVOICING.INVOICE.PAID` webhook arrived, and the report is committed.

## Stage 4: Voice spike (Vapi)

**This needs your approval for about 3–5 short test calls,** at about $0.10–0.13 per minute, **under $2 in total**. I state the exact estimate before each call. You make the calls yourself in the browser.

**Build**

- A bare page `/lab/voice`:
  - `new Vapi("proxy", APP_URL + "/api/vapi-proxy")` with `@vapi-ai/web@3.0.0` pinned exactly
  - `/api/vapi-proxy/call/web`, which discards the body and creates the call with the private key
- **`scripts/vapi-setup.ts`, first version:** Bearer credential, **1 dummy tool**, a saved assistant (`silenceTimeoutSeconds: 240`, idle hook, `recordingEnabled: false`, `controlEnabled`). Running this script is free.
- `/api/vapi/events` and `/api/vapi/tools`, which record raw payloads as fixtures.
- A "simulate payment" button on the lab page that runs `notifyCall()`: a server `say` and then `add-message` through the controlUrl.

**Measure and record in `docs/voice-spike-report.md`**

- **R4:** Is there a controlUrl in the `/call/web` response?
- **R5:** The call `type` values and the payload fields.
- **R13:** Does the proxy work with SDK 3.0.0? If not, 2.7.1.
- **R14:** Do the silence and hook settings stick?
- **R15:** The delay from `say` to speech.
- **R6:** 2–3 Gemini models compared: p50/p95 turn latency, tool-call success, empty or cut-off turns.
- The golden-path duration with a stopwatch, which sets `VAPI_MAX_CALL_SECONDS`.
- Does the call survive 120 s of silence?

**What you do:** the Vapi account and budget decision; `VAPI_PRIVATE_KEY` and `VAPI_WEBHOOK_SECRET` in `.env` and Render; **OK the push**; a yes for each test call.

**Done when:** every item above is answered, and `VAPI_LLM_MODEL` and `VAPI_MAX_CALL_SECONDS` are chosen from the measurements.

## Stage 5: Domain model and state machine

**Build**

- **The full Drizzle schema** (SPEC §7) with UUIDv7 IDs and globally unique refs.
- **State machine:**
  - `transition()` and the flag tables (SPEC §8)
  - the CAS helper
  - the **status trigger** as a `drizzle-kit generate --custom` migration
  - `booking_events`
- **Domain logic:**
  - pricing snapshot and payout and invoice math
  - availability: hours, durations, buffers, held slots, timezone and the **US DST change on 11-01**
  - signed slot IDs through `sign(purpose)` (SPEC §20)
- **Seed:** `seed-data.ts` (template), cloning, and sample history.

**Tests**

- the full transition and flag tables
- the **fast-check money and rank invariant**
- Postgres: the trigger rejects a backward change; concurrent CAS (two writers, one wins)
- slots, including DST
- token purposes (each type rejected where another is expected)
- pricing and payout rounding

## Stage 6: Payment service, webhooks and jobs

**Build**

- **The ledger** (SPEC §10.3): lease, unknown-outcome handling, GET-then-retry recovery.
- **Services:**
  - `createOrderForBooking` and `authorizeBooking` (a short claim transaction, status checks, orphan void)
  - `markJobDone`, `markNoShow`, `waiveFee`, `cancelBooking`
  - `billExtraWork`, `billViaInvoice` (void first), `requestReapproval`
  - payouts with the natural key
- **Webhook processing:** dedupe, re-GET, CAS, then processed. Rows with `simulated = true` (lab simulator events) are never processed — they are marked processed on arrival or skipped.
- **Jobs behind `/api/jobs/tick`, in SPEC §12 order:** reconcile, outbox, expire, reauthorize, stale holds, payouts, summaries, retention.
- **Fake PayPal** (`PAYPAL_MODE=mock`) with scriptable outcomes.
- **Real reauthorization check on or after 10-26** with the open authorizations from stage 2: reauthorize, capture the child, try to void the child (expect `CANNOT_BE_VOIDED`), void another parent. The results go into the sandbox report (R3).

**Tests:** **the payment matrix, SPEC §24 items 1–25 and 28–30**, as integration tests on real Postgres with fake PayPal.

**Done when:** the matrix is green and the lab runs against the sandbox through the new services.

## Stage 7: Vertical slice

**Build**

- **Agent core:**
  - the prompt core plus channel sections
  - the 4 flat tool schemas
  - handlers with scoping, zod limits, **one pending booking per call**, supersede and replay
  - the Vapi and Gemini adapters
- **Chat:**
  - `/try/chat` and `/api/chat`: size limits, history cap, the Gemini runtime decision (raw `Content[]` or Interactions), `thinkingLevel: "low"`
  - quick replies
  - **auto-confirmation through `/api/chat/event`**
- **Web call:** `/try/call` with the proxy, the mic preflight and the pre-call form, `notifyCall` (`say` plus `add-message`, the browser fallback, dedupe), and the polling state endpoint.
- **PayPanel:**
  - the cookie routes `/api/try/bookings/{id}/order|authorize`, `presentationMode: "popup"`, and the sandbox buyer login shown inside the panel
  - QR code / device link, and the `/pay/{token}` page
- **Demo workspace basics:** POST start, signed cookie, cloning, badge.
- **Minimal owner page:** Job done, No-show and Cancel, with the PayPal activity feed.
- **Email:** outbox rows and the Outbox view. Real sending comes in stage 8.
- **Call summary** with Gemini structured output: the transcript goes in as untrusted data, with `maxLength` limits.
- **Gemini daily budget counter.**

**Tests**

- matrix items 26–27
- a fake LLM drives a whole chat to `authorized` and the auto-confirmation
- Vapi fixture contract tests: single-line results, every `toolCallId` answered
- the Gemini thought-signature round trip
- Playwright: the chat happy path in mock mode

**What you do:** the Gemini key and models in `.env` and Render; **OK the push**; a yes for each live test call or chat. I state the cost first.

**Done when:** on Render, a browser call and a chat each go booking → pay → the agent confirms by itself, and Job done → captured → paid_out works. **Then record the fallback video take.**

## Stage 8: Voice and email for production

**Build**

- **`vapi-setup.ts`, final:** 4 tools with their own filler lines, the assistant from the spike measurements, and the phone number with no `assistantId`.
- **Phone:** `assistant-request` routing (owner → main, everyone else → phone-demo), per-caller and global caps, booking claims on `/try`, and the nightly reset of the phone-demo workspace.
- **Cost guards:**
  - atomic voice-minute reservations
  - "voice busy → chat"
  - remaining minutes on `/try`
  - cost per call in the dashboard
  - `end-call` for unknown in-progress calls
- **Resend live:**
  - demo email opt-in (confirm mail)
  - the phone-path caps
  - the 4 templates (DB fields only)
  - the bounce and complaint webhook feeding the suppression list, with auto-pause
  - the Outbox re-drive job

**Tests:** assistant-request routing and caps; claims (wrong ref or digits, claim once); proxy caps; email delivery rules (unconfirmed → outbox only; suppression; per-recipient caps); the Resend webhook signature.

**What you do:** the Resend DNS and keys; optionally the free number; **OK the push**; a yes for each test call.

**Done when:** on Render, a phone call by you (international dialing is your call) books and claims; demo emails reach a confirmed address; caps and fallbacks behave.

## Stage 9: `/try` polish and dashboard

**Build**

- **`/try`:** stepper, badge, open on another device, reset with confirmation, sample history, processor list, the "book tomorrow vs later" hint, mobile hints.
- **Dashboard:**
  - Overview: KPIs, upcoming jobs, needs attention, PayPal activity
  - Calls: AI summary card and transcript
  - Bookings: timeline, payment details, every action with its dialog and rule explanation
  - Payments & payouts
  - **Price list & policies**
  - Outbox
- Status chips and flags, polling refresh, live regions.

**Tests:** server-action auth, idempotency and sibling conflict; claimed-booking access; Playwright: Job done → captured → paid_out, no-show, cancel (timely and late), extra work.

**Done when:** every action works on Render against the sandbox, and payouts arrive in Maya's and Luis's sandbox accounts.

## Stage 10: Bryntum Scheduler _(trial started ≥ 2026-11-01)_

**Build**

- **Install:** `pnpm add -E @bryntum/scheduler@npm:@bryntum/scheduler-trial@7.3.7 @bryntum/scheduler-react@7.3.7`, plus `allowBuilds` for both trial packages.
- **Wrapper:** a `'use client'` component using `next/dynamic(…, { ssr: false })`. The CSS (fontawesome, `scheduler.css` and one theme) is imported inside the client tree; check for clashes with the Tailwind preflight.
- **Views:**
  - a **compact read-only schedule** on the dashboard overview (and on the call page if it fits)
  - the full `/dashboard/schedule`
  - technicians as resources, bookings as events: hatched while pending with a hold-expiry marker, solid blue once authorized, live through polling
  - **the same data as `check_availability`**
- No drag-to-reschedule (deferred).

**Tests:** the bookings → events adapter, and the status styling map. The trial watermark is accepted.

**Done when:** the schedule renders on Render and flips live when a payment comes in. The video shot list gets its Bryntum beat.

## Stage 11: Hardening, then feature freeze on 11-07

- Playwright e2e of the whole flow in mock mode, plus a manual sandbox checklist.
- **Device matrix:** desktop Chrome, Safari and Firefox with the popup during a live call; iOS Safari and Android Chrome with chat, pay and QR.
- **Security pass:** auth on every route, CSP measured and tightened, rate limits and global caps, logs free of PII, `pnpm audit`, gitleaks, retention job.
- Error, empty and loading states; accessibility (axe); 404 and 500 pages.
- **After 11-07, only bug fixes.**

## Stage 12: Launch kit

**Build**

- **README:**
  - pitch with "Why it's different"
  - **sourced numbers** on missed calls and no-shows (researched, not made up)
  - architecture, the payment state machine, and the "guardrailed agentic commerce" section
  - how to run it (local mock mode, sandbox)
  - **For judges:** URL, sandbox buyers, steps, voice cap and chat equivalent
  - AI usage: Gemini on Vapi for voice, Gemini for chat and summaries
  - PayPal APIs used, processors and privacy
- Screenshots and GIFs.
- **Video, ≤ 2:45, final take by 11-09:**
  1. Who it's for and the problem with numbers (20 s)
  2. Live browser call (60 s)
  3. **Pays while still on the call, then "Got it — you're all set"** (30 s)
  4. Dashboard: capture, payout, no-show (30 s)
  5. Bryntum schedule flipping to confirmed (10 s)
  6. Guardrail: the agent refuses a discount, prices come from the DB (10 s)
  7. Under the hood: the PayPal activity feed (15 s)

  Production notes:
  - Captions burned in.
  - No music, or royalty-free music only.
  - Only text names for Vapi, Google and Bryntum.
  - The Sandbox label stays visible, and time cuts are captioned.

- **Devpost text** (draft by 11-09). Check that GitHub detects the license.
- **Final checklist:** `LAB_ENABLED=false`, buyer logins checked, a runbook for resetting a buyer password, the final deploy (**OK the push**) and the smoke test.

**What you do:** upload the video to YouTube as **Public**, make the repo public, and **submit on 11-11**.

---

## Standing rules

- No `git push` without your explicit OK, one push at a time.
- No paid API call without your explicit yes for exactly that call, with the cost named first. Calls made by judges run under the standing Vapi and Gemini budgets that you set.
- I never ask for secrets, never print them and never commit them. You enter them into `.env` and Render.
- Agent, UI and README are in English. We talk in German.
