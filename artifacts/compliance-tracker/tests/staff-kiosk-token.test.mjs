import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const roster = await readFile(new URL("../src/pages/staff-roster.tsx", import.meta.url), "utf8");
const kiosk = await readFile(new URL("../src/pages/staff-kiosk.tsx", import.meta.url), "utf8");

assert.match(roster, /kiosk#kiosk_token=\$\{encodeURIComponent\(data\.kiosk_token\)\}/,
  "manager kiosk links must put the token in the URL fragment");
assert.doesNotMatch(roster, /kiosk\?kiosk_token=/,
  "manager kiosk links must not put the token in the query string");
assert.match(roster, /staff\/set-pin#staff_id=\$\{member\.id\}&enrollment_token=\$\{encodeURIComponent\(data\.enrollment_token\)\}/,
  "manager PIN setup links must put enrollment credentials in the URL fragment");
assert.doesNotMatch(roster, /staff\/set-pin\?staff_id=.*enrollment_token=/,
  "manager PIN setup links must not put enrollment credentials in the query string");
assert.match(kiosk, /window\.location\.hash\.slice\(1\)/,
  "kiosk must read its token from the URL fragment");
assert.doesNotMatch(kiosk, /window\.location\.search\).*kiosk_token/,
  "kiosk must not read its token from the query string");
assert.match(kiosk, /history\.replaceState/,
  "kiosk must remove the fragment before making requests");
assert.match(kiosk, /const fragment = new URLSearchParams\(window\.location\.hash\.slice\(1\)\)/,
  "PIN setup must parse enrollment credentials from the URL fragment");
assert.doesNotMatch(kiosk, /new URLSearchParams\(window\.location\.search\).*enrollment_token/,
  "PIN setup must not parse enrollment credentials from the query string");
assert.match(kiosk, /window\.sessionStorage\.setItem\("staff-pin-enrollment-token", fromUrl\)/,
  "PIN setup must transfer the fragment token to session storage");
assert.match(kiosk, /"x-kiosk-token": token/,
  "kiosk API requests must authenticate with the kiosk-token header");

console.log("Staff kiosk token URL regression tests passed.");