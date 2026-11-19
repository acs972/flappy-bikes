import { ApiError, compareScores, keyedHash } from './leaderboard.js';

const israelDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
});

// Calendar dates handle Israel's daylight-saving changes without assuming 24-hour days.
export function israelDay(timestamp) {
  const parts = Object.fromEntries(israelDate.formatToParts(timestamp).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000;
}

// Both public and admin requests accept exactly the same three periods.
export function requestedPeriod(request) {
  const period = new URL(request.url).searchParams.get('period') || 'alltime';
  if (!['daily', 'weekly', 'alltime'].includes(period)) throw new ApiError(400, 'Choose daily, weekly, or alltime.');
  return period;
}

// A one-way identifier lets the browser highlight its player without publishing contact details.
export function publicPlayerId(playerId, key) {
  return keyedHash('public-player', playerId, key);
}

// Reuse unchanged journal records. The strong listing's ETags detect new scores,
// deletion markers and resets; a failed cache write never loses an accepted score.
// This cache deliberately contains no contacts. Admin fetches those only for its top 50.
export async function rankingRecords(store, contestId) {
  const cacheKey = `ranking-cache/${contestId}`;
  const [listing, cached] = await Promise.all([
    store.list({ prefix: `runs/${contestId}/` }),
    store.getWithMetadata(cacheKey, { type: 'json' }),
  ]);
  const previous = cached?.data?.version === 1 ? cached.data.records : {};
  const records = {};
  let changed = Object.keys(previous).length !== listing.blobs.length;
  for (let offset = 0; offset < listing.blobs.length; offset += 16) {
    await Promise.all(listing.blobs.slice(offset, offset + 16).map(async blob => {
      if (previous[blob.key]?.etag === blob.etag) {
        records[blob.key] = previous[blob.key];
        return;
      }
      changed = true;
      const entry = await store.getWithMetadata(blob.key, { type: 'json' });
      if (!entry) return;
      const value = entry.data;
      records[blob.key] = { etag: entry.etag, value: value ? {
        runId: value.runId, playerId: value.playerId, nickname: value.nickname,
        score: value.score, submittedAt: value.submittedAt,
      } : null };
    }));
  }
  if (changed || !cached) {
    try {
      await store.setJSON(cacheKey, { version: 1, records },
        cached ? { onlyIfMatch: cached.etag } : { onlyIfNew: true });
    } catch { /* The journal remains authoritative even if caching is unavailable. */ }
  }
  return Object.values(records).map(entry => entry.value).filter(Boolean);
}

// Filter submissions BEFORE selecting personal bests, so a lower new score can win today.
export function rankPeriod(records, window, period, now = Date.now()) {
  const today = israelDay(now);
  const sunday = today - new Date(today * 86400000).getUTCDay();
  const start = window.start ? Date.parse(window.start) : -Infinity;
  const end = window.end ? Date.parse(window.end) : Infinity;
  const best = new Map();
  for (const record of records) {
    const time = record.submittedAt;
    if (!Number.isFinite(time) || time > now || time < start || time >= end) continue;
    const day = israelDay(time);
    if (period === 'daily' && day !== today) continue;
    if (period === 'weekly' && (day < sunday || day > today)) continue;
    const previous = best.get(record.playerId);
    if (!previous || compareScores(record, previous) < 0) best.set(record.playerId, record);
  }
  return [...best.values()].sort(compareScores);
}
