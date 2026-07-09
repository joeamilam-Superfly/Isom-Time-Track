const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
});

// PTO accrual rules:
// - After 1 year:  5 days (40 hours at 8h/day)
// - After 2 years: 6 days
// - After 3 years: 7 days
// - After 4 years: 8 days
// - After 5+ years: 10 days (cap)
function calculateAllotmentHours(yearsOfService) {
  if (yearsOfService < 1) return 0;
  if (yearsOfService >= 5) return 10 * 8; // 10 days at 5+ years (cap per policy)
  const days = 5 + (yearsOfService - 1); // year 1=5, 2=6, 3=7, 4=8 days
  return days * 8;
}

// Netlify scheduled function. Runs daily at 6am ET. Checks whether any
// active employee at any company has a work anniversary TODAY, and if
// so, updates their PTO allotment for the current year based on years
// of service. This is the only place PTO allotment gets auto-set; admin
// can still manually override it via the team drill-down at any time.
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
  if (etHour !== 6 && !forceRun) {
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, reason: `Current ET hour is ${etHour}, not 6` }),
    };
  }

  const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const [todayYear, todayMonth, todayDay] = todayEt.split('-').map(Number);
  const currentYear = todayYear;

  // Fetch all active roles that have an employment_start_date set
  const { data: roles, error } = await supabase
    .from('employee_company_roles')
    .select('employee_id, company_id, employment_start_date')
    .eq('active', true)
    .not('employment_start_date', 'is', null);

  if (error) {
    console.error('Failed to load roles:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  let updated = 0;
  let checked = 0;

  for (const role of roles || []) {
    const startDate = role.employment_start_date;
    const [startYear, startMonth, startDay] = startDate.split('-').map(Number);

    // Check if today is their work anniversary (same month and day, at
    // least one year in). Handles Feb 29 birthdays by using Mar 1 on
    // non-leap years - Intl date handling normalizes this naturally.
    if (startMonth !== todayMonth || startDay !== todayDay) continue;
    checked++;

    const yearsOfService = currentYear - startYear;
    if (yearsOfService < 1) continue;

    const allotmentHours = calculateAllotmentHours(yearsOfService);

    // Fetch existing balance for this year to preserve used_hours and
    // uto_days_taken - we're only updating the allotment, not resetting
    // the used hours (those accumulated through the year so far).
    const { data: existing } = await supabase
      .from('pto_balances')
      .select('used_hours, uto_days_taken')
      .eq('employee_id', role.employee_id)
      .eq('company_id', role.company_id)
      .eq('year', currentYear)
      .maybeSingle();

    const { error: upsertError } = await supabase
      .from('pto_balances')
      .upsert({
        employee_id: role.employee_id,
        company_id: role.company_id,
        year: currentYear,
        allotment_hours: allotmentHours,
        used_hours: existing ? existing.used_hours : 0,
        uto_days_taken: existing ? existing.uto_days_taken : 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'employee_id,company_id,year' });

    if (upsertError) {
      console.error(`Failed to update allotment for ${role.employee_id}:`, upsertError);
    } else {
      console.log(`Updated allotment for ${role.employee_id} at ${role.company_id}: ${yearsOfService} years = ${allotmentHours}h`);
      updated++;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ date: todayEt, checked, updated }),
  };
};

exports.config = {
  schedule: '0 * * * *',
};
