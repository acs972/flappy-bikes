import { bestScores, contest, failure, json, requireMethod, storage } from '../lib/leaderboard.js';

export default async function handler(request) {
  try {
    requireMethod(request, 'GET');
    const window = contest();
    const scores = window.status === 'not started' ? [] : await bestScores(storage(), window.id);
    return json({
      contest: { status: window.status, start: window.start, end: window.end },
      // Explicit allowlist: never spread a stored record into a public response.
      top10: scores.slice(0, 10).map((entry, index) => ({ rank: index + 1, nickname: entry.nickname, score: entry.score })),
    });
  } catch (error) { return failure(error); }
}
