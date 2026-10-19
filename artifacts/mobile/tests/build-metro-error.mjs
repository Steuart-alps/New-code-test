import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The publish build (scripts/build.js) downloads bundles from Metro. When Metro
// rejects a bundle it answers HTTP 500 with the parser error in the body; the
// build log must show that error, bounded and without terminal codes, and the
// partial download must still be removed.
const require = createRequire(import.meta.url);
const { downloadFile } = require('../scripts/build.js');
const { formatMetroError, MAX_MESSAGE_CHARS } = require('../scripts/metro-error.js');

const metroSyntaxError = {
  type: 'TransformError',
  message: 'SyntaxError: /app/app/broken.tsx: Unexpected token, expected "," (3:7)',
  filename: 'app/broken.tsx',
  lineNumber: 3,
  column: 7,
  snippet: '\u001b[0m \u001b[90m 2 |\u001b[39m \u001b[36mconst\u001b[39m a \u001b[33m=\u001b[39m {\n\u001b[31m\u001b[1m>\u001b[22m\u001b[39m 3 |\u001b[39m   b\u001b[33m:\u001b[39m \u001b[35m1\u001b[39m c\u001b[0m',
  errors: [{ description: 'SyntaxError: /app/app/broken.tsx: Unexpected token, expected "," (3:7)' }],
};

const server = createServer((req, res) => {
  if (req.url === '/syntax.bundle') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify(metroSyntaxError));
  } else if (req.url === '/html.bundle') {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<pre>Unable to resolve module ./missing from app/index.tsx</pre>\u0007');
  } else if (req.url === '/huge.bundle') {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('x'.repeat(2 * 1024 * 1024));
  } else if (req.url === '/empty.bundle') {
    res.writeHead(502);
    res.end();
  } else if (req.url === '/ok.bundle') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('console.log("bundle");');
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'metro-error-'));

async function failure(name, what) {
  const output = join(dir, `${name}.js`);
  const error = await downloadFile(`${base}/${name}.bundle`, output, what).then(
    () => assert.fail(`${name}: a failed response must reject`),
    (err) => err,
  );
  assert.equal(existsSync(output), false, `${name}: no partial file is left behind`);
  return error.message;
}

try {
  const syntax = await failure('syntax', 'ios bundle');
  assert.match(syntax, /^HTTP 500 Internal Server Error from Metro for ios bundle:/);
  assert.match(syntax, /TransformError: SyntaxError: .*Unexpected token/, 'the parser error is shown');
  assert.match(syntax, /at app\/broken\.tsx:3:7/, 'the file and position are shown');
  assert.match(syntax, /3 \|\s+b: 1 c/, 'the code frame is shown');
  assert.doesNotMatch(syntax, /\u001b/, 'terminal colour codes are removed');
  assert.equal(syntax.match(/Unexpected token/g).length, 1, 'a description repeating the message is not printed twice');

  const html = await failure('html', 'android bundle');
  assert.match(html, /^HTTP 500 Internal Server Error from Metro for android bundle:/);
  assert.match(html, /Unable to resolve module \.\/missing/);
  assert.doesNotMatch(html, /\u0007/, 'control characters are removed');

  const huge = await failure('huge', 'ios bundle');
  assert.ok(huge.length < MAX_MESSAGE_CHARS + 200, `a huge body is capped (${huge.length} chars)`);
  assert.match(huge, /truncated/);

  const empty = await failure('empty', 'android bundle');
  assert.equal(empty, 'HTTP 502 Bad Gateway from Metro for android bundle (empty response body)');

  const ok = join(dir, 'ok.js');
  await downloadFile(`${base}/ok.bundle`, ok, 'ios bundle');
  assert.equal(readFileSync(ok, 'utf8'), 'console.log("bundle");', 'a good bundle still downloads');

  // Shapes Metro may send without a code frame, and non-object JSON.
  assert.equal(formatMetroError('{"type":"NotFoundError","message":"No such file"}'), 'NotFoundError: No such file');
  assert.equal(formatMetroError('"plain string"'), '"plain string"');
  assert.equal(formatMetroError('[1,2]'), '[1,2]');
  assert.equal(formatMetroError('{}'), '{}');
  assert.equal(formatMetroError('{"message":"Boom","filename":"a.ts","lineNumber":null}'), 'Boom\nat a.ts');

  console.log('build metro error: ok');
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
