-- Traceable stock-in corrections. The original entry remains unchanged.
alter table public.stock_ins add column if not exists corrected_product_id uuid references public.products(id);
alter table public.stock_ins add column if not exists corrected_pieces integer check (corrected_pieces > 0);
alter table public.stock_ins add column if not exists corrected_units integer check (corrected_units > 0);
alter table public.stock_ins add column if not exists corrected_entered_quantity integer check (corrected_entered_quantity > 0);
alter table public.stock_ins add column if not exists corrected_entered_unit text;
alter table public.stock_ins add column if not exists corrected_by uuid references auth.users(id);
alter table public.stock_ins add column if not exists corrected_by_email text;
alter table public.stock_ins add column if not exists corrected_at timestamptz;

drop policy if exists "workspace corrects stock ins" on public.stock_ins;
revoke update on public.stock_ins from authenticated;

create or replace function public.correct_stock_in(
  target_workspace uuid,
  target_stock_in bigint,
  target_product uuid,
  target_quantity integer,
  target_unit_mode text
) returns boolean language plpgsql security definer set search_path = public
as $$
declare
  original_entry public.stock_ins%rowtype;
  target_pack_size integer;
  target_unit text;
  target_units integer;
begin
  if auth.uid() is null or target_quantity <= 0 or target_unit_mode not in ('package', 'base') then
    raise exception 'Invalid correction';
  end if;
  select * into original_entry from public.stock_ins
  where id = target_stock_in and workspace_id = target_workspace;
  if not found or not public.is_workspace_member(target_workspace)
    or (original_entry.added_by <> auth.uid() and not public.is_workspace_admin(target_workspace)) then
    raise exception 'Not allowed';
  end if;
  select pack_size, unit into target_pack_size, target_unit from public.products
  where id = target_product and workspace_id = target_workspace;
  if not found then raise exception 'Invalid product'; end if;
  target_units := case when target_unit_mode = 'package' then target_quantity * target_pack_size else target_quantity end;
  update public.stock_ins set
    corrected_product_id = target_product,
    corrected_pieces = case when target_unit_mode = 'package' then target_quantity else 1 end,
    corrected_units = target_units,
    corrected_entered_quantity = target_quantity,
    corrected_entered_unit = case when target_unit_mode = 'package' then '箱／包' else target_unit end,
    corrected_by = auth.uid(),
    corrected_by_email = coalesce(auth.jwt()->>'email', 'team member'),
    corrected_at = now()
  where id = target_stock_in and workspace_id = target_workspace;
  return true;
end $$;

revoke all on function public.correct_stock_in(uuid, bigint, uuid, integer, text) from public;
grant execute on function public.correct_stock_in(uuid, bigint, uuid, integer, text) to authenticated;

drop view if exists public.recent_activity;
drop view if exists public.inventory_current;

create view public.inventory_current with (security_invoker = true) as
select p.workspace_id, p.id, p.category, p.brand, p.flavor, p.name, p.spec, p.unit,
  p.pack_size, p.low_stock_level, p.sort_order, latest.quantity as latest_quantity,
  latest.stocktake_date, latest.counted_by_email,
  coalesce(sum(coalesce(si.corrected_units, si.units_added)) filter (
    where latest.created_at is null or si.added_at > latest.created_at
  ), 0)::integer as stock_in_after_count,
  coalesce(latest.quantity, 0)::integer + coalesce(sum(coalesce(si.corrected_units, si.units_added)) filter (
    where latest.created_at is null or si.added_at > latest.created_at
  ), 0)::integer as current_qty
from public.products p
left join lateral (
  select s.quantity, s.stocktake_date, s.counted_by_email, s.created_at
  from public.stocktakes s
  where s.product_id = p.id and s.workspace_id = p.workspace_id
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
    null::text as corrected_by_email, null::timestamptz as corrected_at
  from public.stocktakes s
  join public.products p on p.id = s.product_id and p.workspace_id = s.workspace_id
  union all
  select si.workspace_id, si.id, '入貨'::text as kind,
    coalesce(si.corrected_product_id, si.product_id) as product_id,
    effective_product.name as product_name,
    coalesce(si.corrected_units, si.units_added) as quantity,
    coalesce(si.corrected_entered_quantity, si.entered_quantity) as entered_quantity,
    coalesce(si.corrected_entered_unit, si.entered_unit) as entered_unit,
    effective_product.pack_size, si.added_by as actor_id, si.added_by_email as actor,
    si.added_at as happened_at, si.corrected_at is not null as is_corrected,
    case when si.corrected_at is not null then si.units_added else null end as original_quantity,
    case when si.corrected_at is not null then original_product.name else null end as original_product_name,
    si.corrected_by_email, si.corrected_at
  from public.stock_ins si
  join public.products original_product
    on original_product.id = si.product_id and original_product.workspace_id = si.workspace_id
  join public.products effective_product
    on effective_product.id = coalesce(si.corrected_product_id, si.product_id)
   and effective_product.workspace_id = si.workspace_id
) activity;

grant select on public.inventory_current, public.recent_activity to authenticated;
