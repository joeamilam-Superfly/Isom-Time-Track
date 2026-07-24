const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { isHoliday, isWeekend } = require('./_hours-logic');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
});

// Finds or creates a "Lunch" job location at a company, the same
// pattern as getOrCreateOffLocation in pto-requests.js.
async function getOrCreateLunchLocation(companyId) {
  const { data: existing, error: lookupError } = await supabase
    .from('job_locations')
    .select('id')
    .eq('company_id', companyId)
    .ilike('name', 'Lunch')
    .eq('active', true)
    .limit(1)
    .single();

  // PGRST116 = no rows found, which is expected when location doesn't exist yet
  if (lookupError && lookupError.code !== 'PGRST116') {
    console.error(`Lunch location lookup failed for company ${companyId}:`, lookupError.message);
  }
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('job_locations')
    .insert({ company_id: companyId, name: 'Lunch', normalized_name: 'lunch', active: true })
    .select('id')
    .single();

  if (error) {
    console.error('Failed to create Lunch location:', error);
    return null;
  }
  return created.id;
}

// Returns true if a job location name contains 'lunch' or 'break'
// (case-insensitive) - matches the existing isBreakLocationName logic
// in _hours-logic.js, kept inline here since this function is standalone
// and doesn't have access to the shared module's Supabase client.
function isLunchOrBreakName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes('lunch') || n.includes('break');
}

// Netlify scheduled function. Runs hourly; only acts at 6pm ET each day.
// For each active employee at each company, checks whether they logged
// 8+ hours of non-lunch/break work on the PREVIOUS day (yesterday ET)
// and if so, auto-creates a 0.5-hour paid lunch segment for that day,
// unless they already have one. Employees marked OFF or with no hours
// logged are skipped.
exports.handler = async (event) => {
  const now = new Date();
  const etHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }).format(now)
  );

  const forceRun = event?.queryStringParameters?.force === 'true';
  if (etHour !== 0 && !forceRun) {
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, reason: `Current ET hour is ${etHour}, not 0 (midnight)` }),
    };
  }

  // Work against yesterday ET - at midnight the previous day's entries
  // are fully in, giving employees until end of day to log their own lunch
  // before the auto-add fires. This prevents duplicate lunches when an
  // employee logs their own lunch segment after 6pm.
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
    new Date(now.getTime() - 24 * 60 * 60 * 1000)
  );

  const { data: memberships, error: memberError } = await supabase
    .from('employee_company_roles')
    .select('employee_id, company_id, foreman_id, employees!employee_company_roles_employee_id_fkey(active)')
    .eq('active', true);

  if (memberError) {
    console.error('Failed to load memberships:', memberError);
    return { statusCode: 500, body: JSON.stringify({ error: memberError.message }) };
  }

  const activeMemberships = (memberships || []).filter(m => m.employees?.active);

  let added = 0;
  let skipped = 0;

  // Cache lunch location IDs per company to avoid repeated lookups
  const lunchLocationCache = {};

  for (const m of activeMemberships) {
    const { employee_id: employeeId, company_id: companyId, foreman_id: foremanId } = m;

    // Fetch all time entries for this employee at this company yesterday
    const { data: entries, error: entryError } = await supabase
      .from('time_entries')
      .select('id, hours_worked, hours_type, job_locations(name)')
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .eq('entry_date', yesterday);

    if (entryError) {
      console.error(`Entry fetch failed for ${employeeId}:`, entryError);
      continue;
    }

    if (!entries || entries.length === 0) {
      skipped++;
      continue; // No hours logged at all - skip
    }

    // Skip holidays - employees working on recognized holidays get double
    // time on their work segments but lunch should not be auto-added since
    // the holiday pay rules differ and the hours threshold doesn't apply.
    if (isHoliday(yesterday)) {
      skipped++;
      continue;
    }

    // Check if any entry is an OFF assignment - skip the whole day
    const isOff = entries.some(e => e.job_locations?.name?.toUpperCase() === 'OFF');
    if (isOff) {
      skipped++;
      continue;
    }

    // Check if a lunch/break segment already exists for this day
    const alreadyHasLunch = entries.some(e => isLunchOrBreakName(e.job_locations?.name));
    if (alreadyHasLunch) {
      skipped++;
      continue;
    }

    // Sum non-lunch/break work hours - this is the threshold check.
    // PTO entries also excluded since they're not work hours.
    const workHours = entries
      .filter(e => !isLunchOrBreakName(e.job_locations?.name) && e.hours_type !== 'pto')
      .reduce((sum, e) => sum + Number(e.hours_worked || 0), 0);

    if (workHours < 8.0) {
      skipped++;
      continue;
    }

    // Get or create the Lunch location for this company
    if (!lunchLocationCache[companyId]) {
      lunchLocationCache[companyId] = await getOrCreateLunchLocation(companyId);
    }
    const lunchLocationId = lunchLocationCache[companyId];
    if (!lunchLocationId) {
      console.error(`Could not get/create Lunch location for company ${companyId}`);
      continue;
    }

    // Insert the 0.5-hour paid lunch segment. time_in and time_out are
    // intentionally null - the actual time doesn't matter for pay purposes,
    // only hours_worked = 0.5. Status is 'draft' so it goes through normal
    // approval flow alongside the employee's other segments.
    const { error: insertError } = await supabase
      .from('time_entries')
      .insert({
        employee_id: employeeId,
        company_id: companyId,
        entry_date: yesterday,
        job_location_id: lunchLocationId,
        activity_description: 'Lunch (auto-added)',
        time_in: null,
        time_out: null,
        hours_worked: 0.5,
        hours_type: 'regular',
        is_weekend: isWeekend(yesterday),
        is_holiday: isHoliday(yesterday),
        foreman_id: foremanId || null,
        status: 'draft',
      });

    if (insertError) {
      console.error(`Lunch insert failed for ${employeeId} on ${yesterday}:`, JSON.stringify(insertError));
      skipped++;
    } else {
      console.log(`Lunch added for employee ${employeeId} on ${yesterday}`);
      added++;
    }
  }

  console.log(`Lunch auto-add complete for ${yesterday}: ${added} added, ${skipped} skipped`);
  return {
    statusCode: 200,
    body: JSON.stringify({ date: yesterday, added, skipped }),
  };
};

exports.config = {
  schedule: '0 5 * * *', // 5am UTC = midnight ET (accounts for ET being UTC-5)
};
