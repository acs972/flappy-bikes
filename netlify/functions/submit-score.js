import { ApiError, contest, failure, json, readSubmission, requireMethod, requireOpen, reserveSubmission, secret, storage, validatePlayer, validateScore, verifyRun, visitorHash } from '../lib/leaderboard.js';
import { minimumRunSeconds } from '../lib/score-timing.js';

export default async function handler(request, context) {
  try {
    requireMethod(request, 'POST');
    const key = secret();
    const body = await readSubmission(request);
    const receivedAt = Date.now();
    const window = contest(receivedAt);
    requireOpen(window);
    const run = verifyRun(body.token, key, window.id, receivedAt);
    const score = validateScore(body.score);
    const player = validatePlayer(body.nickname, body.contact, key);
    if ((receivedAt - run.startedAt) / 1000 < minimumRunSeconds(score)) {
      throw new ApiError(422, 'That score arrived too quickly for this game. Please play a new run and try again.');
    }
    const store = storage();
    const runKey = `runs/${window.id}/${run.id}`;
    if (await store.getMetadata(runKey)) throw new ApiError(409, 'This run has already been submitted. Please start a new run.');
    await reserveSubmission(store, visitorHash(context, key), run.id);
    // Check again after storage waits so an expired/closed run cannot slip through.
    const commitAt = Date.now();
    requireOpen(contest(commitAt));
    verifyRun(body.token, key, window.id, commitAt);
    // Rank ties by server receipt time, not by how quickly storage responded.
    const submittedAt = receivedAt;
    const result = await store.setJSON(runKey, {
      runId: run.id,
      playerId: player.playerId,
      nickname: player.nickname,
      contact: player.contact, // Private Blobs value only; never included in responses.
      score,
      startedAt: run.startedAt,
      submittedAt,
    }, { onlyIfNew: true });
    if (!result.modified) throw new ApiError(409, 'This run has already been submitted. Please start a new run.');
    return json({ message: 'Score saved. Only your best score appears on the leaderboard.', score, submittedAt: new Date(submittedAt).toISOString() }, 201);
  } catch (error) { return failure(error); }
}
