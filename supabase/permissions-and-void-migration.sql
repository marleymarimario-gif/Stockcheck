-- Store rename, member roles and auditable record voiding.

alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check
  check (role in ('owner', 'admin', 'member', 'viewer'));
alter table public.workspace_invites drop constraint if exists workspace_invites_role_check;
alter table public.workspace_invites add constraint workspace_invites_role_check
  check (role in ('admin', 'member', 'viewer'));

alter table public.stocktakes add column if not exists voided_at timestamptz;
alter table public.stocktakes add column if not exists voided_by uuid references auth.users(id);
alter table public.stocktakes add column if not exists voided_by_email text;
alter table public.stocktakes add column if not exists void_reason text;
alter table public.stock_ins add column if not exists voided_at timestamptz;
alter table public.stock_ins add column if not exists voided_by uuid references auth.users(id);
alter table public.stock_ins add column if not exists voided_by_email text;
alter table public.stock_ins add column if not exists void_reason text;

create or replace function public.is_workspace_owner(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace and m.user_id = auth.uid() and m.role = 'owner'
  )
$$;

create or replace function public.has_workspace_write_access(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace and m.user_id = auth.uid()
      and m.role in ('owner', 'admin', 'member')
  )
$$;

create or replace function public.rename_workspace(target_workspace uuid, new_name text)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_workspace_owner(target_workspace)
    or char_length(trim(new_name)) not between 1 and 80 then
    raise exception 'Not allowed';
  end if;
  update public.workspaces set name = trim(new_name) where id = target_workspace;
  return found;
end $$;

create or replace function public.update_workspace_member_role(
  target_workspace uuid, target_user uuid, new_role text
) returns boolean language plpgsql security definer set search_path = public
as $$
declare caller_role text; current_role text;
begin
  select role into caller_role from public.workspace_members
  where workspace_id = target_workspace and user_id = auth.uid();
  select role into current_role from public.workspace_members
  where workspace_id = target_workspace and user_id = target_user;
  if caller_role not in ('owner', 'admin') or current_role is null or current_role = 'owner'
    or new_role not in ('admin', 'member', 'viewer') then
    raise exception 'Not allowed';
  end if;
  if caller_role = 'admin' and (current_role = 'admin' or new_role = 'admin') then
    raise exception 'Only the owner can manage administrators';
  end if;
  update public.workspace_members set role = new_role
  where workspace_id = target_workspace and user_id = target_user;
  return found;
end $$;

create or replace function public.remove_workspace_member(
  target_workspace uuid, target_user uuid
) returns boolean language plpgsql security definer set search_path = public
as $$
declare caller_role text; current_role text;
begin
  select role into caller_role from public.workspace_members
  where workspace_id = target_workspace and user_id = auth.uid();
  select role into current_role from public.workspace_members
  where workspace_id = target_workspace and user_id = target_user;
  if caller_role not in ('owner', 'admin') or current_role is null or current_role = 'owner' then
    raise exception 'Not allowed';
  end if;
  if caller_role = 'admin' and current_role = 'admin' then
    raise exception 'Only the owner can remove administrators';
  end if;
  delete from public.workspace_members
  where workspace_id = target_workspace and user_id = target_user;
  return found;
end $$;

create or replace function public.void_activity_record(
  target_workspace uuid, target_kind text, target_id bigint,
  target_reason text, target_batch boolean default false
) returns integer language plpgsql security definer set search_path = public
as $$
declare affected integer; batch_order text;
begin
  if not public.is_workspace_admin(target_workspace) or char_length(trim(target_reason)) < 2 then
    raise exception 'Not allowed';
  end if;
  if target_kind = '入貨' then
    select order_number into batch_order from public.stock_ins
    where workspace_id = target_workspace and id = target_id and voided_at is null;
    if not found then raise exception 'Record not found'; end if;
    if target_batch and coalesce(trim(batch_order), '') <> '' then
      update public.stock_ins set voided_at = now(), voided_by = auth.uid(),
        voided_by_email = coalesce(auth.jwt()->>'email', 'team member'), void_reason = trim(target_reason)
      where workspace_id = target_workspace and order_number = batch_order and voided_at is null;
    else
      update public.stock_ins set voided_at = now(), voided_by = auth.uid(),
        voided_by_email = coalesce(auth.jwt()->>'email', 'team member'), void_reason = trim(target_reason)
      where workspace_id = target_workspace and id = target_id and voided_at is null;
    end if;
  elsif target_kind = '盤點' then
    update public.stocktakes set voided_at = now(), voided_by = auth.uid(),
      voided_by_email = coalesce(auth.jwt()->>'email', 'team member'), void_reason = trim(target_reason)
    where workspace_id = target_workspace and id = target_id and voided_at is null;
  else
    raise exception 'Invalid record type';
  end if;
  get diagnostics affected = row_count;
  return affected;
end $$;

revoke all on function public.rename_workspace(uuid, text) from public;
revoke all on function public.update_workspace_member_role(uuid, uuid, text) from public;
revoke all on function public.remove_workspace_member(uuid, uuid) from public;
revoke all on function public.void_activity_record(uuid, text, bigint, text, boolean) from public;
grant execute on function public.rename_workspace(uuid, text) to authenticated;
grant execute on function public.update_workspace_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_workspace_member(uuid, uuid) to authenticated;
grant execute on function public.void_activity_record(uuid, text, bigint, text, boolean) to authenticated;

create or replace function public.correct_stock_in(
  target_workspace uuid, target_stock_in bigint, target_product uuid,
  target_quantity integer, target_unit_mode text, target_product_name text,
  target_category text, target_subcategory text
) returns boolean language plpgsql security definer set search_path = public
as $$
declare original_entry public.stock_ins%rowtype; target_pack_size integer; target_unit text; target_units integer;
begin
  if auth.uid() is null or not public.is_workspace_admin(target_workspace)
    or target_quantity <= 0 or target_unit_mode not in ('package', 'base')
    or trim(target_product_name) = '' or trim(target_category) = '' or trim(target_subcategory) = '' then
    raise exception 'Not allowed';
  end if;
  select * into original_entry from public.stock_ins
  where id = target_stock_in and workspace_id = target_workspace and voided_at is null;
  if not found then raise exception 'Record not found'; end if;
  select pack_size, unit into target_pack_size, target_unit from public.products
  where id = target_product and workspace_id = target_workspace;
  if not found then raise exception 'Invalid product'; end if;
  update public.products set name = trim(target_product_name), category = trim(target_category), subcategory = trim(target_subcategory)
  where id = target_product and workspace_id = target_workspace;
  target_units := case when target_unit_mode = 'package' then target_quantity * target_pack_size else target_quantity end;
  update public.stock_ins set corrected_product_id = target_product,
    corrected_pieces = case when target_unit_mode = 'package' then target_quantity else 1 end,
    corrected_units = target_units, corrected_entered_quantity = target_quantity,
    corrected_entered_unit = case when target_unit_mode = 'package' then '箱／包' else target_unit end,
    corrected_by = auth.uid(), corrected_by_email = coalesce(auth.jwt()->>'email', 'team member'), corrected_at = now()
  where id = target_stock_in and workspace_id = target_workspace;
  return true;
end $$;

drop policy if exists "admins update workspaces" on public.workspaces;
drop policy if exists "owners update workspaces" on public.workspaces;
create policy "owners update workspaces" on public.workspaces for update to authenticated
  using (public.is_workspace_owner(id)) with check (public.is_workspace_owner(id));

drop policy if exists "admins add invites" on public.workspace_invites;
create policy "admins add invites" on public.workspace_invites for insert to authenticated
  with check (
    public.is_workspace_admin(workspace_id) and invited_by = auth.uid()
    and role in ('member', 'viewer', 'admin')
    and (role <> 'admin' or public.is_workspace_owner(workspace_id))
  );

drop policy if exists "workspace adds products" on public.products;
drop policy if exists "workspace updates products" on public.products;
drop policy if exists "workspace admins add products" on public.products;
drop policy if exists "workspace admins update products" on public.products;
create policy "workspace admins add products" on public.products for insert to authenticated
  with check (public.is_workspace_admin(workspace_id) and created_by = auth.uid());
create policy "workspace admins update products" on public.products for update to authenticated
  using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace adds stocktakes" on public.stocktakes;
drop policy if exists "workspace writers add stocktakes" on public.stocktakes;
create policy "workspace writers add stocktakes" on public.stocktakes for insert to authenticated
  with check (public.has_workspace_write_access(workspace_id)
    and public.product_in_workspace(product_id, workspace_id) and counted_by = auth.uid());
drop policy if exists "workspace adds stock ins" on public.stock_ins;
drop policy if exists "workspace writers add stock ins" on public.stock_ins;
create policy "workspace writers add stock ins" on public.stock_ins for insert to authenticated
  with check (public.has_workspace_write_access(workspace_id)
    and public.product_in_workspace(product_id, workspace_id) and added_by = auth.uid());

drop index if exists public.stock_ins_workspace_order_product_idx;
create unique index stock_ins_workspace_order_product_idx
  on public.stock_ins(workspace_id, order_number, product_id)
  where order_number is not null and trim(order_number) <> '' and voided_at is null;

drop view if exists public.recent_activity;
drop view if exists public.inventory_current;
create view public.inventory_current with (security_invoker = true) as
select p.workspace_id, p.id, p.category, p.subcategory, p.brand, p.flavor, p.name, p.spec, p.unit,
  p.pack_size, p.low_stock_level, p.sort_order, latest.quantity as latest_quantity,
  latest.stocktake_date, latest.counted_by_email,
  coalesce(sum(coalesce(si.corrected_units, si.units_added)) filter
    (where si.voided_at is null and (latest.created_at is null or si.added_at > latest.created_at)), 0)::integer as stock_in_after_count,
  coalesce(latest.quantity, 0)::integer + coalesce(sum(coalesce(si.corrected_units, si.units_added)) filter
    (where si.voided_at is null and (latest.created_at is null or si.added_at > latest.created_at)), 0)::integer as current_qty
from public.products p
left join lateral (
  select s.quantity, s.stocktake_date, s.counted_by_email, s.created_at
  from public.stocktakes s
  where s.product_id = p.id and s.workspace_id = p.workspace_id and s.voided_at is null
  order by s.created_at desc limit 1
) latest on true
left join public.stock_ins si
  on coalesce(si.corrected_product_id, si.product_id) = p.id and si.workspace_id = p.workspace_id
group by p.workspace_id, p.id, latest.quantity, latest.stocktake_date, latest.counted_by_email, latest.created_at;

create view public.recent_activity with (security_invoker = true) as
select * from (
  select s.workspace_id, s.id, '盤點'::text as kind, s.product_id, p.name as product_name,
    s.quantity, s.entered_quantity, s.entered_unit, p.pack_size, s.counted_by as actor_id,
    s.counted_by_email as actor, s.created_at as happened_at, false as is_corrected,
    null::integer as original_quantity, null::text as original_product_name,
    null::text as corrected_by_email, null::timestamptz as corrected_at, s.source,
    null::text as order_number, s.voided_at is not null as is_voided,
    s.voided_by_email, s.voided_at, s.void_reason
  from public.stocktakes s join public.products p on p.id = s.product_id and p.workspace_id = s.workspace_id
  union all
  select si.workspace_id, si.id, '入貨'::text, coalesce(si.corrected_product_id, si.product_id),
    effective_product.name, coalesce(si.corrected_units, si.units_added),
    coalesce(si.corrected_entered_quantity, si.entered_quantity), coalesce(si.corrected_entered_unit, si.entered_unit),
    effective_product.pack_size, si.added_by, si.added_by_email, si.added_at, si.corrected_at is not null,
    case when si.corrected_at is not null then si.units_added else null end,
    case when si.corrected_at is not null then original_product.name else null end,
    si.corrected_by_email, si.corrected_at, si.source, si.order_number,
    si.voided_at is not null, si.voided_by_email, si.voided_at, si.void_reason
  from public.stock_ins si
  join public.products original_product on original_product.id = si.product_id and original_product.workspace_id = si.workspace_id
  join public.products effective_product on effective_product.id = coalesce(si.corrected_product_id, si.product_id) and effective_product.workspace_id = si.workspace_id
) activity;

grant select on public.inventory_current, public.recent_activity to authenticated;
