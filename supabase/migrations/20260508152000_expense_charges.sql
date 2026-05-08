-- Add expense_charges table: tax / service charges attached to an expense.
-- Supports percentage (0–100) and fix_amount (major currency units).

-- ── 1. Enums ─────────────────────────────────────────────────────────────────

create type public.expense_charge_type as enum (
  'tax',
  'service_charge'
);

comment on type public.expense_charge_type is
  'Category of surcharge attached to an expense.';

create type public.expense_charge_amount_type as enum (
  'percentage',
  'fix_amount'
);

comment on type public.expense_charge_amount_type is
  'How the charge amount is expressed: percentage (0–100) or a fixed monetary amount.';

-- ── 2. Table ─────────────────────────────────────────────────────────────────

create table public.expense_charges (
  id          uuid                              primary key default gen_random_uuid(),
  expense_id  uuid                              not null references public.expenses (id) on delete cascade,
  user_id     uuid                              not null references auth.users (id) on delete cascade,
  type        public.expense_charge_type        not null,
  amount_type public.expense_charge_amount_type not null,
  amount      numeric                           not null,
  currency    text                              null,
  created_at  timestamptz                       not null default now(),

  constraint expense_charges_amount_non_negative check (amount >= 0),
  constraint expense_charges_percentage_range
    check (amount_type <> 'percentage' or (amount >= 0 and amount <= 100))
);

comment on table  public.expense_charges             is '1:N surcharges (tax, service) on a parent expense row. Stored metadata only — not auto-applied to cost totals.';
comment on column public.expense_charges.type        is 'tax or service_charge.';
comment on column public.expense_charges.amount_type is 'percentage (0–100, e.g. 11 = 11%) or fix_amount (major currency units).';
comment on column public.expense_charges.amount      is 'Charge value. For percentage: 0–100. For fix_amount: major currency units.';
comment on column public.expense_charges.currency    is 'ISO 4217 code; relevant when amount_type = fix_amount. NULL means same currency as parent expense.';

-- ── 3. Indexes ───────────────────────────────────────────────────────────────

create index expense_charges_expense_id_idx on public.expense_charges (expense_id);
create index expense_charges_user_id_idx    on public.expense_charges (user_id);

-- ── 4. RLS ───────────────────────────────────────────────────────────────────

alter table public.expense_charges enable row level security;

create policy "expense_charges_select_own"
  on public.expense_charges for select
  to authenticated
  using (auth.uid() = user_id);

create policy "expense_charges_insert_own"
  on public.expense_charges for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "expense_charges_update_own"
  on public.expense_charges for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "expense_charges_delete_own"
  on public.expense_charges for delete
  to authenticated
  using (auth.uid() = user_id);
