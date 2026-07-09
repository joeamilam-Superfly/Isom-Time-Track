const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { sendSms } = require('./_sms');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
});

// PTO accrual rules - must stay in sync with the client-side
// calcAllotmentHours function in team.js.
function calculateAllotmentHours(yearsOfService) {
  if (yearsOfService < 1) return 0;
  if (yearsOfService >= 5) return 10 * 8; // 10 days at 5+ years (cap per policy)
  const days = 5 + (yearsOfService - 1); // year 1=5, 2=6, 3=7, 4=8 days
  return days * 8;
}

// Adds n days to a YYYY-MM-DD string, returning YYYY-MM-DD.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Netlify scheduled function. Runs hourly; only acts at 6am ET each day.
// Does two things each run:
//
// 1. ANNIVERSARY ACCRUAL: if today is someone's work anniversary (same
//    month+day as their employment_start_date, at least 1 year in),
//    updates their PTO allotment for the current year.
//
// 2. ANNIVERSARY REMINDER: if someone's work anniversary is exactly 30
//    days from today AND they have a remaining PTO balance > 0, sends
//    them one SMS reminding them to either take the time or submit a
//    payout request before their balance resets. Uses reminder_log with
//    the anniversary date as the key so it only ever fires once.
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

  // Date that is exactly 30 days from now - anniversary reminders fire
  // when this date matches someone's month+day start date.
  const in30Days = addDays(todayEt, 30);
  const [, in30Month, in30Day] = in30Days.split('-').map(Number);

  // Fetch all active roles that have an employment_start_date set,
  // including employee phone for SMS and company name for context.
  const { data: roles, error } = await supabase
    .from('employee_company_roles')
    .select('employee_id, company_id, employment_start_date, employees!employee_company_roles_employee_id_fkey(first_name, phone, active), companies(name, active)')
    .eq('active', true)
    .not('employment_start_date', 'is', null);

  if (error) {
    console.error('Failed to load roles:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  const activeRoles = (roles || []).filter(
    r => r.employees?.active && r.companies?.active
  );

  let accrualUpdated = 0;
  let remindersSent = 0;

  for (const role of activeRoles) {
    const startDate = role.employment_start_date;
    const [startYear, startMonth, startDay] = startDate.split('-').map(Number);

    // ---- 1. ANNIVERSARY ACCRUAL ----
    if (startMonth === todayMonth && startDay === todayDay) {
      const yearsOfService = currentYear - startYear;
      if (yearsOfService >= 1) {
        const allotmentHours = calculateAllotmentHours(yearsOfService);

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
          console.error(`Accrual failed for ${role.employee_id}:`, upsertError);
        } else {
          console.log(`Accrual: ${role.employee_id} at ${role.company_id} — ${yearsOfService}yr = ${allotmentHours}h`);
          accrualUpdated++;
        }
      }
    }

    // ---- 2. ANNIVERSARY REMINDER (30 days out) ----
    if (startMonth === in30Month && startDay === in30Day) {
      const yearsOfService = currentYear - startYear;
      if (yearsOfService < 1) continue; // not entitled yet

      // Check if we've already sent this reminder (keyed on the
      // anniversary date itself, not today, so it's idempotent).
      const anniversaryDate = `${currentYear}-${String(startMonth).padStart(2,'0')}-${String(startDay).padStart(2,'0')}`;

      const { data: alreadySent } = await supabase
        .from('reminder_log')
        .select('id')
        .eq('employee_id', role.employee_id)
        .eq('company_id', role.company_id)
        .eq('reminder_date', anniversaryDate)
        .maybeSingle();

      if (alreadySent) continue;

      // Only remind if they actually have unused balance
      const { data: balance } = await supabase
        .from('pto_balances')
        .select('allotment_hours, used_hours')
        .eq('employee_id', role.employee_id)
        .eq('company_id', role.company_id)
        .eq('year', currentYear)
        .maybeSingle();

      const remaining = balance
        ? Number(balance.allotment_hours) - Number(balance.used_hours)
        : 0;

      if (remaining <= 0) {
        // Log as skipped so we don't re-check every day
        await supabase.from('reminder_log').insert({
          employee_id: role.employee_id,
          company_id: role.company_id,
          reminder_date: anniversaryDate,
          sms_status: 'skipped_no_balance',
        });
        continue;
      }

      const remainingDays = (remaining / 8).toFixed(1);
      const companyName = role.companies?.name || 'your company';
      const firstName = role.employees?.first_name || 'there';
      const message = `${companyName}: Hi ${firstName}, your annual leave resets in 30 days (${anniversaryDate}). You have ${remaining.toFixed(1)} hours (${remainingDays} days) unused. Log in to request time off or submit a payout request before it resets.`;

      let smsResult = { status: 'skipped_no_phone' };
      if (role.employees?.phone) {
        smsResult = await sendSms(role.employees.phone, message);
      }

      await supabase.from('reminder_log').insert({
        employee_id: role.employee_id,
        company_id: role.company_id,
        reminder_date: anniversaryDate,
        sms_status: smsResult.status,
      });

      if (smsResult.status === 'sent' || smsResult.status === 'skipped_no_credentials') {
        remindersSent++;
      }

      console.log(`Anniversary reminder: ${role.employee_id} — ${remaining}h remaining, SMS: ${smsResult.status}`);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ date: todayEt, accrualUpdated, remindersSent }),
  };
};

exports.config = {
  schedule: '0 * * * *',
};
