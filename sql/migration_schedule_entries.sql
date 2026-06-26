-- Migration: day-level scheduling (which job site a person is assigned
-- to work each day, set by a foreman/admin, viewed by the employee).
-- Run this against your EXISTING Supabase database.

create table if not exists schedule_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  company_id uuid not null references companies(id),
  scheduled_date date not null,
  job_location_id uuid references job_locations(id),
  note text,
  created_by uuid not null references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_schedule_entries_employee_date on schedule_entries(employee_id, scheduled_date);
create index if not exists idx_schedule_entries_company_date on schedule_entries(company_id, scheduled_date);
create index if not exists idx_schedule_entries_location on schedule_entries(job_location_id);

create table if not exists schedule_change_log (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  company_id uuid not null references companies(id),
  scheduled_date date not null,
  change_type text not null check (change_type in ('created','updated','deleted')),
  old_job_location_id uuid references job_locations(id),
  new_job_location_id uuid references job_locations(id),
  old_note text,
  new_note text,
  changed_by uuid not null references employees(id),
  is_same_day_change boolean not null default false,
  sms_status text,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_schedule_change_log_employee on schedule_change_log(employee_id);
create index if not exists idx_schedule_change_log_company on schedule_change_log(company_id);
create index if not exists idx_schedule_change_log_unacknowledged on schedule_change_log(employee_id, acknowledged_at);
