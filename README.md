# ESportsBattle Rank

A static site with a public leaderboard and rating history for ESportsBattle players
(`index.html`), plus an admin panel for managing players, ratings and
achievements (`admin.html`), with roles and permissions for its admins. It is plain HTML,
CSS and JavaScript: no build step, no runtime dependencies and no server of its own
(two Supabase Edge Functions aside). Match results come from Google Sheets,
configuration comes from Supabase, and ratings are computed in the browser.

The site is an **alpha** version: both pages show an "ALPHA PRODUCT" notice saying it is
not the final product.

## How it works

```
Google Sheets (match results)   ──>  js/sheets.js ─┐
                                                   ├─> js/engine.js ─> leaderboard + history
Supabase tables (players, settings, ...) ──────────┘   (computeRatings)
                                                              │
                          js/app.js (public page) <───────────┤
                          js/admin.js (admin panel) <─────────┘
```

### Work day

The firm's work day runs from 07:30 to 07:30 the next morning, Kyiv time (`Europe/Kyiv`:
UTC+2 in winter, UTC+3 in summer). Every date in the rating data is a work day, not a
calendar day. The match sheets already date each row by its work day: a date's block of
rows starts at 07:30 and runs past midnight, so a match at 01:15 keeps the previous date.
`rating_adjustments.applied_date` is a work day as well.

`js/common.js` has the helpers. They format with `Intl` in the `Europe/Kyiv` time zone, so
the viewer's own time zone never matters:

- `kyivWallClock(instant)`: Kyiv date and time, `{ date: "YYYY-MM-DD", time: "HH:MM:SS" }`.
- `workDayOffset(time)`: seconds since 07:30 for an `H:MM` or `H:MM:SS` time (`07:29:59`
  is the work day's last second), or null.
- `workDayOf(instant)`: the work day an instant belongs to (a Kyiv time before 07:30 still
  belongs to the previous day). `workDayOf()` is the current work day.
- `adjustmentMoment(row)`: when a `rating_adjustments` row takes effect (see below).

### Match results: Google Sheets (`js/sheets.js`)

1. **Index doc** (`SHEETS_INDEX_ID`): one row per year, column B = year, column C = link
   to that year's doc.
2. **Yearly doc**: one tab per month, named `Jan26`, `Feb26` … `Dec26` (month
   abbreviation plus the last two digits of the year).
3. **Month tab**: row 1 is a header. Columns A–J are Date (`DD.MM.YYYY`, the work day),
   Tournament, Time (Kyiv, `H:MM` or `H:MM:SS`), Team1, Team2, Player1, Player2, Score1,
   (empty), Score2. Rows without both players, without numeric scores or with an
   impossible date are skipped. Each match gets `time` as `HH:MM:SS`, or null when
   column C is not a valid time; such a row still counts as a match.

Sheets are read as CSV through the `gviz/tq?tqx=out:csv` endpoint with no credentials,
so the docs must be readable by anyone with the link. Matches are sorted by date and,
within a day, by sheet row (which is time order). The row order matters: it is the order in
which the engine applies a day's matches, and the row number is part of the match signature
used for points. The time is not part of the signature; the engine uses it only to place
adjustments saved during the day.

### Rating engine (`js/engine.js`)

`buildRatings()` loads the sheets plus `player_config`, `rating_adjustments`,
`settings` and `rating_groups`, then calls `computeRatings()`. Both pages run it.

- Only nicknames in `player_config` take part. A player is rated from their
  `initial_rating`, or from the first adjustment that sets their rating.
- The engine walks the work days that have matches or adjustments, in date order. On
  each day it applies that day's start-of-day adjustments, then plays the day's matches in
  sheet order (applying adjustments saved during the day at their moment, see below), then
  records entries for every rated player. A match counts only when both players are rated
  and neither is suspended (`suspended_from`/`suspended_to`) on that day.
- **Adjustments** (`rating_adjustments`) set an absolute rating, `new_rating`. A manual
  adjustment is not a reset: the history before it stays, and later results build on the
  new value. When a row takes effect depends on its `applied_date` and on `created_at`,
  the moment the database saved it (`adjustmentMoment()` in `js/common.js`):
  - **Dated the work day it is saved on** (an adjustment for the current work day:
    `applied_date` is the work day of `created_at`): at the moment it was saved. It
    applies right before the first match of that day whose time is at or after that
    moment, or after the day's last match if there is none. Earlier matches of the day
    keep counting with the old rating. A match without a time never triggers it. Several
    such rows apply in the order they were saved (to the second), then by `id`.
  - **Dated another day** (backdated, saved ahead, or without `created_at`): at 07:30 of
    that work day, before its matches. Several apply in `id` order; the last one wins.
  - **Monthly reset** (`reason = monthly_reset`): at 07:30 of its date (the 1st),
    whenever it was saved.

  Adjustments dated after the current work day (`workDayOf()`) wait until their date, so a
  monthly reset saved ahead of time does not change ratings early. When the sheet already
  has matches on the next day (its clock is a little ahead), that day counts as well; a
  match dated further ahead is taken as a typo and releases nothing. An adjustment without a numeric `new_rating` or a
  `YYYY-MM-DD` `applied_date` is ignored.
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
  rated player gets, in this order:
  1. a **start** entry `{ date, rating, start: true, reset }`, only when start-of-day
     adjustments set the player's rating that day: `rating` is the value after them and
     before the matches, and `reset` is true when one of them was a `monthly_reset`;
  2. an **adjusted** entry `{ date, rating, adjusted: true, from, time }` for each
     adjustment of the player that applied during the day: `rating` is the value it set,
     `from` the rating just before it (null if the player was not rated yet) and `time`
     the Kyiv time it was saved (`HH:MM`);
  3. one **end-of-day** entry `{ date, rating, games }`, where `games` is the number of
     that player's matches that counted that day.

  The last entry of a series is always an end entry. `endEntries(series)` in
  `js/common.js` keeps only the end entries, one per day.
- `groups`: the normalized groups.

Ratings are reset monthly: the admin panel's Monthly Reset tab saves one `rating_adjustments`
row per player with reason `monthly_reset` for the chosen date, normally the 1st; the reset
applies at 07:30 that day. Saving inserts the new rows first and then deletes only the
reset rows of that date saved before them, so a failed save changes nothing and two saves
of the same month at once never leave it without a reset. Rating changes shown on the site ("7 days", "1 day") use
`monthDelta(series, days)` from `js/common.js`, which never reaches back before the start
of the latest month and never measures from an adjusted entry.

### Public page ratings

A player's profile shows two ratings:

- **Closing rating**: the rating at the close of the previous work day (07:30 Kyiv time),
  like a closing price. It stays the same for the whole work day.
- **Live rating**: the latest rating, including the current work day's matches and
  adjustments so far.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `css/styles.css` | Public page. |
| `admin.html`, `css/admin.css` | Admin panel. |
| `js/common.js` | Shared config (`SUPABASE` URL, publishable key, bucket names) and helpers: Supabase headers, avatars, escaping (`escapeHtml`, `safeUrl`, `safeColor`), dates, the Kyiv work day (`kyivWallClock`, `workDayOffset`, `workDayOf`, `adjustmentMoment`), `groupForRating`, `endEntries`, `monthDelta`. |
| `js/sheets.js` | Reads matches from Google Sheets. |
| `js/engine.js` | Supabase reads (`sbFetch`, `sbFetchAll`) and the rating engine. |
| `js/app.js` | Public page UI: leaderboard, search, profile, chart, compare, achievements. Reloads the data every 10 minutes while the tab is visible. |
| `js/admin.js` | Admin panel UI. |
| `icons/favicon.svg` | Favicon. |
| `supabase/functions/esb-sync/` | Edge function that copies matches from the ESportsBattle API: `sync.js` (the logic) and `index.ts` (Deno wiring). See below. |
| `supabase/functions/admin-users/` | Edge function behind the admin panel's Users tab: `handler.js` (the logic) and `index.ts` (Deno wiring). See below. |
| `supabase/migrations/` | SQL for Row Level Security, roles and permissions. |
| `supabase/tests/roles_test.sql` | SQL self-test of the roles rules; it rolls itself back. |
| `tests/` | Unit tests (Node's built-in test runner). |
| `DEPLOY.md` | The deployment runbook, in English and Ukrainian: the manual Supabase steps (migrations, the first super admin, the admin-users function, redeploying esb-sync) and the checks after them. |

The pages load their scripts as classic `defer` scripts, in this order:
`index.html` loads `common.js`, `sheets.js`, `engine.js`, `app.js`; `admin.html` loads
`common.js`, `sheets.js`, `engine.js`, `admin.js`. They share one global scope, so a
top-level name must be declared in only one of the files loaded by a page.

## Supabase

### Tables

| Table | Columns the code uses | Read by | Written by |
| --- | --- | --- | --- |
| `player_config` | `nickname`, `initial_rating`, `suspended_from`, `suspended_to`, `active` | engine, admin | admin (add, delete players) |
| `rating_adjustments` | `id`, `nickname`, `new_rating`, `applied_date`, `reason`, `created_at` (set by the database on insert; the roles migration adds it, with default `now()`, where it is missing) | engine, admin | admin (Monthly Reset, Adjustments tabs) |
| `settings` | `key` (unique), `value` | engine, admin, esb-sync (`esb_sync_cursor`) | admin (Formula tab); esb-sync (`esb_sync_cursor` row) |
| `rating_groups` | `id`, `name`, `min_rating`, `color`, `coef` | engine, admin | admin (Groups tab edits existing rows) |
| `hidden_players` | `nick` | public page, admin | admin |
| `achievements` | `id`, `name`, `icon_url`, `url` | public page, admin | admin |
| `player_achievements` | `nick`, `achievement_id` | public page, admin | admin |
| `admin_log` | `id`, `created_at` (both only defaults: the API cannot set them), `action`, `details`, `email` (a trigger sets it to the signed-in user's email) | admin (Log tab) | admin (every admin action) |
| `permissions` | `key`, `label`, `description`, `sort` | admin | the roles migration (a fixed list) |
| `roles` | `id`, `name`, `description`, `is_super`, `created_at` | admin, admin-users | admin (Roles tab) |
| `role_permissions` | `role_id`, `permission_key` | admin, admin-users | admin (Roles tab) |
| `user_roles` | `user_id` (primary key), `role_id`, `assigned_at`, `assigned_by` (both set by a trigger) | admin, admin-users, `my_access()` | admin (Users tab), admin-users |
| `admin_users` | `user_id`, `created_at` | nothing since the roles migration, which copied it into `user_roles` | SQL editor |
| `matches` | `external_id`, `date`, `time`, `tournament`, `team1`, `team2`, `player1`, `player2`, `score1`, `score2`, `source` | esb-sync only (duplicate check); nothing in the site | esb-sync |

`suspended_from`/`suspended_to` have no UI; set them with SQL. `active` is written when a
player is added but is not read. Storage buckets (both public): `player-avatars` holds
`<nickname>.png` (URL-encoded nickname); `achievements` holds achievement icons.

### Security model

- The publishable key in `js/common.js` ships to every visitor by design. It only
  identifies the project; Row Level Security decides what a request may do.
- Two migrations set up the rules:
  1. `supabase/migrations/20260926000000_admin_only_writes.sql` makes every site table
     readable by anyone and writable only by admins, makes `admin_log` admin-only, and
     lets only admins upload, replace or delete objects in the two buckets. An admin was
     a Supabase Auth user listed in `public.admin_users`.
  2. `supabase/migrations/20260927000000_roles.sql` replaces "any admin may write" with
     roles and permissions. It keeps the public reads, replaces the first migration's
     write policies (`esb_admin_*`) with per-permission ones (`esb_perm_*`) and copies
     `admin_users` into `user_roles` as super admins. It also works on a project where
     the first migration was never applied.
- An **admin** is a Supabase Auth user with a row in `public.user_roles`, which gives them
  exactly one role. A user without a role can sign in to Supabase but cannot read or
  change anything the public cannot.
- The database enforces every rule, with RLS policies and triggers. On the site tables,
  `admin_log` and the two buckets every write must pass a permissive and a restrictive
  policy, so an old "allow all" policy cannot open them again. The admin panel only hides
  what the role cannot use.
- The esb-sync function uses the service role key, which bypasses RLS. The admin-users
  function uses it only for the Auth admin API and for reads; it writes `user_roles` as
  the caller, so the policies apply to those writes.

#### Permissions

The list is fixed (seeded by the migration); roles combine them.

| Key | Shown as | Allows |
| --- | --- | --- |
| `players.edit` | Add and delete players | writes to `player_config` |
| `players.visibility` | Hide and show players | writes to `hidden_players` |
| `avatars.upload` | Upload player photos | uploads to the `player-avatars` bucket |
| `achievements.edit` | Create, edit and delete achievements | writes to `achievements`, uploads to the `achievements` bucket |
| `badges.assign` | Assign achievements to players | writes to `player_achievements` |
| `groups.edit` | Edit rating groups | writes to `rating_groups` |
| `reset.run` | Save monthly resets | `rating_adjustments` rows with reason `monthly_reset` |
| `adjustments.edit` | Add and delete rating adjustments | every other `rating_adjustments` row (another reason, or none) |
| `formula.edit` | Edit the rating formula | the `settings` rows `WinMin`, `WinMax`, `DrawMin`, `DrawMax` |
| `log.read` | Read the activity log | reading `admin_log` |
| `log.clear` | Clear the activity log | deleting from `admin_log` (Postgres deletes only rows you can read, so this needs `log.read` too) |
| `users.manage` | Create and delete users, assign roles | writes to `user_roles` and the admin-users function |

Creating, editing and deleting roles, and choosing their permissions (`roles` and
`role_permissions` writes), is for the super admin only. It is not a permission that can
be given to anyone else.

A write is checked on the old row and on the new one, so turning a monthly reset into an
ordinary adjustment needs both `reset.run` and `adjustments.edit`. Without any
permission, every admin can add `admin_log` entries (the email is always the signed-in
user's, whatever the client sends, and `id` and `created_at` always keep their defaults),
read the permission list and the roles, and read their own `user_roles` row. Nobody edits
log entries. Other `settings` keys and `matches` need the super admin. Other storage
buckets are left to their own policies.

#### Roles and the super admin

- A role is a name, a description and a set of permissions (`role_permissions`).
- One role is seeded: **Super admin** (`is_super`). It has every permission without any
  `role_permissions` rows. Over the API it cannot be renamed, edited or deleted and
  nothing can be added to it. No other role can become super: `is_super` never changes
  and a unique index allows only one super role. A trigger keeps `is_super` fixed and the
  super role from being deleted in the SQL editor too.
- A role that is still assigned to users cannot be deleted (foreign key; the admin panel
  says "Role is still assigned to users").

#### Anti-escalation rules

- Only the super admin changes roles and their permissions, so nobody else can give a
  role more rights, or strip a right from someone else's role to make that role (and its
  users) theirs to manage.
- You can assign a role only if you could grant it: a super admin can grant any role,
  anyone else only a role that is not super and whose every permission they hold
  (`private.can_grant_role`). Changing or removing someone's role also needs that for their
  current role, so a users manager cannot demote or delete a super admin, or anyone whose
  role has rights the manager lacks.
- Nobody can change or remove their own role. The admin-users function does not let you
  delete your own account or set your own password either.
- The last super admin cannot be removed: an update or delete of `user_roles` that leaves
  nobody with the super role fails with "Cannot remove the last super admin" (SQLSTATE
  `PT409`, so PostgREST answers 409). That also blocks deleting that user under
  Authentication > Users. The check takes a lock first, so two super admins removing each
  other at the same moment cannot both succeed.
- `user_roles.assigned_at` and `assigned_by` are set by a trigger to the time and the
  signed-in caller, not to values the client sends.

#### Database functions

- `public.my_access()`: `POST /rest/v1/rpc/my_access` with the user's token returns
  `{"role": {"id": 1, "name": "Super admin", "is_super": true}, "permissions": ["players.edit", ...]}`,
  or `{"role": null, "permissions": []}` for a user without a role. Signed-in users only.
- `public.is_admin()`: kept for older front ends; true when the caller has a role.
- `private.is_staff()`, `private.is_super()`, `private.has_permission(key)` and
  `private.can_grant_role(role_id)` are what the policies call. The `private` schema is not
  exposed by the API, and the functions only describe the caller.

#### How the admin panel adapts

- It signs in with Supabase Auth (email and password), keeps the session in
  `localStorage` (`esb_admin_session`), refreshes it when it expires and sends the user's
  access token with all of its own reads and writes (the shared `buildRatings()` reads use
  the publishable key).
- After login it calls `POST /rest/v1/rpc/my_access`. An account without a role gets "This
  account has no role in the admin panel." and is signed out. A network error or a
  server error (5xx) gives "Connection error. Try again." and keeps the session, with the
  panel still closed. Any other failure, including a missing `my_access` because the
  roles migration is not applied, gives "Could not verify admin access. Try again." and
  signs out.
- The header shows `<email> · <role name>`, and the panel shows only what the role allows:

  | Tab | Shown with | Controls inside |
  | --- | --- | --- |
  | Players | always | Add player and delete: `players.edit`; visibility switch: `players.visibility`; photo upload: `avatars.upload`; achievement picker: `badges.assign` |
  | Achievements | always | create, edit, delete: `achievements.edit` |
  | Dashboard | always | |
  | Log | `log.read` | Clear log: `log.clear` |
  | Groups | `groups.edit` | |
  | Monthly Reset | `reset.run` | |
  | Adjustments | `adjustments.edit` | |
  | Formula | `formula.edit` | |
  | Users | `users.manage` | list (email, role, created, last sign-in), create (email, password, role), set password, delete, change role |
  | Roles | the super admin only | create, rename and describe, permission checkboxes, delete |

- **Users tab:** the list and the create, set password and delete actions go through the
  admin-users function. Changing a user's role upserts their `user_roles` row directly
  (`on_conflict=user_id`); "No role (remove access)" deletes it. The role choices are the
  roles you can grant, and your own row is read-only. A role picked with the mouse or a
  finger is saved at once; one picked with the keyboard waits for Enter or the "Save role"
  button, so moving through the list with the arrow keys does not grant each role on the
  way.
- **Roles tab:** each role with its name, description, number of users and permission
  checkboxes; ticking one inserts a `role_permissions` row, unticking deletes it. Only
  the super admin sees this tab, and the database accepts these writes only from the
  super admin. The super role is shown locked, as "All permissions".

### Rollout

Deploy by [DEPLOY.md](DEPLOY.md), the step-by-step runbook (English and Ukrainian). In
short, and in one sitting: apply the two migrations in order, make yourself super admin,
deploy the admin-users function (and redeploy esb-sync if you use it), publish the site,
then check it (the SQL self-test is optional). The notes below explain how the parts behave; they are not extra steps.

- **Migrations.** Only the roles migration is safe to run again. It copies `admin_users`
  into `user_roles` as super admins only while `user_roles` is empty, so running it again
  never brings back an admin you removed. Running the first migration again after the
  roles migration brings back its `admin_users` checks; running the roles migration once
  more undoes that. A listed table that does not exist yet is skipped with only a warning
  and gets no protection, so DEPLOY.md step 1 ends with a query that lists such tables.
- **The first super admin** is added with SQL (DEPLOY.md step 2). The SQL editor bypasses
  RLS, so this also works when you are locked out of the admin panel. Everyone else can
  then be created and given roles in the Users tab.
- **admin-users** is deployed with `supabase functions deploy admin-users --no-verify-jwt`.
  The gateway's own JWT check rejects valid sign-ins on projects with Supabase's new API
  keys, as this one has, and the function verifies every caller's token itself with
  `auth.getUser` (see [admin-users edge function](#admin-users-edge-function)).
- **Front-end versions.** The new admin panel needs the roles migration: without it,
  sign-in ends with "Could not verify admin access. Try again." The admin panel from
  before the first migration writes with the publishable key, so its writes stop working
  as soon as that migration runs, while the public page keeps working. The one built for
  the first migration still signs in after the roles migration, because `is_admin()` now
  means "has a role", but its writes succeed only where the role allows.
- **SQL self-test** (`supabase/tests/roles_test.sql`, optional): paste it into the SQL
  editor and run it, or `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f
  supabase/tests/roles_test.sql`. It runs in one transaction that it rolls back, with
  throwaway users, roles and rows. Each check prints a `PASS` notice (psql shows them;
  the SQL editor may show only the last result), the first failure stops it with
  `FAIL ...`, and a full pass ends with the row "roles test: all checks passed". It
  expects the site tables to exist, and skips the `matches` checks when that table is
  empty.

Switching off public sign-ups (Authentication → Sign In / Providers → Allow new users to
sign up) is recommended but not required: a new account has no role, so it cannot change
anything.

## Accessibility

Both pages aim at WCAG 2.1 AA:

- Everything works from the keyboard: a leaderboard row's nickname and its "vs" button are
  buttons, badge links and the history list take focus, the compare dialog keeps focus
  inside (the page behind it is `inert`) and Escape closes it, as well as the hover card,
  the chart tip and badge names. In the admin panel the photo and icon uploads, the badge
  picker (Escape closes it and returns focus), the switches and the colour pickers are
  keyboard reachable, and keyboard focus always shows a 2px accent outline.
- Controls have names that say which player, user, role or date they act on; tabs expose
  `aria-current`, disclosures `aria-expanded`, the "vs" pick `aria-pressed`.
- Screen readers hear status changes: search results, compare picks, refreshes, saves,
  form errors and load failures (`role="status"`, and `role="alert"` for login errors).
- Text reaches 4.5:1 and field borders 3:1 against the page and card backgrounds. The
  animated green glow and the ALPHA watermark are decorative and not counted.

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
stub `fetch`. `tests/admin-users.test.js` imports the admin-users function's
`handler.js` and runs it with fake dependencies, and `tests/esb-sync.test.js` runs the
esb-sync function's `sync.js` against a fake ESB API and `matches` table. The CI workflow
`.github/workflows/test.yml` runs `npm test` on every push and pull request.

The database rules (RLS policies and triggers) are not covered by `npm test`; check them
against the real project with `supabase/tests/roles_test.sql` (see [Rollout](#rollout)
and [DEPLOY.md](DEPLOY.md), step 5).

## esb-sync edge function

The esb-sync function (Deno, supabase-js v2: the logic is in `sync.js`, the wiring in
`index.ts`, both in `supabase/functions/esb-sync/`) fetches finished
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
- A failed ESB request (non-OK status, network error, invalid JSON or 15 s timeout), a
  failed duplicate check, or an insert that fails for any reason other than a match's data
  (for example the network, a permission or a missing column) marks that day as failed.
  The run stops there and, in auto mode, the cursor stays on that day so it is retried
  next time. If a day keeps failing, the `errors` in the response say why; the cursor can
  be moved by editing the `esb_sync_cursor` row. No new day is started after about 100
  seconds, and a day still inserting matches one by one at about 130 seconds stops there
  and is retried by the next run (the platform limit is 150 s).
- These are skipped and reported in `errors` without failing the day: matches without an
  id or with an id that is not a whole number below 2^53 (`external_id` is a bigint; a
  digit string such as `"0123"` is stored as 123), matches without a `YYYY-MM-DD` date,
  match lists that are not arrays, and matches the database refuses because of their data
  (Postgres error class 22 or 23, such as a value of the wrong type). A skipped match is
  not tried again once the cursor has moved past its day. If the cause hits every match
  (for example ESB changes a field's type, or `matches` gets a new constraint), whole days
  are skipped: fix the cause, then sync those dates again in manual mode.
- A day's new matches go in with one insert. Only when the database refuses it because of
  a match's data are they inserted one by one, so the other matches are still saved. A
  match refused only because its `external_id` is already stored (an overlapping run saved
  it) is skipped without an error.
- A run that ends with `ok: false` (HTTP 200) or with HTTP 500 also writes its response to
  the function's logs in the Supabase dashboard, since whatever calls the function may not
  keep it. The response holds only the first 10 errors, so a run with more also logs the
  whole list. The "refused by the database" errors name their day, so you know which
  dates to sync again.
- Response: HTTP 200 `{ ok, mode, processedFrom, processedUpTo, remaining,
  nextDateFrom, sbTournamentsFound, inserted, errorCount, errors }` for every completed
  run (`ok` is false if anything failed; `errors` holds the first 10). 400 for invalid
  input (bad or impossible dates, `dateFrom` after `dateTo`, `dateTo` without
  `dateFrom`), 401 for a wrong secret, 405 for other methods, 500 for an unreadable or
  invalid cursor and unexpected errors.
- **`SYNC_SECRET`**: when this function secret is set, every call must send the header
  `x-sync-secret: <value>`, otherwise it gets 401. When it is not set, anyone who can
  reach the function URL can run it.

Deploy and configure it with the Supabase CLI (DEPLOY.md step 3 and "Optional hardening"):

```sh
supabase secrets set SYNC_SECRET=<random value>    # optional, see SYNC_SECRET above
supabase functions deploy esb-sync --no-verify-jwt
```

`--no-verify-jwt` turns off the gateway's own JWT check, for the same reason as for
admin-users: it rejects valid callers on projects with Supabase's new API keys. The
function then relies on `SYNC_SECRET`, which it checks itself (with or without the
flag). Nothing in this repository schedules the function; whatever calls it must send
the secret once it is set.

## admin-users edge function

`supabase/functions/admin-users/` creates and deletes admin panel users and sets their
passwords; the admin panel's Users tab calls it. `handler.js` holds the logic (plain
JavaScript, everything it talks to is passed in, tested by `tests/admin-users.test.js`);
`index.ts` wires it to `Deno.serve` and supabase-js with two clients: a service-role
client for the Auth admin API and for reading roles and `user_roles`, and a client made
with the request's `Authorization` header for `my_access()` and the `user_roles` writes,
so RLS and the last-super-admin trigger check those as the caller.

Every call is `POST {SUPABASE.URL}/functions/v1/admin-users` with a JSON body and the
headers `Authorization: Bearer <user access token>` and `apikey`. CORS allows any origin
(POST, OPTIONS). Every action needs `users.manage`.

| Body | Response (200) |
| --- | --- |
| `{"action": "list"}` | `{"users": [{"id", "email", "created_at", "last_sign_in_at", "role_id"}]}` |
| `{"action": "create", "email", "password", "role_id"}` | `{"user": {"id", "email", "role_id"}}`: a confirmed user with that password. The role is assigned as the caller, so it must be one they can grant; if that fails, the new user is deleted again. |
| `{"action": "delete", "user_id"}` | `{"ok": true}` |
| `{"action": "set_password", "user_id", "password"}` | `{"ok": true}` |

`delete` and `set_password` never target the caller, and a target whose role the caller
could not grant gets 403. Passwords need at least 8 characters. Errors are
`{"error": "..."}` with 400 for bad input, 401 for a missing or invalid token, 403 for a
missing permission, 404 for an unknown user, 405 for other methods, 409 when the email is
taken or for the last super admin, and 500 otherwise.

Deploy it with `supabase functions deploy admin-users --no-verify-jwt` (DEPLOY.md,
step 3). The flag turns off only the gateway's own JWT check, which rejects valid sign-ins
on projects with Supabase's new API keys, as this one has. The function still verifies
every call itself: `verifyToken` checks the bearer token with `auth.getUser` (401 when it
is missing or invalid), and the permissions come from `my_access()` called as the caller.
It uses the project URL and keys that Supabase gives every function, so there are no
secrets to set.
