-- Per-user expense categories (emoji + name).
-- Apply with Supabase CLI: `supabase db push` / link remote, or run in SQL editor.

create table if not exists public.cost_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  emoji text not null default '',
  name text not null,
  constraint cost_categories_user_name_unique unique (user_id, name)
);

comment on table public.cost_categories is 'User-defined cost categories; link from costs.category_id when used.';

create index if not exists cost_categories_user_id_idx
  on public.cost_categories (user_id);

alter table public.cost_categories enable row level security;

create policy "cost_categories_select_own"
  on public.cost_categories
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "cost_categories_insert_own"
  on public.cost_categories
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "cost_categories_update_own"
  on public.cost_categories
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "cost_categories_delete_own"
  on public.cost_categories
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Optional: FK from `costs` or legacy `monthly_costs` when that table already exists.
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'costs'
  ) then
    alter table public.costs
      add column if not exists category_id uuid references public.cost_categories (id) on delete set null;
    create index if not exists costs_category_id_idx
      on public.costs (category_id);
  elsif exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'monthly_costs'
  ) then
    alter table public.monthly_costs
      add column if not exists category_id uuid references public.cost_categories (id) on delete set null;
    create index if not exists monthly_costs_category_id_idx
      on public.monthly_costs (category_id);
  end if;
end
$$;
