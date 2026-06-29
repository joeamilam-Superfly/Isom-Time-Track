# Multi-Company Timesheet Platform

A mobile-first weekly timesheet app supporting multiple companies (Isom
Electric, South Pointe, and any others added later) in one shared system.
Employees log hours by phone + PIN, foremen approve their crew's hours,
admins manage their company and export payroll-ready totals, and a super
admin role can see across every company. PTO is tracked per person
(combined across every company someone works at) with single-stage
foreman approval. Daily SMS reminders go out at 4pm ET to anyone who
hasn't logged hours that day, per company they belong to.

## Stack

- **Frontend**: static HTML/CSS/vanilla JS (no build step, no framework) in `public/`
- **Backend**: Netlify Functions in `netlify/functions/`
- **Database**: Supabase (Postgres)
- **SMS**: Twilio (stubbed until credentials are added - logs instead of sending)

## Multi-company design

- **companies**: the tenant boundary. Seeded with "Isom Electric" and
  "South Pointe"; add more by inserting a row.
- **employees**: person-level identity only (phone, PIN, name, email).
  A person logs in once regardless of how many companies they belong to.
- **employee_company_roles**: the actual role assignment. One row per
  employee per company, each with its own role (`employee`/`foreman`/
  `admin`) and its own `foreman_id` (who approves them, at that company).
  The same person can be an employee at one company and an admin at
  another - each is a separate row here.
- **super_admin**: a flag directly on `employees`. A super admin can act
  as admin at every company, even ones they don't have an explicit row
  for. Use this for people who oversee the whole platform (i.e., you).
- **Company switcher**: anyone with more than one company shows a
  dropdown in the top bar to switch which company context they're acting
  in. Switching never requires logging in again - the session token only
  proves who you are, and the active company is just local UI state that
  gets sent with every request, re-validated server-side every time.
- **job_locations**, **time_entries**, **pto_requests**, and
  **reminder_log** are all scoped to a specific company. **pto_balances**
  is the one exception - PTO balance is tracked per person, combined
  across every company they work at, by design.
- **holidays** is shared/global across all companies (US holidays don't
  vary by employer). Revisit this if a company ever needs a different
  calendar.

## One-time setup

### 1. Supabase

1. Create a new Supabase project.
2. In the SQL editor, run `sql/schema.sql`. This creates every table,
   seeds the 2026 US holiday calendar, and seeds the two companies
   (Isom Electric, South Pointe).
3. Copy the Project URL and the `service_role` key from Settings > API.
   Use the service role key, not the anon key - the functions need full
   access since RLS is off and they enforce permissions themselves.

**If you already have a live database from an earlier version of this
app**, `schema.sql` will fail (tables already exist) - that's expected.
Instead, run only the specific migration file(s) under `sql/migration_*`
that correspond to features added since your database was last set up.
Each migration file is self-contained and uses `if not exists` guards, so
it's safe to run even if some of it was already applied.

### 2. Environment variables

Copy `.env.example` to `.env` and fill in:

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` - from step 1
- `AUTH_TOKEN_SECRET` - any long random string (signs login sessions).
  Generate one with:
  ```
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` - leave
  blank for now. The reminder function logs what it would send instead
  of failing when these are missing.
- `ANTHROPIC_API_KEY` - for the AI help assistant (the chat bubble button
  in the header). Get one at https://console.anthropic.com under Settings
  > API Keys. Leave blank to launch without it - the help button will
  still appear but will explain it isn't configured yet rather than
  erroring.

Set these in Netlify under Project configuration > Environment variables
before the first deploy, or the functions will fail at runtime.

### 3. Create your first users

There's no public signup screen on purpose. Use the helper script
locally:

```bash
npm install
```

Set your Supabase credentials once in your terminal session (these stay
set only for as long as this terminal window stays open - if you close
it and reopen a new one, you'll need to set them again before running
any more `create-employee.js` commands):

**Mac/Linux/zsh terminal:**
```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_KEY=your_service_role_key
```

**Windows Command Prompt:**
```cmd
set SUPABASE_URL=https://your-project.supabase.co
set SUPABASE_SERVICE_KEY=your_service_role_key
```

**Windows PowerShell:**
```powershell
$env:SUPABASE_URL="https://your-project.supabase.co"
$env:SUPABASE_SERVICE_KEY="your_service_role_key"
```

Then create yourself as a super admin first, so you can manage every
company (same command on every platform, once the variables above are
set):

```
node scripts/create-employee.js --first Joe --last Amilam --phone 8645551234 --pin 4821 --superadmin true
```

Then assign company-specific admins, foremen, and employees (still in
the same terminal window, so the env vars are still set):

```
node scripts/create-employee.js --first Mitzi --last Isom --phone 8645555555 --pin 1111 --company "Isom Electric" --role admin

node scripts/create-employee.js --first Craig --last Isom --phone 8645556666 --pin 2222 --company "Isom Electric" --role foreman

node scripts/create-employee.js --first John --last Doe --phone 8645557777 --pin 3333 --company "Isom Electric" --role employee --foreman 8645556666
```

To add an existing person to a SECOND company (e.g. someone who works at
both Isom Electric and South Pointe), run the script again with the same
phone number and a different `--company`:

```
node scripts/create-employee.js --phone 8645556666 --company "South Pointe" --role employee
```

PINs should be 4-6 digits.

### 4. Set up photo storage

The job site photo log needs a Supabase Storage bucket:

1. In Supabase: **Storage** in the left sidebar > **New bucket**
2. Name it exactly `job-site-photos`
3. Leave it **private** (do not make it public) - the app generates
   short-lived signed URLs to display photos, so a public bucket isn't
   needed and would let anyone with a guessed URL see job site photos.
4. No RLS policies need to be configured on this bucket - every upload,
   read, and delete happens through `netlify/functions/job-photos.js`
   using the service role key, which already bypasses RLS the same way
   it does for every other table in this app.

### 5. Deploy to Netlify

**Before pushing to GitHub:** if you extracted this project from a zip
file, double-check that `package.json`, `netlify.toml`, `site/`, and
`netlify/` are sitting directly in your repo folder, not nested one level
deeper inside another folder with the same or similar name. Unzipping
sometimes creates an extra wrapper folder (e.g.
`multi-company-timesheet/multi-company-timesheet/...`) - if you copy the
*outer* folder's contents into your repo instead of the *inner* one, the
deploy will fail to find anything. Open the folder in File Explorer or
Finder and confirm you see those files immediately, not inside another
subfolder, before copying anything into your GitHub repo folder.

1. Push this project to a GitHub repo (GitHub Desktop works well for
   this - create a new repo, copy this project's contents into the repo
   folder it creates, commit, publish).
2. In Netlify: New site from Git (or "Import an existing project"),
   point at the repo.
3. Build settings are already in `netlify.toml` (no build command needed,
   publishes `site/`, functions live in `netlify/functions/`). If
   Netlify's UI shows a "Publish directory" field during setup, confirm
   it says `site` (not blank, not `public`) before deploying.
4. Add the environment variables from step 2 in the Netlify UI **before**
   the first deploy - if you add them after, you'll need to trigger a
   fresh deploy afterward for them to take effect (Deploys tab -> Trigger
   deploy -> Deploy site).
5. Deploy.

The scheduled reminder function runs hourly (cron is UTC-based) and only
actually sends reminders during the 4pm America/New_York hour, computed
fresh each run, so it stays correct across the EST/EDT change
automatically.

## Day-to-day use

- **Employees** log in with phone + PIN. If they belong to more than one
  company, a switcher appears in the top bar; otherwise it's hidden and
  they just see their one company. They see their current week as a row
  of punch-card stubs; tapping a day shows every time segment logged that
  day (a day can have more than one - e.g. 7-11 at one job site, 12-4 at
  another) with options to add, edit, or remove a segment. Tapping
  "+ Log today's hours" on a day with nothing logged yet opens the
  add-segment form immediately, skipping the empty list screen. Inside
  the form, "Save and add another segment" saves the current one and
  goes straight into a fresh form for the next, without a round trip back
  to the day view - meant for the common case of logging several
  segments from one sitting, since job sites and times vary too much day
  to day for any kind of "same as before" shortcut to help. When adding a
  new segment to a day that already has one, the form shows a read-only
  "Last entry today" reference (location and time range) right at the
  top, so the employee can see where they left off before typing the new
  one - this is purely informational, nothing gets pre-filled from it,
  since gaps between segments vary too much to guess at safely.
- **Overlap protection**: a new or edited segment is checked against every
  other segment within a day of it (the day itself, the day before, and
  the day after, to correctly catch overnight shifts that cross midnight)
  and is rejected with a clear error if its time range overlaps an
  existing one - e.g. logging 1:00-2:00 then trying to also log 1:45-3:00
  the same day will be blocked, naming the conflicting entry. Back-to-back
  segments (one ending exactly when another starts) are allowed.
- **Time off**: every employee has a Time Off tab to request PTO and see
  their balance (combined across every company they work at). Approval
  is single-stage: the employee's foreman at that company approves or
  denies, and approval immediately deducts the balance and writes the
  approved days onto the employee's timesheet as PTO.
- **Job locations**: as an employee types a job location name, matching
  existing locations at that company appear live underneath the field -
  including ones that don't match exactly, since the matching catches
  typos and punctuation differences (e.g. typing "Anderson Dubose" while
  "Anderson-DuBose Warehouse" already exists will surface it). Employees
  can only SELECT an existing location this way - they cannot create a
  new one. If an employee types a name with no close match and tries to
  save, the backend rejects it with a message telling them to ask their
  foreman or admin to add it first. Only a foreman or admin can create a
  new job location (from the Admin tab's "Job locations" section, or via
  the same duplicate-checking flow if they're the one entering a
  segment), and the same near-duplicate confirmation ("is this the same
  job site?") still applies to them, to keep the list clean regardless of
  who's adding to it.
- **Per-segment foreman selection**: every employee has a default
  assigned foreman at each company (set when they're added), but since
  someone may work for a different foreman on a given job, each
  individual segment has its own foreman dropdown (pre-filled with their
  default, changeable per segment). Approval for a whole week is NOT
  based on the default assignment - it's computed fresh each week from
  actual hours worked: whichever foreman has the majority of an
  employee's hours that week becomes the approver for the WHOLE week,
  even segments that named a different foreman. This means the same
  employee can have a different approving foreman from one week to the
  next, depending on who they actually worked for. Ties are broken in
  favor of the employee's default assigned foreman if they're one of the
  tied foremen.
- **Foremen** see an Approvals tab and a Team tab scoped to whichever
  company they're currently switched into. Visibility now includes both
  their permanently-assigned crew AND anyone who logged a segment naming
  them as foreman that week, even if that person isn't normally assigned
  to them - but the "approve" button only appears for the actual
  determined approver for that employee's week (computed as described
  above), not just anyone who can see the entry. Approval happens at the
  whole-day level even though a day may have multiple segments -
  approving or rejecting a week approves/rejects every segment in it
  together.
- **Leave requests** (vacation and sick time share one balance, labeled
  "Leave" everywhere in the app) are routed differently from regular
  hours, since they're submitted before any work happens for those
  dates: the approving foreman is whoever was on the employee's single
  most recently logged segment at the time of submission (or their
  default assigned foreman if they have no segments logged yet). This is
  locked in at submission time and does NOT get recalculated later, even
  if the employee logs new segments under a different foreman while the
  request is still pending - the approver for a pending request never
  shifts mid-flight.
- **Admins** see everyone at their company in the Team tab with full
  drill-down, can override entries, give final approval, set leave
  allotments and directly edit used leave hours (for backfilling history or
  correcting a mistake outside the normal request flow), and export the
  week to CSV (one row per segment, so a multi-segment day produces
  multiple CSV rows). Admins can also add employees directly from the
  Team tab ("+ Add employee") - if the phone number already belongs to
  someone, this just gives them a role at this company; otherwise it
  creates a brand new person. Employees can be deactivated (and later
  reactivated) from their drill-down page rather than deleted outright,
  since deleting would orphan their historical hours and PTO records.
  The system blocks deactivating the last active admin at a company, so
  a company can never be left with no one able to manage it. An "Edit
  profile" button on the same drill-down page lets admin correct an
  existing employee's name, phone number, email, role at this company,
  or default assigned foreman - none of this could be changed after
  initial creation before. Changing the phone number changes their login
  number too. Demoting the only active admin at a company to a
  different role is blocked the same way deactivating the last admin is.
  Job locations work the same way - the Admin tab has a "Job locations"
  section to add new ones or deactivate/reactivate existing ones, and
  deactivating a location never deletes it, since past timesheet entries
  still reference it by name.
- **Cleaning up duplicate job locations**: the duplicate-prevention at
  entry time only stops NEW duplicates from being created - it doesn't
  retroactively fix ones that already exist (from before that logic was
  added, or from any edge case that slipped past it). "Find possible
  duplicates" on the Admin tab scans every job location at the company
  and groups ones that look like the same site under different spellings
  (e.g. three different "Transit" variants). Admin picks which one in
  each group to keep, can uncheck anything that doesn't actually belong
  in that group (the matching is similarity-based and occasionally groups
  things too aggressively), and merging moves every historical hour entry
  and photo over to the kept location, then deactivates the rest. This is
  safe to run anytime new duplicates turn up - it's a scan, not a one-time
  fix, and re-running it after merging never breaks anything already
  merged.
- **Super admins** (the `super_admin` flag) can switch into any company
  and act as admin there, even without an explicit role row.
- **AI help assistant**: a chat bubble button in the header (next to log
  out) opens a help panel, available to everyone on every screen. It only
  answers questions about how the app works and about the logged-in
  person's own data - their hours this week, their PTO balance, their
  approval status, recent PTO requests. It cannot see or discuss anyone
  else's information, and it declines anything outside the app (general
  company policy, HR questions, etc.) and suggests asking a foreman or
  admin directly. Requires an `ANTHROPIC_API_KEY` environment variable;
  without it, the button still works but explains the assistant isn't
  configured yet rather than failing silently.
- **One person at multiple companies**: since role lives in
  `employee_company_roles`, not on the employee record itself, the same
  phone number can be added to as many companies as needed - "Add
  employee" with that phone number at a second company's Team tab just
  adds a new role there without creating a duplicate person or touching
  their existing role anywhere else. Each company can independently have
  as many admins as it needs - there's no cap.
- **Super admin grants**: anyone who's already a super admin can grant
  the same status to someone else from the new "Platform" tab (visible
  only to super admins, independent of which company is currently
  active). Granting it to someone else does not remove your own status -
  this is additive, not a transfer. You cannot revoke your own super
  admin status through this screen (another super admin would need to do
  that, or it can be changed directly in the database).
- **Job site photo log**: a "Photos" tab, visible to every employee
  regardless of role, where anyone can attach a photo and a description
  of completed work, automatically tagged with the server's date/time
  (not anything the client could spoof) and an optional job location.
  Photos are browsable as a feed across the whole company and filterable
  by job location. Photos are compressed and resized client-side before
  upload (capped at 1600px on the longest side) to keep uploads fast on
  job-site connections and stay safely under Netlify's request size
  limit. The uploader can delete their own photos; admins can delete any
  photo at their company. Requires the `job-site-photos` Supabase Storage
  bucket (see setup step 4 below).

- **Scheduling**: foremen and admins have a "Schedule" sub-tab inside
  Approvals (same week navigation, toggle between the two views) showing
  a grid of every active employee against the workdays (Mon-Fri) of the
  selected week. Clicking any cell shows that person's existing
  assignment(s) for that day and lets you add another or remove one - a
  single day can have more than one assignment, same as time segments,
  since a person can be scheduled across more than one job site in a
  day. Any foreman or admin can assign anyone at the company; there's no
  per-foreman restriction here. Employees see their own schedule
  read-only via "View my schedule" on the My Hours tab, showing roughly
  4 weeks ahead. The grid intentionally only ever shows ONE week at a
  time, even though scheduling reaches a month out - showing a full
  month's worth of day columns at once doesn't work well with a roster
  of 20+ people on a phone-width screen, so instead the Schedule sub-view
  shows a "Jump to week" dropdown (this week plus the next 5) to get
  several weeks ahead quickly without repeatedly tapping the single-week
  arrow.
- **Schedule change notifications**: every create, edit, or removal of a
  schedule entry is logged. If the change affects TODAY's date, the
  employee also gets a text message describing the change (stubbed and
  logging until Twilio credentials are added, same pattern as the daily
  reminder feature). Regardless of timing, the next time the employee
  opens the app they're shown a blocking prompt listing what changed,
  which they must explicitly tap to dismiss - that tap is timestamped
  and stored as the actual proof-of-notification record (`acknowledged_at`
  in `schedule_change_log`), not just evidence that the change was
  technically displayed somewhere.

## Overtime rules (as implemented)

- Any hours worked on a Saturday or Sunday are overtime, regardless of
  how many hours were worked that week.
- Any hours on a recognized holiday are tracked as holiday hours (their
  own bucket, not overtime).
- For Monday-Friday non-holiday hours, the first 40 hours in the week are
  regular and anything beyond that is overtime. A single day's hours
  that straddle the 40-hour line are split proportionally.
- PTO hours don't count toward the 40-hour threshold.
- There is no dedicated "lunch" field anymore - employees log a break the
  same way they log any work segment, by picking or adding a job location
  (e.g. one named "Lunch" or "Break"). Any segment whose job location name
  contains "lunch" or "break" (case-insensitive) is treated as a break:
  the first 30 minutes of that SPECIFIC segment is paid, and anything
  beyond 30 minutes in that same segment is unpaid - not counted as
  regular, overtime, or anything else. Each break segment gets its own
  independent 30-minute allowance, so two separate 20-minute breaks in
  one day are both fully paid, since neither individually exceeds 30
  minutes. If an employee skips lunch entirely, they simply don't log a
  break segment that day - nothing forces one.
  Known tradeoff: this is name-based, not an explicit flag, so a real job
  site whose name happens to contain "lunch" or "break" (e.g. "Breakwater
  Marina") would also get this treatment. Worth keeping in mind when
  naming job locations.

These rules currently apply uniformly across every company. If different
companies ever need different OT rules, that would be a follow-up change
to `_hours-logic.js` and the functions that call it.

## Project structure

```
netlify/functions/
  _auth-context.js       shared bearer-token auth check
  _company-role.js        resolves an employee's role at a given company,
                           fresh from the DB on every request (the JWT
                           never carries a role, since role is per-company
                           and switching companies shouldn't need a new login)
  _hours-logic.js          OT/regular/holiday/PTO calculation (unit tested)
  _location-match.js       fuzzy job-location duplicate detection
  _jwt.js                  minimal signed session tokens
  auth-login.js            POST /api/auth-login (returns the company list)
  time-entries.js          GET/POST /api/time-entries
  job-locations.js         GET/POST/PUT /api/job-locations (PUT activates
                           or deactivates a location)
  job-locations-dedup.js   GET/PUT /api/job-locations-dedup (scan for and
                           merge likely-duplicate job locations)
  foremen-list.js          GET /api/foremen-list (every foreman/admin at a
                           company, for the per-segment foreman dropdown -
                           open to any active role, not just admins)
  schedule.js              GET/POST/PUT/DELETE /api/schedule (the day-level
                           scheduling tool; logs every change for the
                           change-notification and acknowledgment system)
  schedule-acknowledge.js  PUT /api/schedule-acknowledge (an employee
                           confirming they saw a schedule change - this is
                           the actual proof-of-notification record)
  _sms.js                  shared Twilio sender, used by both
                           scheduled-reminders.js and schedule.js's
                           same-day change notifications
  approvals.js             POST /api/approvals
  weekly-summary.js        GET /api/weekly-summary
  pto-requests.js          GET/POST/PUT /api/pto-requests
  pto-balances.js          GET/PUT /api/pto-balances
  employee-management.js   POST/PUT /api/employee-management (add, deactivate,
                           reactivate employees and their company roles)
  super-admin-management.js GET/PUT /api/super-admin-management (grant/revoke
                           super admin status; only callable by an existing
                           super admin)
  job-photos.js            GET/POST/DELETE /api/job-photos (the photo log;
                           uploads go to Supabase Storage, metadata here)
  dashboard.js             GET /api/dashboard (directory list + drill-down)
  assistant.js             POST /api/assistant (AI help chat, scoped to the
                           caller's own data, never sees other employees)
  scheduled-reminders.js   runs hourly, sends 4pm ET SMS nudges per company

site/
  index.html
  css/styles.css
  js/app.js                state, company switcher, routing, API helper
  js/login.js
  js/assistant.js          AI help chat panel, opened from the header button
  js/week.js
  js/location-match.js     frontend copy of the fuzzy-matching logic, used
                           for live-typing suggestions (keep in sync with
                           netlify/functions/_location-match.js)
  js/dayedit.js
  js/approvals.js
  js/admin.js              also contains the weekly scheduling grid
                           (foreman/admin), folded into the Approvals tab
  js/timeoff.js            Leave request + balance screen
  js/team.js                directory + drill-down dashboard
  js/platform.js           super admin grant/revoke screen
  js/photolog.js           job site photo feed, including client-side
                           image compression before upload
  js/schedule.js           employee's own "view my schedule" and the
                           change-acknowledgment prompt (the foreman/admin
                           scheduling grid itself lives in approvals.js)

sql/schema.sql             fresh-install schema
sql/migration_*.sql        incremental migrations for existing databases -
                           see the note under Supabase setup, step 1
scripts/create-employee.js
netlify.toml
.env.example
```

## Known limitations / things worth knowing

- A PTO request that spans Dec 31 -> Jan 1 is checked and deducted
  entirely against the *start date's* calendar year. Only matters for
  requests that literally straddle New Year's Day.
- No password reset / forgot-PIN flow yet - admin resets by updating the
  `pin_hash` column directly.
- Export is CSV, not a styled .xlsx.
- There's no week-locking step that warns a foreman if days are simply
  missing entirely before approving a week (it only requires every
  *present* day to be in draft status).
- `foreman_id` in `employee_company_roles` isn't enforced by a database
  constraint to be someone who also has a role at that same company -
  this is checked in the application layer (`create-employee.js` and the
  approval endpoints) but isn't bulletproof against direct database edits.
