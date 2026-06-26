-- ISOM Electric / Multi-Company Timesheet Platform
-- Fresh schema, multi-company native from the start.
-- Run this once in a new Supabase project's SQL editor.

create extension if not exists pgcrypto;

-- ============================================================
-- COMPANIES
-- The tenant boundary. Each company has its own employees (via roles),
-- job locations, time entries, and PTO requests/approvals.
-- ============================================================
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- EMPLOYEES
-- Person-level identity only: phone/PIN/name/email. Role and foreman
-- assignment live in employee_company_roles, since the same person can
-- work at more than one company with a different role at each.
-- super_admin is a person-level flag that spans every company.
-- PTO balance also lives here (combined across all companies, by design).
-- ============================================================
create table employees (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  phone text not null unique,        -- normalized E.164, e.g. +18645551234
  email text,
  pin_hash text not null,            -- bcrypt hash of 4-6 digit PIN
  super_admin boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_employees_phone on employees(phone);

-- ============================================================
-- EMPLOYEE_COMPANY_ROLES
-- One row per employee per company they belong to. foreman_id points to
-- another employee who must ALSO have a row at this same company
-- (enforced at the application layer, not a DB constraint, since
-- conditional cross-row FKs aren't straightforward in Postgres).
-- ============================================================
create table employee_company_roles (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  company_id uuid not null references companies(id),
  role text not null default 'employee' check (role in ('employee', 'foreman', 'admin')),
  foreman_id uuid references employees(id),
  hourly_rate numeric(10,2),         -- optional, used for OT cost reporting only
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(employee_id, company_id)
);

create index idx_ecr_employee on employee_company_roles(employee_id);
create index idx_ecr_company on employee_company_roles(company_id);
create index idx_ecr_foreman on employee_company_roles(foreman_id);

-- ============================================================
-- JOB LOCATIONS (scoped to company)
-- ============================================================
create table job_locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  normalized_name text not null,     -- lowercased, punctuation stripped, for fuzzy match
  address text,
  active boolean not null default true,
  created_by uuid references employees(id),
  created_at timestamptz not null default now()
);

create index idx_job_locations_company on job_locations(company_id);
create index idx_job_locations_normalized on job_locations(normalized_name);

-- ============================================================
-- HOLIDAYS (global/shared across all companies - US holidays don't vary
-- by employer. Revisit if a company ever needs a different calendar.)
-- ============================================================
create table holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text not null,
  is_standard boolean not null default true,
  active boolean not null default true
);

insert into holidays (holiday_date, name) values
  ('2026-01-01', 'New Year''s Day'),
  ('2026-05-25', 'Memorial Day'),
  ('2026-06-19', 'Juneteenth'),
  ('2026-07-03', 'Independence Day (observed)'),
  ('2026-09-07', 'Labor Day'),
  ('2026-11-26', 'Thanksgiving Day'),
  ('2026-11-27', 'Day after Thanksgiving'),
  ('2026-12-25', 'Christmas Day');

-- ============================================================
-- TIME ENTRIES (scoped to company)
-- Multiple rows per employee per company per day are allowed - each row
-- is one work SEGMENT (a single time-in/time-out block, possibly at a
-- different job site). A day with two segments (e.g. 7-11 at Site A,
-- 12-4 at Site B) is two rows sharing the same entry_date. Overlap
-- between segments on the same day is checked at the application layer
-- (netlify/functions/time-entries.js), not by a database constraint,
-- since "overlap" is a comparison between rows rather than something a
-- simple column check can express.
--
-- Approval still happens at the WHOLE-DAY level: the approvals endpoint
-- is given every segment id for a day (or week) and approves/rejects them
-- together as one batch, so a day's segments always move through the
-- workflow as a unit even though they're separate rows.
-- ============================================================
create table time_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  company_id uuid not null references companies(id),
  entry_date date not null,
  job_location_id uuid references job_locations(id),
  foreman_id uuid references employees(id), -- the foreman selected on THIS segment, which can differ from the employee's default assigned foreman. Approval routing for a whole week is computed from these (whichever foreman has the most hours that week), not just this single field.
  activity_description text,
  time_in time,
  lunch_minutes integer not null default 0,
  time_out time,
  hours_worked numeric(5,2) not null default 0,
  hours_type text not null default 'regular' check (hours_type in ('regular','overtime','holiday','pto')),
  is_weekend boolean not null default false,
  is_holiday boolean not null default false,
  status text not null default 'draft' check (status in ('draft','foreman_approved','admin_approved','rejected')),
  foreman_approved_by uuid references employees(id),
  foreman_approved_at timestamptz,
  admin_approved_by uuid references employees(id),
  admin_approved_at timestamptz,
  rejection_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_time_entries_employee_date on time_entries(employee_id, entry_date);
create index idx_time_entries_employee_company_date on time_entries(employee_id, company_id, entry_date);
create index idx_time_entries_company on time_entries(company_id);
create index idx_time_entries_status on time_entries(status);
create index idx_time_entries_foreman on time_entries(foreman_id);

-- ============================================================
-- PTO BALANCES
-- Person-level, NOT scoped to company - combined across every company
-- the employee works at, per explicit decision. One row per employee
-- per calendar year.
-- ============================================================
create table pto_balances (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  year integer not null,
  allotment_hours numeric(6,2) not null default 0,
  used_hours numeric(6,2) not null default 0,
  updated_at timestamptz not null default now(),
  unique(employee_id, year)
);

create index idx_pto_balances_employee_year on pto_balances(employee_id, year);

-- ============================================================
-- PTO REQUESTS (scoped to company - approval flows through that
-- company's foreman). Single-stage approval: foreman approves or denies,
-- no separate admin step. Approval immediately deducts pto_balances and
-- writes matching rows into time_entries with hours_type='pto'.
-- ============================================================
create table pto_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  company_id uuid not null references companies(id),
  assigned_foreman_id uuid references employees(id), -- determined at submission time (the foreman on the employee's most recent logged segment, or their default assigned foreman if they have no segments yet), and locked in - does not get recalculated later even if the employee logs new segments under a different foreman while this request is pending
  start_date date not null,
  end_date date not null,
  hours_per_day numeric(5,2) not null default 8,
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','denied','cancelled')),
  decided_by uuid references employees(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create index idx_pto_requests_employee on pto_requests(employee_id);
create index idx_pto_requests_company on pto_requests(company_id);
create index idx_pto_requests_status on pto_requests(status);
create index idx_pto_requests_assigned_foreman on pto_requests(assigned_foreman_id);

-- ============================================================
-- REMINDER LOG (scoped to company - someone could need a separate
-- reminder per company they work at)
-- ============================================================
create table reminder_log (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  company_id uuid not null references companies(id),
  reminder_date date not null,
  sent_at timestamptz not null default now(),
  sms_status text,
  unique(employee_id, company_id, reminder_date)
);

-- ============================================================
-- JOB SITE PHOTOS
-- A dedicated photo log, separate from time_entries, browsable by job
-- location across all employees (per explicit decision: any employee
-- can browse the whole feed, not just admins/foremen). The actual image
-- files live in Supabase Storage, in a bucket named 'job-site-photos';
-- this table stores the metadata and the storage path, not the image
-- bytes themselves.
-- ============================================================
create table job_site_photos (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  company_id uuid not null references companies(id),
  job_location_id uuid references job_locations(id),
  storage_path text not null,        -- path within the Supabase Storage bucket
  description text,
  taken_at timestamptz not null default now(),  -- when the photo was logged (date + time)
  created_at timestamptz not null default now()
);

create index idx_job_site_photos_company on job_site_photos(company_id);
create index idx_job_site_photos_location on job_site_photos(job_location_id);
create index idx_job_site_photos_employee on job_site_photos(employee_id);
create index idx_job_site_photos_taken_at on job_site_photos(taken_at);

-- ============================================================
-- SCHEDULE ENTRIES
-- Day-level scheduling: which job site(s) a person is assigned to work
-- on a given day, set by a foreman or admin (never the employee
-- themselves - this is assignment, not self-selection). Multiple rows
-- per person per day are allowed, same as time_entries, since a single
-- day's assignment can span more than one job site. There is
-- deliberately no time-of-day on this table - per explicit decision,
-- day-level granularity (which site, not what time) is what's needed.
-- This is entirely separate from time_entries (the actual logged hours)
-- - a schedule entry is a plan, not a record of work performed.
-- ============================================================
create table schedule_entries (
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

create index idx_schedule_entries_employee_date on schedule_entries(employee_id, scheduled_date);
create index idx_schedule_entries_company_date on schedule_entries(company_id, scheduled_date);
create index idx_schedule_entries_location on schedule_entries(job_location_id);

-- ============================================================
-- SCHEDULE CHANGE LOG
-- One row per change event (create, update, or delete of a schedule
-- entry), used both to drive the employee-facing "your schedule
-- changed" alert and as the auditable proof-of-notification record. The
-- employee must explicitly acknowledge a change (acknowledged_at gets
-- set only when they actively confirm, never automatically) - this is
-- the actual evidence that they were told about it, not just that it
-- was technically visible somewhere in the app.
-- change_type: 'created', 'updated', 'deleted'
-- A same-day change (scheduled_date is the actual current date at the
-- time of the change) also triggers an SMS, tracked via sms_status,
-- the same stubbed-until-credentials-exist pattern as the existing
-- reminder_log/Twilio integration.
-- ============================================================
create table schedule_change_log (
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
  sms_status text, -- null until an SMS attempt is made; then 'sent', 'failed', or 'skipped_no_credentials'
  acknowledged_at timestamptz, -- set only when the employee actively confirms - this is the proof
  created_at timestamptz not null default now()
);

create index idx_schedule_change_log_employee on schedule_change_log(employee_id);
create index idx_schedule_change_log_company on schedule_change_log(company_id);
create index idx_schedule_change_log_unacknowledged on schedule_change_log(employee_id, acknowledged_at);

-- ============================================================
-- SEED: the two known companies
-- ============================================================
insert into companies (name) values
  ('Isom Electric'),
  ('South Pointe');
