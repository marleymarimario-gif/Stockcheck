-- Upgrade Stockcheck from one shared catalogue to isolated workspaces.
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  owner_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin','member')),
  invited_by uuid not null references auth.users(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists workspace_invites_open_email_idx
  on public.workspace_invites(workspace_id, lower(email)) where accepted_at is null;

insert into public.workspaces(id, name)
values ('00000000-0000-0000-0000-000000000001', 'Mario Warehouse')
on conflict (id) do nothing;

alter table public.products add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.stocktakes add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.stock_ins add column if not exists workspace_id uuid references public.workspaces(id);
update public.products set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null;
update public.stocktakes s set workspace_id = p.workspace_id from public.products p where s.product_id = p.id and s.workspace_id is null;
update public.stock_ins s set workspace_id = p.workspace_id from public.products p where s.product_id = p.id and s.workspace_id is null;
alter table public.products alter column workspace_id set not null;
alter table public.stocktakes alter column workspace_id set not null;
alter table public.stock_ins alter column workspace_id set not null;
create index if not exists products_workspace_idx on public.products(workspace_id, sort_order);
create index if not exists stocktakes_workspace_idx on public.stocktakes(workspace_id, created_at desc);
create index if not exists stock_ins_workspace_idx on public.stock_ins(workspace_id, added_at desc);

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.workspace_members m where m.workspace_id = target_workspace and m.user_id = auth.uid()) $$;

create or replace function public.is_workspace_admin(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.workspace_members m where m.workspace_id = target_workspace and m.user_id = auth.uid() and m.role in ('owner','admin')) $$;

create or replace function public.product_in_workspace(target_product uuid, target_workspace uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.products p where p.id = target_product and p.workspace_id = target_workspace) $$;

create or replace function public.create_workspace(workspace_name text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare new_id uuid;
begin
  if auth.uid() is null or char_length(trim(workspace_name)) not between 1 and 80 then raise exception 'Invalid workspace'; end if;
  insert into public.workspaces(name, owner_id) values (trim(workspace_name), auth.uid()) returning id into new_id;
  insert into public.workspace_members(workspace_id, user_id, email, role)
  values (new_id, auth.uid(), coalesce(auth.jwt()->>'email','member'), 'owner');
  return new_id;
end $$;

create or replace function public.accept_my_workspace_invites()
returns integer language plpgsql security definer set search_path = public
as $$
declare accepted_count integer;
begin
  if auth.uid() is null or coalesce(auth.jwt()->>'email','') = '' then return 0; end if;
  insert into public.workspace_members(workspace_id, user_id, email, role)
  select i.workspace_id, auth.uid(), lower(auth.jwt()->>'email'), i.role
  from public.workspace_invites i
  where lower(i.email) = lower(auth.jwt()->>'email') and i.accepted_at is null
  on conflict (workspace_id, user_id) do nothing;
  get diagnostics accepted_count = row_count;
  update public.workspace_invites set accepted_at = now()
  where lower(email) = lower(auth.jwt()->>'email') and accepted_at is null;
  return accepted_count;
end $$;

revoke all on function public.create_workspace(text) from public;
revoke all on function public.accept_my_workspace_invites() from public;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.accept_my_workspace_invites() to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;

drop policy if exists "members read workspaces" on public.workspaces;
create policy "members read workspaces" on public.workspaces for select to authenticated using (public.is_workspace_member(id));
drop policy if exists "admins update workspaces" on public.workspaces;
create policy "admins update workspaces" on public.workspaces for update to authenticated using (public.is_workspace_admin(id)) with check (public.is_workspace_admin(id));

drop policy if exists "members read memberships" on public.workspace_members;
create policy "members read memberships" on public.workspace_members for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists "members read invites" on public.workspace_invites;
create policy "members read invites" on public.workspace_invites for select to authenticated using (public.is_workspace_admin(workspace_id) or lower(email) = lower(auth.jwt()->>'email'));
drop policy if exists "admins add invites" on public.workspace_invites;
create policy "admins add invites" on public.workspace_invites for insert to authenticated with check (public.is_workspace_admin(workspace_id) and invited_by = auth.uid());
drop policy if exists "admins remove invites" on public.workspace_invites;
create policy "admins remove invites" on public.workspace_invites for delete to authenticated using (public.is_workspace_admin(workspace_id));

drop policy if exists "team reads products" on public.products;
drop policy if exists "team adds products" on public.products;
drop policy if exists "team updates products" on public.products;
create policy "workspace reads products" on public.products for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "workspace adds products" on public.products for insert to authenticated with check (public.is_workspace_member(workspace_id) and created_by = auth.uid());
create policy "workspace updates products" on public.products for update to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists "team reads stocktakes" on public.stocktakes;
drop policy if exists "team adds stocktakes" on public.stocktakes;
create policy "workspace reads stocktakes" on public.stocktakes for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "workspace adds stocktakes" on public.stocktakes for insert to authenticated with check (public.is_workspace_member(workspace_id) and public.product_in_workspace(product_id, workspace_id) and counted_by = auth.uid());

drop policy if exists "team reads stock ins" on public.stock_ins;
drop policy if exists "team adds stock ins" on public.stock_ins;
create policy "workspace reads stock ins" on public.stock_ins for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "workspace adds stock ins" on public.stock_ins for insert to authenticated with check (public.is_workspace_member(workspace_id) and public.product_in_workspace(product_id, workspace_id) and added_by = auth.uid());

drop view if exists public.recent_activity;
drop view if exists public.inventory_current;
create view public.inventory_current with (security_invoker = true) as
select p.workspace_id, p.id, p.category, p.subcategory, p.brand, p.flavor, p.name, p.spec, p.unit,
  p.pack_size, p.low_stock_level, p.sort_order, latest.quantity as latest_quantity,
  latest.stocktake_date, latest.counted_by_email,
  coalesce(sum(si.units_added) filter (where latest.created_at is null or si.added_at > latest.created_at), 0)::integer as stock_in_after_count,
  coalesce(latest.quantity, 0)::integer + coalesce(sum(si.units_added) filter (where latest.created_at is null or si.added_at > latest.created_at), 0)::integer as current_qty
from public.products p
left join lateral (select s.quantity, s.stocktake_date, s.counted_by_email, s.created_at from public.stocktakes s where s.product_id = p.id and s.workspace_id = p.workspace_id order by s.created_at desc limit 1) latest on true
left join public.stock_ins si on si.product_id = p.id and si.workspace_id = p.workspace_id
group by p.workspace_id, p.id, latest.quantity, latest.stocktake_date, latest.counted_by_email, latest.created_at;

create view public.recent_activity with (security_invoker = true) as
select * from (
  select s.workspace_id, s.id, '盤點'::text as kind, p.name as product_name, s.quantity, s.counted_by_email as actor, s.created_at as happened_at from public.stocktakes s join public.products p on p.id = s.product_id and p.workspace_id = s.workspace_id
  union all
  select si.workspace_id, si.id, '入貨'::text as kind, p.name as product_name, si.units_added as quantity, si.added_by_email as actor, si.added_at as happened_at from public.stock_ins si join public.products p on p.id = si.product_id and p.workspace_id = si.workspace_id
) activity;

grant select on public.workspaces, public.workspace_members, public.workspace_invites to authenticated;
grant insert, delete on public.workspace_invites to authenticated;
grant select on public.inventory_current, public.recent_activity to authenticated;

-- The live project also uses a one-time claim_legacy_workspace RPC.
-- Its deployment-specific secret hash is intentionally not stored in this public repository.
