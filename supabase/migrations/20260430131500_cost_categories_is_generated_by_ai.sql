alter table public.cost_categories
  add column if not exists is_generated_by_ai boolean not null default false;

comment on column public.cost_categories.is_generated_by_ai is
  'True when this category row was created by the expense extraction pipeline (not manually by the user).';
