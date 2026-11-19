import { contest, failure, json, requireMethod, secret, storage } from '../lib/leaderboard.js';
import { publicPlayerId, rankingRecords, rankPeriod, requestedPeriod } from '../lib/rankings.js';

export default async function handler(request) {
  try {
    requireMethod(request, 'GET');
    const key = secret();
    const now = Date.now();
    const window = contest(now);
    const period = requestedPeriod(request);
    const records = window.status === 'not started' ? [] : await rankingRecords(storage(), window.id);
    const scores = rankPeriod(records, window, period, now);
    const winner = window.status === 'ended' ? rankPeriod(records, window, 'alltime', now)[0] : null;
    return json({
      period,
      winner: winner ? { nickname: winner.nickname, score: winner.score } : null,
      contest: { status: window.status, start: window.start, end: window.end },
      // Explicit allowlist: never spread a stored record into a public response.
      top10: scores.slice(0, 10).map((entry, index) => ({ rank: index + 1, nickname: entry.nickname, score: entry.score, playerId: publicPlayerId(entry.playerId, key) })),
    });
  } catch (error) { return failure(error); }
}
