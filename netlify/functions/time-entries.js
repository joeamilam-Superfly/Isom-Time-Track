const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { rawHoursForEntry, isWeekend, isHoliday, findOverlappingSegment } = require('./_hours-logic');
const { resolveCompanyRole, supabase } = require('./_company-role');

// Validates that a chosen foreman_id genuinely has a foreman or admin
// role at this company - an employee picking from the dropdown should
// never be able to submit something else (a guessed ID, another plain
// employee, someone from a different company) as the foreman on a segment.
async function isValidForemanChoice(foremanId, companyId) {
  if (!foremanId) return true; // null/unset is always valid - falls back to default
  const { data } = await supabase
    .from('employee_company_roles')
    .select('role')
    .eq('employee_id', foremanId)
    .eq('company_id', companyId)
    .eq('active', true)
    .maybeSingle();
  return !!data && (data.role === 'foreman' || data.role === 'admin');
}

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Multiple segments per day are allowed (e.g. 7-11 at one site, 12-4 at
// another), so before saving a segment we check it against every OTHER
// segment that could plausibly overlap it. That window is the segment's
// own day plus the day before and after, since an overnight shift logged
// under one entry_date can extend its real-world time into the next
// calendar day (and a segment logged the next day could start before an
// overnight shift from the prior day actually ends).
async function checkForOverlap(employeeId, companyId, entryDate, timeIn, timeOut, excludeId) {
  if (!timeIn || !timeOut) return null; // nothing to overlap-check without both times

  const windowStart = addDaysStr(entryDate, -1);
  const windowEnd = addDaysStr(entryDate, 1);

  let query = supabase
    .from('time_entries')
    .select('id, entry_date, time_in, time_out, job_locations(name)')
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)
    .gte('entry_date', windowStart)
    .lte('entry_date', windowEnd)
    .not('status', 'eq', 'rejected'); // rejected segments don't count as real conflicts

  if (excludeId) query = query.neq('id', excludeId);

  const { data: candidates, error } = await query;
  if (error) return { error };

  const overlap = findOverlappingSegment(
    { entryDate, timeIn, timeOut },
    candidates || []
  );

  return overlap ? { overlap } : null;
}

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  // ---------------- GET: list segments ----------------
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const companyId = params.companyId;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const targetEmployeeId = params.employeeId || auth.employeeId;
    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (targetEmployeeId !== auth.employeeId && myRole.role === 'employee') {
      return forbidden('You can only view your own time entries');
    }

    let query = supabase
      .from('time_entries')
      .select('*, job_locations(name), employees!time_entries_foreman_id_fkey(first_name, last_name)')
      .eq('employee_id', targetEmployeeId)
      .eq('company_id', companyId)
      .order('entry_date', { ascending: true })
      .order('time_in', { ascending: true });

    if (params.startDate) query = query.gte('entry_date', params.startDate);
    if (params.endDate) query = query.lte('entry_date', params.endDate);

    const { data, error } = await query;
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ entries: data }) };
  }

  // ---------------- POST: create a new segment ----------------
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const companyId = body.companyId;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const targetEmployeeId = body.employeeId || auth.employeeId;
    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (targetEmployeeId !== auth.employeeId && myRole.role !== 'admin') {
      return forbidden('You do not have permission to edit this employee\'s hours');
    }

    if (targetEmployeeId !== auth.employeeId) {
      const targetRole = await resolveCompanyRole(targetEmployeeId, companyId, false);
      if (!targetRole) {
        return { statusCode: 400, body: JSON.stringify({ error: 'That employee does not belong to this company' }) };
      }
    }

    const {
      entryDate, jobLocationId, activityDescription,
      timeIn, timeOut, hoursType, foremanId,
    } = body;

    if (!entryDate) {
      return { statusCode: 400, body: JSON.stringify({ error: 'entryDate is required' }) };
    }

    if (hoursType === 'pto') {
      return { statusCode: 400, body: JSON.stringify({ error: 'PTO must be submitted as a PTO request, not entered directly. Use the PTO request form.' }) };
    }

    if (!timeIn || !timeOut) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Both timeIn and timeOut are required' }) };
    }

    let finalForemanId = foremanId || null;
    if (finalForemanId) {
      const validChoice = await isValidForemanChoice(finalForemanId, companyId);
      if (!validChoice) {
        return { statusCode: 400, body: JSON.stringify({ error: 'The selected foreman is not a valid foreman or admin at this company' }) };
      }
    } else {
      // No foreman explicitly picked - fall back to the employee's
      // default assigned foreman at this company, if they have one.
      const { data: roleRow } = await supabase
        .from('employee_company_roles')
        .select('foreman_id')
        .eq('employee_id', targetEmployeeId)
        .eq('company_id', companyId)
        .maybeSingle();
      finalForemanId = roleRow ? roleRow.foreman_id : null;
    }

    const overlapResult = await checkForOverlap(targetEmployeeId, companyId, entryDate, timeIn, timeOut, null);
    if (overlapResult && overlapResult.error) return errorResponse(overlapResult.error);
    if (overlapResult && overlapResult.overlap) {
      const o = overlapResult.overlap;
      const siteName = o.job_locations?.name ? ` at ${o.job_locations.name}` : '';
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: `This overlaps with an existing entry${siteName} on ${o.entry_date} from ${o.time_in.slice(0,5)} to ${o.time_out.slice(0,5)}. Adjust the times or edit/remove that entry first.`,
        }),
      };
    }

    const weekend = isWeekend(entryDate);
    const holiday = isHoliday(entryDate);
    const rawHours = rawHoursForEntry(timeIn, timeOut);
    // Holiday double-time: employees working on a recognized holiday are
    // paid 2x, so we store 2x the hours directly in hours_worked so
    // payroll reads the correct payable amount without any multiplier.
    const computedHours = holiday ? rawHours * 2 : rawHours;

    const row = {
      employee_id: targetEmployeeId,
      company_id: companyId,
      entry_date: entryDate,
      job_location_id: jobLocationId || null,
      foreman_id: finalForemanId,
      activity_description: activityDescription || null,
      time_in: timeIn,
      time_out: timeOut,
      hours_worked: computedHours,
      hours_type: hoursType || 'regular',
      is_weekend: weekend,
      is_holiday: holiday,
      status: 'draft',
    };

    const { data, error } = await supabase
      .from('time_entries')
      .insert(row)
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 201, body: JSON.stringify({ entry: data }) };
  }

  // ---------------- PUT: edit an existing segment ----------------
  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { entryId, companyId, jobLocationId, activityDescription, timeIn, timeOut, foremanId, entryDate } = body;
    if (!entryId) return { statusCode: 400, body: JSON.stringify({ error: 'entryId is required' }) };
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const { data: existing, error: fetchError } = await supabase
      .from('time_entries')
      .select('*')
      .eq('id', entryId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Entry not found' }) };
    if (existing.company_id !== companyId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This entry does not belong to the specified company' }) };
    }

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (existing.employee_id !== auth.employeeId && myRole.role !== 'admin') {
      return forbidden('You do not have permission to edit this employee\'s hours');
    }

    if (existing.hours_type === 'pto') {
      return forbidden('This is a PTO entry created from an approved PTO request. Cancel or adjust it through PTO management, not the regular hours form.');
    }

    // Employees can edit draft and foreman_approved entries (not yet fully
    // approved) - allows correcting a wrong day even after a foreman has
    // seen it, since the corrected entry goes back to draft for re-approval.
    // Admin can always edit regardless of status.
    if (existing.status === 'admin_approved' && myRole.role !== 'admin') {
      return forbidden('This entry has been fully approved. Ask an admin to make changes.');
    }

    const finalTimeIn = timeIn !== undefined ? timeIn : existing.time_in;
    const finalTimeOut = timeOut !== undefined ? timeOut : existing.time_out;
    const finalEntryDate = entryDate !== undefined ? entryDate : existing.entry_date;

    if (!finalTimeIn || !finalTimeOut) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Both timeIn and timeOut are required' }) };
    }

    // Overlap check must use the FINAL date, not the original - if the
    // employee is moving this segment to a different day, we need to check
    // for conflicts on that new day, not the day it used to be on.
    const overlapResult = await checkForOverlap(existing.employee_id, companyId, finalEntryDate, finalTimeIn, finalTimeOut, entryId);
    if (overlapResult && overlapResult.error) return errorResponse(overlapResult.error);
    if (overlapResult && overlapResult.overlap) {
      const o = overlapResult.overlap;
      const siteName = o.job_locations?.name ? ` at ${o.job_locations.name}` : '';
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: `This overlaps with an existing entry${siteName} on ${o.entry_date} from ${o.time_in.slice(0,5)} to ${o.time_out.slice(0,5)}. Adjust the times or edit/remove that entry first.`,
        }),
      };
    }

    let finalForemanId = existing.foreman_id;
    if (foremanId !== undefined) {
      if (foremanId) {
        const validChoice = await isValidForemanChoice(foremanId, companyId);
        if (!validChoice) {
          return { statusCode: 400, body: JSON.stringify({ error: 'The selected foreman is not a valid foreman or admin at this company' }) };
        }
      }
      finalForemanId = foremanId || null;
    }

    // Recompute is_weekend and is_holiday if the date changed, since
    // moving a segment from a weekday to a weekend (or onto a holiday)
    // changes how the hours are classified for overtime purposes.
    let finalIsWeekend = existing.is_weekend;
    let finalIsHoliday = existing.is_holiday;
    if (finalEntryDate !== existing.entry_date) {
      finalIsWeekend = isWeekend(finalEntryDate);
      finalIsHoliday = isHoliday(finalEntryDate);
    }

    const rawHours = rawHoursForEntry(finalTimeIn, finalTimeOut);
    // Holiday double-time: store 2x hours so payroll reads correct amount
    const computedHours = finalIsHoliday ? rawHours * 2 : rawHours;

    const updateRow = {
      entry_date: finalEntryDate,
      job_location_id: jobLocationId !== undefined ? jobLocationId : existing.job_location_id,
      foreman_id: finalForemanId,
      activity_description: activityDescription !== undefined ? activityDescription : existing.activity_description,
      time_in: finalTimeIn,
      time_out: finalTimeOut,
      hours_worked: computedHours,
      is_weekend: finalIsWeekend,
      is_holiday: finalIsHoliday,
      status: myRole.role === 'admin' ? existing.status : 'draft', // non-admin edits reset to draft for re-approval
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('time_entries')
      .update(updateRow)
      .eq('id', entryId)
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ entry: data }) };
  }

  // ---------------- DELETE: remove a segment ----------------
  if (event.httpMethod === 'DELETE') {
    const params = event.queryStringParameters || {};
    const { entryId, companyId } = params;
    if (!entryId) return { statusCode: 400, body: JSON.stringify({ error: 'entryId is required' }) };
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const { data: existing, error: fetchError } = await supabase
      .from('time_entries')
      .select('employee_id, company_id, status, hours_type')
      .eq('id', entryId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Entry not found' }) };
    if (existing.company_id !== companyId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This entry does not belong to the specified company' }) };
    }

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (existing.employee_id !== auth.employeeId && myRole.role !== 'admin') {
      return forbidden('You do not have permission to delete this employee\'s hours');
    }

    if (existing.hours_type === 'pto') {
      return forbidden('This is a PTO entry created from an approved PTO request. Cancel it through PTO management, not here.');
    }

    if (existing.status !== 'draft' && existing.status !== 'rejected' && myRole.role !== 'admin') {
      return forbidden('This day has already been approved. Ask an admin to make changes.');
    }

    const { error } = await supabase.from('time_entries').delete().eq('id', entryId);
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
