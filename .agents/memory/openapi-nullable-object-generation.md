---
name: OpenAPI nullable object generation
description: Constraint for OpenAPI schemas consumed by the repository's Orval TypeScript generators
---

Referenced object schemas marked `nullable: true` can make both the React client and Zod-generated TypeScript invalid (`interface X { ... } | null`). Keep the component schema as a normal object and put `nullable: true` on the property that references it when a response field may be null.

**Why:** The repository's generator templates render object nullability differently from scalar nullability, and the resulting generated source is parsed by both TypeScript and Expo Metro.

**How to apply:** After changing OpenAPI component schemas, run the API-spec codegen before typechecking or restarting mobile workflows; inspect generated object declarations if a parser error appears.