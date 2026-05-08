-- Add confidence_score to expenses.
-- Populated by AI extraction pipelines (bill scan, text); null for manual rows.

alter table public.expenses
  add column confidence_score double precision null;

alter table public.expenses
  add constraint expenses_confidence_score_range
  check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));

comment on column public.expenses.confidence_score is
  'Model-estimated confidence in [0,1] for AI-extracted draft expenses. NULL for manual or unknown.';
