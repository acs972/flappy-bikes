import { contest, failure, json, requireMethod, requireOpen, RUN_LIFETIME_MS, secret, signRun } from '../lib/leaderboard.js';

export default async function handler(request) {
  try {
    requireMethod(request, 'POST');
    const key = secret();
    const now = Date.now();
    const window = contest(now);
    requireOpen(window);
    return json({ token: signRun(key, window.id, now), startedAt: new Date(now).toISOString(), expiresAt: new Date(now + RUN_LIFETIME_MS).toISOString() }, 201);
  } catch (error) { return failure(error); }
}
