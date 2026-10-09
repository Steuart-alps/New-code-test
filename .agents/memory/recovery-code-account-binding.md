# Recovery-code account binding

Recovery-code hashes are unsalted SHA-256, so the `user_id` predicate is the only
thing tying a code to its account. It exists in two places: `consumeRecoveryCode`
(web `/auth/2fa/verify`, sign-in reset) and the inline UPDATE inside
`/auth/mobile-login/verify-totp`. `test:twofa-recovery` submits account A's unused
code against account B's pending challenge on both paths; removing either
predicate fails it. Keep both predicates (or merge the mobile query into a shared
helper that keeps the filter and the challenge transaction).
