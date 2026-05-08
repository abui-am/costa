-- Add `expenses` parent table (1:N → costs), payment_method enum,
-- migrate existing costs into expense rows, slim down costs columns.

-- ── 1. payment_method enum ──────────────────────────────────────────────────
create type public.payment_method as enum (
  'UNSPECIFIED',
  'CASH',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'BANK_TRANSFER',
  'E_WALLET',
  'QR_PAY',
  'OTHER'
);

comment on type public.payment_method is
  'How a purchase was paid. UNSPECIFIED = unknown/not set.';

-- ── 2. expenses table ────────────────────────────────────────────────────────
create table public.expenses (
  id             uuid          primary key default gen_random_uuid(),
  user_id        uuid          not null references auth.users (id) on delete cascade,
  name           text          not null default '',
  date           date          not null,
  notes          text,
  location       text          not null default '',
  payment_method public.payment_method not null default 'UNSPECIFIED',
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now()
);

comment on table  public.expenses             is 'One logical spend event (receipt, bill batch, or manual grouping). Children live in costs.';
comment on column public.expenses.date        is 'Transaction/spend calendar day (YYYY-MM-DD). Drives month filters via date_trunc(''month'', date). Month-only input → first of month.';
comment on column public.expenses.name        is 'Whole-expense title: merchant name or user label. Distinct from costs.name (line item).';
comment on column public.expenses.payment_method is 'Payment method enum; UNSPECIFIED when unknown.';

create index expenses_user_id_date_idx on public.expenses (user_id, date desc);

-- ── 3. expenses RLS ──────────────────────────────────────────────────────────
alter table public.expenses enable row level security;

create policy "expenses_select_own"
  on public.expenses for select
  to authenticated
  using (auth.uid() = user_id);

create policy "expenses_insert_own"
  on public.expenses for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "expenses_update_own"
  on public.expenses for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "expenses_delete_own"
  on public.expenses for delete
  to authenticated
  using (auth.uid() = user_id);

-- ── 4. Add expense_id to costs (nullable during backfill) ────────────────────
alter table public.costs
  add column if not exists expense_id uuid null;

-- ── 5. Backfill: one expenses row per existing costs row (1:1 for legacy) ───
-- Map legacy free-text payment_method to enum. Empty/null → UNSPECIFIED.
-- Known synonyms (case-insensitive, trimmed).
do $$
declare
  r record;
  new_expense_id uuid;
  pm public.payment_method;
  pm_raw text;
  expense_date date;
begin
  for r in
    select
      id,
      user_id,
      name,
      coalesce(spent_on, billing_month) as computed_date,
      notes,
      location,
      payment_method,
      billing_month
    from public.costs
    where expense_id is null
  loop
    -- Resolve date: prefer spent_on, fall back to billing_month (first of month)
    expense_date := coalesce(r.computed_date, current_date);

    -- Normalize payment_method text → enum
    pm_raw := lower(trim(coalesce(r.payment_method, '')));
    pm := case
      when pm_raw = ''                                           then 'UNSPECIFIED'::public.payment_method
      when pm_raw in ('cash', 'tunai', 'uang tunai')            then 'CASH'::public.payment_method
      when pm_raw in ('credit card', 'credit', 'kartu kredit',
                      'cc', 'visa', 'mastercard', 'amex')       then 'CREDIT_CARD'::public.payment_method
      when pm_raw in ('debit card', 'debit', 'kartu debit',
                      'atm', 'eftpos')                          then 'DEBIT_CARD'::public.payment_method
      when pm_raw in ('bank transfer', 'transfer', 'wire',
                      'ach', 'tf', 'transfer bank')             then 'BANK_TRANSFER'::public.payment_method
      when pm_raw in ('e-money', 'e money', 'emoney', 'e-wallet',
                      'ewallet', 'gopay', 'ovo', 'dana',
                      'shopeepay', 'linkaja', 'paypal',
                      'digital wallet')                         then 'E_WALLET'::public.payment_method
      when pm_raw in ('qris', 'qr', 'qr pay', 'qr-pay',
                      'scan', 'qr code')                        then 'QR_PAY'::public.payment_method
      else 'OTHER'::public.payment_method
    end;

    insert into public.expenses (
      user_id, name, date, notes, location, payment_method
    ) values (
      r.user_id,
      trim(coalesce(r.name, '')),
      expense_date,
      nullif(trim(coalesce(r.notes, '')), ''),
      trim(coalesce(r.location, '')),
      pm
    )
    returning id into new_expense_id;

    update public.costs
      set expense_id = new_expense_id
    where id = r.id;
  end loop;
end
$$;

-- ── 6. Set expense_id NOT NULL and add FK ────────────────────────────────────
alter table public.costs
  alter column expense_id set not null;

alter table public.costs
  add constraint costs_expense_id_fkey
  foreign key (expense_id)
  references public.expenses (id)
  on delete cascade;

create index costs_expense_id_idx on public.costs (expense_id);

-- ── 7. Drop columns from costs that moved to expenses ───────────────────────
-- Drop billing_month check constraint first (by name from original migration).
do $$
begin
  -- Remove check constraint on billing_month if it exists
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'costs'
      and constraint_type = 'CHECK'
      and constraint_name like '%billing_month%'
  ) then
    execute (
      select 'alter table public.costs drop constraint ' || quote_ident(constraint_name)
      from information_schema.table_constraints
      where table_schema = 'public'
        and table_name   = 'costs'
        and constraint_type = 'CHECK'
        and constraint_name like '%billing_month%'
      limit 1
    );
  end if;
end
$$;

alter table public.costs
  drop column if exists billing_month,
  drop column if exists category,
  drop column if exists notes,
  drop column if exists location,
  drop column if exists payment_method,
  drop column if exists spent_on;

comment on table public.costs is 'Line items for a spend event. Parent context (date, notes, location, payment_method) lives on expenses.';
