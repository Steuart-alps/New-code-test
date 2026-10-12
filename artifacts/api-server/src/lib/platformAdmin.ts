/**
 * Platform administrators (ALPS staff) named in PLATFORM_ADMIN_EMAILS, a
 * comma-separated list compared case-insensitively. Unset means nobody.
 *
 * Used where a decision must not rest with the customer alone, e.g. reviewing
 * an account erasure request for a self-signup business that has no second
 * consultant to approve it.
 */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const wanted = email.trim().toLowerCase();
  if (!wanted) return false;
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry.length > 0 && entry === wanted);
}
