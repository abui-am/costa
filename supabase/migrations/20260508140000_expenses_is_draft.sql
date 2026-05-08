-- Add is_draft flag to expenses.
-- Existing rows default to false (already posted).
-- AI extraction (from-bill, from-text) inserts with is_draft = true.

alter table public.expenses
  add column if not exists is_draft boolean not null default false;

comment on column public.expenses.is_draft is
  'True while the expense is in review (AI-extracted and not yet confirmed by user). False = posted and included in reports.';

create index expenses_user_id_is_draft_date_idx
  on public.expenses (user_id, is_draft, date desc);
