-- A room link is a bearer capability. Only the RPC functions can read these tables.
create schema if not exists splitly_private;
revoke all on schema splitly_private from public;

create table splitly_private.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table splitly_private.participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references splitly_private.rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  position integer not null check (position between 1 and 20),
  unique (room_id, position)
);
create unique index participants_unique_name on splitly_private.participants
  (room_id, lower(name));

create table splitly_private.expenses (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references splitly_private.rooms(id) on delete cascade,
  payer_id uuid not null references splitly_private.participants(id),
  amount_cents bigint not null check (amount_cents between 1 and 9999999999),
  description text check (description is null or char_length(description) between 1 and 120),
  created_at timestamptz not null default now()
);
create index expenses_by_room on splitly_private.expenses(room_id, created_at desc);

alter table splitly_private.rooms enable row level security;
alter table splitly_private.participants enable row level security;
alter table splitly_private.expenses enable row level security;
revoke all on all tables in schema splitly_private from public, anon, authenticated;

create function splitly_private.room_id_for_token(p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from splitly_private.rooms
  where p_token ~ '^[0-9a-f]{64}$'
    and token_hash = pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'));
$$;

create function splitly_private.room_snapshot(p_room_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', r.id,
    'name', r.name,
    'updatedAt', r.updated_at,
    'participants', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'name', p.name, 'position', p.position
      ) order by p.position)
      from splitly_private.participants p where p.room_id = r.id
    ), '[]'::jsonb),
    'expenses', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'payerId', e.payer_id, 'amountCents', e.amount_cents,
        'description', e.description, 'createdAt', e.created_at
      ) order by e.created_at desc, e.id desc)
      from splitly_private.expenses e where e.room_id = r.id
    ), '[]'::jsonb)
  ) from splitly_private.rooms r where r.id = p_room_id;
$$;

create function splitly_private.create_room(p_name text, p_names text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room_id uuid;
  v_token text;
  v_name text;
  v_seen text[] := '{}';
  v_position integer := 0;
begin
  if p_names is null or pg_catalog.array_length(p_names, 1) not between 2 and 20 then
    raise exception 'INVALID_PARTICIPANTS';
  end if;
  if p_name is not null and pg_catalog.char_length(pg_catalog.btrim(p_name)) > 80 then
    raise exception 'INVALID_ROOM_NAME';
  end if;
  foreach v_name in array p_names loop
    v_name := pg_catalog.btrim(v_name);
    if v_name is null or pg_catalog.char_length(v_name) not between 1 and 40
      or pg_catalog.lower(v_name) = any(v_seen) then
      raise exception 'INVALID_PARTICIPANTS';
    end if;
    v_seen := pg_catalog.array_append(v_seen, pg_catalog.lower(v_name));
  end loop;

  v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') ||
    pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  insert into splitly_private.rooms(name, token_hash)
    values (coalesce(nullif(pg_catalog.btrim(p_name), ''), 'ห้องค่าใช้จ่าย'),
      pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8')))
    returning id into v_room_id;
  foreach v_name in array p_names loop
    v_position := v_position + 1;
    insert into splitly_private.participants(room_id, name, position)
      values (v_room_id, pg_catalog.btrim(v_name), v_position);
  end loop;
  return pg_catalog.jsonb_build_object(
    'token', v_token,
    'room', splitly_private.room_snapshot(v_room_id)
  );
end;
$$;

create function splitly_private.read_room(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select splitly_private.room_snapshot(splitly_private.room_id_for_token(p_token));
$$;

create function splitly_private.add_participant(p_token text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room_id uuid;
  v_position integer;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  perform 1 from splitly_private.rooms where id = v_room_id for update;
  if p_name is null or pg_catalog.char_length(pg_catalog.btrim(p_name)) not between 1 and 40 then
    raise exception 'INVALID_PARTICIPANT';
  end if;
  select coalesce(max(position), 0) + 1 into v_position
    from splitly_private.participants where room_id = v_room_id;
  if v_position > 20 then raise exception 'ROOM_FULL'; end if;
  if exists (select 1 from splitly_private.participants
      where room_id = v_room_id and pg_catalog.lower(name) = pg_catalog.lower(pg_catalog.btrim(p_name))) then
    raise exception 'DUPLICATE_PARTICIPANT';
  end if;
  insert into splitly_private.participants(room_id, name, position)
    values (v_room_id, pg_catalog.btrim(p_name), v_position);
  update splitly_private.rooms set updated_at = now() where id = v_room_id;
  return splitly_private.room_snapshot(v_room_id);
end;
$$;

create function splitly_private.add_expense(
  p_token text, p_payer_id uuid, p_amount_cents bigint, p_description text
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  perform 1 from splitly_private.rooms where id = v_room_id for update;
  if p_amount_cents is null or p_amount_cents not between 1 and 9999999999 then
    raise exception 'INVALID_AMOUNT';
  end if;
  if p_description is not null and pg_catalog.char_length(pg_catalog.btrim(p_description)) > 120 then
    raise exception 'INVALID_DESCRIPTION';
  end if;
  if not exists (select 1 from splitly_private.participants
      where room_id = v_room_id and id = p_payer_id) then
    raise exception 'INVALID_PAYER';
  end if;
  insert into splitly_private.expenses(room_id, payer_id, amount_cents, description)
    values (v_room_id, p_payer_id, p_amount_cents,
      nullif(pg_catalog.btrim(p_description), ''));
  update splitly_private.rooms set updated_at = now() where id = v_room_id;
  return splitly_private.room_snapshot(v_room_id);
end;
$$;

-- PostgREST exposes only public wrappers. The private schema is not an API schema.
create function public.splitly_create_room(p_name text, p_names text[])
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.create_room(p_name, p_names);
$$;
create function public.splitly_read_room(p_token text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select splitly_private.read_room(p_token);
$$;
create function public.splitly_add_participant(p_token text, p_name text)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.add_participant(p_token, p_name);
$$;
create function public.splitly_add_expense(
  p_token text, p_payer_id uuid, p_amount_cents bigint, p_description text
)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.add_expense(p_token, p_payer_id, p_amount_cents, p_description);
$$;

revoke all on all functions in schema splitly_private from public, anon, authenticated;
revoke all on function public.splitly_create_room(text, text[]) from public, authenticated;
revoke all on function public.splitly_read_room(text) from public, authenticated;
revoke all on function public.splitly_add_participant(text, text) from public, authenticated;
revoke all on function public.splitly_add_expense(text, uuid, bigint, text) from public, authenticated;
grant usage on schema splitly_private to anon;
grant execute on function splitly_private.create_room(text, text[]) to anon;
grant execute on function splitly_private.read_room(text) to anon;
grant execute on function splitly_private.add_participant(text, text) to anon;
grant execute on function splitly_private.add_expense(text, uuid, bigint, text) to anon;
grant execute on function public.splitly_create_room(text, text[]) to anon;
grant execute on function public.splitly_read_room(text) to anon;
grant execute on function public.splitly_add_participant(text, text) to anon;
grant execute on function public.splitly_add_expense(text, uuid, bigint, text) to anon;
