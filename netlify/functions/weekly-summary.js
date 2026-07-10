const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { classifyWeek, determineWeeklyApprovalForeman } = require('./_hours-logic');
const { resolveCompanyRole, supabase } = require('./_company-role');

function weekStart(dateStr, startDay = 0) {
  // startDay: 0 = Sunday (default), 1 = Monday
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = (day - startDay + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  const params = event.queryStringParameters || {};
  const companyId = params.companyId;
  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole) return forbidden('You do not have access to this company');

  // Fetch company config for week start day (0=Sun, 1=Mon)
  const { data: company } = await supabase
    .from('companies')
    .select('week_start_day')
    .eq('id', companyId)
    .maybeSingle();
  const weekStartDay = company ? (company.week_start_day || 0) : 0;

  const weekOf = params.weekOf ? weekStart(params.weekOf, weekStartDay) : weekStart(new Date().toISOString().slice(0, 10), weekStartDay);
  const weekEnd = addDays(weekOf, 6);

  // Determine which employees this caller is allowed to see, AT THIS COMPANY.
  let employeeIds;
  if (params.employeeId) {
    if (params.employeeId !== auth.employeeId && myRole.role === 'employee') {
      return forbidden('You can only view your own summary');
    }
    employeeIds = [params.employeeId];
  } else if (myRole.role === 'admin') {
    const { data: all } = await supabase
      .from('employee_company_roles')
      .select('employee_id')
      .eq('company_id', companyId)
      .eq('active', true);
    employeeIds = (all || []).map(r => r.employee_id);

    // Also include anyone DEACTIVATED at this company who still logged
    // hours during the requested week, so payroll-relevant hours don't
    // silently disappear from the summary/export just because someone
    // was deactivated partway through (or after) the week.
    const { data: deactivatedWithEntries } = await supabase
      .from('time_entries')
      .select('employee_id')
      .eq('company_id', companyId)
      .gte('entry_date', weekOf)
      .lte('entry_date', weekEnd);

    const existingIds = new Set(employeeIds);
    for (const row of deactivatedWithEntries || []) {
      if (!existingIds.has(row.employee_id)) {
        employeeIds.push(row.employee_id);
        existingIds.add(row.employee_id);
      }
    }
  } else if (myRole.role === 'foreman') {
    const { data: theirs } = await supabase
      .from('employee_company_roles')
      .select('employee_id')
      .eq('company_id', companyId)
      .eq('foreman_id', auth.employeeId)
      .eq('active', true);
    const permanentCrewIds = (theirs || []).map(r => r.employee_id);

    // Also include anyone who logged a segment THIS WEEK naming this
    // foreman directly (via the per-segment foreman dropdown), even if
    // they're not permanently assigned to this foreman - the approval
    // routing for the week is computed from actual hours worked, not
    // just the permanent assignment, so visibility has to match.
    const { data: thisWeekSegments } = await supabase
      .from('time_entries')
      .select('employee_id')
      .eq('company_id', companyId)
      .eq('foreman_id', auth.employeeId)
      .gte('entry_date', weekOf)
      .lte('entry_date', weekEnd);

    const idSet = new Set(permanentCrewIds);
    for (const row of thisWeekSegments || []) idSet.add(row.employee_id);

    employeeIds = [...idSet];
    employeeIds.push(auth.employeeId);
  } else {
    employeeIds = [auth.employeeId];
  }

  if (employeeIds.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ weekOf, weekEnd, summaries: [] }) };
  }

  const { data: entries, error } = await supabase
    .from('time_entries')
    .select('*, employees!time_entries_employee_id_fkey(first_name, last_name), job_locations(name)')
    .eq('company_id', companyId)
    .in('employee_id', employeeIds)
    .gte('entry_date', weekOf)
    .lte('entry_date', weekEnd)
    .order('entry_date', { ascending: true });

  if (error) return errorResponse(error);

  // Needed to compute each employee's determined approving foreman for
  // this week, since determineWeeklyApprovalForeman falls back to the
  // default assigned foreman for any segment that didn't specify one.
  const { data: defaultForemanRows } = await supabase
    .from('employee_company_roles')
    .select('employee_id, foreman_id')
    .eq('company_id', companyId)
    .in('employee_id', employeeIds);

  const defaultForemanByEmployee = {};
  for (const r of defaultForemanRows || []) {
    defaultForemanByEmployee[r.employee_id] = r.foreman_id;
  }

  const byEmployee = {};
  for (const e of entries || []) {
    if (!byEmployee[e.employee_id]) byEmployee[e.employee_id] = [];
    byEmployee[e.employee_id].push(e);
  }

  const summaries = Object.entries(byEmployee).map(([employeeId, empEntries]) => {
    const { entries: classified, totals } = classifyWeek(empEntries);

    const approvingForemanId = determineWeeklyApprovalForeman(empEntries, defaultForemanByEmployee[employeeId]);

    // Group classified segments by date - a day can now have multiple
    // segments (e.g. two job sites in one day), so the frontend needs one
    // "day" object per date containing an array of segments, not one
    // object per segment that happens to share a date with others.
    const byDate = {};
    for (const c of classified) {
      if (!byDate[c.entry_date]) byDate[c.entry_date] = [];
      byDate[c.entry_date].push({
        id: c.id,
        jobLocation: c.job_locations?.name || null,
        jobLocationId: c.job_location_id || null,
        activityDescription: c.activity_description,
        timeIn: c.time_in,
        timeOut: c.time_out,
        hoursWorked: c.hours_worked,
        hoursType: c.hours_type,
        status: c.status,
        foremanId: c.foreman_id,
      });
    }

    const days = Object.entries(byDate).map(([date, segments]) => ({
      date,
      segments,
      totalHoursWorked: round2(segments.reduce((sum, s) => sum + Number(s.hoursWorked), 0)),
    }));

    return {
      employeeId,
      employeeName: empEntries[0]?.employees
        ? `${empEntries[0].employees.first_name} ${empEntries[0].employees.last_name}`
        : null,
      approvingForemanId,
      days,
      totals: {
        regularHoursWorked: round2(totals.regular),
        overtimeHoursWorked: round2(totals.overtime),
        holidayHours: round2(totals.holiday),
        ptoHours: round2(totals.pto),
        weeklyHours: round2(totals.weekly_total),
      },
    };
  });

  return { statusCode: 200, body: JSON.stringify({ weekOf, weekEnd, summaries }) };
};
