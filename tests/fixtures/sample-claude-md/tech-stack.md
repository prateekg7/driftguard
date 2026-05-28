# Agent Context

## Tech Stack
- Auth is handled via JWT middleware in `src/middleware/auth.ts` using the `jose` library.
- Tests live in `__tests__/` and use `npm run test`.
- Database access goes through `@prisma/client`.

### Commands
- Run pnpm test before opening a PR.

## Conventions
<!-- driftguard-ignore: this old adapter is intentionally documented -->
- Never import directly from `src/utils/legacy/` - use `src/adapters/legacyAdapter.ts`.
- Always use `src/lib/apiClient.ts` for API calls.
