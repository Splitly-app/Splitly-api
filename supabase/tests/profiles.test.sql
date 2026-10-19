begin;
set local search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'user-a@example.test'),
  ('00000000-0000-0000-0000-000000000002', 'user-b@example.test');
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-000000000001', 'User A'),
  ('00000000-0000-0000-0000-000000000002', 'User B');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

select results_eq(
  'select display_name from public.profiles order by display_name',
  array['User A']::text[],
  'User A can only read their own profile'
);
with updated as (
  update public.profiles set display_name = 'stolen'
  where id = '00000000-0000-0000-0000-000000000002' returning id
)
select is((select count(*)::integer from updated), 0,
  'User A cannot update User B');
select lives_ok(
  $test$update public.profiles set display_name = 'Updated A'
    where id = '00000000-0000-0000-0000-000000000001'$test$,
  'User A can update their own profile'
);
select throws_ok(
  $test$insert into public.profiles(id, display_name)
    values ('00000000-0000-0000-0000-000000000003', 'Other')$test$,
  '42501', null,
  'User A cannot insert a profile owned by someone else'
);

reset role;
select * from finish();
rollback;
