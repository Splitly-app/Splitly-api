create extension if not exists pgcrypto with schema extensions;

alter table splitly_private.participants
  add column pin_hash text,
  add column recovery_hash bytea,
  add column failed_attempts integer not null default 0,
  add column locked_until timestamptz;

create table splitly_private.member_sessions (
  token_hash bytea primary key,
  room_id uuid not null references splitly_private.rooms(id) on delete cascade,
  participant_id uuid not null references splitly_private.participants(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index member_sessions_by_participant on splitly_private.member_sessions(participant_id);
alter table splitly_private.member_sessions enable row level security;
revoke all on splitly_private.member_sessions from public, anon, authenticated;

create table splitly_private.expense_members (
  expense_id uuid not null references splitly_private.expenses(id) on delete cascade,
  participant_id uuid not null references splitly_private.participants(id) on delete cascade,
  included boolean not null default true,
  primary key (expense_id, participant_id)
);
insert into splitly_private.expense_members(expense_id, participant_id)
select e.id, p.id from splitly_private.expenses e
join splitly_private.participants p on p.room_id = e.room_id;
alter table splitly_private.expense_members enable row level security;
revoke all on splitly_private.expense_members from public, anon, authenticated;

alter table splitly_private.expenses
  add column proof_path text,
  add column proof_mime_type text,
  add column proof_size_bytes integer,
  add constraint proof_metadata_together check (
    (proof_path is null and proof_mime_type is null and proof_size_bytes is null)
    or (proof_path is not null and proof_mime_type in
      ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
      and proof_size_bytes between 1 and 5000000)
  );

create function splitly_private.member_id_for_session(p_room_id uuid, p_member_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select participant_id from splitly_private.member_sessions
  where room_id = p_room_id
    and p_member_token ~ '^[0-9a-f]{64}$'
    and token_hash = pg_catalog.sha256(pg_catalog.convert_to(p_member_token, 'UTF8'))
    and expires_at > now();
$$;

create function splitly_private.room_snapshot_v2(p_room_id uuid, p_member_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', r.id, 'name', r.name, 'updatedAt', r.updated_at,
    'viewerParticipantId', splitly_private.member_id_for_session(r.id, p_member_token),
    'participants', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'name', p.name, 'position', p.position, 'claimed', p.pin_hash is not null
      ) order by p.position)
      from splitly_private.participants p where p.room_id = r.id
    ), '[]'::jsonb),
    'expenses', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'payerId', e.payer_id, 'amountCents', e.amount_cents,
        'description', e.description, 'createdAt', e.created_at,
        'hasProof', e.proof_path is not null,
        'eligibleParticipantIds', coalesce((
          select pg_catalog.jsonb_agg(em.participant_id order by p.position)
          from splitly_private.expense_members em
          join splitly_private.participants p on p.id = em.participant_id
          where em.expense_id = e.id
        ), '[]'::jsonb),
        'participantIds', coalesce((
          select pg_catalog.jsonb_agg(em.participant_id order by p.position)
          from splitly_private.expense_members em
          join splitly_private.participants p on p.id = em.participant_id
          where em.expense_id = e.id and em.included
        ), '[]'::jsonb)
      ) order by e.created_at desc, e.id desc)
      from splitly_private.expenses e where e.room_id = r.id
    ), '[]'::jsonb)
  ) from splitly_private.rooms r where r.id = p_room_id;
$$;

create function splitly_private.read_room_v2(p_token text, p_member_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select splitly_private.room_snapshot_v2(
    splitly_private.room_id_for_token(p_token), p_member_token
  );
$$;
create function public.splitly_read_room_v2(p_token text, p_member_token text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select splitly_private.read_room_v2(p_token, p_member_token);
$$;

create function splitly_private.issue_member_session(
  p_room_id uuid, p_participant_id uuid, p_recovery_code text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_token text;
begin
  v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') ||
    pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  insert into splitly_private.member_sessions(token_hash, room_id, participant_id, expires_at)
  values (pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8')),
    p_room_id, p_participant_id, now() + interval '30 days');
  return pg_catalog.jsonb_build_object(
    'memberToken', v_token, 'participantId', p_participant_id,
    'recoveryCode', p_recovery_code
  );
end;
$$;

create function splitly_private.select_member(
  p_token text, p_participant_id uuid, p_pin text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid; v_person splitly_private.participants%rowtype; v_code text;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  if p_pin !~ '^[0-9]{6}$' then raise exception 'INVALID_PIN_FORMAT'; end if;
  select * into v_person from splitly_private.participants
    where id = p_participant_id and room_id = v_room_id for update;
  if not found then return null; end if;
  if v_person.locked_until > now() then
    return '{"error":"LOCKED"}'::jsonb;
  end if;
  if v_person.pin_hash is null then
    v_code := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
    update splitly_private.participants set
      pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
      recovery_hash = pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8')),
      failed_attempts = 0, locked_until = null
    where id = p_participant_id;
  elsif extensions.crypt(p_pin, v_person.pin_hash) <> v_person.pin_hash then
    update splitly_private.participants set
      failed_attempts = case when locked_until <= now() then 1 else failed_attempts + 1 end,
      locked_until = case when
        (case when locked_until <= now() then 1 else failed_attempts + 1 end) >= 5
        then now() + interval '15 minutes' else null end
    where id = p_participant_id;
    return '{"error":"INVALID_PIN"}'::jsonb;
  else
    update splitly_private.participants
      set failed_attempts = 0, locked_until = null where id = p_participant_id;
  end if;
  return splitly_private.issue_member_session(v_room_id, p_participant_id, v_code);
end;
$$;
create function public.splitly_select_member(p_token text, p_participant_id uuid, p_pin text)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.select_member(p_token, p_participant_id, p_pin);
$$;

create function splitly_private.recover_member(
  p_token text, p_participant_id uuid, p_code text, p_new_pin text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid; v_person splitly_private.participants%rowtype; v_new_code text;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  if p_new_pin !~ '^[0-9]{6}$' or p_code !~ '^[0-9a-f]{32}$' then
    raise exception 'INVALID_RECOVERY_FORMAT';
  end if;
  select * into v_person from splitly_private.participants
    where id = p_participant_id and room_id = v_room_id for update;
  if not found then return null; end if;
  if v_person.locked_until > now() then return '{"error":"LOCKED"}'::jsonb; end if;
  if v_person.recovery_hash is null or
    v_person.recovery_hash <> pg_catalog.sha256(pg_catalog.convert_to(p_code, 'UTF8')) then
    update splitly_private.participants set
      failed_attempts = case when locked_until <= now() then 1 else failed_attempts + 1 end,
      locked_until = case when
        (case when locked_until <= now() then 1 else failed_attempts + 1 end) >= 5
        then now() + interval '15 minutes' else null end
    where id = p_participant_id;
    return '{"error":"INVALID_RECOVERY"}'::jsonb;
  end if;
  v_new_code := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  update splitly_private.participants set
    pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
    recovery_hash = pg_catalog.sha256(pg_catalog.convert_to(v_new_code, 'UTF8')),
    failed_attempts = 0, locked_until = null
  where id = p_participant_id;
  delete from splitly_private.member_sessions where participant_id = p_participant_id;
  return splitly_private.issue_member_session(v_room_id, p_participant_id, v_new_code);
end;
$$;
create function public.splitly_recover_member(
  p_token text, p_participant_id uuid, p_code text, p_new_pin text
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.recover_member(p_token, p_participant_id, p_code, p_new_pin);
$$;

create function splitly_private.add_participant_v2(p_token text, p_name text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid; v_position integer; v_person_id uuid; v_code text; v_session jsonb;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  perform 1 from splitly_private.rooms where id = v_room_id for update;
  if p_name is null or pg_catalog.char_length(pg_catalog.btrim(p_name)) not between 1 and 40
    or p_pin !~ '^[0-9]{6}$' then raise exception 'INVALID_PARTICIPANT'; end if;
  select coalesce(max(position), 0) + 1 into v_position
    from splitly_private.participants where room_id = v_room_id;
  if v_position > 20 then raise exception 'ROOM_FULL'; end if;
  if exists (select 1 from splitly_private.participants
    where room_id = v_room_id and pg_catalog.lower(name) = pg_catalog.lower(pg_catalog.btrim(p_name))) then
    raise exception 'DUPLICATE_PARTICIPANT';
  end if;
  v_code := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  insert into splitly_private.participants(
    room_id, name, position, pin_hash, recovery_hash
  ) values (
    v_room_id, pg_catalog.btrim(p_name), v_position,
    extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
    pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8'))
  ) returning id into v_person_id;
  v_session := splitly_private.issue_member_session(v_room_id, v_person_id, v_code);
  update splitly_private.rooms set updated_at = now() where id = v_room_id;
  return v_session || pg_catalog.jsonb_build_object(
    'room', splitly_private.room_snapshot_v2(v_room_id, v_session->>'memberToken')
  );
end;
$$;
create function public.splitly_add_participant_v2(p_token text, p_name text, p_pin text)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.add_participant_v2(p_token, p_name, p_pin);
$$;

create function splitly_private.add_expense_v2(
  p_token text, p_member_token text, p_amount_cents bigint, p_description text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid; v_member_id uuid; v_expense_id uuid;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  v_member_id := splitly_private.member_id_for_session(v_room_id, p_member_token);
  if v_member_id is null then return '{"error":"FORBIDDEN"}'::jsonb; end if;
  perform 1 from splitly_private.rooms where id = v_room_id for update;
  if p_amount_cents is null or p_amount_cents not between 1 and 9999999999
    or p_description is not null and pg_catalog.char_length(pg_catalog.btrim(p_description)) > 120 then
    raise exception 'INVALID_EXPENSE';
  end if;
  insert into splitly_private.expenses(room_id, payer_id, amount_cents, description)
    values (v_room_id, v_member_id, p_amount_cents, nullif(pg_catalog.btrim(p_description), ''))
    returning id into v_expense_id;
  insert into splitly_private.expense_members(expense_id, participant_id)
    select v_expense_id, id from splitly_private.participants where room_id = v_room_id;
  update splitly_private.rooms set updated_at = now() where id = v_room_id;
  return splitly_private.room_snapshot_v2(v_room_id, p_member_token);
end;
$$;
create function public.splitly_add_expense_v2(
  p_token text, p_member_token text, p_amount_cents bigint, p_description text
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.add_expense_v2(p_token, p_member_token, p_amount_cents, p_description);
$$;

create function splitly_private.set_expense_members(
  p_token text, p_member_token text, p_expense_id uuid, p_participant_ids uuid[]
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid; v_member_id uuid; v_payer_id uuid; v_count integer;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  v_member_id := splitly_private.member_id_for_session(v_room_id, p_member_token);
  if v_member_id is null then return '{"error":"FORBIDDEN"}'::jsonb; end if;
  perform 1 from splitly_private.rooms where id = v_room_id for update;
  select payer_id into v_payer_id from splitly_private.expenses
    where id = p_expense_id and room_id = v_room_id for update;
  if not found then return null; end if;
  if v_payer_id <> v_member_id then return '{"error":"FORBIDDEN"}'::jsonb; end if;
  if p_participant_ids is null or coalesce(pg_catalog.array_length(p_participant_ids, 1), 0) not between 1 and 20
    or (select count(distinct chosen.id) from pg_catalog.unnest(p_participant_ids) as chosen(id))
      <> pg_catalog.array_length(p_participant_ids, 1) then
    return '{"error":"INVALID_MEMBERS"}'::jsonb;
  end if;
  select count(*) into v_count from splitly_private.expense_members
    where expense_id = p_expense_id and participant_id = any(p_participant_ids);
  if v_count <> pg_catalog.array_length(p_participant_ids, 1) then
    return '{"error":"INVALID_MEMBERS"}'::jsonb;
  end if;
  update splitly_private.expense_members set included = participant_id = any(p_participant_ids)
    where expense_id = p_expense_id;
  update splitly_private.rooms set updated_at = now() where id = v_room_id;
  return splitly_private.room_snapshot_v2(v_room_id, p_member_token);
end;
$$;
create function public.splitly_set_expense_members(
  p_token text, p_member_token text, p_expense_id uuid, p_participant_ids uuid[]
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.set_expense_members(p_token, p_member_token, p_expense_id, p_participant_ids);
$$;

create function splitly_private.proof_target(
  p_token text, p_member_token text, p_expense_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_room_id uuid; v_member_id uuid;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  v_member_id := splitly_private.member_id_for_session(v_room_id, p_member_token);
  if v_member_id is null or not exists (
    select 1 from splitly_private.expenses where id = p_expense_id
      and room_id = v_room_id and payer_id = v_member_id
  ) then return '{"error":"FORBIDDEN"}'::jsonb; end if;
  return pg_catalog.jsonb_build_object('roomId', v_room_id);
end;
$$;
create function public.splitly_proof_target(
  p_token text, p_member_token text, p_expense_id uuid
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select splitly_private.proof_target(p_token, p_member_token, p_expense_id);
$$;

create function splitly_private.set_proof(
  p_token text, p_member_token text, p_expense_id uuid,
  p_path text, p_mime_type text, p_size_bytes integer
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid; v_member_id uuid; v_payer_id uuid; v_previous text;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  v_member_id := splitly_private.member_id_for_session(v_room_id, p_member_token);
  if v_member_id is null then return '{"error":"FORBIDDEN"}'::jsonb; end if;
  perform 1 from splitly_private.rooms where id = v_room_id for update;
  select payer_id, proof_path into v_payer_id, v_previous from splitly_private.expenses
    where id = p_expense_id and room_id = v_room_id for update;
  if not found then return null; end if;
  if v_payer_id <> v_member_id then return '{"error":"FORBIDDEN"}'::jsonb; end if;
  if p_path not like (v_room_id::text || '/' || p_expense_id::text || '/%')
    or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
    or p_size_bytes not between 1 and 5000000 then raise exception 'INVALID_PROOF'; end if;
  update splitly_private.expenses set proof_path = p_path, proof_mime_type = p_mime_type,
    proof_size_bytes = p_size_bytes where id = p_expense_id;
  update splitly_private.rooms set updated_at = now() where id = v_room_id;
  return pg_catalog.jsonb_build_object('previousPath', v_previous);
end;
$$;
create function public.splitly_set_proof(
  p_token text, p_member_token text, p_expense_id uuid,
  p_path text, p_mime_type text, p_size_bytes integer
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.set_proof(p_token, p_member_token, p_expense_id,
    p_path, p_mime_type, p_size_bytes);
$$;
create function splitly_private.proof_info(p_token text, p_expense_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'path', e.proof_path, 'mimeType', e.proof_mime_type, 'sizeBytes', e.proof_size_bytes
  ) from splitly_private.expenses e
  where e.id = p_expense_id and e.room_id = splitly_private.room_id_for_token(p_token)
    and e.proof_path is not null;
$$;
create function public.splitly_proof_info(p_token text, p_expense_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select splitly_private.proof_info(p_token, p_expense_id);
$$;

-- Remove old link-only writes. The new routes require a member session.
revoke execute on function public.splitly_add_participant(text, text) from anon;
revoke execute on function public.splitly_add_expense(text, uuid, bigint, text) from anon;
revoke execute on function splitly_private.add_participant(text, text) from anon;
revoke execute on function splitly_private.add_expense(text, uuid, bigint, text) from anon;

revoke all on all functions in schema splitly_private from public, anon, authenticated;
grant usage on schema splitly_private to anon, service_role;
grant execute on function splitly_private.create_room(text, text[]) to anon;
grant execute on function splitly_private.read_room(text) to anon;
grant execute on function splitly_private.read_room_v2(text, text) to anon;
grant execute on function splitly_private.select_member(text, uuid, text) to anon;
grant execute on function splitly_private.recover_member(text, uuid, text, text) to anon;
grant execute on function splitly_private.add_participant_v2(text, text, text) to anon;
grant execute on function splitly_private.add_expense_v2(text, text, bigint, text) to anon;
grant execute on function splitly_private.set_expense_members(text, text, uuid, uuid[]) to anon;
grant execute on function splitly_private.proof_target(text, text, uuid) to anon;
grant execute on function splitly_private.set_proof(text, text, uuid, text, text, integer) to service_role;
grant execute on function splitly_private.proof_info(text, uuid) to service_role;

revoke all on function public.splitly_read_room_v2(text, text) from public, authenticated;
revoke all on function public.splitly_select_member(text, uuid, text) from public, authenticated;
revoke all on function public.splitly_recover_member(text, uuid, text, text) from public, authenticated;
revoke all on function public.splitly_add_participant_v2(text, text, text) from public, authenticated;
revoke all on function public.splitly_add_expense_v2(text, text, bigint, text) from public, authenticated;
revoke all on function public.splitly_set_expense_members(text, text, uuid, uuid[]) from public, authenticated;
revoke all on function public.splitly_proof_target(text, text, uuid) from public, authenticated;
revoke all on function public.splitly_set_proof(text, text, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.splitly_proof_info(text, uuid) from public, anon, authenticated;
grant execute on function public.splitly_read_room_v2(text, text) to anon;
grant execute on function public.splitly_select_member(text, uuid, text) to anon;
grant execute on function public.splitly_recover_member(text, uuid, text, text) to anon;
grant execute on function public.splitly_add_participant_v2(text, text, text) to anon;
grant execute on function public.splitly_add_expense_v2(text, text, bigint, text) to anon;
grant execute on function public.splitly_set_expense_members(text, text, uuid, uuid[]) to anon;
grant execute on function public.splitly_proof_target(text, text, uuid) to anon;
grant execute on function public.splitly_set_proof(text, text, uuid, text, text, integer) to service_role;
grant execute on function public.splitly_proof_info(text, uuid) to service_role;
