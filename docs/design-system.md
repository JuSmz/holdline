# Holdline design system (v1, 2026-10-22)

The goal: the demo feels like an Apple product. It is calm, obvious and fast. Every screen has one
clear next step, and nothing on screen is a raw code.

## Principles

1. **One primary action per screen.** It is a blue pill button. Everything else is secondary (a gray pill) or a text link.
2. **Plain words, never codes.** Status enums, PayPal states and reasons are translated to plain English (see the label tables). IDs appear only in detail views, in mono, small and copyable.
3. **The system moves on its own.** Pages poll and update in place: no "reload to see". Every wait shows what is happening ("PayPal is confirming…").
4. **Always know where you are.** The app header shows the demo copy and a Customer | Owner switch. The customer flow shows the three steps, with the current one highlighted.
5. **Generous space, few lines.** Soft gray canvas, white rounded surfaces, hairline borders, a light shadow. No gradients, no heavy borders, no dense tables on mobile.
6. **Mobile first** for /try, chat and /pay. The call page works best on a laptop and says so.

## Tokens (`src/app/globals.css`)

| Token                          | Value                                                                              | Use                                           |
| ------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `--canvas` / `bg-canvas`       | `#f5f5f7`                                                                          | app page background (marketing stays white)   |
| `--card` / `bg-card`           | `#ffffff`                                                                          | surfaces                                      |
| `--foreground`                 | `#1d1d1f`                                                                          | text                                          |
| `--muted-foreground`           | `#6e6e73`                                                                          | secondary text                                |
| `--border`                     | `rgb(0 0 0 / 8%)`                                                                  | hairlines                                     |
| `--brand`                      | `#0a5cff`                                                                          | primary actions, links, focus, "on hold"      |
| `--success` / `--success-soft` | `#1a7f37` / `#e9f6ee`                                                              | charged, paid out, hold approved confirmation |
| `--warning` / `--warning-soft` | `#a35a00` / `#fff4e0`                                                              | awaiting approval, fee pending                |
| `--danger` / `--danger-soft`   | `#c4001a` / `#ffecee`                                                              | payment problems, destructive actions         |
| `--neutral-soft`               | `#efeff2`                                                                          | neutral pills, secondary buttons              |
| `shadow-card`                  | `0 1px 2px rgb(0 0 0/4%), 0 8px 24px rgb(0 0 0/4%)`                                | cards                                         |
| radius                         | cards `rounded-2xl` (20px), sheets `rounded-3xl`, buttons and pills `rounded-full` |                                               |

Type: Geist. The page title is `text-3xl sm:text-4xl font-semibold tracking-tight`. A section title is `text-lg font-semibold`. Body text is `text-[15px]`. Secondary text is `text-sm text-muted-foreground`. Use `tabular-nums` for money and times.

Motion: new messages and state changes use `animate-in fade-in slide-in-from-bottom-1 duration-300` (tw-animate-css). Never animate layout jumps. Respect `prefers-reduced-motion` (`motion-safe:`).

## Components (`src/components/ui/*`)

- `Button`: pill. Variants: `default` (brand blue), `secondary` (gray), `outline`, `ghost`, `link`, `destructive`, `dark` (black). Sizes: `sm`, `default` (h-10), `lg` (h-12).
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`: the white surface.
- `StatusPill`: a booking status label with its color and dot (label tables below).
- `ConfirmDialog`: Base UI AlertDialog. Takes a title, a body, the money line (amount plus rule) and a confirm label. **Never `window.confirm`.**
- `Sheet`: Base UI Dialog styled as a right-side sheet on desktop and a bottom sheet on mobile.
- `SegmentedNav`: the Customer | Owner switch (links styled as a segmented control).
- `Steps`: the three customer steps (current, done, upcoming).
- `Notice`: an inline status line (info/success/warning/danger) with `role="status"`.
- `Field`/`Input`: rounded inputs with a label.
- `EmptyState`: an icon, one sentence and an optional action.

## Labels

**Booking status, as the owner sees it**

| status            | label             | pill    |
| ----------------- | ----------------- | ------- |
| `pending_payment` | Awaiting approval | warning |
| `authorized`      | Hold approved     | brand   |
| `completed`       | Charging          | neutral |
| `no_show`         | No-show           | neutral |
| `cancelled`       | Cancelled         | neutral |
| `captured`        | Charged           | success |
| `paid_out`        | Paid out          | success |
| `voided`          | Hold released     | neutral |
| `expired`         | Expired           | neutral |

A payment flag adds a red dot plus a short line: "Capture failed — retry or bill by invoice", "Payout failed — retry", "Hold lost — the customer has to approve again", "Hold renewal failed — the customer has to approve again", "Approval under review", "Capture pending at PayPal".

**Activity lines, in plain English.** For example: "PayPal hold approved · $149.00", "Charged $149.00", "Technician payout sent · Maya · $89.40", "Hold released", "No-show fee charged · $49.00", "Invoice sent · $25.00". Each line shows a date when it isn't from today ("Oct 21, 9:00 PM").

## Page flow

1. `/` (marketing): hero → **Try the live demo** (primary) → /try. How it works in three steps.
2. `/try`, without a demo copy: one card with "Your own private copy of a plumbing business, with sample history", **Start the demo**, and the note "Sandbox — no real money". With one: the three steps and two big choices (**Chat**, the recommended choice that works everywhere, and **Call in browser** for a laptop with a mic). Reset is in the header menu.
3. `/try/chat`: starts at once with the sample identity, shown as an editable line ("You're Sam · sam@example.com · Change"). There is a full-height chat with a sticky composer and quick replies that fit the current state. The pay panel sits on the right on desktop and opens as a bottom sheet on mobile when a booking appears. After approval: the confirmation in the chat, the panel turns green, and a primary **See it as the owner →** appears.
4. `/try/call`: a big call card (idle → connecting → live with level meter → ended). The transcript merges one speaker's consecutive fragments into one bubble. The pay panel and the after-approval CTA work as in chat.
5. `/pay/{token}`: a single centered card with the business name, booking summary, amount, the hold explanation and the PayPal button. The final state is read-only.
6. `/dashboard`: tabs **Overview · Bookings · Calls · Payments · Price list · Outbox**. It polls every 3 s. A booking opens a sheet with a summary, a timeline, the payments (with PayPal IDs) and actions. Every action uses `ConfirmDialog` with the exact amount and rule. A payout is sent right after the capture, so `Paid out` appears within seconds.
