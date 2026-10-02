---
name: Typecheck and Orval barrels
description: Root typecheck is valid; Orval barrel formatting must remain compatible with regeneration.
---

# Keep root typecheck and Orval regeneration healthy

Treat the root typecheck as a required validation signal. In manually maintained Orval barrel files, use single-quoted wildcard exports because Orval detects existing exports using an exact single-quoted string match.

**Why:** Double-quoted exports are semantically equivalent to TypeScript, but repeated Orval regeneration does not recognize them and appends duplicate single-quoted exports. Duplicate wildcard exports can obscure or reintroduce ambiguous generated names.

**How to apply:** After changing the OpenAPI spec or Orval configuration, run codegen and the root typecheck. Confirm a second codegen run leaves manually maintained barrel files unchanged.

Package-level checks must build their own referenced composite libraries before invoking `tsc -p --noEmit`; the root check already does this through `tsc --build`, but direct API/web checks otherwise fail with TS6305 when ignored declaration output is absent.

**Why:** A clean workspace has no committed `lib/*/dist` declarations. Direct package validation then reports missing referenced outputs and can also degrade inferred types into misleading follow-on errors.

**How to apply:** Keep package `typecheck` scripts self-preparing only their declared references, and retain the root `tsc --build` as the shared library gate.

Domain helpers added to api-zod must use a separate package subpath export rather than a manual export in its generated root index.

**Why:** Orval rewrites the api-zod root barrel during regeneration, deleting hand-added domain exports even when they use single quotes. The manually maintained api-client-react barrel is different and can retain its public domain re-exports.

**How to apply:** Expose shared domain helpers through package exports; import that subpath on the server and re-export it from the maintained client barrel. Include regeneration in validation.
