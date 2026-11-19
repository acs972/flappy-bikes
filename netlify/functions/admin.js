import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, contest, failure, json, keyedHash, readSubmission, storage } from '../lib/leaderboard.js';

import { rankingRecords, rankPeriod, requestedPeriod } from '../lib/rankings.js';

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_LIMIT = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const israelTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
});

// Fixed-size digests allow constant-time comparison even for different password lengths.
function passwordMatches(request, expected) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer (.+)$/i.exec(header);
  const supplied = match && header.length <= 4096 ? match[1] : '';
  const digest = value => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

// Persist only failure timestamps and a keyed IP hash. Successful logins do not
// clear failures: an attacker cannot reset the rolling window with another request.
async function authenticate(request, context, store) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new ApiError(503, 'Admin access is not configured. Set ADMIN_PASSWORD in Netlify.');
  if (!context?.ip) throw new ApiError(503, 'Could not identify this connection. Please try again.');
  const key = `admin-auth/${keyedHash('admin-login-ip', context.ip, expected)}`;
  const matches = passwordMatches(request, expected);
  for (let attempt = 0; attempt < 10; attempt++) {
    const entry = await store.getWithMetadata(key, { type: 'json' });
    const now = Date.now();
    const failures = (entry?.data?.failures || []).filter(time => time > now - FAILURE_WINDOW_MS);
    if (failures.length >= FAILURE_LIMIT) {
      const retry = Math.max(1, Math.ceil((Math.min(...failures) + FAILURE_WINDOW_MS - now) / 1000));
      throw new ApiError(429, 'Too many failed admin logins. Please wait before trying again.', { 'Retry-After': String(retry) });
    }
    if (matches) return;
    const written = await store.setJSON(key, { failures: [...failures, now] },
      entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (written.modified) throw new ApiError(401, 'Incorrect or missing admin password.', { 'WWW-Authenticate': 'Bearer realm="Contest admin"' });
  }
  // Fail closed during heavy contention, without revealing or logging credentials.
  throw new ApiError(429, 'Too many login attempts. Please try again later.', { 'Retry-After': '900' });
}

// A null record is ignored by the existing public ranking but still counts as a
// used token. This removes the private details without allowing the deleted run back in.
async function deleteEntry(store, contestId, id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new ApiError(400, 'Please choose a valid entry to delete.');
  const key = `runs/${contestId}/${id}`;
  const entry = await store.getWithMetadata(key, { type: 'json' });
  if (!entry?.data) throw new ApiError(404, 'That entry has already been removed or is not in this contest.');
  const result = await store.setJSON(key, null, { onlyIfMatch: entry.etag });
  if (!result.modified) throw new ApiError(409, 'That entry changed. Refresh the list before deleting it.');
}

// Take a key snapshot before deletion to avoid skipping pages as the list shrinks.
// Only score/used-run records are wiped; admin lockouts and visitor rate limits remain.
async function resetEntries(store) {
  const [runs, caches] = await Promise.all([store.list({ prefix: 'runs/' }), store.list({ prefix: 'ranking-cache/' })]);
  const blobs = [...runs.blobs, ...caches.blobs];
  for (let offset = 0; offset < blobs.length; offset += 16) {
    await Promise.all(blobs.slice(offset, offset + 16).map(blob => store.delete(blob.key)));
  }
  return runs.blobs.length;
}

export default async function handler(request, context) {
  try {
    const store = storage();
    // Authenticate even unsupported methods before exposing any contest data.
    await authenticate(request, context, store);
    const window = contest();
    if (request.method === 'GET') {
      const period = requestedPeriod(request);

      const records = await rankingRecords(store, window.id);
      const sorted = rankPeriod(records, window, period);
      // Contacts are read only after authentication and are never put in the ranking cache.
      const entries = await Promise.all(sorted.slice(0, 50).map(async (record, index) => {
        const current = await store.get(`runs/${window.id}/${record.runId}`, { type: 'json' });
        if (!current) return null;
        return { id: record.runId, rank: index + 1, nickname: record.nickname, score: record.score,
          contact: current.contact, submittedAt: new Date(record.submittedAt).toISOString(),
          submittedAtIsrael: israelTime.format(record.submittedAt) };
      }));
      const ranking = { totalPlayers: sorted.length, entries: entries.filter(Boolean) };
      return json({
        period, timezone: 'Asia/Jerusalem',
        contest: { status: window.status, start: window.start, end: window.end,
          startIsrael: window.start ? israelTime.format(Date.parse(window.start)) : null,
          endIsrael: window.end ? israelTime.format(Date.parse(window.end)) : null },
        ...ranking,
      });
    }
    if (request.method !== 'POST') throw new ApiError(405, 'Please use GET or POST.', { Allow: 'GET, POST' });
    const body = await readSubmission(request);
    if (body.action === 'delete') {
      await deleteEntry(store, window.id, body.id);
      return json({ message: 'Entry deleted. Any lower score from the same player may now appear.' });
    }
    if (body.action === 'reset') {
      if (body.confirm !== 'RESET') throw new ApiError(400, 'Type RESET to confirm the leaderboard reset.');
      const deleted = await resetEntries(store);
      return json({ message: `Reset complete: removed ${deleted} score/used-run records.`, deleted });
    }
    throw new ApiError(400, 'Choose the delete or reset action.');
  } catch (error) { return failure(error); }
}
