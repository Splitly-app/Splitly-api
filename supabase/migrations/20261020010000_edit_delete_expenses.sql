create function splitly_private.update_expense(
  p_token text, p_member_token text, p_expense_id uuid,
  p_amount_cents bigint, p_description text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid; v_member_id uuid; v_payer_id uuid;
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
  if p_amount_cents is null or p_amount_cents not between 1 and 9999999999
    or p_description is not null and pg_catalog.char_length(pg_catalog.btrim(p_description)) > 120 then
    raise exception 'INVALID_EXPENSE';
  end if;
  update splitly_private.expenses set amount_cents = p_amount_cents,
    description = nullif(pg_catalog.btrim(p_description), '')
    where id = p_expense_id;
  update splitly_private.rooms set updated_at = now() where id = v_room_id;
  return splitly_private.room_snapshot_v2(v_room_id, p_member_token);
end;
$$;

create function public.splitly_update_expense(
  p_token text, p_member_token text, p_expense_id uuid,
  p_amount_cents bigint, p_description text
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.update_expense(
    p_token, p_member_token, p_expense_id, p_amount_cents, p_description);
$$;

create function splitly_private.delete_expense(
  p_token text, p_member_token text, p_expense_id uuid
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room_id uuid; v_member_id uuid; v_payer_id uuid; v_proof_path text;
begin
  v_room_id := splitly_private.room_id_for_token(p_token);
  if v_room_id is null then return null; end if;
  v_member_id := splitly_private.member_id_for_session(v_room_id, p_member_token);
  if v_member_id is null then return '{"error":"FORBIDDEN"}'::jsonb; end if;
  perform 1 from splitly_private.rooms where id = v_room_id for update;
  select payer_id, proof_path into v_payer_id, v_proof_path
    from splitly_private.expenses
    where id = p_expense_id and room_id = v_room_id for update;
  if not found then return null; end if;
  if v_payer_id <> v_member_id then return '{"error":"FORBIDDEN"}'::jsonb; end if;
  delete from splitly_private.expenses where id = p_expense_id;
  update splitly_private.rooms set updated_at = now() where id = v_room_id;
  return pg_catalog.jsonb_build_object(
    'room', splitly_private.room_snapshot_v2(v_room_id, p_member_token),
    'proofPath', v_proof_path
  );
end;
$$;

create function public.splitly_delete_expense(
  p_token text, p_member_token text, p_expense_id uuid
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select splitly_private.delete_expense(p_token, p_member_token, p_expense_id);
$$;

revoke all on function splitly_private.update_expense(text, text, uuid, bigint, text) from public, anon, authenticated;
revoke all on function splitly_private.delete_expense(text, text, uuid) from public, anon, authenticated;
revoke all on function public.splitly_update_expense(text, text, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.splitly_delete_expense(text, text, uuid) from public, anon, authenticated;
grant execute on function splitly_private.update_expense(text, text, uuid, bigint, text) to anon;
grant execute on function splitly_private.delete_expense(text, text, uuid) to anon;
grant execute on function public.splitly_update_expense(text, text, uuid, bigint, text) to anon;
grant execute on function public.splitly_delete_expense(text, text, uuid) to anon;
