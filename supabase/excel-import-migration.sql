-- Excel import audit labels and workspace-safe duplicate order protection.
alter table public.stocktakes add column if not exists source text not null default '手動盤點';

drop index if exists public.stock_ins_order_product_idx;
create unique index if not exists stock_ins_workspace_order_product_idx
  on public.stock_ins(workspace_id, order_number, product_id)
  where order_number is not null and trim(order_number) <> '';

drop view if exists public.recent_activity;
create view public.recent_activity with (security_invoker = true) as
select * from (
  select s.workspace_id, s.id, '盤點'::text as kind, s.product_id, p.name as product_name,
    s.quantity, s.entered_quantity, s.entered_unit, p.pack_size, s.counted_by as actor_id,
    s.counted_by_email as actor, s.created_at as happened_at, false as is_corrected,
    null::integer as original_quantity, null::text as original_product_name,
    null::text as corrected_by_email, null::timestamptz as corrected_at, s.source
  from public.stocktakes s join public.products p on p.id = s.product_id and p.workspace_id = s.workspace_id
  union all
  select si.workspace_id, si.id, '入貨'::text, coalesce(si.corrected_product_id, si.product_id),
    effective_product.name, coalesce(si.corrected_units, si.units_added),
    coalesce(si.corrected_entered_quantity, si.entered_quantity), coalesce(si.corrected_entered_unit, si.entered_unit),
    effective_product.pack_size, si.added_by, si.added_by_email, si.added_at, si.corrected_at is not null,
    case when si.corrected_at is not null then si.units_added else null end,
    case when si.corrected_at is not null then original_product.name else null end,
    si.corrected_by_email, si.corrected_at, si.source
  from public.stock_ins si
  join public.products original_product on original_product.id = si.product_id and original_product.workspace_id = si.workspace_id
  join public.products effective_product on effective_product.id = coalesce(si.corrected_product_id, si.product_id) and effective_product.workspace_id = si.workspace_id
) activity;

grant select on public.recent_activity to authenticated;
