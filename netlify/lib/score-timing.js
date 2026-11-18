// Values read from index.html: startGame, addObstacle, update, resetBike, resize.
// For play width W: speed=max(145, .42*W) px/s; obstacle width=max(54, .13*W).
// First spawn: .25 s. Subsequent spawns: every 1.65 s (239.25–350.658 px apart).
// Spawn x=W+35; bike x=.24*W; scoring requires right edge < bike x-26.
// On a fixed screen, travel time=(.76*W + 61 + max(54,.13*W))/max(145,.42*W).
// E.g. W=338.5 (375px phone): first point ~2.817s; W=506: ~2.656s.
// The API has no trusted viewport data, and the game allows resizing mid-run,
// which rescales obstacles. Therefore we do NOT enforce fixed-screen travel time:
// the safe cross-device lower bound is the spawn time of the score-th obstacle.
// Speed cannot produce a point before that obstacle exists. Allow .10s total
// margin, including the same-frame movement (frame dt is capped at .035s).
// Update this formula if spawning/scoring changes. No client clock is trusted.
export function minimumRunSeconds(score) {
  if (score === 0) return 0;
  return Math.max(0, 0.25 + (score - 1) * 1.65 - 0.10);
}
