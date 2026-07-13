const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  const params = event.queryStringParameters || {};
  const companyId = params.companyId;
  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole || myRole.role !== 'admin') return forbidden('Only admins can access reports');

  const { reportType, groupBy, period, periodValue, locationId, format } = params;
  if (reportType !== 'billing') return { statusCode: 400, body: JSON.stringify({ error: 'Unknown report type' }) };

  // ---- Compute date range from period ----
  let startDate, endDate;
  if (period === 'week') {
    // periodValue is the Monday of the week YYYY-MM-DD
    startDate = periodValue;
    const end = new Date(periodValue + 'T00:00:00Z');
    end.setUTCDate(end.getUTCDate() + 6);
    endDate = end.toISOString().slice(0, 10);
  } else if (period === 'month') {
    // periodValue is YYYY-MM
    const [y, m] = periodValue.split('-').map(Number);
    startDate = `${y}-${String(m).padStart(2,'0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    endDate = `${y}-${String(m).padStart(2,'0')}-${lastDay}`;
  } else if (period === 'year') {
    // periodValue is YYYY
    startDate = `${periodValue}-01-01`;
    endDate = `${periodValue}-12-31`;
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid period' }) };
  }

  // ---- Fetch time entries for the period ----
  let entryQuery = supabase
    .from('time_entries')
    .select('employee_id, job_location_id, hours_worked, hours_type, entry_date, employees!time_entries_employee_id_fkey(first_name, last_name), job_locations(id, name, budget_amount, budget_materials)')
    .eq('company_id', companyId)
    .gte('entry_date', startDate)
    .lte('entry_date', endDate)
    .neq('hours_type', 'pto');

  if (locationId && locationId !== 'all') {
    entryQuery = entryQuery.eq('job_location_id', locationId);
  }

  const { data: entries, error: entryError } = await entryQuery;
  if (entryError) return errorResponse(entryError);

  // ---- Fetch bill rates for all employees in results ----
  const employeeIds = [...new Set((entries || []).map(e => e.employee_id))];
  let billRateMap = {};
  if (employeeIds.length > 0) {
    const { data: roles } = await supabase
      .from('employee_company_roles')
      .select('employee_id, bill_rate, role, foreman_id')
      .eq('company_id', companyId)
      .in('employee_id', employeeIds);
    for (const r of roles || []) {
      billRateMap[r.employee_id] = {
        billRate: r.bill_rate ? Number(r.bill_rate) : 0,
        role: r.role,
        foremanId: r.foreman_id,
      };
    }
  }

  // Also fetch foreman names for hierarchy
  const foremanIds = [...new Set(Object.values(billRateMap).map(r => r.foremanId).filter(Boolean))];
  let foremanNameMap = {};
  if (foremanIds.length > 0) {
    const { data: foremans } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .in('id', foremanIds);
    for (const f of foremans || []) {
      foremanNameMap[f.id] = `${f.first_name} ${f.last_name}`;
    }
  }

  // ---- Fetch receipts for the period ----
  let receiptQuery = supabase
    .from('job_site_photos')
    .select('employee_id, job_location_id, receipt_amount, taken_at, employees(first_name, last_name), job_locations(id, name)')
    .eq('company_id', companyId)
    .eq('is_receipt', true)
    .gte('taken_at', startDate + 'T00:00:00Z')
    .lte('taken_at', endDate + 'T23:59:59Z');

  if (locationId && locationId !== 'all') {
    receiptQuery = receiptQuery.eq('job_location_id', locationId);
  }

  const { data: receipts, error: receiptError } = await receiptQuery;
  if (receiptError) return errorResponse(receiptError);

  // ---- Fetch all job locations for budget data ----
  const { data: locations } = await supabase
    .from('job_locations')
    .select('id, name, budget_amount, budget_materials')
    .eq('company_id', companyId);
  const locationMap = {};
  for (const l of locations || []) locationMap[l.id] = l;

  // ---- Build report grouped by LOCATION ----
  if (groupBy === 'location') {
    const locationGroups = {};

    for (const e of entries || []) {
      const locId = e.job_location_id || 'unassigned';
      const locName = e.job_locations?.name || 'No location';
      if (!locationGroups[locId]) {
        locationGroups[locId] = {
          locationId: locId,
          locationName: locName,
          budgetLabor: locationMap[locId]?.budget_amount ? Number(locationMap[locId].budget_amount) : null,
          budgetMaterials: locationMap[locId]?.budget_materials ? Number(locationMap[locId].budget_materials) : null,
          laborHours: 0,
          laborDollars: 0,
          materialsDollars: 0,
          employees: {},
        };
      }
      const g = locationGroups[locId];
      const empId = e.employee_id;
      const empName = e.employees ? `${e.employees.first_name} ${e.employees.last_name}` : 'Unknown';
      const rate = billRateMap[empId]?.billRate || 0;
      const hours = Number(e.hours_worked);
      const dollars = hours * rate;
      g.laborHours += hours;
      g.laborDollars += dollars;
      if (!g.employees[empId]) g.employees[empId] = { name: empName, hours: 0, dollars: 0, rate };
      g.employees[empId].hours += hours;
      g.employees[empId].dollars += dollars;
    }

    for (const r of receipts || []) {
      const locId = r.job_location_id || 'unassigned';
      const locName = r.job_locations?.name || 'No location';
      if (!locationGroups[locId]) {
        locationGroups[locId] = {
          locationId: locId, locationName: locName,
          budgetLabor: locationMap[locId]?.budget_amount ? Number(locationMap[locId].budget_amount) : null,
          budgetMaterials: locationMap[locId]?.budget_materials ? Number(locationMap[locId].budget_materials) : null,
          laborHours: 0, laborDollars: 0, materialsDollars: 0, employees: {},
        };
      }
      locationGroups[locId].materialsDollars += r.receipt_amount ? Number(r.receipt_amount) : 0;
    }

    const groups = Object.values(locationGroups)
      .sort((a, b) => a.locationName.localeCompare(b.locationName))
      .map(g => ({
        ...g,
        laborDollars: Math.round(g.laborDollars * 100) / 100,
        materialsDollars: Math.round(g.materialsDollars * 100) / 100,
        totalDollars: Math.round((g.laborDollars + g.materialsDollars) * 100) / 100,
        employees: Object.values(g.employees).sort((a, b) => a.name.localeCompare(b.name)),
        laborBudgetRemaining: g.budgetLabor != null ? Math.round((g.budgetLabor - g.laborDollars) * 100) / 100 : null,
        materialsBudgetRemaining: g.budgetMaterials != null ? Math.round((g.budgetMaterials - g.materialsDollars) * 100) / 100 : null,
      }));

    const totals = {
      laborHours: Math.round(groups.reduce((s, g) => s + g.laborHours, 0) * 100) / 100,
      laborDollars: Math.round(groups.reduce((s, g) => s + g.laborDollars, 0) * 100) / 100,
      materialsDollars: Math.round(groups.reduce((s, g) => s + g.materialsDollars, 0) * 100) / 100,
      totalDollars: Math.round(groups.reduce((s, g) => s + g.totalDollars, 0) * 100) / 100,
    };

    return { statusCode: 200, body: JSON.stringify({ groupBy: 'location', period, startDate, endDate, groups, totals }) };
  }

  // ---- Build report grouped by EMPLOYEE (with foreman hierarchy) ----
  if (groupBy === 'employee') {
    // Group entries by employee
    const empGroups = {};

    for (const e of entries || []) {
      const empId = e.employee_id;
      const empName = e.employees ? `${e.employees.first_name} ${e.employees.last_name}` : 'Unknown';
      const rate = billRateMap[empId]?.billRate || 0;
      const foremanId = billRateMap[empId]?.foremanId || null;
      const role = billRateMap[empId]?.role || 'employee';
      if (!empGroups[empId]) {
        empGroups[empId] = { empId, name: empName, role, foremanId, billRate: rate, hours: 0, dollars: 0, locations: {} };
      }
      const hours = Number(e.hours_worked);
      empGroups[empId].hours += hours;
      empGroups[empId].dollars += hours * rate;
      const locId = e.job_location_id || 'unassigned';
      const locName = e.job_locations?.name || 'No location';
      if (!empGroups[empId].locations[locId]) empGroups[empId].locations[locId] = { name: locName, hours: 0, dollars: 0 };
      empGroups[empId].locations[locId].hours += hours;
      empGroups[empId].locations[locId].dollars += hours * rate;
    }

    // Build foreman hierarchy
    const foremanGroups = {};
    const unassignedEmps = [];

    for (const emp of Object.values(empGroups)) {
      emp.dollars = Math.round(emp.dollars * 100) / 100;
      emp.locations = Object.values(emp.locations)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(l => ({ ...l, dollars: Math.round(l.dollars * 100) / 100 }));

      if (emp.role === 'foreman' || emp.role === 'admin') {
        if (!foremanGroups[emp.empId]) foremanGroups[emp.empId] = { foreman: emp, crew: [] };
        else foremanGroups[emp.empId].foreman = emp;
      } else if (emp.foremanId) {
        if (!foremanGroups[emp.foremanId]) foremanGroups[emp.foremanId] = { foreman: null, crew: [] };
        foremanGroups[emp.foremanId].crew.push(emp);
      } else {
        unassignedEmps.push(emp);
      }
    }

    // Add foremen who have crew but no entries themselves
    for (const fId of Object.keys(foremanGroups)) {
      if (!foremanGroups[fId].foreman) {
        const { data: fEmp } = await supabase.from('employees').select('first_name, last_name').eq('id', fId).maybeSingle();
        foremanGroups[fId].foreman = {
          empId: fId, name: fEmp ? `${fEmp.first_name} ${fEmp.last_name}` : 'Unknown',
          role: 'foreman', hours: 0, dollars: 0, locations: [],
        };
      }
    }

    const groups = Object.values(foremanGroups)
      .sort((a, b) => (a.foreman?.name || '').localeCompare(b.foreman?.name || ''))
      .map(g => ({
        foreman: g.foreman,
        crew: g.crew.sort((a, b) => a.name.localeCompare(b.name)),
        teamHours: Math.round(([g.foreman, ...g.crew].reduce((s, e) => s + (e?.hours || 0), 0)) * 100) / 100,
        teamDollars: Math.round(([g.foreman, ...g.crew].reduce((s, e) => s + (e?.dollars || 0), 0)) * 100) / 100,
      }));

    // Receipts by employee
    const receiptByEmp = {};
    for (const r of receipts || []) {
      const empId = r.employee_id;
      if (!receiptByEmp[empId]) receiptByEmp[empId] = { name: r.employees ? `${r.employees.first_name} ${r.employees.last_name}` : 'Unknown', amount: 0 };
      receiptByEmp[empId].amount += r.receipt_amount ? Number(r.receipt_amount) : 0;
    }

    const totals = {
      laborHours: Math.round(Object.values(empGroups).reduce((s, e) => s + e.hours, 0) * 100) / 100,
      laborDollars: Math.round(Object.values(empGroups).reduce((s, e) => s + e.dollars, 0) * 100) / 100,
      materialsDollars: Math.round(Object.values(receiptByEmp).reduce((s, e) => s + e.amount, 0) * 100) / 100,
    };
    totals.totalDollars = Math.round((totals.laborDollars + totals.materialsDollars) * 100) / 100;

    return { statusCode: 200, body: JSON.stringify({ groupBy: 'employee', period, startDate, endDate, groups, unassigned: unassignedEmps, receiptByEmp, totals }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'groupBy must be location or employee' }) };
};
