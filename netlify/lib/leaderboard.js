import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const RUN_LIFETIME_MS = 30 * 60 * 1000;
const SUBMISSION_INTERVAL_MS = 20_000;
const DAILY_LIMIT = 30;

export class ApiError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// Always return a small JSON response; never cache tokens or personal submissions.
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export function failure(error) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status, error.headers);
  // Do not echo SDK errors, request bodies, tokens, contacts, or IPs into responses/logs.
  return json({ error: 'The leaderboard is temporarily unavailable. Please try again shortly.' }, 503);
}

export function requireMethod(request, method) {
  if (request.method !== method) throw new ApiError(405, `Please use ${method} for this endpoint.`, { Allow: method });
}

export function secret() {
  const value = process.env.LEADERBOARD_SECRET;
  if (!value) throw new ApiError(503, 'Leaderboard setup is incomplete: set LEADERBOARD_SECRET in Netlify.');
  if (Buffer.byteLength(value) < 32) throw new ApiError(503, 'LEADERBOARD_SECRET must contain at least 32 random characters.');
  return value;
}

// Purpose labels keep IP hashes, player identifiers, and signatures separate.
export function keyedHash(purpose, value, key) {
  return createHmac('sha256', key).update(`${purpose}\0${value}`).digest('hex');
}

function isoSetting(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  // Require an explicit timezone to avoid a server's local timezone changing the contest.
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const time = Date.parse(value);
  const calendar = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!match || !Number.isFinite(time) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new ApiError(503, `Leaderboard setup error: ${name} must be a valid ISO date with a timezone, for example 2026-12-01T09:00:00Z.`);
  }
  return new Date(time).toISOString();
}

// Changing the contest dates creates a separate group of scores in the same store.
export function contest(now = Date.now()) {
  const start = isoSetting('CONTEST_START');
  const end = isoSetting('CONTEST_END');
  if (start && end && Date.parse(start) >= Date.parse(end)) {
    throw new ApiError(503, 'Leaderboard setup error: CONTEST_END must be after CONTEST_START.');
  }
  const status = start && now < Date.parse(start) ? 'not started'
    : end && now >= Date.parse(end) ? 'ended' : 'open';
  const id = createHash('sha256').update(JSON.stringify([start, end])).digest('hex');
  return { id, status, start, end };
}

export function requireOpen(window) {
  if (window.status !== 'open') {
    throw new ApiError(403, window.status === 'ended' ? 'This contest has ended.' : 'The contest has not started yet.');
  }
}

export function storage() {
  return getStore({ name: 'leaderboard', consistency: 'strong' });
}

// The server signs the run ID and start time; the browser cannot choose either.
export function signRun(key, contestId, now) {
  const payload = { v: 1, id: randomUUID(), startedAt: now, contestId };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyRun(token, key, contestId, now) {
  const invalid = () => new ApiError(401, 'This run token is invalid. Please start a new run.');
  if (typeof token !== 'string' || token.length > 2048) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw invalid();
  const expected = createHmac('sha256', key).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw invalid();
  let run;
  try { run = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!run || run.v !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run.id)
      || !Number.isSafeInteger(run.startedAt) || run.startedAt > now || run.startedAt < 0 || run.contestId !== contestId) throw invalid();
  if (now - run.startedAt > RUN_LIFETIME_MS) throw new ApiError(410, 'This run has expired after 30 minutes. Please start a new run.');
  return run;
}

// Limit the body while reading it, including requests without Content-Length.
export async function readSubmission(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'Please send the score as JSON.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'Please include the run token, score, nickname, and contact.');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        throw new ApiError(413, 'That submission is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'The submission is not valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Please send a JSON object.');
  return body;
}

export function validateScore(score) {
  if (!Number.isInteger(score) || score < 0 || score > 9999) {
    throw new ApiError(400, 'Score must be a whole number from 0 to 9999.');
  }
  return score;
}

export function validatePlayer(nickname, contact, key) {
  if (typeof nickname !== 'string' || typeof contact !== 'string') throw new ApiError(400, 'Please enter a nickname and a contact.');
  const name = nickname.normalize('NFKC').trim().replace(/ +/g, ' ');
  if (Array.from(name).length < 2 || Array.from(name).length > 12
      || !/^[A-Za-z0-9\u05D0-\u05EA .,!?'"_\-\u05F3\u05F4]+$/.test(name)
      || !/[A-Za-z0-9\u05D0-\u05EA]/.test(name)) {
    throw new ApiError(400, 'Use 2–12 characters for your nickname: English or Hebrew letters, numbers, spaces, and basic punctuation.');
  }
  // A deliberately simple filter, not a substitute for reviewing contest entries.
  const folded = name.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's');
  const words = folded.split(/[^a-z\u05D0-\u05EA]+/);
  const banned = new Set(['fuck', 'fucker', 'fucking', 'shit', 'bitch', 'cunt', 'asshole', 'זין', 'זונה', 'זונות', 'מניאק', 'כוסאמק']);
  if (words.some(word => banned.has(word))) throw new ApiError(400, 'Please choose a more suitable nickname.');
  const privateContact = contact.normalize('NFKC').trim();
  if (!privateContact || Array.from(privateContact).length > 40 || /[\p{Cc}\p{Cf}]/u.test(privateContact)) {
    throw new ApiError(400, 'Please enter an Instagram handle or phone number, up to 40 characters.');
  }
  const digits = privateContact.replace(/\D/g, '');
  const phone = /^\+?[0-9 ()-]+$/.test(privateContact) && digits.length >= 7 && digits.length <= 15;
  const instagram = /^@?[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?$/.test(privateContact);
  if (!phone && !instagram) throw new ApiError(400, 'Use an Instagram handle (such as @yourname) or a phone number.');
  const normalizedContact = phone ? `phone:${digits}` : `instagram:${privateContact.replace(/^@/, '').toLowerCase()}`;
  const playerId = keyedHash('player', JSON.stringify([name.toLowerCase(), normalizedContact]), key);
  return { nickname: name, contact: privateContact, playerId };
}

// Trust Netlify's context, never a caller-supplied X-Forwarded-For header.
export function visitorHash(context, key) {
  if (!context?.ip || typeof context.ip !== 'string') throw new ApiError(503, 'We could not identify this connection. Please try again.');
  return keyedHash('visitor-ip', context.ip, key);
}

// Compare-and-set prevents concurrent requests from both spending the same allowance.
// This reservation is deliberately not rolled back if a later write fails: fail closed.
export async function reserveSubmission(store, visitor, runId) {
  const blobKey = `rate/${visitor}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = await store.getWithMetadata(blobKey, { type: 'json' });
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const previous = entry?.data;
    const count = previous?.day === day ? previous.count : 0;
    if (previous && now - previous.lastAt < SUBMISSION_INTERVAL_MS) {
      const seconds = Math.ceil((SUBMISSION_INTERVAL_MS - (now - previous.lastAt)) / 1000);
      throw new ApiError(429, `Please wait ${seconds} seconds before submitting again.`, { 'Retry-After': String(seconds) });
    }
    if (count >= DAILY_LIMIT) {
      const tomorrow = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
      throw new ApiError(429, 'This connection has reached 30 submissions today. Please try again tomorrow (UTC).', { 'Retry-After': String(Math.ceil((tomorrow - now) / 1000)) });
    }
    const result = await store.setJSON(blobKey, { day, count: count + 1, lastAt: now, runId },
      entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (result.modified) return;
  }
  throw new ApiError(503, 'Several submissions arrived together. Please try again shortly.');
}

export function compareScores(a, b) {
  return b.score - a.score || a.submittedAt - b.submittedAt || a.runId.localeCompare(b.runId);
}
