---
name: Typecheck and Orval barrels
description: Root typecheck is valid; Orval barrel formatting must remain compatible with regeneration.
---

# Keep root typecheck and Orval regeneration healthy

Treat the root typecheck as a required validation signal. In manually maintained Orval barrel files, use single-quoted wildcard exports because Orval detects existing exports using an exact single-quoted string match.

**Why:** Double-quoted exports are semantically equivalent to TypeScript, but repeated Orval regeneration does not recognize them and appends duplicate single-quoted exports. Duplicate wildcard exports can obscure or reintroduce ambiguous generated names.

**How to apply:** After changing the OpenAPI spec or Orval configuration, run codegen and the root typecheck. Confirm a second codegen run leaves manually maintained barrel files unchanged.
