# Deploying this version / Розгортання цієї версії

[English](#english) · [Українська](#українська)

## English

The website deploys as usual, but this version also changes the Supabase database and
adds a server function. Those parts are not deployed with the website, so do them by
hand, **in this order**. If the new website goes live before steps 1 and 2, no one can
sign in to the admin panel.

### 1. Apply the database migrations

In the Supabase dashboard, open **SQL Editor**, paste each file and click **Run**, one at
a time and in this order:

1. `supabase/migrations/20260926000000_admin_only_writes.sql`: everyone can read, and
   only admins can change data.
2. `supabase/migrations/20260927000000_roles.sql`: roles and permissions. On its first
   run, anyone already listed in `admin_users` becomes a super admin.

The roles file is safe to run again. Do not run the first file again after the roles
file, because that brings back its old admin checks; if it happens, run the roles file
again. If the output shows a warning that a table does not exist, create that table and
run the roles file again, because a missing table is skipped and gets no protection.

With the [Supabase CLI](https://supabase.com/docs/guides/cli) you can run
`supabase db push` instead, after linking the project in step 3. It asks for the
database password and applies the migrations that have not run yet.

### 2. Make yourself super admin

Your account must already exist under **Authentication → Users**. In the SQL Editor,
put in your email and run:

```sql
insert into public.user_roles (user_id, role_id)
select u.id, r.id from auth.users u, public.roles r
where u.email = 'you@example.com' and r.is_super
on conflict (user_id) do update set role_id = excluded.role_id;
```

After that you can create every other user and role from the admin panel.

### 3. Deploy the user-management function

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
  `supabase functions deploy esb-sync --no-verify-jwt`. Anything that calls it must then
  send the header `x-sync-secret`.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| "This account has no role in the admin panel." | Do step 2 for that account, or give it a role in the Users tab. |
| "Could not verify admin access." | Check that both migrations ran (step 1). |
| The Users tab shows an error | The function is not deployed yet (step 3). |
| The Users tab says "The server function rejected your sign-in (… Invalid JWT …)" | Deploy the function again with `--no-verify-jwt` (step 3). |
| Locked out of the admin panel | The SQL Editor always works, whatever the roles are. Run step 2 again for your account. |

## Українська

Сайт розгортається як завжди, але ця версія також змінює базу даних Supabase і додає
серверну функцію. Ці частини не розгортаються разом із сайтом, тому виконайте їх вручну,
**саме в такому порядку**. Якщо новий сайт запрацює раніше, ніж виконано кроки 1 і 2,
ніхто не зможе увійти в адмін-панель.

### 1. Застосуйте міграції бази даних

У дашборді Supabase відкрийте **SQL Editor**, вставте кожен файл і натисніть **Run**, по
одному та в такому порядку:

1. `supabase/migrations/20260926000000_admin_only_writes.sql`: читати можуть усі, а
   змінювати дані можуть лише адміністратори.
2. `supabase/migrations/20260927000000_roles.sql`: ролі та права доступу. Під час першого
   запуску всі, хто вже є в `admin_users`, стають super admin.

Файл ролей можна безпечно запускати повторно. Не запускайте перший файл знову після
файлу ролей, бо це повертає його старі перевірки адміністраторів; якщо так сталося,
запустіть файл ролей ще раз. Якщо у виводі є попередження, що якоїсь таблиці не існує,
створіть цю таблицю й запустіть файл ролей ще раз, бо відсутня таблиця пропускається і
залишається без захисту.

Замість цього можна скористатися [Supabase CLI](https://supabase.com/docs/guides/cli) і
виконати `supabase db push` після того, як під'єднаєте проєкт на кроці 3. Команда
запитає пароль бази даних і застосує міграції, які ще не виконувалися.

### 2. Зробіть себе super admin

Ваш обліковий запис уже має існувати в **Authentication → Users**. У SQL Editor вкажіть
свою email-адресу й виконайте:

```sql
insert into public.user_roles (user_id, role_id)
select u.id, r.id from auth.users u, public.roles r
where u.email = 'you@example.com' and r.is_super
on conflict (user_id) do update set role_id = excluded.role_id;
```

Після цього всіх інших користувачів і ролі можна створювати в адмін-панелі.

### 3. Розгорніть функцію керування користувачами

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
  розгорніть її командою `supabase functions deploy esb-sync --no-verify-jwt`. Після цього
  все, що її викликає, має надсилати заголовок `x-sync-secret`.

### Якщо щось пішло не так

| Що ви бачите | Що робити |
| --- | --- |
| "This account has no role in the admin panel." | Виконайте крок 2 для цього облікового запису або призначте йому роль на вкладці Users. |
| "Could not verify admin access." | Перевірте, що обидві міграції виконано (крок 1). |
| На вкладці Users показується помилка | Функцію ще не розгорнуто (крок 3). |
| На вкладці Users написано "The server function rejected your sign-in (… Invalid JWT …)" | Розгорніть функцію ще раз із `--no-verify-jwt` (крок 3). |
| Немає доступу до адмін-панелі | SQL Editor працює завжди, незалежно від ролей. Виконайте крок 2 ще раз для свого облікового запису. |
