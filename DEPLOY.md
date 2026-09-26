# Deploying this version / Розгортання цієї версії

[English](#english) · [Українська](#українська)

## English

The website deploys as usual, but this version also changes the Supabase database, adds a
server function and updates the `esb-sync` function. Those parts are not deployed with
the website, so do them by hand, **in this order**. If the new website goes live before
steps 1 and 2, no one can sign in to the admin panel. From step 1 until the new website
is live (step 4), the admin panel that is live now still opens but cannot save anything,
while the public page keeps working, so do steps 1–4 in one sitting.

### 1. Apply the database migrations

In the Supabase dashboard, open **SQL Editor**, paste each file and click **Run**, one at
a time and in this order:

1. `supabase/migrations/20260926000000_admin_only_writes.sql`: everyone can read, and
   only admins can change data.
2. `supabase/migrations/20260927000000_roles.sql`: roles and permissions. On its first
   run, anyone already listed in `admin_users` becomes a super admin. It also adds the
   `created_at` column to `rating_adjustments` if the table does not have it yet.

The roles file is safe to run again. Do not run the first file again after the roles
file, because that brings back its old admin checks; if it happens, run the roles file
again.

With the [Supabase CLI](https://supabase.com/docs/guides/cli) you can run
`supabase db push` instead, after linking the project (step 3). It asks for the
database password and applies the migrations that have not run yet.

Either way, then check that every table got its protection. Run this in the SQL Editor;
it must return no rows:

```sql
select t as unprotected_table
from unnest(array['player_config', 'hidden_players', 'achievements', 'player_achievements',
                  'rating_groups', 'rating_adjustments', 'settings', 'matches', 'admin_log']) as t
where not coalesce((select c.relrowsecurity from pg_class c
                    where c.oid = to_regclass('public.' || t)), false)
   or (select count(*) from pg_policies p
       where p.schemaname = 'public' and p.tablename = t
         and p.policyname in ('esb_perm_only_insert', 'esb_perm_only_update',
                              'esb_perm_only_delete')) < 3;
```

Each row names a table that is not protected, usually because it did not exist when the
roles file ran: such a table is skipped with only a warning, which the SQL Editor may not
show. Create that table, run the roles file again, then run this check again.

### 2. Make yourself super admin

Your account must already exist under **Authentication → Users**. In the SQL Editor,
put in your email and run:

```sql
insert into public.user_roles (user_id, role_id)
select u.id, r.id from auth.users u, public.roles r
where u.email = 'you@example.com' and r.is_super
on conflict (user_id) do update set role_id = excluded.role_id;
```

Once steps 3 and 4 are done, you can create every other user and role from the admin panel.

### 3. Deploy the `admin-users` function (only for the Users tab)

The admin panel's **Users** tab lists, creates and deletes accounts and sets passwords
through the `admin-users` server function. Everything else in the admin panel, the Roles
tab included, works without it, so you can do this step after step 4. Until you do, the
Users tab says "The admin-users server function did not answer", and you can add and
delete accounts under **Authentication → Users** in the Supabase dashboard (give them a
role with the query in step 2, or later in the Users tab).

No tools to install. In the Supabase dashboard:

1. Open **Edge Functions**, click **Deploy a new function** and choose **Via Editor**.
2. Name it `admin-users`.
3. Replace the contents of the starter file `index.ts` with
   `supabase/functions/admin-users/index.ts`. Add a file named `handler.js` with the
   contents of `supabase/functions/admin-users/handler.js`.
4. Click **Deploy function**.
5. Open the function's **Details** tab, switch off **Verify JWT with legacy secret** and
   click **Save changes**. A function made in the editor starts with it on. Check it again
   after every later update.

That switch is the gateway's own token check, which rejects valid sign-ins on projects
that use Supabase's new API keys, as this one does. The function checks every caller's
token itself. Supabase provides the project URL and keys to the function automatically,
so there are no secrets to set, and the master key never reaches the browser.

With the [Supabase CLI](https://supabase.com/docs/guides/cli) instead, from the
repository folder:

```sh
supabase login
supabase link --project-ref vgmwxtpsbwzeqwtpxamo
supabase functions deploy admin-users --no-verify-jwt
```

`--no-verify-jwt` switches off the same check as item 5 above.

**`esb-sync` (optional).** The version that is live now keeps syncing matches as before,
and the website does not read the `matches` table, so you can leave it. To get the fixes
in this version, open `esb-sync` under **Edge Functions**, replace its code with
`supabase/functions/esb-sync/index.ts`, add a file `sync.js` with the contents of
`supabase/functions/esb-sync/sync.js`, and deploy the update. Leave its **Verify JWT with
legacy secret** switch as it is: an update from the dashboard keeps it, so whatever calls
the function today keeps working. With the CLI, run
`supabase functions deploy esb-sync --no-verify-jwt` instead, which keeps it callable
whatever key its caller sends; then, unless you set `SYNC_SECRET` (see "Optional
hardening" below), anyone who knows its URL can start a sync, which only copies finished
matches from ESportsBattle.

### 4. Deploy the website

Merge the pull request so that your hosting publishes the new version.

### 5. Check it

- **Admin panel:** sign in. The header shows your email and "Super admin", and the Users
  and Roles tabs appear.
- **Database self-test (optional):** paste `supabase/tests/roles_test.sql` into the SQL
  Editor and run it. It stops at the first rule that is wrong, with an error naming it.
  When every check passes, the result reads `roles test: all checks passed`. Either way
  it undoes everything it created.

### Optional hardening

- **Sign-ups:** under **Authentication → Sign In / Providers**, switch off **Allow new
  users to sign up**. This is not required, because a new account has no role and cannot
  change anything.
- **Match sync:** if you use the `esb-sync` function, you can protect it with a secret:
  add `SYNC_SECRET=<random value>` under **Edge Functions → Secrets** (or run
  `supabase secrets set SYNC_SECRET=<random value>`), and deploy this version of
  `esb-sync` as in step 3. The function checks the secret itself. Anything that calls it
  must then send the header `x-sync-secret`.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| "This account has no role in the admin panel." | Do step 2 for that account, or give it a role in the Users tab. |
| "Could not verify admin access. Try again." | Check that both migrations ran (step 1). |
| "Connection error. Try again." when logging in or opening the admin panel | The network failed, or Supabase answered with a server error (5xx). If your password was already accepted, you stay signed in; try again in a moment. |
| The Users tab says "The admin-users server function did not answer." (an older build: "Failed to fetch" or "Load failed") | The `admin-users` function is not deployed yet (step 3). |
| The Users tab says "The server function rejected your sign-in (… Invalid JWT …)" | Switch off **Verify JWT with legacy secret** for `admin-users` (step 3, item 5). |
| Locked out of the admin panel | The SQL Editor always works, whatever the roles are. Run step 2 again for your account. |
| `esb-sync` answers 400 | The request has a date that is not a real `YYYY-MM-DD` date, `dateFrom` after `dateTo` (after today when `dateTo` is left out), or `dateTo` without `dateFrom`. |
| `esb-sync` answers 500 with "settings.esb_sync_cursor is …" | The `esb_sync_cursor` row in the `settings` table is not a date on or before today. Fix it, or delete it to start again from 2026-01-01. |
| The `errors` from `esb-sync` say "refused by the database" | Those matches were skipped. Fix the cause (for example a changed field type or a new constraint on `matches`), then sync the days named in those errors again (when `errorCount` is above 10, the full list is in the function's logs in the Supabase dashboard) by sending `POST {"dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD"}` to the function. |

## Українська

Сайт розгортається як завжди, але ця версія також змінює базу даних Supabase, додає
серверну функцію й оновлює функцію `esb-sync`. Ці частини не розгортаються разом із
сайтом, тому виконайте їх вручну, **саме в такому порядку**. Якщо новий сайт запрацює
раніше, ніж виконано кроки 1 і 2, ніхто не зможе увійти в адмін-панель. Від кроку 1 і
доки не запрацює новий сайт (крок 4), адмін-панель, яка працює зараз, відкривається, але
не може нічого зберегти, тоді як публічна сторінка працює як звичайно, тож виконайте
кроки 1–4 за один раз.

### 1. Застосуйте міграції бази даних

У дашборді Supabase відкрийте **SQL Editor**, вставте кожен файл і натисніть **Run**, по
одному та в такому порядку:

1. `supabase/migrations/20260926000000_admin_only_writes.sql`: читати можуть усі, а
   змінювати дані можуть лише адміністратори.
2. `supabase/migrations/20260927000000_roles.sql`: ролі та права доступу. Під час першого
   запуску всі, хто вже є в `admin_users`, стають super admin. Також вона додає до
   `rating_adjustments` стовпець `created_at`, якщо його ще немає.

Файл ролей можна безпечно запускати повторно. Не запускайте перший файл знову після
файлу ролей, бо це повертає його старі перевірки адміністраторів; якщо так сталося,
запустіть файл ролей ще раз.

Замість цього можна скористатися [Supabase CLI](https://supabase.com/docs/guides/cli) і
виконати `supabase db push` після того, як під'єднаєте проєкт (крок 3). Команда
запитає пароль бази даних і застосує міграції, які ще не виконувалися.

У будь-якому разі потім перевірте, що кожна таблиця отримала захист. Виконайте цей запит
у SQL Editor; він не має повернути жодного рядка:

```sql
select t as unprotected_table
from unnest(array['player_config', 'hidden_players', 'achievements', 'player_achievements',
                  'rating_groups', 'rating_adjustments', 'settings', 'matches', 'admin_log']) as t
where not coalesce((select c.relrowsecurity from pg_class c
                    where c.oid = to_regclass('public.' || t)), false)
   or (select count(*) from pg_policies p
       where p.schemaname = 'public' and p.tablename = t
         and p.policyname in ('esb_perm_only_insert', 'esb_perm_only_update',
                              'esb_perm_only_delete')) < 3;
```

Кожен рядок називає таблицю без захисту, найчастіше тому, що її не існувало, коли
запускався файл ролей: таку таблицю пропущено лише з попередженням, якого SQL Editor може
не показати. Створіть цю таблицю, запустіть файл ролей ще раз, а потім знову виконайте
цю перевірку.

### 2. Зробіть себе super admin

Ваш обліковий запис уже має існувати в **Authentication → Users**. У SQL Editor вкажіть
свою email-адресу й виконайте:

```sql
insert into public.user_roles (user_id, role_id)
select u.id, r.id from auth.users u, public.roles r
where u.email = 'you@example.com' and r.is_super
on conflict (user_id) do update set role_id = excluded.role_id;
```

Коли виконаєте кроки 3 і 4, усіх інших користувачів і ролі можна буде створювати в адмін-панелі.

### 3. Розгорніть функцію `admin-users` (лише для вкладки Users)

Вкладка **Users** в адмін-панелі показує, створює та видаляє облікові записи й задає
паролі через серверну функцію `admin-users`. Усе інше в адмін-панелі, зокрема вкладка
Roles, працює без неї, тож цей крок можна виконати й після кроку 4. Доки ви цього не
зробите, на вкладці Users написано "The admin-users server function did not answer", а
облікові записи можна додавати й видаляти в **Authentication → Users** у дашборді
Supabase (роль їм можна дати запитом із кроку 2 або пізніше на вкладці Users).

Нічого встановлювати не потрібно. У дашборді Supabase:

1. Відкрийте **Edge Functions**, натисніть **Deploy a new function** і виберіть
   **Via Editor**.
2. Назвіть функцію `admin-users`.
3. Замініть вміст початкового файлу `index.ts` на вміст
   `supabase/functions/admin-users/index.ts`. Додайте файл `handler.js` із вмістом
   `supabase/functions/admin-users/handler.js`.
4. Натисніть **Deploy function**.
5. Відкрийте вкладку **Details** цієї функції, вимкніть **Verify JWT with legacy secret**
   і натисніть **Save changes**. У функції, створеної в редакторі, цей перемикач спочатку
   ввімкнений. Перевіряйте його після кожного наступного оновлення.

Цей перемикач вмикає власну перевірку токенів у шлюзі, яка відхиляє коректні входи в
проєктах із новими API-ключами Supabase, як у цьому проєкті. Функція сама перевіряє
токен кожного, хто її викликає. Supabase автоматично передає функції URL проєкту та
ключі, тож жодних секретів налаштовувати не потрібно, а головний ключ ніколи не потрапляє
в браузер.

Натомість можна скористатися [Supabase CLI](https://supabase.com/docs/guides/cli) у
папці репозиторію:

```sh
supabase login
supabase link --project-ref vgmwxtpsbwzeqwtpxamo
supabase functions deploy admin-users --no-verify-jwt
```

`--no-verify-jwt` вимикає ту саму перевірку, що й пункт 5 вище.

**`esb-sync` (необов'язково).** Версія, яка працює зараз, і далі синхронізує матчі, як
раніше, а сайт не читає таблицю `matches`, тож її можна не чіпати. Щоб отримати
виправлення з цієї версії, відкрийте `esb-sync` в **Edge Functions**, замініть її код на
`supabase/functions/esb-sync/index.ts`, додайте файл `sync.js` із вмістом
`supabase/functions/esb-sync/sync.js` і розгорніть оновлення. Перемикач **Verify JWT with
legacy secret** залиште як є: оновлення з дашборду його зберігає, тож усе, що викликає
функцію зараз, і далі працюватиме. Через CLI натомість виконайте
`supabase functions deploy esb-sync --no-verify-jwt`: так функцію можна викликати з
будь-яким ключем, і, якщо не налаштувати `SYNC_SECRET` (див. розділ "Додатковий захист"
нижче), синхронізацію може запустити кожен, хто знає URL функції; вона лише копіює
завершені матчі з ESportsBattle.

### 4. Розгорніть сайт

Виконайте merge pull request, щоб ваш хостинг опублікував нову версію.

### 5. Перевірте

- **Адмін-панель:** увійдіть. У заголовку видно вашу email-адресу та "Super admin", а
  також з'являються вкладки Users і Roles.
- **Самоперевірка бази даних (необов'язково):** вставте `supabase/tests/roles_test.sql` у
  SQL Editor і запустіть. Скрипт зупиняється на першому неправильному правилі з
  помилкою, яка його називає. Якщо всі перевірки пройдено, результат буде
  `roles test: all checks passed`. В обох випадках він скасовує все, що створив.

### Додатковий захист (необов'язково)

- **Реєстрація:** у **Authentication → Sign In / Providers** вимкніть **Allow new users
  to sign up**. Це не обов'язково, адже новий обліковий запис не має ролі й нічого не
  може змінити.
- **Синхронізація матчів:** якщо ви використовуєте функцію `esb-sync`, її можна
  захистити секретом: додайте `SYNC_SECRET=<випадкове значення>` в **Edge Functions →
  Secrets** (або виконайте `supabase secrets set SYNC_SECRET=<випадкове значення>`) і
  розгорніть цю версію `esb-sync`, як описано на кроці 3. Секрет функція перевіряє сама.
  Після цього все, що її викликає, має надсилати заголовок `x-sync-secret`.

### Якщо щось пішло не так

| Що ви бачите | Що робити |
| --- | --- |
| "This account has no role in the admin panel." | Виконайте крок 2 для цього облікового запису або призначте йому роль на вкладці Users. |
| "Could not verify admin access. Try again." | Перевірте, що обидві міграції виконано (крок 1). |
| "Connection error. Try again." під час входу або відкриття адмін-панелі | Стався збій мережі, або Supabase відповів помилкою сервера (5xx). Якщо пароль уже було прийнято, ви залишаєтеся в системі; спробуйте ще раз трохи пізніше. |
| На вкладці Users написано "The admin-users server function did not answer." (у старішій збірці: "Failed to fetch" або "Load failed") | Функцію `admin-users` ще не розгорнуто (крок 3). |
| На вкладці Users написано "The server function rejected your sign-in (… Invalid JWT …)" | Вимкніть **Verify JWT with legacy secret** для `admin-users` (крок 3, пункт 5). |
| Немає доступу до адмін-панелі | SQL Editor працює завжди, незалежно від ролей. Виконайте крок 2 ще раз для свого облікового запису. |
| `esb-sync` повертає код 400 | У запиті є дата, що не є справжньою датою у форматі `YYYY-MM-DD`, `dateFrom` пізніша за `dateTo` (або за сьогоднішню дату, якщо `dateTo` не передано), або `dateTo` передано без `dateFrom`. |
| `esb-sync` повертає код 500 з повідомленням "settings.esb_sync_cursor is …" | У рядку `esb_sync_cursor` таблиці `settings` записано не дату або дату, пізнішу за сьогоднішню. Виправте його або видаліть, щоб почати знову з 2026-01-01. |
| У `errors` від `esb-sync` написано "refused by the database" | Ці матчі пропущено. Усуньте причину (наприклад, змінений тип поля або нове обмеження в `matches`), а потім ще раз синхронізуйте дні, названі в цих помилках (якщо `errorCount` більший за 10, повний список є в журналі функції на панелі Supabase): надішліть функції `POST {"dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD"}`. |
