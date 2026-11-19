# Flappy Bikes leaderboard

The game calls the public endpoints below. The separate admin page is for the organizer only.

## Endpoints

- **POST `/.netlify/functions/start-run`**: returns a signed `token`, server
  `startedAt`, and `expiresAt`. Call when the player starts, not after finishing.
- **POST `/.netlify/functions/submit-score`**: checks and saves
  `{ token, score, nickname, contact }` as JSON.
- **GET `/.netlify/functions/leaderboard?period=daily|weekly|alltime`**: returns
  `contest: { status, start, end }` and
  `period`, `winner` (All Time winner when ended, otherwise null), and
  `top10: [{ rank, nickname, score, playerId }]`. The public player ID is a one-way
  identifier used for highlighting, not a contact. Status is `not started`, `open`, or
  `ended`. No public endpoint returns contact information.

The default period is `alltime`. Daily means today in Israel; Weekly starts on
Sunday in Israel (`Asia/Jerusalem`, including daylight saving changes). All Time
is limited to the configured contest window and decides the prize winner.
Each nickname/contact pair gets one entry per period: its best score in that period.
An older high score does not hide a lower score submitted today. Existing runs
are included automatically using their original submission times; no migration
or reset is needed. The submit response also returns the public `playerId`, so
the browser can highlight the correct rider even when nicknames are shared.
Devices that have not submitted since this update still use nickname matching.
Ties go to the earliest server submission. Letter case, Instagram's `@`,
and phone formatting are ignored when identifying a pair.

## Environment variables in Netlify

Open **Project configuration → Environment variables** and set these with
**Functions** scope (or all scopes). Never put the secret in browser code or Git.

| Variable | What to enter |
| --- | --- |
| `LEADERBOARD_SECRET` | Required: at least 32 random characters. Use the generator below. |
| `ADMIN_PASSWORD` | A separate long random password for the private admin page. Set it with Functions scope; never put it in HTML or Git. |
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
Ranking selects each player's best after filtering by period, so simultaneous
submissions cannot overwrite a better score. A private `ranking-cache/` snapshot
reuses unchanged records by their storage ETags. Requests list journal versions
and download only new or changed records; the first request builds the cache
from older runs. The cache contains no contacts. Admin reads contacts only for
the selected top 50. Deletes and resets are detected from journal versions, so
there is no separate score-index write that could lose an accepted submission.
Listing and ranking still grow with the number of runs; very large campaigns
should move to an indexed database. This is not a constant-time database index.

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
4. The game already connects run start, score submission, and leaderboard display.
   Check the deployed game before opening the contest.
5. Choose the winning-run verification process before launching the prize contest.

Errors are JSON `{ "error": "friendly explanation" }`: 400/413/415 for input,
401 for invalid tokens, 403 for closed contests, 405 for wrong methods,
409 for reused runs, 410 for expiry, 422 for impossible timing,
429 for limits (with `Retry-After`), and 503 for setup/storage problems.

References: [Netlify Functions](https://docs.netlify.com/build/functions/api/)
and [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/).

## Private admin page

1. Set `ADMIN_PASSWORD` in Netlify's environment variables (Functions scope),
   using a different random password from `LEADERBOARD_SECRET`, then redeploy.
   Login IP hashes use the admin password as their HMAC key, separately from run signing.
2. Open `https://YOUR-SITE.netlify.app/admin.html` directly. It is not linked in
   the game and has `noindex`. The HTML login screen is public; the password
   protects every data request and action. Use HTTPS.
3. Sign in. The password stays only in memory for that tab and is sent in the
   `Authorization: Bearer <password>` header. It is never put in URLs, browser
   storage, logs, or responses. Reload, leave the page, or Sign out to clear it.
4. Select Daily, Weekly, or All Time. Each shows up to 50 players, with each
   nickname/contact pair's best score **within that period**. Daily means today
   in Israel; Weekly means the current Sunday–Saturday week in Israel; All Time
   means all scores for the currently configured contest. Submission times and
   contest dates use `Asia/Jerusalem`, including daylight saving time.
5. Use **Copy winner details** on All Time to copy #1's nickname, score, contact,
   and submission time. It copies personal information to your clipboard, so
   keep it private. Verify the winner before awarding the prize.

Missing/wrong passwords return 401. After 5 failures from the same hashed IP in
a rolling 15-minute window, requests return 429 with `Retry-After`, including
correct-password requests until the window frees up. Shared Wi-Fi shares this
limit. Failed attempts store timestamps and an HMAC IP hash, never raw IPs or
passwords. Storage failures deny access instead of bypassing the limit.

### Delete one entry

Click Delete and confirm. This deletes that accepted run's score and contact;
a null marker retains its used-token protection. Public endpoints ignore that
marker. A player's lower score can then reappear: this deletes one entry, not
every run by that person, and does not ban them from submitting future runs.

### Reset for a fresh contest

Reset permanently deletes **all** score and used-run records and ranking caches, including old
contest groups and deletion markers. It preserves visitor rate limits and admin
login lockouts. It does not change contest dates or environment variables.

Before resetting, close submissions with the contest dates, rotate
`LEADERBOARD_SECRET`, and redeploy. Allow any in-flight submissions to finish.
Then click the red Reset leaderboard button and type exactly `RESET`. Set the
new contest dates and redeploy when ready to reopen it. Password-protected admin
access continues to work while the contest is closed.

This storage reset is not a transaction with public submissions, and public
endpoint logic is unchanged. Without closing submissions and changing the
signing secret, ongoing runs or still-valid old tokens can add scores again.
A failed reset may be partial; refresh and repeat it after resolving the error.
Do not reset a live contest or assume a site redeploy backs up Blobs.

### Admin API (for reference)

Every request requires `Authorization: Bearer <password>`. Do not paste actual
passwords into URLs or shared command histories.

- `GET /.netlify/functions/admin?period=daily|weekly|alltime` returns `contest`,
  `period`, `timezone`, `totalPlayers`, and `entries`. Entries include `id`,
  `rank`, `nickname`, `score`, `contact`, `submittedAt` (ISO), and
  `submittedAtIsrael` (readable Israel time). Default period: `alltime`.
- `POST /.netlify/functions/admin` with JSON `{ "action": "delete", "id": "ENTRY_ID" }`.
- `POST /.netlify/functions/admin` with JSON `{ "action": "reset", "confirm": "RESET" }`.

Admin responses use `Cache-Control: no-store`. Contacts are only returned by this
authenticated endpoint. Use a separate Netlify
site for testing because previews of the same site share production Blobs.

## Checking the three boards

1. Deploy to a separate test Netlify site, or use Netlify Dev. Opening the HTML
   file directly cannot call Functions. Keep the contest dates unchanged when
   checking existing scores, since changing dates selects a different contest.
2. Open Leaderboard: All Time should be selected and marked Prize board. Tap
   Daily and Weekly, including quickly switching while a request is loading.
3. Submit different runs with the same nickname and contact (wait at least
   20 seconds between submissions). Each board should show one best score for
   that pair. Your entry should be highlighted after a successful submission.
4. With scores from earlier days, confirm today's board uses only today's runs
   and Weekly uses only runs since Sunday in Israel. Check around Israel midnight
   and Saturday-to-Sunday midnight; the browser's local timezone should not matter.
5. Open the private admin page and compare each period with the public board.
   Delete a test run and refresh every affected tab. A remaining lower score may
   appear. Only on the test site, follow the reset instructions above and confirm
   all three boards become empty.
6. Inspect the public endpoint responses: no contact fields should appear.
   After the contest ends, every tab's winner message must name All Time #1,
   even if today's board is empty or has a different leader.
