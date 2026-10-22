# Gemini notes (checked 2026-10-22)

Source: the official docs at ai.google.dev (pages updated 2026-10-15 to 10-19). No paid request was
made for this research.

## Models and prices (paid Standard tier, USD per 1M tokens)

| Model                   | Input                              | Output (incl. thinking) | Thinking default             |
| ----------------------- | ---------------------------------- | ----------------------- | ---------------------------- |
| `gemini-3.8-flash`      | $0.75 until 2026-12-31, then $1.50 | $3.75, then $7.50       | medium; `minimal` is refused |
| `gemini-3.6-flash`      | same as 3.8                        | same as 3.8             | medium                       |
| `gemini-3.5-flash-lite` | $0.30                              | $2.50                   | minimal                      |
| `gemini-3.1-flash-lite` | $0.25                              | $1.50                   | minimal                      |

- The models page recommends 3.5 Flash-Lite or 3.8 Flash for new projects.
- Suggested: chat `gemini-3.8-flash` (thinking `low`), summaries `gemini-3.1-flash-lite` (thinking `minimal`).
- The table is mirrored in `src/server/gemini/budget.ts`. An unknown model is charged at the highest rate.

## Function calling and thought signatures

- The model returns `functionCall` parts with an `id`. The first call of a response carries a `thoughtSignature`.
- Signatures must come back in their original parts, or the request fails with a 400. Only the current turn is validated (everything after the last user text).
- Parallel calls go in one model turn, followed by one user turn with all `functionResponse` parts in the same order, matched by `id`. Interleaving them is a 400.
- There is no `tool` role. Responses go back in a `user` turn.
- Holdline stores `candidates[0].content` verbatim and appends a turn only when it completes.

## Config

- `thinkingConfig.thinkingLevel`: `minimal` | `low` | `medium` | `high`. Thinking can't be switched off fully.
- `maxOutputTokens` includes thinking tokens, which are billed even when output is cut off.
- `temperature`, `topP` and `topK` are ignored on 3.6 Flash and newer, so Holdline doesn't send them.
- Structured output: `responseMimeType: "application/json"` with `responseJsonSchema`.
  - `maxLength`, `minLength` and `pattern` are ignored, so lengths are enforced in our own zod schema.
  - The REST reference now prefers `responseFormat`, but the older fields still work.

## Interactions API (not used)

- It became GA in June 2026 and is now recommended.
- It stores conversations at Google: 55 days on the paid tier by default, configurable to 7, 14 or 28 days. `store=false` disables `previous_interaction_id`.
- It handles signatures on the server.
- Holdline keeps the stateless `generateContent` path, so conversation data stays in our database.

## Billing and limits

- Cost per request = (prompt − cached) × input + cached × cache rate + (candidates + thoughts) × output.
- `usageMetadata` fields: `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount` and `toolUsePromptTokenCount`.
- Tier 1 spend limit: $10 per rolling 10 minutes (429 `RESOURCE_EXHAUSTED`). Project spend caps are experimental and react with about 10 minutes' delay.
- New API keys must be restricted (since 2026-05-28). Restrict the key to the Generative Language API.
- EEA/UK users may only be served by paid services, and the demo uses the paid tier.
