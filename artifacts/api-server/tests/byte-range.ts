import assert from "node:assert/strict";
import { parseByteRange } from "../src/lib/byteRange";

const size = 1000;
assert.equal(parseByteRange(undefined, size), undefined, "no header reads the whole object");
assert.deepEqual(parseByteRange("bytes=0-99", size), { start: 0, end: 99 });
assert.deepEqual(parseByteRange("bytes=0-1", size), { start: 0, end: 1 }, "Safari's two-byte probe");
assert.deepEqual(parseByteRange("bytes=900-", size), { start: 900, end: 999 }, "open-ended");
assert.deepEqual(parseByteRange("bytes=0-", size), { start: 0, end: 999 }, "the player's first request");
assert.deepEqual(parseByteRange("bytes=990-5000", size), { start: 990, end: 999 }, "end past the object is clamped");
assert.deepEqual(parseByteRange("bytes=-64", size), { start: 936, end: 999 }, "suffix: the last 64 bytes");
assert.deepEqual(parseByteRange("bytes=-5000", size), { start: 0, end: 999 }, "suffix longer than the object");
assert.deepEqual(parseByteRange(" bytes=5-9 ", size), { start: 5, end: 9 }, "surrounding whitespace");
for (const invalid of [
  "bytes=1000-", "bytes=1000-1001", "bytes=10-5", "bytes=-0", "bytes=-", "bytes=0-1,5-9",
  "items=0-9", "bytes=a-b", "bytes=99999999999999999999-",
]) {
  assert.equal(parseByteRange(invalid, size), "invalid", invalid);
}
assert.equal(parseByteRange("bytes=0-0", 0), "invalid", "an empty object has no satisfiable range");
console.log("byte-range parser checks passed");
