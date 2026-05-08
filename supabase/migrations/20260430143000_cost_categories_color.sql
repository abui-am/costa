alter table public.cost_categories
  add column if not exists color text not null default '';

comment on column public.cost_categories.color is 'UI tint, e.g. #RRGGBB, #RGB, or #RRGGBBAA; empty when unset.';
