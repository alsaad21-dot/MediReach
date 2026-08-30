# Admin photo gallery — one-time Supabase setup

The admin gallery ([index.html](index.html), `AdminGallery`) is gated two ways:

1. **Client-side**: the "Admin" nav link and page only render if the signed-in
   user's `profiles.is_admin` is `true`. This is just UX — it hides the link,
   it doesn't protect the data.
2. **Server-side (the real protection)**: Supabase Row Level Security. Without
   the policies below, the gallery's query returns nothing for *everyone*,
   admin or not — RLS defaults to deny.

Run this once in your Supabase project's **SQL Editor**:

```sql
-- 1. Add the admin flag to profiles.
alter table profiles add column if not exists is_admin boolean not null default false;

-- 2. Let admins (and only admins) read every row in messages and
--    conversations — needed so the gallery can see attachments across all
--    users, not just the signed-in admin's own chats.
-- Dropped first so this script is safe to re-run (e.g. if a later statement
-- in the same run fails, Supabase rolls back the whole batch as one
-- transaction, so you'll need to re-run everything from the top).
drop policy if exists "Admins can read all messages" on messages;
create policy "Admins can read all messages"
on messages for select
to authenticated
using (
  exists (
    select 1 from profiles
    where profiles.user_id = auth.uid()
    and profiles.is_admin = true
  )
);

drop policy if exists "Admins can read all conversations" on conversations;
create policy "Admins can read all conversations"
on conversations for select
to authenticated
using (
  exists (
    select 1 from profiles
    where profiles.user_id = auth.uid()
    and profiles.is_admin = true
  )
);

-- 3. Make your own account an admin (replace the email):
update profiles
set is_admin = true
where user_id = (select id from auth.users where email = 'you@example.com');
```

**Notes**

- If your `profiles`, `messages`, or `conversations` tables use different
  column names than shown here (e.g. something other than `user_id` /
  `conversation_id`), adjust the policies to match — the app's existing
  queries assume this shape, so if those already work, this should too.
- To revoke admin access from an account, just set `is_admin = false` for
  that row — no code changes needed.
- The gallery shows **every** image attachment ever sent to Clarity across
  all users, including anything sensitive (rashes, injuries, lab results).
  Treat admin access accordingly.
