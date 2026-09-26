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
`supabase db push` instead, after linking the project in step 3. It asks for the
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

### 3. Deploy the server functions

The admin panel's **Users** tab creates and deletes accounts through the `admin-users`
function. From the repository folder:

```sh
brew install supabase/tap/supabase                # once; other systems: see the CLI docs
supabase login
supabase link --project-ref vgmwxtpsbwzeqwtpxamo
supabase functions deploy admin-users --no-verify-jwt
```

`--no-verify-jwt` turns off the gateway's own token check, which rejects valid sign-ins
on projects that use Supabase's new API keys, as this one does. The function checks
every caller's token itself. Supabase provides the project URL and keys to the function
automatically, so there are no secrets to set, and the master key never reaches the
browser.

If you use the `esb-sync` function, redeploy it too, so the fixes in this version take
effect:

```sh
supabase functions deploy esb-sync --no-verify-jwt
```

Until you do, the old version keeps running as before. The flag keeps the function
callable whatever key its caller sends. Unless you set `SYNC_SECRET` (see "Optional
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
- **Match sync:** if you use the `esb-sync` function, you can protect it by running
  `supabase secrets set SYNC_SECRET=<random value>` and redeploying it with
  `supabase functions deploy esb-sync --no-verify-jwt` (the flag is needed for the same
  reason as in step 3; the function checks the secret itself). Anything that calls it must
  then send the header `x-sync-secret`.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| "This account has no role in the admin panel." | Do step 2 for that account, or give it a role in the Users tab. |
| "Could not verify admin access. Try again." | Check that both migrations ran (step 1). |
| "Connection error. Try again." when logging in or opening the admin panel | The network failed, or Supabase answered with a server error (5xx). If your password was already accepted, you stay signed in; try again in a moment. |
| The Users tab shows an error | The `admin-users` function is not deployed yet (step 3). |
| The Users tab says "The server function rejected your sign-in (… Invalid JWT …)" | Deploy `admin-users` again with `--no-verify-jwt` (step 3). |
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
виконати `supabase db push` після того, як під'єднаєте проєкт на кроці 3. Команда
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

### 3. Розгорніть серверні функції

Вкладка **Users** в адмін-панелі створює та видаляє облікові записи через функцію
`admin-users`. У папці репозиторію виконайте:

```sh
brew install supabase/tap/supabase                # один раз; для інших систем див. документацію CLI
supabase login
supabase link --project-ref vgmwxtpsbwzeqwtpxamo
supabase functions deploy admin-users --no-verify-jwt
```

`--no-verify-jwt` вимикає власну перевірку токенів у шлюзі, яка відхиляє коректні входи
в проєктах із новими API-ключами Supabase, як у цьому проєкті. Функція сама перевіряє
токен кожного, хто її викликає. Supabase автоматично передає функції URL проєкту та
ключі, тож жодних секретів налаштовувати не потрібно, а головний ключ ніколи не потрапляє
в браузер.

Якщо ви використовуєте функцію `esb-sync`, розгорніть і її повторно, щоб запрацювали
виправлення з цієї версії:

```sh
supabase functions deploy esb-sync --no-verify-jwt
```

Доки ви цього не зробите, працює стара версія, як і раніше. Прапорець залишає функцію
доступною, хоч би який ключ надсилав той, хто її викликає. Якщо не налаштувати
`SYNC_SECRET` (див. розділ "Додатковий захист" нижче), синхронізацію може запустити кожен, хто знає
URL функції; вона лише копіює завершені матчі з ESportsBattle.

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
  захистити: виконайте `supabase secrets set SYNC_SECRET=<випадкове значення>` і повторно
  розгорніть її командою `supabase functions deploy esb-sync --no-verify-jwt` (прапорець
  потрібен із тієї самої причини, що й на кроці 3; секрет функція перевіряє сама). Після
  цього все, що її викликає, має надсилати заголовок `x-sync-secret`.

### Якщо щось пішло не так

| Що ви бачите | Що робити |
| --- | --- |
| "This account has no role in the admin panel." | Виконайте крок 2 для цього облікового запису або призначте йому роль на вкладці Users. |
| "Could not verify admin access. Try again." | Перевірте, що обидві міграції виконано (крок 1). |
| "Connection error. Try again." під час входу або відкриття адмін-панелі | Стався збій мережі, або Supabase відповів помилкою сервера (5xx). Якщо пароль уже було прийнято, ви залишаєтеся в системі; спробуйте ще раз трохи пізніше. |
| На вкладці Users показується помилка | Функцію `admin-users` ще не розгорнуто (крок 3). |
| На вкладці Users написано "The server function rejected your sign-in (… Invalid JWT …)" | Розгорніть `admin-users` ще раз із `--no-verify-jwt` (крок 3). |
| Немає доступу до адмін-панелі | SQL Editor працює завжди, незалежно від ролей. Виконайте крок 2 ще раз для свого облікового запису. |
| `esb-sync` повертає код 400 | У запиті є дата, що не є справжньою датою у форматі `YYYY-MM-DD`, `dateFrom` пізніша за `dateTo` (або за сьогоднішню дату, якщо `dateTo` не передано), або `dateTo` передано без `dateFrom`. |
| `esb-sync` повертає код 500 з повідомленням "settings.esb_sync_cursor is …" | У рядку `esb_sync_cursor` таблиці `settings` записано не дату або дату, пізнішу за сьогоднішню. Виправте його або видаліть, щоб почати знову з 2026-01-01. |
| У `errors` від `esb-sync` написано "refused by the database" | Ці матчі пропущено. Усуньте причину (наприклад, змінений тип поля або нове обмеження в `matches`), а потім ще раз синхронізуйте дні, названі в цих помилках (якщо `errorCount` більший за 10, повний список є в журналі функції на панелі Supabase): надішліть функції `POST {"dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD"}`. |
