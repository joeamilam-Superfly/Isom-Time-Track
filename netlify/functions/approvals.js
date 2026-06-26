const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');
const { determineWeeklyApprovalForeman } = require('./_hours-logic');

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

// For a given employee at a company, figures out who the approving
// foreman is for the week containing entryDate. This is computed fresh
// from that week's actual segments (whichever foreman has the most
// hours that week), not read from a fixed assignment - the same
// employee can have a different approver from one week to the next.
async function getApprovingForemanForWeek(employeeId, companyId, entryDate, defaultForemanId) {
  const weekOf = weekStart(entryDate);
  const weekEnd = addDays(weekOf, 6);

  const { data: weekSegments, error } = await supabase
    .from('time_entries')
    .select('foreman_id, hours_worked')
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)
    .gte('entry_date', weekOf)
    .lte('entry_date', weekEnd);

  if (error) return { error };

  const foremanId = determineWeeklyApprovalForeman(weekSegments || [], defaultForemanId);
  return { foremanId };
}

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { companyId, action, entryIds, note } = body;
  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'entryIds must be a non-empty array' }) };
  }
  if (!['foreman_approve', 'admin_approve', 'reject'].includes(action)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };
  }

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole || myRole.role === 'employee') {
    return forbidden('You do not have approval permission at this company');
  }

  const { data: entries, error: fetchError } = await supabase
    .from('time_entries')
    .select('id, employee_id, entry_date, status, company_id')
    .in('id', entryIds);

  if (fetchError) return errorResponse(fetchError);
  if (!entries || entries.length === 0) {
    return { statusCode: 404, body: JSON.stringify({ error: 'No matching entries found' }) };
  }

  const wrongCompany = entries.some(e => e.company_id !== companyId);
  if (wrongCompany) {
    return { statusCode: 400, body: JSON.stringify({ error: 'One or more entries do not belong to the specified company' }) };
  }

  // Each entry might belong to a different employee and/or a different
  // week, so the approving foreman has to be computed per (employee,
  // week) pair, not once for the whole batch. In practice the frontend
  // only ever sends entries for one employee's one week at a time, but
  // this is computed correctly either way rather than assuming that.
  const employeeIds = [...new Set(entries.map(e => e.employee_id))];
  const { data: roleRows, error: roleError } = await supabase
    .from('employee_company_roles')
    .select('employee_id, foreman_id')
    .eq('company_id', companyId)
    .in('employee_id', employeeIds);

  if (roleError) return errorResponse(roleError);

  const defaultForemanByEmployee = {};
  for (const r of roleRows || []) {
    defaultForemanByEmployee[r.employee_id] = r.foreman_id;
  }

  // Build a cache key per (employee, weekOf) so we don't recompute the
  // same week's routing multiple times if several entries in this batch
  // fall in the same week (the normal case).
  const approvingForemanCache = {};
  async function getCachedApprovingForeman(employeeId, entryDate) {
    const key = `${employeeId}:${weekStart(entryDate)}`;
    if (key in approvingForemanCache) return approvingForemanCache[key];
    const result = await getApprovingForemanForWeek(employeeId, companyId, entryDate, defaultForemanByEmployee[employeeId]);
    approvingForemanCache[key] = result;
    return result;
  }

  if (action === 'foreman_approve') {
    for (const e of entries) {
      const result = await getCachedApprovingForeman(e.employee_id, e.entry_date);
      if (result.error) return errorResponse(result.error);
      if (result.foremanId !== auth.employeeId && myRole.role !== 'admin') {
        return forbidden('You are not the approving foreman for this employee\'s hours this week');
      }
    }

    const wrongStatus = entries.some(e => e.status !== 'draft' && e.status !== 'rejected');
    if (wrongStatus) {
      return { statusCode: 409, body: JSON.stringify({ error: 'Some entries are not in a state that can be foreman-approved' }) };
    }

    const { error } = await supabase
      .from('time_entries')
      .update({
        status: 'foreman_approved',
        foreman_approved_by: auth.employeeId,
        foreman_approved_at: new Date().toISOString(),
      })
      .in('id', entryIds);

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ updated: entryIds.length }) };
  }

  if (action === 'admin_approve') {
    if (myRole.role !== 'admin') return forbidden('Only admins can give final approval');
    const wrongStatus = entries.some(e => e.status !== 'foreman_approved');
    if (wrongStatus) {
      return { statusCode: 409, body: JSON.stringify({ error: 'Entries must be foreman-approved before final approval' }) };
    }

    const { error } = await supabase
      .from('time_entries')
      .update({
        status: 'admin_approved',
        admin_approved_by: auth.employeeId,
        admin_approved_at: new Date().toISOString(),
      })
      .in('id', entryIds);

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ updated: entryIds.length }) };
  }

  if (action === 'reject') {
    for (const e of entries) {
      const result = await getCachedApprovingForeman(e.employee_id, e.entry_date);
      if (result.error) return errorResponse(result.error);
      if (result.foremanId !== auth.employeeId && myRole.role !== 'admin') {
        return forbidden('You are not the approving foreman for this employee\'s hours this week');
      }
    }

    const { error } = await supabase
      .from('time_entries')
      .update({
        status: 'rejected',
        rejection_note: note || null,
        foreman_approved_by: null,
        foreman_approved_at: null,
        admin_approved_by: null,
        admin_approved_at: null,
      })
      .in('id', entryIds);

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ updated: entryIds.length }) };
  }
};
