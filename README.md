# Holdline

> **Answers the call. Books the job. Secures the payment.**

Holdline is an AI phone agent for small trades businesses such as plumbers and electricians.

- It **answers** every call.
- It **books the job** at the business's fixed price.
- It **secures the payment** while the caller is still on the line. The caller approves a PayPal authorization hold, and the appointment is confirmed only once that hold exists.
- After the job, the owner captures the payment with one click. No-shows pay only the no-show fee, and a timely cancellation releases the hold.
- The technician's share is paid out automatically.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). **PayPal sandbox only. No real money moves.**

> 🚧 **Work in progress.** The live demo for judges (`/try`), the full README and the test instructions arrive before submission. Progress: [PLAN.md](PLAN.md). Design: [SPEC.md](SPEC.md).

## Stack

- **App:** Next.js 16 (App Router, TypeScript), Tailwind CSS v4, shadcn/ui
- **Database:** Postgres 18 with Drizzle ORM
- **Hosting:** Render, from the Blueprint in [`render.yaml`](render.yaml)
- **PayPal:**
  - Orders v2 (authorize), Payments v2 (capture, void, reauthorize), Invoicing v2, Payouts v1, verified webhooks
  - JS SDK v6 on the pay page
- **Voice:** Vapi, using Google Gemini as the model
- **Chat:** the Gemini Developer API (`generateContent` over REST), same prompt core and tools as the voice agent
- **Email:** Resend

## Run locally

Requirements: Node 24 or newer, pnpm 10, and Postgres 18 (Homebrew `postgresql@18`).

```bash
pnpm install
pnpm db:local:init && pnpm db:local:start   # own Postgres in ./.pg on localhost:55433
cp .env.example .env                        # fill in values; secrets need >= 32 chars
pnpm db:migrate && pnpm db:seed
pnpm dev
```

**Quality gates:**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm test` runs both test projects:

- **unit tests**
- **integration tests** against the local test database (`DATABASE_URL_TEST`)

`pnpm test:e2e` runs the Playwright chat happy path in mock mode (fake PayPal, fake Gemini, its own
`holdline_e2e` database, the installed Chrome). It calls no paid API.

## Chat runtime decision (stage 7)

The text chat uses **stateless `generateContent`** with the raw `Content[]` stored in our own database
(`calls.gemini_contents`), not the Interactions API:

- the conversation stays in our database (the Interactions API keeps it at Google for up to 55 days by default);
- every model part is stored and sent back verbatim, so Gemini 3's thought signatures survive function calling;
- a turn's contents are appended atomically when it completes, so history never holds a call without its response.

Details and sources: [`docs/gemini-notes.md`](docs/gemini-notes.md).

## Safety rails

- The server **refuses to start** unless `PAYPAL_ENV=sandbox`.
- Prices come only from the database. The AI agent has no tool that moves money.
- A global daily Gemini budget (`GEMINI_DAILY_BUDGET_CENTS`, counted from `usageMetadata`) and a daily voice-minute cap (`DEMO_DAILY_VOICE_MINUTES`) stop paid usage.
- Every PayPal POST carries a `PayPal-Request-Id`. A forward-only booking state machine is enforced in code and by a database trigger.

---

Holdline is an independent hackathon project. Not affiliated with PayPal. MIT licensed.
