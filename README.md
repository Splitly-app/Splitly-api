# Splitly API

Independent Bun 1.4.3 / Elysia repository. Run `bun install --frozen-lockfile`,
then `bun run check`, `bun run test`, and `bun run build` from this directory.

For native development, copy `.env.local.example` to `.env.local`, fill in the
dev Supabase URL and publishable key, then run `bun run dev`. The API listens at
`http://localhost:8082`; set `API_DOCS_ENABLED=true` to open Swagger UI at
`/docs` and OpenAPI JSON at `/docs/json`. Documentation is off by default.

This repository owns `supabase/migrations` and its RLS tests. With Docker
running, use `bun run db:start`, `bun run db:reset:local`, and
`bun run db:test` to validate schema locally. Link and push only to a selected
Supabase development project after reviewing `supabase db push --dry-run`.

The production image builds from this repository root with `Dockerfile`.
