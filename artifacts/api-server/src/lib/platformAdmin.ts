import { isPlatformOperator } from "../middleware/requireAuth";

/**
 * Platform administrators (ALPS staff) named in PLATFORM_ADMIN_EMAILS, a
 * comma-separated list compared case-insensitively. Unset means nobody.
 * Delegates to isPlatformOperator so there is one reading of the variable.
 *
 * Used where a decision must not rest with the customer alone, e.g. reviewing
 * an account erasure request for a self-signup business that has no second
 * consultant to approve it.
 */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  return isPlatformOperator(email ? { email } : null);
}
