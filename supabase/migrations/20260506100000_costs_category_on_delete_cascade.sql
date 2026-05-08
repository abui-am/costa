-- Deleting a cost category removes costs that referenced it (category_id NOT NULL, so CASCADE is the safe denormalization cleanup).

alter table public.costs
  drop constraint if exists costs_category_id_fkey;

alter table public.costs
  add constraint costs_category_id_fkey
  foreign key (category_id)
  references public.cost_categories (id)
  on delete cascade;

comment on constraint costs_category_id_fkey on public.costs is
  'Removing a category deletes its costs (FK cascade).';
