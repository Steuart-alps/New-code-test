import { inflateSync } from 'node:zlib';

// Recovers the text PDFKit drew with embedded (Identity-H) fonts, so tests can
// assert on what a generated PDF says. Not a general PDF parser: it reads the
// uncompressed object layout, ToUnicode maps and Tf/Tj/TJ operators PDFKit writes.
export function pdfText(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const objects = new Map();
  for (const match of raw.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const [, id, body] = match;
    const streamAt = body.indexOf('stream');
    if (streamAt === -1) { objects.set(id, { dict: body }); continue; }
    const dict = body.slice(0, streamAt);
    let data = Buffer.from(body.slice(streamAt + 6).replace(/^\r?\n/, '').replace(/\r?\n?endstream\s*$/, ''), 'latin1');
    if (dict.includes('/FlateDecode')) data = inflateSync(data);
    objects.set(id, { dict, stream: data.toString('latin1') });
  }
  const unicode = (hex) => String.fromCodePoint(
    ...hex.split(/\s+/).filter(Boolean).map((unit) => parseInt(unit, 16)),
  );
  const cmaps = new Map();
  for (const [id, { dict }] of objects) {
    const ref = dict.match(/\/ToUnicode (\d+) 0 R/);
    if (!ref) continue;
    const cmap = new Map();
    const source = objects.get(ref[1])?.stream ?? '';
    for (const [, block] of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const [, start, list] of block.matchAll(/<([0-9a-f]+)>\s*<[0-9a-f]+>\s*\[([^\]]*)\]/gi)) {
        [...list.matchAll(/<([0-9a-f ]+)>/gi)].forEach(([, hex], offset) => cmap.set(parseInt(start, 16) + offset, unicode(hex)));
      }
    }
    for (const [, block] of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const [, glyph, hex] of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f ]+)>/gi)) cmap.set(parseInt(glyph, 16), unicode(hex));
    }
    cmaps.set(id, cmap);
  }
  const resolve = (dict, key) => {
    const ref = dict.match(new RegExp(`/${key} (\\d+) 0 R`));
    return ref ? objects.get(ref[1]) : null;
  };
  const lines = [];
  const pages = [...objects.values()].filter(({ dict }) => /\/Type \/Page\b/.test(dict));
  for (const page of pages) {
    const resources = resolve(page.dict, 'Resources')?.dict ?? page.dict;
    const fonts = resources.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1] ?? '';
    const names = new Map([...fonts.matchAll(/\/(\w+) (\d+) 0 R/g)].map(([, name, id]) => [name, cmaps.get(id)]));
    const content = resolve(page.dict, 'Contents')?.stream ?? '';
    let cmap = new Map();
    for (const [, font, text] of content.matchAll(/\/(\w+) [\d.]+ Tf|(\[[^\]]*\]\s*TJ|<[0-9a-f]*>\s*Tj)/gi)) {
      if (font) { cmap = names.get(font) ?? new Map(); continue; }
      lines.push([...text.matchAll(/<([0-9a-f]*)>/gi)]
        .map(([, hex]) => (hex.match(/.{4}/g) ?? []).map((glyph) => cmap.get(parseInt(glyph, 16)) ?? '').join(''))
        .join(''));
    }
  }
  return lines.join('\n');
}
