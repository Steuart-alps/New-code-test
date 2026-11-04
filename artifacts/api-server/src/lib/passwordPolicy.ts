/**
 * Password rules for every place a password is chosen (sign-up, reset,
 * invite set-up, and admins setting one). Following NCSC advice, length plus a
 * block on the most commonly used passwords, rather than forced symbols.
 */
export const MIN_PASSWORD_LENGTH = 8;

// Commonly used passwords of 8 or more characters (shorter ones fail the
// length rule anyway), from public breached-password lists, plus obvious
// choices for this product. Compared in lower case.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "password1234", "password!", "password1!",
  "passw0rd", "p@ssword", "p@ssw0rd", "p@ssword1", "p@ssw0rd1", "pa55word", "passwort",
  "12345678", "123456789", "1234567890", "12345678910", "0123456789", "87654321", "987654321",
  "11111111", "00000000", "88888888", "12341234", "11223344", "12121212", "123123123", "1q2w3e4r",
  "1q2w3e4r5t", "qwertyuiop", "qwerty123", "qwerty1234", "qwertyui", "1qaz2wsx", "zaq12wsx",
  "asdfghjkl", "asdfasdf", "zxcvbnm1", "abcd1234", "abc12345", "abcdefgh", "a1b2c3d4", "aa123456",
  "iloveyou", "iloveyou1", "sunshine", "sunshine1", "princess", "football", "football1", "baseball",
  "superman", "starwars", "welcome1", "welcome123", "welcome!", "letmein1", "letmein123", "trustno1",
  "whatever", "computer", "corvette", "mercedes", "liverpool", "liverpool1", "chelsea1", "arsenal1",
  "manchester", "rangers1", "celtic1888", "scotland", "scotland1", "england1", "michelle", "jennifer",
  "jordan23", "qazwsxedc", "changeme", "changeme1", "changeme123", "default1", "administrator",
  "admin123", "admin1234", "adminadmin", "test1234", "testtest", "testing1", "testing123",
  "secret123", "monkey123", "dragon123", "master123", "shadow123", "summer2024", "summer2025",
  "summer2026", "winter2024", "winter2025", "winter2026", "autumn2025", "autumn2026", "spring2026",
  "january1", "september", "november", "december", "complytrack", "complytrack1", "complytrack123",
  "health&safety", "healthandsafety", "safety123", "compliance", "compliance1", "alpsconsultancy",
]);

/** Why a password can't be used, in plain words, or null when it is fine. */
export function passwordProblem(password: unknown, email?: string | null): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  const lower = password.toLowerCase();
  const tooCommon = "That password is too common and easy to guess. Try three random words, such as \"kettle-river-lamp\".";
  if (COMMON_PASSWORDS.has(lower)) return tooCommon;
  // The same character repeated, or a run of consecutive digits or letters.
  if (/^(.)\1+$/.test(lower)) return tooCommon;
  if ("01234567890123456789".includes(lower) || "98765432109876543210".includes(lower)) return tooCommon;
  if ("abcdefghijklmnopqrstuvwxyz".includes(lower)) return tooCommon;
  const local = (email ?? "").trim().toLowerCase().split("@")[0] ?? "";
  if (local.length >= 4 && (lower === local || lower === (email ?? "").trim().toLowerCase())) {
    return "Don't use your email address as your password.";
  }
  return null;
}
