const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { sendSms } = require('./_sms');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
});

// Netlify scheduled function. Runs hourly (cron is UTC); only actually acts
// during the 4pm America/New_York hour, computed fresh each run so it
// stays correct across the EST/EDT daylight saving transition.
//
// Multi-company: reminders are evaluated PER COMPANY MEMBERSHIP, not per
// employee globally. Someone who works at two companies could have logged
// hours at one but not the other on a given day, and should still be
// reminded about whichever company they haven't logged for.
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
  if (etHour !== 16 && !forceRun) {
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: `Current ET hour is ${etHour}, not 16` }) };
  }

  const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);

  const { data: memberships, error: memberError } = await supabase
    .from('employee_company_roles')
    .select('employee_id, company_id, employees!employee_company_roles_employee_id_fkey(first_name, phone, active), companies(name, active)')
    .eq('active', true);

  if (memberError) {
    console.error('Failed to load company memberships:', memberError);
    return { statusCode: 500, body: JSON.stringify({ error: memberError.message }) };
  }

  const activeMemberships = (memberships || []).filter(
    m => m.employees?.active && m.companies?.active
  );

  const results = [];

  for (const m of activeMemberships) {
    const employeeId = m.employee_id;
    const companyId = m.company_id;

    const { data: existingReminder } = await supabase
      .from('reminder_log')
      .select('id')
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .eq('reminder_date', todayEt)
      .maybeSingle();

    if (existingReminder) {
      continue;
    }

    const { data: existingEntry } = await supabase
      .from('time_entries')
      .select('id')
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .eq('entry_date', todayEt)
      .maybeSingle();

    if (existingEntry) {
      await supabase.from('reminder_log').insert({
        employee_id: employeeId,
        company_id: companyId,
        reminder_date: todayEt,
        sms_status: 'skipped_has_entry',
      });
      continue;
    }

    const companyName = m.companies?.name || 'your company';
    const message = `${companyName}: Hi ${m.employees.first_name}, you haven't logged your hours for today yet. Reply or log in to add them before end of day.`;
    const result = await sendSms(m.employees.phone, message);

    await supabase.from('reminder_log').insert({
      employee_id: employeeId,
      company_id: companyId,
      reminder_date: todayEt,
      sms_status: result.status,
    });

    results.push({ employeeId, companyId, ...result });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ checked: activeMemberships.length, remindersSent: results.length, results }),
  };
};

exports.config = {
  schedule: '0 * * * *',
};
