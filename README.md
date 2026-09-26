# ESportsBattle Rank

A static site with a public leaderboard and rating history for ESportsBattle players
(`index.html`), plus an admin panel for managing players, ratings and
achievements (`admin.html`). It is plain HTML, CSS and JavaScript: no build step, no
runtime dependencies and no server of its own. Match results come from Google Sheets,
configuration comes from Supabase, and ratings are computed in the browser.

## How it works

```
Google Sheets (match results)   ──>  js/sheets.js ─┐
                                                   ├─> js/engine.js ─> leaderboard + history
Supabase tables (players, settings, ...) ──────────┘   (computeRatings)
                                                              │
                          js/app.js (public page) <───────────┤
                          js/admin.js (admin panel) <─────────┘
```

### Match results: Google Sheets (`js/sheets.js`)

1. **Index doc** (`SHEETS_INDEX_ID`): one row per year, column B = year, column C = link
   to that year's doc.
2. **Yearly doc**: one tab per month, named `Jan26`, `Feb26` … `Dec26` (month
   abbreviation plus the last two digits of the year).
3. **Month tab**: row 1 is a header. Columns A–J are Date (`DD.MM.YYYY`), Tournament,
   Time, Team1, Team2, Player1, Player2, Score1, (empty), Score2. Rows without both
   players, without numeric scores or with an impossible date are skipped.

Sheets are read as CSV through the `gviz/tq?tqx=out:csv` endpoint with no credentials,
so the docs must be readable by anyone with the link. Matches are sorted by date and,
within a day, by sheet row. The row order matters: it is the order in which the engine
applies a day's matches, and the row number is part of the match signature used for points.

### Rating engine (`js/engine.js`)

`buildRatings()` loads the sheets plus `player_config`, `rating_adjustments`,
`settings` and `rating_groups`, then calls `computeRatings()`. Both pages run it.

- Only nicknames in `player_config` take part. A player is rated from their
  `initial_rating`, or from the first adjustment that sets their rating.
- The engine walks the days that have matches or adjustments, in date order. On each
  day it first applies that day's `rating_adjustments` (the rating becomes
  `new_rating` at the start of the day), then plays the day's matches in sheet order,
  then records an entry for every rated player. A match counts only when both players
  are rated and neither is suspended (`suspended_from`/`suspended_to`) on that day.
  Adjustments dated after today (or after the last match day, if later) wait until
  their date, so a monthly reset saved ahead of time does not change ratings early.
- **Points.** Each match gets a base value from a deterministic hash of its signature:
  `min + k` for a whole number `k` from 0 to `max − min`. A win adds
  `base × coef` (the winner's group coefficient) to the winner and takes the same
  amount from the loser. In a draw, both players get the draw base when their
  coefficients are equal; otherwise, with `coef` the weaker player's (larger)
  coefficient, the weaker player gets `base × coef` and the stronger one `base ÷ coef`.
- **Formula settings** are `settings` rows `WinMin`/`WinMax` (default 3/3) and
  `DrawMin`/`DrawMax` (default 1/1). A missing, non-numeric or negative value falls back
  to its default. Because `k` is a whole number, `max − min` must be a whole number:
  2.5–4.5 works, 2.5–3 does not (it could award more than the max). The admin panel's
  Formula tab enforces this and `min ≤ max`.
- **Groups** come from `rating_groups`. `normalizeGroups()` turns them into
  `{ id, name, min, color, coef }` sorted by `min` descending; a missing or non-positive
  `coef` counts as 1, and a colour that is not a hex value is shown grey. A player's
  group is the highest one whose `min` they reach (else the lowest group). With no groups
  at all the engine throws "No rating groups configured".

`buildRatings()` returns `{ leaderboard, history, groups }`:

- `leaderboard`: `[{ rank, nickname, rating, group }]`, highest rating first (ratings are
  rounded to 2 decimals; ties are ordered by nickname).
- `history`: `{ [nickname]: entries[] }`, sorted by date. For every processed day each
  rated player gets one **end-of-day** entry `{ date, rating, games }`, where `games` is
  the number of that player's matches that counted that day. When adjustments set a
  player's rating that day, a **start** entry `{ date, rating, start: true, reset }`
  comes right before the end entry: `rating` is the value after the adjustments and
  before the matches, and `reset` is true when one of them was a `monthly_reset`. The
  last entry of a series is always an end entry.
- `groups`: the normalized groups.

Ratings are reset monthly: the admin panel's Monthly Reset tab saves one `rating_adjustments`
row per player with reason `monthly_reset` for the chosen date. Rating changes shown on
the site ("7 days", "1 day") use `monthDelta(series, days)` from `js/common.js`, which
never reaches back before the start of the latest month.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `css/styles.css` | Public page. |
| `admin.html`, `css/admin.css` | Admin panel. |
| `js/common.js` | Shared config (`SUPABASE` URL, publishable key, bucket names) and helpers: Supabase headers, avatars, escaping (`escapeHtml`, `safeUrl`, `safeColor`), dates, `groupForRating`, `monthDelta`. |
| `js/sheets.js` | Reads matches from Google Sheets. |
| `js/engine.js` | Supabase reads (`sbFetch`, `sbFetchAll`) and the rating engine. |
| `js/app.js` | Public page UI: leaderboard, search, profile, chart, compare, achievements. Reloads the data every 10 minutes while the tab is visible. |
| `js/admin.js` | Admin panel UI. |
| `icons/favicon.svg` | Favicon. |
| `supabase/functions/esb-sync/index.ts` | Edge function that copies matches from the ESportsBattle API (see below). |
| `supabase/migrations/` | SQL for Row Level Security and admin accounts. |
| `tests/` | Unit tests (Node's built-in test runner). |

The pages load their scripts as classic `defer` scripts, in this order:
`index.html` loads `common.js`, `sheets.js`, `engine.js`, `app.js`; `admin.html` loads
`common.js`, `sheets.js`, `engine.js`, `admin.js`. They share one global scope, so a
top-level name must be declared in only one of the files loaded by a page.

## Supabase

### Tables

| Table | Columns the code uses | Read by | Written by |
| --- | --- | --- | --- |
| `player_config` | `nickname`, `initial_rating`, `suspended_from`, `suspended_to`, `active` | engine, admin | admin (add, delete players) |
| `rating_adjustments` | `id`, `nickname`, `new_rating`, `applied_date`, `reason` | engine, admin | admin (Monthly Reset, Adjustments tabs) |
| `settings` | `key` (unique), `value` | engine, admin, esb-sync (`esb_sync_cursor`) | admin (Formula tab); esb-sync (`esb_sync_cursor` row) |
| `rating_groups` | `id`, `name`, `min_rating`, `color`, `coef` | engine, admin | admin (Groups tab edits existing rows) |
| `hidden_players` | `nick` | public page, admin | admin |
| `achievements` | `id`, `name`, `icon_url`, `url` | public page, admin | admin |
| `player_achievements` | `nick`, `achievement_id` | public page, admin | admin |
| `admin_log` | `id`, `created_at`, `action`, `details`, `email` | admin | admin |
| `admin_users` | `user_id`, `created_at` | `is_admin()` only | SQL editor / service role |
| `matches` | `external_id`, `date`, `time`, `tournament`, `team1`, `team2`, `player1`, `player2`, `score1`, `score2`, `source` | esb-sync only (duplicate check); nothing in the site | esb-sync |

`suspended_from`/`suspended_to` have no UI; set them with SQL. `active` is written when a
player is added but is not read. Storage buckets (both public): `player-avatars` holds
`<nickname>.png` (URL-encoded nickname); `achievements` holds achievement icons.

### Security model

- The publishable key in `js/common.js` ships to every visitor by design. It only
  identifies the project; Row Level Security decides what a request may do.
- `supabase/migrations/20260926000000_admin_only_writes.sql` makes every site table
  readable by anyone and writable only by admins, makes `admin_log` admin-only, and
  lets only admins upload, replace or delete objects in the two buckets. An admin is a
  Supabase Auth user listed in `public.admin_users`; the policies call
  `public.is_admin()`.
- The admin panel signs in with Supabase Auth (email and password), keeps the session in
  `localStorage` (`esb_admin_session`), refreshes it when it expires and sends the user's
  access token with all of its own reads and writes (the shared `buildRatings()` reads
  use the publishable key). After login it calls `POST /rest/v1/rpc/is_admin` and signs
  out an account that is not an admin.
- The esb-sync function uses the service role key, which bypasses RLS.

Rollout of the migration:

1. Apply it: paste it into the Supabase SQL editor and run it, or `supabase db push`.
   It is safe to run again.
2. Add each admin (the user must already exist under Authentication > Users):
   ```sql
   insert into public.admin_users (user_id)
   select id from auth.users where email = 'admin@example.com';
   ```
3. Deploy the new front end. The old admin panel writes with the publishable key, so
   its writes stop working as soon as step 1 runs.

Disabling public sign-ups is recommended but not required, since every write checks
`admin_users`.

## Local development

```sh
python3 -m http.server 8000     # from the repository root
```

Open <http://localhost:8000/index.html> (admin panel: `/admin.html`). There is nothing to
build. The pages use the live Supabase project and Google Sheets configured in
`js/common.js` and `js/sheets.js`, so anything saved in the admin panel changes
production data.

## Tests

```sh
npm test
```

Requires Node.js 20 or newer and has no dependencies to install. The tests load the
site's scripts into one `vm` context the way the pages do (`tests/helpers/load.js`) and
stub `fetch`.

## esb-sync edge function

`supabase/functions/esb-sync/index.ts` (Deno, supabase-js v2) fetches finished
tournaments at Stamford Bridge (`ECF-location-1`) from
`football.esportsbattle.com/api`, day by day, and inserts their matches into `matches`,
skipping `external_id`s that are already there. **Nothing in the site reads the
`matches` table today**; the leaderboard uses Google Sheets.

- **Auto mode** (GET, or POST without `dateFrom`): starts at the `esb_sync_cursor`
  row in `settings` (2026-01-01 if it does not exist) and syncs up to 14 days, never past
  today. The cursor moves to the first day the run did not finish; once caught up it is
  set to yesterday, so each run re-checks yesterday and today.
- **Manual mode**: `POST {"dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD"}`
  (`dateTo` defaults to today). Syncs up to 14 days of that range and never moves the
  cursor; continue with the returned `nextDateFrom`.
- A failed ESB request (non-OK status, network error, invalid JSON or 15 s timeout) or a
  failed duplicate check or insert marks that day as failed. The run stops there and, in auto
  mode, the cursor stays on that day so it is retried next time. If a day keeps failing,
  the `errors` in the response say why; the cursor can be moved by editing the
  `esb_sync_cursor` row. Matches without an id or a `YYYY-MM-DD` date, and match lists
  that are not arrays, are skipped and reported in `errors` without failing the day.
  No new day is started after about 100 seconds.
- Response: HTTP 200 `{ ok, mode, processedFrom, processedUpTo, remaining,
  nextDateFrom, sbTournamentsFound, inserted, errorCount, errors }` for every completed
  run (`ok` is false if anything failed; `errors` holds the first 10). 400 for invalid
  input (bad or impossible dates, `dateFrom` after `dateTo`, `dateTo` without
  `dateFrom`), 401 for a wrong secret, 405 for other methods, 500 for an unreadable or
  invalid cursor and unexpected errors.
- **`SYNC_SECRET`**: when this function secret is set, every call must send the header
  `x-sync-secret: <value>`, otherwise it gets 401. When it is not set, anyone who can
  reach the function URL can run it.

Deploy and configure it with the Supabase CLI:

```sh
supabase secrets set SYNC_SECRET=<random value>
supabase functions deploy esb-sync
```

The Supabase gateway also verifies a JWT in `Authorization` unless the function is
deployed with `--no-verify-jwt`; `SYNC_SECRET` is checked either way. Nothing in this
repository schedules the function; whatever calls it must send the secret once it is
set.
