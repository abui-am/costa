-- Require every cost row to reference cost_categories.
-- Targets `public.costs` or legacy `public.monthly_costs` (prefers `costs`).

do $$
declare
  t text;
  fname text;
begin
  select c.relname
  into t
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = 'costs'
  limit 1;

  if t is null then
    select c.relname
    into t
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname = 'monthly_costs'
    limit 1;
  end if;

  if t is null then
    return;
  end if;

  execute format('delete from public.%I where category_id is null', t);

  select con.conname
  into fname
  from pg_constraint con
  join pg_class tbl on tbl.oid = con.conrelid
  join pg_namespace n on n.oid = tbl.relnamespace
  join lateral unnest(con.conkey) as ck(attnum) on true
  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = ck.attnum
  where n.nspname = 'public'
    and tbl.relname = t
    and con.contype = 'f'
    and a.attname = 'category_id'
  limit 1;

  if fname is not null then
    execute format(
      'alter table public.%I drop constraint %I',
      t,
      fname
    );
  end if;

  execute format(
    'alter table public.%I alter column category_id set not null',
    t
  );

  if not exists (
    select 1
    from pg_constraint con
    join pg_class tbl on tbl.oid = con.conrelid
    join pg_namespace n on n.oid = tbl.relnamespace
    where n.nspname = 'public'
      and tbl.relname = t
      and con.conname = 'costs_category_id_fkey'
  ) then
    execute format(
      'alter table public.%I add constraint costs_category_id_fkey foreign key (category_id) references public.cost_categories (id) on delete restrict',
      t
    );
  end if;

  execute format(
    'comment on column public.%I.category_id is %L',
    t,
    'FK to cost_categories — required on every row.'
  );
end
$$;
