# Flappy Bikes leaderboard

Backend only: the game is unchanged and does not call these endpoints yet.

## Endpoints

- **POST `/.netlify/functions/start-run`**: returns a signed `token`, server
  `startedAt`, and `expiresAt`. Call when the player starts, not after finishing.
- **POST `/.netlify/functions/submit-score`**: checks and saves
  `{ token, score, nickname, contact }` as JSON.
- **GET `/.netlify/functions/leaderboard`**: returns
  `contest: { status, start, end }` and
  `top10: [{ rank, nickname, score }]`. Status is `not started`, `open`, or
  `ended`. No endpoint returns contact information.

Each nickname/contact pair gets one leaderboard entry: its best score.
Ties go to the earliest server submission. Letter case, Instagram's `@`,
and phone formatting are ignored when identifying a pair.

## Environment variables in Netlify

Open **Project configuration → Environment variables** and set these with
**Functions** scope (or all scopes). Never put the secret in browser code or Git.

| Variable | What to enter |
| --- | --- |
| `LEADERBOARD_SECRET` | Required: at least 32 random characters. Use the generator below. |
| `CONTEST_START` | Optional ISO time, e.g. `2026-12-01T09:00:00+02:00`. |
| `CONTEST_END` | Optional ISO time, e.g. `2026-12-08T18:00:00+02:00`. |

Generate a secret locally with Node.js:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Choose your actual dates, including timezone. Start is inclusive; end is exclusive.
Neither date set means open for testing. One date set applies only that boundary.
Invalid dates block requests. Keep the secret stable during the contest.

## Validation and private data

Tokens expire after 30 minutes and cannot be reused. Scores must be integers
from 0 to 9999. Timing uses the game's 0.25-second initial spawn and 1.65-second
spacing. The speed calculation and conservative resize allowance are documented
in [score-timing.js](netlify/lib/score-timing.js).

Nicknames allow 2–12 English/Hebrew letters, numbers, spaces, and basic punctuation,
with a simple bad-word filter. Contact is an Instagram handle or phone number,
up to 40 characters; phones need 7–15 digits. Ownership is not verified.

All data is in the private **leaderboard** Blobs store. Netlify supplies access
automatically. One atomic write saves each accepted run and consumes its ID.
Ranking reads these records and selects each player's best, so simultaneous
submissions cannot overwrite a better score. Larger campaigns should add a
ranking index/database because ranking currently reads the contest's full journal.

Limits are one submission per 20 seconds and 30 per UTC day, using a secret-keyed
IP hash. No raw IPs are stored by this code. Shared Wi-Fi shares a limit.
Conditional writes protect concurrent requests. A failure after reserving an
allowance may still consume it; wait before retrying. A 409 means already saved.

Changing contest dates creates a separate ranking and invalidates old contest
tokens. Old records remain private. Changing the secret changes player/IP hashes
and invalidates tokens. Use a separate Netlify site for testing: previews on the
same site share this store.

The organizer can find winner contacts in Netlify's Blobs dashboard. Delete
private data after the contest when no longer needed, but retain used-run
records while tokens are still valid. Do not publish dashboard exports.

## Before awarding the free day on two bikes

**Timing checks cannot prove someone played.** Someone can start a run, wait,
then submit an invented score. Before awarding the prize, add server-verified
gameplay (server-issued obstacles plus a checked input replay), or require an
organizer-supervised winning run. Contact verification and nickname moderation
also need a separate process.

## Next steps

1. Install Node.js 22.12 or newer. Run `npm install` here and commit the generated
   `package-lock.json`.
2. Connect the Git repository to Netlify and deploy. The configuration publishes
   the project root and builds `netlify/functions`. Plain drag-and-drop uploads
   do not build functions.
3. Set the environment variables and redeploy. Check the endpoints on a separate
   test site first. For local work use Netlify Dev; opening HTML directly cannot
   run the backend.
4. Next, connect the game to run start, score submission, and leaderboard display.
   Render nicknames as text and explain why contact details are collected.
5. Choose the winning-run verification process before launching the prize contest.

Errors are JSON `{ "error": "friendly explanation" }`: 400/413/415 for input,
401 for invalid tokens, 403 for closed contests, 405 for wrong methods,
409 for reused runs, 410 for expiry, 422 for impossible timing,
429 for limits (with `Retry-After`), and 503 for setup/storage problems.

References: [Netlify Functions](https://docs.netlify.com/build/functions/api/)
and [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/).
