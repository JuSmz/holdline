# Voice spike report (stage 4)

Status: **build deployed (7f8d9d7), assistant saved, calls pending.** Filled in from the test calls in `/lab/voice` (owner lab on Render).

## Setup

| Item                | Value                                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| Web SDK             | `@vapi-ai/web` 3.0.0 (pinned), via `new Vapi("proxy", origin + "/api/vapi-proxy")` |
| Assistant           | `Holdline`, saved by `pnpm vapi:setup https://holdline-web.onrender.com`           |
| Credential          | Bearer, `VAPI_WEBHOOK_SECRET` (API or dashboard)                                   |
| Tools               | 1 dummy tool, `get_services` (fixed lab catalog)                                   |
| Voice / transcriber | Vapi `Elliot` / Deepgram `nova-3` (`en`)                                           |

## Findings before any call (2026-10-21, from the published API)

- `silenceTimeoutSeconds` is not in `CreateAssistantDTO` any more (OpenAPI at `api.vapi.ai/api-json`, server SDK 3.0.0). The timeout docs still describe it and `silence-timed-out` is still an ended reason. → sent anyway, verified by read-back.
- The hook union is `call.ending`, `assistant.speech.interrupted`, `customer.speech.interrupted`, `customer.speech.timeout`, `session.created`. `call.timeElapsed` is gone. → dropped.
- `/credential` and `/call/web` are not in the published paths; the web SDK still calls `POST /call/web`.
- `monitorPlan` gained `controlAuthenticationEnabled` (Bearer with the **public** key). Left off: the controlUrl stays server-side and is never sent to the browser.
- The web SDK reads only `id`, `webCallUrl`, `transport.callToken`, `artifactPlan.videoRecordingEnabled` and `assistant.voice.provider` from the create response; the proxy returns just those.
- `vapi.start()` needs an assistant argument; the lab passes a placeholder the proxy discards.

## Setup run (2026-10-21, free)

`APP_INSTANCE_ID=p1 pnpm vapi:setup https://holdline-web.onrender.com --model gemini-3.5-flash`, run twice (create, then update):

- credential created through the API (`/credential` works, no dashboard step needed): `839b0c16-…`
- tool `get_services`: `d7b321df-…`, server `/api/vapi/tools` with the credential, 10 s timeout, request-start + delayed messages stored
- assistant `Holdline`: `2469ef6d-f020-44a9-8802-ff53885e5e5b`, `google/gemini-3.5-flash`, `maxDurationSeconds` 480, `silenceTimeoutSeconds` 240, recordings off, control on, listen off
- webhook secret on Render matches `.env`: both routes answer 401 without the token and pass auth with it

## Measurements

| #   | Question                                                                           | Result                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4  | controlUrl in the `/call/web` response?                                            | _pending_                                                                                                                                                                                                                                                                                                              |
| R4b | Does any client message (browser) carry a controlUrl? The lab logs a WARNING if so | _pending_                                                                                                                                                                                                                                                                                                              |
| R5  | Call `type` values and payload fields                                              | _pending_                                                                                                                                                                                                                                                                                                              |
| R13 | Proxy works with SDK 3.0.0?                                                        | **Base URL: yes.** SDK 3.0.0 posts `/call/web` to our proxy. **But Vapi's `/call/web` rejects the private key** (401 "Invalid Key … private key instead of the public key"); `POST /call` accepts it. Fix: the proxy uses a server-only `VAPI_PUBLIC_KEY`. Two lab attempts failed this way, no call created, no cost. |
| R14 | Silence timeout and hooks stick (read-back)? Survives 120 s of silence?            | **Stored:** `silenceTimeoutSeconds: 240` accepted on create and update (2026-10-21) and read back; hook `customer.speech.timeout@30s` stored. 120 s survival: _pending_                                                                                                                                                |
| R15 | Click → speech after a server `say` (target ≤ 2 s)                                 | _pending_                                                                                                                                                                                                                                                                                                              |
| R6  | Gemini models: turn p50/p95, tool-call success, empty or cut-off turns             | _pending_                                                                                                                                                                                                                                                                                                              |
| —   | Golden-path duration → `VAPI_MAX_CALL_SECONDS`                                     | _pending_                                                                                                                                                                                                                                                                                                              |

## Calls

| #   | Model | Purpose | Duration | Cost | Ended reason | Notes |
| --- | ----- | ------- | -------- | ---- | ------------ | ----- |
