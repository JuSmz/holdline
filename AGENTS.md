<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Holdline conventions

- Read `SPEC.md` (design) and `PLAN.md` (stages) first. PayPal is **sandbox only**; the server refuses to start otherwise.
- Pages that read the database go in `src/app/(app)/` (its layout is `force-dynamic`). Static marketing pages go in `src/app/(marketing)/`. Never query the DB at module scope.
- Prices and amounts come only from the database. No agent tool or browser API accepts an amount.
- Every PayPal POST carries a `PayPal-Request-Id`; money operations go through the idempotency ledger.
- Gates before every commit: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Integration tests need the local Postgres (`pnpm db:local:start`).
