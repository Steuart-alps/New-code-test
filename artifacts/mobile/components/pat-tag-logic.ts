export interface TaggedAppliance {
  id: number;
  name: string;
  active: boolean;
  asset_tag?: string | null;
}

export type TagMatch<T extends TaggedAppliance> =
  | { kind: 'empty' }
  | { kind: 'match'; tag: string; appliance: T }
  | { kind: 'multiple'; tag: string; appliances: T[] }
  | { kind: 'retired'; tag: string; appliance: T }
  | { kind: 'unknown'; tag: string };

/**
 * Asset labels are printed and scanned inconsistently (case, stray spaces,
 * trailing newlines from some barcode encoders), so tags compare on a
 * normalised form rather than the raw string.
 */
export function normalizeAssetTag(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * QR asset labels often encode a URL rather than the bare tag. When the whole
 * payload does not match, the tag may be a `tag`/`asset`/`assetTag` query
 * parameter or the last path segment.
 */
function urlTagCandidates(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return [];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
  const candidates: string[] = [];
  for (const key of ['tag', 'asset', 'assetTag', 'asset_tag']) {
    const value = url.searchParams.get(key);
    if (value) candidates.push(value);
  }
  const segment = url.pathname.split('/').filter(Boolean).at(-1);
  if (segment) {
    try {
      candidates.push(decodeURIComponent(segment));
    } catch {
      candidates.push(segment);
    }
  }
  return candidates;
}

function matchNormalized<T extends TaggedAppliance>(appliances: T[], tag: string): TagMatch<T> | null {
  const matches = appliances.filter((appliance) => appliance.asset_tag && normalizeAssetTag(appliance.asset_tag) === tag);
  if (matches.length === 0) return null;
  const active = matches.filter((appliance) => appliance.active);
  if (active.length === 1) return { kind: 'match', tag, appliance: active[0] };
  if (active.length > 1) return { kind: 'multiple', tag, appliances: active };
  return { kind: 'retired', tag, appliance: matches[0] };
}

/**
 * Resolves a scanned or typed asset tag against the PAT register the user can
 * see. Retired appliances are reported rather than selected, because they
 * cannot receive new tests; tags shared by several active appliances are
 * returned for the user to choose between.
 */
export function matchAssetTag<T extends TaggedAppliance>(appliances: T[], raw: string): TagMatch<T> {
  const tag = normalizeAssetTag(raw);
  if (!tag) return { kind: 'empty' };
  const direct = matchNormalized(appliances, tag);
  if (direct) return direct;
  for (const candidate of urlTagCandidates(raw)) {
    const normalized = normalizeAssetTag(candidate);
    const match = normalized ? matchNormalized(appliances, normalized) : null;
    if (match) return match;
  }
  return { kind: 'unknown', tag };
}
