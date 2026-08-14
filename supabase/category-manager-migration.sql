create or replace function public.move_category_to_subcategory(
  target_workspace uuid,
  source_category text,
  target_category text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  moved_count integer;
  clean_source text := trim(source_category);
  clean_target text := trim(target_category);
begin
  if auth.uid() is null or not public.is_workspace_admin(target_workspace) then
    raise exception 'Only workspace administrators can manage categories';
  end if;

  if clean_source = '' or clean_target = '' or clean_source = clean_target then
    raise exception 'Source and target categories must be different';
  end if;

  update public.products
  set category = clean_target,
      subcategory = clean_source
  where workspace_id = target_workspace
    and category = clean_source;

  get diagnostics moved_count = row_count;
  if moved_count = 0 then
    raise exception 'No products found in source category';
  end if;

  return moved_count;
end;
$$;

revoke all on function public.move_category_to_subcategory(uuid, text, text) from public;
grant execute on function public.move_category_to_subcategory(uuid, text, text) to authenticated;
