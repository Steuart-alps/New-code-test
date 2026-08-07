// The rate-limiting implementation lives in ../lib/loginRateLimit so the store
// is encapsulated in one place. This module is kept only as a stable re-export
// for existing import paths.
export { loginRateLimit, makeLoginRateLimit, _resetLoginRateLimit } from "../lib/loginRateLimit";
