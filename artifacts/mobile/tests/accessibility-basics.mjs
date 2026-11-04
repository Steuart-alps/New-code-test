import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Accessibility basics for store review and large text:
// 1. A touchable with no visible <Text> (an icon-only button) carries an
//    accessibilityLabel, so VoiceOver/TalkBack read what it does.
// 2. Inputs, text areas and text buttons use minHeight, not a fixed height,
//    so their text is not clipped when the user enlarges the font size.
async function sources(dir) {
  const entries = await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => `${entry.parentPath ?? entry.path}/${entry.name}`);
}
const files = [...await sources('app'), ...await sources('components')];
assert.ok(files.length > 20, 'screens found');

function openingTagEnd(source, from) {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    else if (source[i] === '>' && depth === 0) return i;
  }
  return -1;
}

const unlabelled = [];
const clipping = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const short = file.slice(file.indexOf('/mobile/') + 8);
  for (const match of source.matchAll(/<(TouchableOpacity|Pressable|TouchableHighlight)\b/g)) {
    const end = openingTagEnd(source, match.index + match[0].length);
    const opening = source.slice(match.index, end + 1);
    const inner = opening.endsWith('/>') ? '' : source.slice(end + 1, source.indexOf(`</${match[1]}>`, end));
    if (opening.includes('accessibilityLabel') || /<Text\b/.test(inner)) continue;
    unlabelled.push(`${short}:${source.slice(0, match.index).split('\n').length}`);
  }
  // Style entries named like text containers, with a fixed height and no
  // fixed width (fixed squares are icon wells).
  const styleStart = source.indexOf('StyleSheet.create(');
  if (styleStart < 0) continue;
  for (const match of source.slice(styleStart).matchAll(/\n\s+(\w+): \{([^{}]*)\}/g)) {
    const [, name, body] = match;
    if (!/(input|textArea|note|submit|btn|button|action)$/i.test(name)) continue;
    if (/(^|[\s,{])height: \d/.test(body) && !/(^|[\s,{])width: \d/.test(body)) clipping.push(`${short} ${name}`);
  }
}
assert.deepEqual(unlabelled, [], 'icon-only buttons need an accessibilityLabel');
assert.deepEqual(clipping, [], 'text containers need minHeight rather than a fixed height');

console.log(`accessibility basics: ok (${files.length} files)`);
