---
name: API server type patterns
description: Common type errors and their fixes in artifacts/api-server Express routes and drizzle queries.
---

## req.params and req.query types

`req.params.id` (and any other named params) is typed as `string | string[]` in this project's @types/express version — not just `string`. Always cast: `req.params.id as string` or `parseInt(req.params.id as string, 10)`.

`req.query.x` is `string | string[] | ParsedQs | ...` — always cast via `req.query as { field?: string }` at the destructuring site, or use `String(req.query.x)` inline.

**Why:** @types/express v4 ParamsDictionary is `Record<string, string | string[]>` in the installed version.

## db.execute(sql`...`) returns QueryResult, not an array

`const [row] = await db.execute(sql`...`)` does NOT work — QueryResult is not iterable.

Safe pattern:
```ts
const result = await db.execute(sql`...`);
const row = ((result as any).rows ?? [])[0];
```

For COUNT queries, the column value is `unknown`, so cast: `parseInt(String(row?.cnt ?? 0))`.

**Why:** Drizzle's `db.execute()` returns `QueryResult<Record<string, unknown>>` which has `.rows` not array semantics. Used in bike-track, hot-tub, sites, safe-track etc.

## db.insert(table).values(any[]).returning() ambiguity

When `table` is a variable (not a literal schema import) and `values()` receives `any`, drizzle infers return as `any[] | QueryResult<never>`. Fix:
```ts
const rows = await db.insert(table).values({...}).returning() as any[];
const row = rows[0];
```

## noImplicitReturns disabled for api-server

`artifacts/api-server/tsconfig.json` has `"noImplicitReturns": false` to suppress TS7030 on Express route handlers. The base tsconfig.base.json has it `true`. This is intentional — the `return res.json()` pattern creates false positives everywhere.

## Drizzle-orm dynamic imports shadowing static imports

Avoid `const { or } = await import("drizzle-orm")` inside a function that already has `import { or } from "drizzle-orm"` at the top of the file. TypeScript flags the block-scoped `const` as TDZ when the static import is used before the dynamic one. Just use the static import.

## req.user not on Express Request

Express `Request` has no `.user` property. Use `(req as any).user?.id` instead.
