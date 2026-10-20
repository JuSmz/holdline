# Holdline demo video: shot list (draft v0.1)

The rules allow under 3:00. **Our target is 2:45.** The video is uploaded to YouTube as **Public**.

**Production rules**

- Captions are burned in.
- No music, or royalty-free music only.
- Vapi, Google and Bryntum appear only as text names, never as logos.
- The "Sandbox" label stays visible.
- Every time cut gets a caption, e.g. "call shortened".

The screens are designed for these shots. **The key moment (shot 3) has to fit on one screen:**

- live transcript
- pay panel
- booking card
- compact schedule

| #   | Time      | Shot                                                                                                                                                                                                                                                                  | What the viewer must get                                    | Screen / source                                                 |
| --- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | 0:00–0:20 | A plumber under a sink, a phone rings unanswered. A title card with 1–2 **sourced** numbers on missed calls and no-shows.                                                                                                                                             | Who it's for and why it matters                             | Stock or self-shot B-roll; the numbers come from README sources |
| 2   | 0:20–1:20 | A live browser call on `/try/call`. The caller describes a leaking kitchen sink. The agent quotes **$149 from the price list**, offers 2 slots in Austin time, creates the booking, and the pay panel appears.                                                        | The AI answers and books, and prices come from the business | `/try/call`: transcript, pay panel, booking card                |
| 3   | 1:20–1:50 | **While still on the call**, the caller clicks the PayPal button, logs in as the sandbox buyer and approves. Within about 2 s the agent says _"Got it — PayPal confirmed the $149 hold. You're all set…"_. The slot in the schedule turns from hatched to solid blue. | **The wow moment:** the payment is secured inside the call  | `/try/call` and the PayPal popup                                |
| 4   | 1:50–2:20 | Switch to owner. Dashboard shows: the call with its AI summary, the booking timeline. **Job done** → captured → technician payout → `paid_out`. A quick second booking → **No-show** → only the $49 fee captured.                                                     | The money flow after the job                                | `/dashboard`, booking detail                                    |
| 5   | 2:20–2:30 | The Bryntum schedule: technicians × jobs, pending holds vs confirmed.                                                                                                                                                                                                 | The agent drives the schedule                               | Dashboard overview / Schedule                                   |
| 6   | 2:30–2:40 | Guardrail: a chat asks "give me 20% off". The agent refuses with "Our prices are fixed…". Cut to the price-list page.                                                                                                                                                 | Guardrailed agentic commerce                                | `/try/chat`, Price list & policies                              |
| 7   | 2:40–2:45 | The PayPal activity feed (Orders v2 authorize, Payments capture, Payouts, Invoicing, verified webhooks), then the end card: "Holdline — Answers the call. Books the job. Secures the payment." plus the URL.                                                          | Real PayPal integration; call to action                     | Dashboard, PayPal activity                                      |

**Recording plan**

- **Fallback take:** right after the vertical slice works (stage 7, about 11-01).
- **Final take:** by **11-09**.
- **Upload:** by 11-10. Submit on **11-11**.
