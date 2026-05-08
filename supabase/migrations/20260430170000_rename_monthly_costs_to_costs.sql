-- Rename legacy `monthly_costs` → `costs` (index + FK constraint names aligned).

do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'monthly_costs'
      and c.relkind = 'r'
  ) then
    alter table public.monthly_costs rename to costs;
  end if;
end
$$;

do $$
begin
  alter index public.monthly_costs_category_id_idx rename to costs_category_id_idx;
exception
  when undefined_object then null;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname = 'costs'
  ) then
    alter table public.costs rename constraint monthly_costs_category_id_fkey to costs_category_id_fkey;
  end if;
exception
  when undefined_object then null;
end
$$;

comment on table public.cost_categories is 'User-defined cost categories; link from costs.category_id when used.';
