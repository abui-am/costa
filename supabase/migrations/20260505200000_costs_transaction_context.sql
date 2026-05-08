-- Receipt / transaction context per cost row.

alter table public.costs
  add column if not exists spent_on date null,
  add column if not exists location text not null default '',
  add column if not exists payment_method text not null default '';

comment on column public.costs.spent_on is 'Calendar date of purchase when known (YYYY-MM-DD).';
comment on column public.costs.location is 'Merchant location or venue (free text).';
comment on column public.costs.payment_method is 'Payment method as on receipt or described (e.g. Credit Card).';
