const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { classifyWeek } = require('./_hours-logic');
const { resolveCompanyRole, supabase } = require('./_company-role');

function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
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
  if (myRole.role === 'employee') return forbidden('The dashboard is only available to foremen and admins');

  const currentYear = new Date().getUTCFullYear();
  const weekOf = weekStart(new Date().toISOString().slice(0, 10));
  const weekEnd = addDays(weekOf, 6);

  // ---------------- Drill-down: full detail for one employee ----------------
  if (params.employeeId) {
    const targetId = params.employeeId;

    // resolveCompanyRole only returns a result for ACTIVE role rows, which
    // would make a deactivated employee's profile completely inaccessible
    // (no way to even view them in order to reactivate). So for the
    // drill-down specifically, look up the role row directly when the
    // viewer is an admin, regardless of its active flag.
    let targetRoleRow;
    if (myRole.role === 'admin') {
      const { data: rawRoleRow, error: roleRowError } = await supabase
        .from('employee_company_roles')
        .select('role, foreman_id, employment_start_date, bill_rate, display_color, active')
        .eq('employee_id', targetId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (roleRowError) return errorResponse(roleRowError);
      targetRoleRow = rawRoleRow;
    } else {
      const resolved = await resolveCompanyRole(targetId, companyId, false);
      targetRoleRow = resolved ? { role: resolved.role, foremanId: resolved.foremanId, active: true } : null;
    }

    if (!targetRoleRow) return { statusCode: 404, body: JSON.stringify({ error: 'Employee not found at this company' }) };

    // Foremen can now view any employee at the company (cross-crew feature)

    const { data: target, error: empError } = await supabase
      .from('employees')
      .select('id, first_name, last_name, phone, email, active')
      .eq('id', targetId)
      .maybeSingle();

    if (empError) return errorResponse(empError);
    if (!target) return { statusCode: 404, body: JSON.stringify({ error: 'Employee not found' }) };

    const rangeStart = params.startDate || addDays(weekOf, -28);
    const rangeEnd = params.endDate || weekEnd;

    const { data: entries, error: entriesError } = await supabase
      .from('time_entries')
      .select('*, job_locations(name)')
      .eq('employee_id', targetId)
      .eq('company_id', companyId)
      .gte('entry_date', rangeStart)
      .lte('entry_date', rangeEnd)
      .order('entry_date', { ascending: true });

    if (entriesError) return errorResponse(entriesError);

    const { data: balance } = await supabase
      .from('pto_balances')
      .select('*')
      .eq('employee_id', targetId)
      .eq('company_id', companyId)
      .eq('year', currentYear)
      .maybeSingle();

    const { data: ptoRequests } = await supabase
      .from('pto_requests')
      .select('*')
      .eq('employee_id', targetId)
      .eq('company_id', companyId)
      .order('start_date', { ascending: false })
      .limit(10);

    const { totals } = classifyWeek((entries || []).filter(e => e.entry_date >= weekOf && e.entry_date <= weekEnd));

    return {
      statusCode: 200,
      body: JSON.stringify({
        employee: {
          id: target.id,
          firstName: target.first_name,
          lastName: target.last_name,
          phone: target.phone,
          email: target.email,
          role: targetRoleRow.role,
          roleActive: targetRoleRow.active,
          active: target.active,
          employmentStartDate: targetRoleRow.employment_start_date || null,
          billRate: targetRoleRow.bill_rate ? Number(targetRoleRow.bill_rate) : null,
          displayColor: targetRoleRow.display_color || null,
        },
        currentWeekTotals: {
          regularHoursWorked: round2(totals.regular),
          overtimeHoursWorked: round2(totals.overtime),
          holidayHours: round2(totals.holiday),
          ptoHours: round2(totals.pto),
          weeklyHours: round2(totals.weekly_total),
        },
        ptoBalance: {
          year: currentYear,
          allotmentHours: balance ? Number(balance.allotment_hours) : 0,
          usedHours: balance ? Number(balance.used_hours) : 0,
          remainingHours: balance ? round2(Number(balance.allotment_hours) - Number(balance.used_hours)) : 0,
          utoDaysTaken: balance ? Number(balance.uto_days_taken) : 0,
        },
        recentPtoRequests: ptoRequests || [],
        entries: (entries || []).map(e => ({
          date: e.entry_date,
          jobLocation: e.job_locations?.name || null,
          activityDescription: e.activity_description,
          timeIn: e.time_in,
          timeOut: e.time_out,
          hoursWorked: e.hours_worked,
          hoursType: e.hours_type,
          status: e.status,
        })),
      }),
    };
  }

  // ---------------- Directory list ----------------
  // Admins can optionally see inactive (deactivated) employees too, so
  // they have somewhere to go to reactivate someone. Foremen and the
  // default view only ever see active people.
  const showInactive = params.includeInactive === 'true' && myRole.role === 'admin';

  let roleQuery = supabase
    .from('employee_company_roles')
    .select('employee_id, role, foreman_id, employment_start_date, active, display_color, queue_eligible, employees!employee_company_roles_employee_id_fkey(id, first_name, last_name, phone, active)')
    .eq('company_id', companyId);

  if (!showInactive) {
    roleQuery = roleQuery.eq('active', true);
  }

  // Foremen now see ALL company employees — their crew is flagged with isMyTeam
  // so the frontend can show "My Team" section first, then "Other Employees"
  // No filter here — let all active employees through

  const { data: roleRows, error: roleListError } = await roleQuery;
  if (roleListError) return errorResponse(roleListError);

  const visibleRows = (roleRows || []).filter(r => r.employees?.active);
  const employeeIds = visibleRows.map(r => r.employee_id);

  if (employeeIds.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ weekOf, weekEnd, people: [] }) };
  }

  // Fetch foreman phone numbers for conflict warnings
  const foremanIds = [...new Set(visibleRows.map(r => r.foreman_id).filter(Boolean))];
  const foremanPhoneMap = {};
  if (foremanIds.length > 0) {
    const { data: foremanRows } = await supabase
      .from('employees')
      .select('id, first_name, last_name, phone')
      .in('id', foremanIds);
    for (const f of foremanRows || []) {
      foremanPhoneMap[f.id] = { name: `${f.first_name} ${f.last_name}`, phone: f.phone };
    }
  }

  if (employeeIds.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ weekOf, weekEnd, people: [] }) };
  }

  const { data: weekEntries } = await supabase
    .from('time_entries')
    .select('employee_id, entry_date, hours_worked, is_weekend, is_holiday, hours_type, job_locations(name)')
    .eq('company_id', companyId)
    .in('employee_id', employeeIds)
    .gte('entry_date', weekOf)
    .lte('entry_date', weekEnd);

  const { data: balances } = await supabase
    .from('pto_balances')
    .select('employee_id, allotment_hours, used_hours')
    .in('employee_id', employeeIds)
    .eq('year', currentYear);

  const entriesByEmployee = {};
  for (const e of weekEntries || []) {
    if (!entriesByEmployee[e.employee_id]) entriesByEmployee[e.employee_id] = [];
    entriesByEmployee[e.employee_id].push(e);
  }

  const balanceByEmployee = {};
  for (const b of balances || []) {
    balanceByEmployee[b.employee_id] = b;
  }

  const people = visibleRows
    .sort((a, b) => {
      const aIsMyTeam = myRole.role === 'foreman'
        ? (a.foreman_id === auth.employeeId || a.employee_id === auth.employeeId) : true;
      const bIsMyTeam = myRole.role === 'foreman'
        ? (b.foreman_id === auth.employeeId || b.employee_id === auth.employeeId) : true;
      if (aIsMyTeam && !bIsMyTeam) return -1;
      if (!aIsMyTeam && bIsMyTeam) return 1;
      return (a.employees.first_name || '').localeCompare(b.employees.first_name || '');
    })
    .map(r => {
      const empEntries = entriesByEmployee[r.employee_id] || [];
      const { totals } = classifyWeek(empEntries);
      const balance = balanceByEmployee[r.employee_id];

      return {
        id: r.employee_id,
        firstName: r.employees.first_name,
        lastName: r.employees.last_name,
        role: r.role,
        foremanId: r.foreman_id || null,
        foremanInfo: r.foreman_id ? (foremanPhoneMap[r.foreman_id] || null) : null,
        isMyTeam: myRole.role === 'foreman'
          ? (r.foreman_id === auth.employeeId || r.employee_id === auth.employeeId)
          : true, // admins see everyone as "their" team
        phone: r.employees.phone,
        roleActive: r.active,
        displayColor: r.display_color || null,
        queueEligible: r.queue_eligible || false,
        currentWeekHours: round2(totals.weekly_total),
        ptoBalance: {
          allotmentHours: balance ? Number(balance.allotment_hours) : 0,
          usedHours: balance ? Number(balance.used_hours) : 0,
          remainingHours: balance ? round2(Number(balance.allotment_hours) - Number(balance.used_hours)) : 0,
        },
      };
    });

  return { statusCode: 200, body: JSON.stringify({ weekOf, weekEnd, people }) };
};
