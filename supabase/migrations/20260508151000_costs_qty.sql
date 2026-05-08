-- Add qty to costs.
-- Represents the purchase quantity for the line item (e.g. 3 coffees, 1.5 kg).
-- amount continues to mean the line total in major currency units.

alter table public.costs
  add column qty numeric not null default 1;

alter table public.costs
  add constraint costs_qty_positive
  check (qty > 0);

comment on column public.costs.qty is
  'Purchase quantity for the line item. Defaults to 1 for single-unit and legacy rows. amount stays the line total regardless of qty.';
