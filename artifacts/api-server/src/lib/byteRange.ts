/**
 * Parse a single-range `Range: bytes=...` header against an object's size.
 * Returns undefined when there is no header, "invalid" when the range cannot
 * be satisfied (answer 416), else inclusive start/end offsets. Supports
 * `start-end`, open-ended `start-` and suffix `-length` forms; multi-range
 * requests are not supported and count as invalid.
 */
export function parseByteRange(
  raw: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  if (!raw) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) return "invalid";
  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  } else {
    // Suffix range: the last N bytes (the whole object when N exceeds it).
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0) return "invalid";
    start = Math.max(0, size - length);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}
