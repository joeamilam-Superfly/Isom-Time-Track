-- Migration: per-segment foreman selection, computed weekly approval
-- routing, and locked-in Leave request approver.
-- Run this against your EXISTING Supabase database (schema.sql is only
-- for brand new installs and does not retroactively alter a live one).

alter table time_entries add column if not exists foreman_id uuid references employees(id);
create index if not exists idx_time_entries_foreman on time_entries(foreman_id);

alter table pto_requests add column if not exists assigned_foreman_id uuid references employees(id);
create index if not exists idx_pto_requests_assigned_foreman on pto_requests(assigned_foreman_id);
