begin;
set local search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
select plan(18);

set local role anon;
select set_config('test.room_token',
  public.splitly_create_room('ทริป', array['เอ', 'บี'])->>'token', true);
select is(length(current_setting('test.room_token')), 64,
  'room token is 64 characters');
select is(public.splitly_read_room_v2(current_setting('test.room_token'), null)->>'name',
  'ทริป', 'link holder can read the room');
select is(public.splitly_read_room_v2(repeat('0', 64), null), null::jsonb,
  'wrong room token cannot read');
select throws_ok('select count(*) from splitly_private.rooms', '42501', null,
  'anon cannot read private tables');

select set_config('test.person_a',
  public.splitly_read_room_v2(current_setting('test.room_token'), null)
    ->'participants'->0->>'id', true);
select set_config('test.person_b',
  public.splitly_read_room_v2(current_setting('test.room_token'), null)
    ->'participants'->1->>'id', true);
select set_config('test.a_claim',
  public.splitly_select_member(current_setting('test.room_token'),
    current_setting('test.person_a')::uuid, '123456')::text, true);
select set_config('test.a_session',
  current_setting('test.a_claim')::jsonb->>'memberToken', true);
select set_config('test.recovery',
  current_setting('test.a_claim')::jsonb->>'recoveryCode', true);
select is(length(current_setting('test.a_session')), 64,
  'first claimant receives a session');
select is(
  public.splitly_read_room_v2(current_setting('test.room_token'),
    current_setting('test.a_session'))->>'viewerParticipantId',
  current_setting('test.person_a'), 'session identifies the chosen member');
select is(
  public.splitly_select_member(current_setting('test.room_token'),
    current_setting('test.person_a')::uuid, '000000')->>'error',
  'INVALID_PIN', 'wrong PIN is rejected');

select is(
  public.splitly_add_expense_v2(current_setting('test.room_token'),
    repeat('0', 64), 12000, 'ค่าอาหาร')->>'error',
  'FORBIDDEN', 'room link alone cannot create an expense');
select is(
  public.splitly_add_expense_v2(current_setting('test.room_token'),
    current_setting('test.a_session'), 12000, 'ค่าอาหาร')
    ->'expenses'->0->>'payerId',
  current_setting('test.person_a'), 'session member is the payer');
select set_config('test.expense_id',
  public.splitly_read_room_v2(current_setting('test.room_token'), null)
    ->'expenses'->0->>'id', true);
select is(
  jsonb_array_length(public.splitly_read_room_v2(
    current_setting('test.room_token'), null)
    ->'expenses'->0->'participantIds'),
  2, 'all current members split a new expense');

select is(
  jsonb_array_length(public.splitly_add_participant_v2(
    current_setting('test.room_token'), 'ซี', '654321')
    ->'room'->'participants'),
  3, 'new member can be added and claimed');
select is(
  jsonb_array_length(public.splitly_read_room_v2(
    current_setting('test.room_token'), null)
    ->'expenses'->0->'eligibleParticipantIds'),
  2, 'new member does not join an older expense');
select is(
  jsonb_array_length(public.splitly_set_expense_members(
    current_setting('test.room_token'), current_setting('test.a_session'),
    current_setting('test.expense_id')::uuid,
    array[current_setting('test.person_b')::uuid])
    ->'expenses'->0->'participantIds'),
  1, 'payer can exclude self');
select is(
  public.splitly_set_expense_members(current_setting('test.room_token'),
    current_setting('test.a_session'), current_setting('test.expense_id')::uuid,
    array[]::uuid[])->>'error',
  'INVALID_MEMBERS', 'empty split is rejected');
select is(
  public.splitly_set_expense_members(current_setting('test.room_token'),
    public.splitly_select_member(current_setting('test.room_token'),
      current_setting('test.person_b')::uuid, '222222')->>'memberToken',
    current_setting('test.expense_id')::uuid,
    array[current_setting('test.person_a')::uuid])->>'error',
  'FORBIDDEN', 'non-payer cannot change the split');

select is(length(current_setting('test.recovery')), 32,
  'first claim returns one recovery code');
select is(
  public.splitly_recover_member(current_setting('test.room_token'),
    current_setting('test.person_a')::uuid, current_setting('test.recovery'),
    '987654')->>'participantId',
  current_setting('test.person_a'), 'recovery resets the PIN');
select is(
  public.splitly_read_room_v2(current_setting('test.room_token'),
    current_setting('test.a_session'))->>'viewerParticipantId',
  null::text, 'recovery revokes old sessions');

reset role;
select * from finish();
rollback;
