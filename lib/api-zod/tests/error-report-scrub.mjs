// Error-report scrubbing shared by the API and web Sentry setups.
// Run: pnpm --filter @workspace/api-zod run test:error-report-scrub
import assert from 'node:assert/strict';
import { createDeliveryLog, redactPath, redactText, redactUrl, scrubErrorReport } from '../src/error-report-scrub.ts';

const results = [];
const test = async (name, fn) => { try { await fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, error]); } };

const HEX = 'a3f9c2'.repeat(10) + 'beef'; // 64 hex chars, like randomBytes(32).toString("hex")
const B64 = 'Zk3_q9XvLm2-Rt8bWc4Yp0sNa7Ue1Hd5Jf6Kg3Qh9Ti'; // 43 chars, like base64url
const UUID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

await test('token path segments are redacted; ids, UUIDs and words are kept', () => {
  assert.equal(redactPath(`/api/sign-off/${HEX}/staff`), '/api/sign-off/[redacted]/staff');
  assert.equal(redactPath(`/api/storage/download/${B64}`), '/api/storage/download/[redacted]');
  assert.equal(redactPath(`/api/clients/42/sites/${UUID}`), `/api/clients/42/sites/${UUID}`);
  assert.equal(redactPath('/api/admin/service-price-preflight'), '/api/admin/service-price-preflight');
  assert.equal(redactPath('/api/kitchen_temperature_readings_2024'), '/api/kitchen_temperature_readings_2024');
});

await test('URLs lose query, fragment and credentials', () => {
  assert.equal(redactUrl(`https://app.example/contractor-portal/${HEX}?token=abc#x`), 'https://app.example/contractor-portal/[redacted]');
  assert.equal(redactUrl('/verify-email?token=abc'), '/verify-email');
  assert.equal(redactUrl('https://user:pass@db.example:5432/x'), 'https://db.example:5432/x');
  assert.equal(redactUrl('http://[bad'), '[redacted]');
});

await test('free text loses emails, bearer values, secret params, queries and tokens', () => {
  const text = redactText(`Failed for jo.bloggs@example.co.uk at /api/x?token=abc: Bearer ${HEX} postgres://u:secret@host/db password=hunter2 sk_live_${B64}`);
  assert.ok(!text.includes('jo.bloggs'), text);
  assert.ok(!text.includes(HEX), text);
  assert.ok(!text.includes('hunter2'), text);
  assert.ok(!text.includes('secret@'), text);
  assert.ok(!text.includes(B64), text);
  assert.ok(!text.includes('?token'), text);
  assert.ok(text.includes('[email]') && text.includes('/api/x') && text.includes('Bearer [redacted]'), text);
  assert.equal(redactText('relation "kitchen_temperature_readings_2024" does not exist'), 'relation "kitchen_temperature_readings_2024" does not exist');
});

await test('error events keep method, path, stack and tags; lose bodies, headers, cookies and PII', () => {
  const event = scrubErrorReport({
    environment: 'production',
    transaction: `GET /api/sign-off/${HEX}`,
    request: {
      method: 'POST',
      url: `https://complytrack.example/api/fix-track/action/${HEX}?code=1`,
      headers: { authorization: 'Bearer x', cookie: 'connect.sid=s%3Aabc', 'x-csrf-token': 'abc' },
      cookies: { 'connect.sid': 'abc' },
      data: '{"password":"hunter2"}',
      query_string: 'token=abc',
      env: { REMOTE_ADDR: '10.0.0.1' },
    },
    user: { id: '7', ip_address: '10.0.0.1', email: 'a@b.co' },
    exception: { values: [{ type: 'Error', value: `Could not email owner@client.co.uk`, stacktrace: { frames: [{ function: 'handler' }] } }] },
    breadcrumbs: [
      { category: 'navigation', data: { from: `/sign-off/${HEX}`, to: '/dashboard?tab=1' } },
      { category: 'fetch', data: { url: `/api/storage/download/${B64}?x=1`, method: 'GET', status_code: 500 } },
      { category: 'http', data: { url: 'https://storage.googleapis.com/b/o', 'http.query': '?X-Goog-Signature=abc', 'http.fragment': '#f' } },
      { category: 'console', message: 'login for x@y.com', data: { arguments: ['x@y.com'] } },
    ],
    tags: { module: 'fixtrack', url: `/sign-off/${HEX}?a=1` },
  });
  assert.equal(event.request.method, 'POST');
  assert.equal(event.request.url, 'https://complytrack.example/api/fix-track/action/[redacted]');
  for (const key of ['headers', 'cookies', 'data', 'query_string', 'env']) assert.equal(event.request[key], undefined, key);
  assert.deepEqual(event.user, { id: '7' });
  assert.equal(event.transaction, 'GET /api/sign-off/[redacted]');
  assert.equal(event.exception.values[0].value, 'Could not email [email]');
  assert.equal(event.exception.values[0].stacktrace.frames[0].function, 'handler');
  assert.equal(event.breadcrumbs[0].data.from, '/sign-off/[redacted]');
  assert.equal(event.breadcrumbs[0].data.to, '/dashboard');
  assert.equal(event.breadcrumbs[1].data.url, '/api/storage/download/[redacted]');
  assert.equal(event.breadcrumbs[1].data.status_code, 500);
  assert.equal(event.breadcrumbs[2].data['http.query'], undefined);
  assert.equal(event.breadcrumbs[2].data['http.fragment'], undefined);
  assert.equal(event.breadcrumbs[3].message, 'login for [email]');
  assert.equal(event.breadcrumbs[3].data.arguments, undefined);
  assert.equal(event.tags.module, 'fixtrack');
  assert.equal(event.tags.url, '/sign-off/[redacted]');
  assert.equal(event.environment, 'production');
});

await test('transactions: span descriptions and URL attributes are scrubbed', () => {
  const event = scrubErrorReport({
    type: 'transaction',
    transaction: `/contractor-portal/${HEX}`,
    contexts: { trace: { data: { 'url.full': `https://x.example/a/${HEX}?k=v`, 'url.query': '?k=v', 'http.target': `/a/${HEX}?k=v` } } },
    spans: [
      { op: 'http.client', description: `GET https://storage.googleapis.com/bucket/obj?X-Goog-Signature=${HEX}`, data: { 'http.url': `https://s.example/o?sig=${HEX}`, 'http.query': 'sig=1' } },
      { op: 'db', description: 'select * from users where email = $1' },
    ],
  });
  assert.equal(event.transaction, '/contractor-portal/[redacted]');
  assert.deepEqual(event.contexts.trace.data, { 'url.full': 'https://x.example/a/[redacted]', 'http.target': '/a/[redacted]' });
  assert.equal(event.spans[0].description, 'GET https://storage.googleapis.com/bucket/obj');
  assert.deepEqual(event.spans[0].data, { 'http.url': 'https://s.example/o' });
  assert.equal(event.spans[1].description, 'select * from users where email = $1');
});

await test('delivery log records what Sentry answered per event id', async () => {
  const log = createDeliveryLog();
  const answers = { a: { statusCode: 200 }, b: { statusCode: 401 }, c: {} };
  const transport = log.wrap({ send: async (envelope) => { if (envelope[0].event_id === 'd') throw new Error('offline'); return answers[envelope[0].event_id]; }, flush: async () => true });
  await transport.send([{ event_id: 'a' }, []]);
  await transport.send([{ event_id: 'b' }, []]);
  await transport.send([{ event_id: 'c' }, []]);
  await assert.rejects(transport.send([{ event_id: 'd' }, []]));
  assert.deepEqual(log.outcome('a'), { outcome: 'accepted', statusCode: 200 });
  assert.deepEqual(log.outcome('b'), { outcome: 'rejected', statusCode: 401 });
  assert.deepEqual(log.outcome('c'), { outcome: 'failed' });
  assert.deepEqual(log.outcome('d'), { outcome: 'failed' });
  assert.deepEqual(log.outcome('zzz'), { outcome: 'pending' });
  assert.equal(typeof transport.flush, 'function');
});

for (const [status, name, error] of results) {
  console.log(`${status} - ${name}`);
  if (error) console.error(error);
}
if (results.some(([status]) => status === 'FAIL')) process.exit(1);
