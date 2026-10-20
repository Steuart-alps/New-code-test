/**
 * Public web pages the app links to (store review requires the privacy policy
 * and terms to be reachable from the sign-in and profile screens).
 *
 * EXPO_PUBLIC_SITE_URL overrides the production web address, e.g. for a
 * staging build. Keep this module import-free: tests load it with Node.
 */
const PRODUCTION_SITE_URL = 'https://complytrack.alpsconsultancy.co.uk';

export function siteUrl(): string {
  const raw = (process.env.EXPO_PUBLIC_SITE_URL ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s/]+$/i.test(raw) ? raw : PRODUCTION_SITE_URL;
}

export const privacyPolicyUrl = () => `${siteUrl()}/privacy`;
export const termsUrl = () => `${siteUrl()}/terms`;
/** Web settings, where owners manage billing and the business account. */
export const webSettingsUrl = () => `${siteUrl()}/settings`;
/** ALPS Consultancy's website (the contact address the privacy policy gives). */
export const CONTACT_URL = 'https://www.alpsconsultancy.co.uk';

/** Roles that own the business account and may request its erasure. */
export function canRequestBusinessDeletion(role: string | null | undefined): boolean {
  return role === 'client_admin' || role === 'consultant';
}
