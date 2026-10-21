begin;
set local search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
select plan(11);

set local role anon;
select set_config('test.room_token',
  public.splitly_create_room('ทริป', array['เอ', 'บี'])->>'token', true);
select set_config('test.person_a',
  public.splitly_read_room_v2(current_setting('test.room_token'), null)
    ->'participants'->0->>'id', true);
select set_config('test.person_b',
  public.splitly_read_room_v2(current_setting('test.room_token'), null)
    ->'participants'->1->>'id', true);
select set_config('test.a_session',
  public.splitly_select_member(current_setting('test.room_token'),
    current_setting('test.person_a')::uuid, '123456')->>'memberToken', true);
select set_config('test.b_session',
  public.splitly_select_member(current_setting('test.room_token'),
    current_setting('test.person_b')::uuid, '654321')->>'memberToken', true);
select public.splitly_add_expense_v2(current_setting('test.room_token'),
  current_setting('test.a_session'), 12000, 'ค่าอาหาร');
select set_config('test.expense_id',
  public.splitly_read_room_v2(current_setting('test.room_token'), null)
    ->'expenses'->0->>'id', true);

select is(public.splitly_update_expense(current_setting('test.room_token'),
  current_setting('test.b_session'), current_setting('test.expense_id')::uuid,
  7500, 'เปลี่ยน')->>'error', 'FORBIDDEN', 'non-payer cannot edit');
select is(public.splitly_update_expense(current_setting('test.room_token'),
  repeat('0', 64), current_setting('test.expense_id')::uuid,
  7500, 'เปลี่ยน')->>'error', 'FORBIDDEN', 'room link alone cannot edit');
select is((public.splitly_read_room_v2(current_setting('test.room_token'), null)
  ->'expenses'->0->>'amountCents')::bigint, 12000::bigint,
  'failed edit leaves the original amount');
select is((public.splitly_update_expense(current_setting('test.room_token'),
  current_setting('test.a_session'), current_setting('test.expense_id')::uuid,
  7525, 'อาหารเย็น')->'expenses'->0->>'amountCents')::bigint,
  7525::bigint, 'payer can edit amount');
select is(public.splitly_read_room_v2(current_setting('test.room_token'), null)
  ->'expenses'->0->>'description', 'อาหารเย็น', 'payer can edit description');
select is(jsonb_array_length(public.splitly_read_room_v2(
  current_setting('test.room_token'), null)
  ->'expenses'->0->'participantIds'), 2, 'edit preserves split members');
select is(public.splitly_delete_expense(current_setting('test.room_token'),
  current_setting('test.b_session'), current_setting('test.expense_id')::uuid)
  ->>'error', 'FORBIDDEN', 'non-payer cannot delete');

reset role;
update splitly_private.expenses set proof_path = 'room/proof.jpg',
  proof_mime_type = 'image/jpeg', proof_size_bytes = 100
  where id = current_setting('test.expense_id')::uuid;
set local role anon;
select set_config('test.deleted', public.splitly_delete_expense(
  current_setting('test.room_token'), current_setting('test.a_session'),
  current_setting('test.expense_id')::uuid)::text, true);
select is(current_setting('test.deleted')::jsonb->>'proofPath',
  'room/proof.jpg', 'delete returns proof path for storage cleanup');
select is(jsonb_array_length(current_setting('test.deleted')::jsonb
  ->'room'->'expenses'), 0, 'delete returns a recalculated room');
select is(public.splitly_delete_expense(current_setting('test.room_token'),
  current_setting('test.a_session'), current_setting('test.expense_id')::uuid),
  null::jsonb, 'deleted expense is no longer available');

reset role;
select is((select count(*) from splitly_private.expense_members
  where expense_id = current_setting('test.expense_id')::uuid),
  0::bigint, 'delete cascades to split members');
select * from finish();
rollback;
