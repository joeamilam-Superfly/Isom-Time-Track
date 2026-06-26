const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { isWeekend, findMostRecentSegmentForeman } = require('./_hours-logic');
const { resolveCompanyRole, supabase } = require('./_company-role');

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateRange(startDate, endDate) {
  const dates = [];
  let cur = startDate;
  while (cur <= endDate) {
    dates.push(cur);
    cur = addDaysStr(cur, 1);
  }
  return dates;
}

async function isHoliday(dateStr) {
  const { data } = await supabase
    .from('holidays')
    .select('id')
    .eq('holiday_date', dateStr)
    .eq('active', true)
    .maybeSingle();
  return !!data;
}

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  // ---------------- GET: list requests ----------------
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const companyId = params.companyId;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    const targetEmployeeId = params.employeeId;

    let query = supabase
      .from('pto_requests')
      .select('*, employees!pto_requests_employee_id_fkey(first_name, last_name)')
      .eq('company_id', companyId)
      .order('start_date', { ascending: true });

    if (targetEmployeeId) {
      if (targetEmployeeId !== auth.employeeId && myRole.role === 'employee') {
        return forbidden('You can only view your own PTO requests');
      }
      query = query.eq('employee_id', targetEmployeeId);
    } else if (myRole.role === 'employee') {
      query = query.eq('employee_id', auth.employeeId);
    } else if (myRole.role === 'foreman') {
      const { data: theirs } = await supabase
        .from('employee_company_roles')
        .select('employee_id')
        .eq('company_id', companyId)
        .eq('foreman_id', auth.employeeId);
      const ids = (theirs || []).map(r => r.employee_id);
      ids.push(auth.employeeId);

      // .or() takes a raw PostgREST filter string with no automatic
      // escaping, per Supabase's own docs - validate every value is a
      // genuine UUID before interpolating it, as defense in depth even
      // though these values come from trusted sources (the verified JWT
      // and a prior database query), not direct user text input.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const safeIds = ids.filter(id => UUID_RE.test(id));
      const safeAuthId = UUID_RE.test(auth.employeeId) ? auth.employeeId : null;

      if (safeAuthId && safeIds.length > 0) {
        // A foreman should also see requests directly assigned to them
        // via the locked-in assigned_foreman_id, even for someone who
        // isn't permanently on their crew - this can happen if that
        // employee's most recent segment named this foreman.
        query = query.or(`employee_id.in.(${safeIds.join(',')}),assigned_foreman_id.eq.${safeAuthId}`);
      } else if (safeAuthId) {
        query = query.eq('assigned_foreman_id', safeAuthId);
      } else {
        // employeeId somehow isn't a valid UUID - shouldn't happen given
        // it comes from a verified JWT, but fail closed rather than risk
        // an unsafe query.
        return forbidden('Invalid session - please log in again');
      }
    }
    // admin with no employeeId filter sees everyone at this company

    if (params.status) query = query.eq('status', params.status);

    const { data, error } = await query;
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ requests: data }) };
  }

  // ---------------- POST: submit a new request ----------------
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, startDate, endDate, hoursPerDay, reason } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const targetEmployeeId = body.employeeId || auth.employeeId;
    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (targetEmployeeId !== auth.employeeId && myRole.role !== 'admin') {
      return forbidden('You can only submit PTO requests for yourself');
    }

    if (!startDate || !endDate) {
      return { statusCode: 400, body: JSON.stringify({ error: 'startDate and endDate are required' }) };
    }
    if (endDate < startDate) {
      return { statusCode: 400, body: JSON.stringify({ error: 'endDate cannot be before startDate' }) };
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    if (startDate < todayStr) {
      return { statusCode: 400, body: JSON.stringify({ error: 'PTO requests must be for upcoming dates, not in the past' }) };
    }

    // Determine and lock in the approving foreman now, at submission
    // time: whoever was the foreman on the employee's most recently
    // logged segment, falling back to their default assigned foreman if
    // they have none yet. This does NOT get recalculated later even if
    // the employee logs new segments under a different foreman while
    // this request is still pending.
    const { data: recentSegments } = await supabase
      .from('time_entries')
      .select('entry_date, time_in, foreman_id')
      .eq('employee_id', targetEmployeeId)
      .eq('company_id', companyId)
      .order('entry_date', { ascending: false })
      .limit(5);

    const { data: roleRow } = await supabase
      .from('employee_company_roles')
      .select('foreman_id')
      .eq('employee_id', targetEmployeeId)
      .eq('company_id', companyId)
      .maybeSingle();

    const assignedForemanId = findMostRecentSegmentForeman(recentSegments || [], roleRow ? roleRow.foreman_id : null);

    const { data, error } = await supabase
      .from('pto_requests')
      .insert({
        employee_id: targetEmployeeId,
        company_id: companyId,
        assigned_foreman_id: assignedForemanId,
        start_date: startDate,
        end_date: endDate,
        hours_per_day: hoursPerDay || 8,
        reason: reason || null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 201, body: JSON.stringify({ request: data }) };
  }

  // ---------------- PUT: decide (approve/deny) or cancel ----------------
  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { requestId, action, note } = body;
    if (!requestId || !['approve', 'deny', 'cancel'].includes(action)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'requestId and a valid action are required' }) };
    }

    const { data: req, error: fetchError } = await supabase
      .from('pto_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);
    if (!req) return { statusCode: 404, body: JSON.stringify({ error: 'PTO request not found' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, req.company_id, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (action === 'cancel') {
      if (req.employee_id !== auth.employeeId && myRole.role !== 'admin') {
        return forbidden('You can only cancel your own PTO requests');
      }
      if (req.status !== 'pending') {
        return { statusCode: 409, body: JSON.stringify({ error: 'Only pending requests can be cancelled' }) };
      }
      const { error } = await supabase.from('pto_requests').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', requestId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // approve / deny - the foreman LOCKED IN on this request at
    // submission time, or an admin. Deliberately does not re-check
    // employee_company_roles.foreman_id, since that could have changed
    // (or the employee could have logged segments under someone else)
    // since this request was submitted - the approver for a pending
    // request is fixed once decided, not recalculated live.
    const isAssignedForeman = req.assigned_foreman_id === auth.employeeId;
    if (!isAssignedForeman && myRole.role !== 'admin') {
      return forbidden('Only this request\'s assigned foreman or an admin can decide this request');
    }
    if (req.status !== 'pending') {
      return { statusCode: 409, body: JSON.stringify({ error: 'This request has already been decided' }) };
    }

    if (action === 'deny') {
      const { error } = await supabase
        .from('pto_requests')
        .update({
          status: 'denied',
          decided_by: auth.employeeId,
          decided_at: new Date().toISOString(),
          decision_note: note || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // action === 'approve'
    const allDates = dateRange(req.start_date, req.end_date);
    const ptoDates = [];
    for (const d of allDates) {
      if (isWeekend(d)) continue;
      if (await isHoliday(d)) continue;
      ptoDates.push(d);
    }

    if (ptoDates.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'The requested range contains no working days (all weekends/holidays)' }) };
    }

    const totalHours = ptoDates.length * Number(req.hours_per_day);
    const year = new Date(req.start_date + 'T00:00:00Z').getUTCFullYear();

    const { data: balance } = await supabase
      .from('pto_balances')
      .select('*')
      .eq('employee_id', req.employee_id)
      .eq('year', year)
      .maybeSingle();

    const remaining = balance ? Number(balance.allotment_hours) - Number(balance.used_hours) : 0;
    if (totalHours > remaining) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `This request needs ${totalHours} PTO hours but only ${remaining} remain for ${year}. Adjust the employee's allotment first if this should still be approved.`,
        }),
      };
    }

    const { data: existingEntries } = await supabase
      .from('time_entries')
      .select('id, entry_date, status')
      .eq('employee_id', req.employee_id)
      .eq('company_id', req.company_id)
      .in('entry_date', ptoDates);

    const blockingEntry = (existingEntries || []).find(e => e.status !== 'draft' && e.status !== 'rejected');
    if (blockingEntry) {
      return { statusCode: 409, body: JSON.stringify({ error: `${blockingEntry.entry_date} already has approved hours logged. Resolve that first.` }) };
    }

    // Remove any leftover draft/rejected segments on these dates before
    // inserting the PTO rows. This used to be an upsert keyed on
    // (employee, company, date), but that uniqueness no longer exists at
    // the database level now that multiple work segments per day are
    // allowed - so PTO approval explicitly clears the day first instead.
    const draftIdsToRemove = (existingEntries || []).map(e => e.id);
    if (draftIdsToRemove.length > 0) {
      const { error: deleteError } = await supabase
        .from('time_entries')
        .delete()
        .in('id', draftIdsToRemove);
      if (deleteError) return errorResponse(deleteError);
    }

    const rows = ptoDates.map(d => ({
      employee_id: req.employee_id,
      company_id: req.company_id,
      entry_date: d,
      job_location_id: null,
      activity_description: 'PTO',
      time_in: null,
      time_out: null,
      hours_worked: Number(req.hours_per_day),
      hours_type: 'pto',
      is_weekend: false,
      is_holiday: false,
      status: 'admin_approved', // PTO is single-stage approved; mark fully settled
      foreman_approved_by: auth.employeeId,
      foreman_approved_at: new Date().toISOString(),
      admin_approved_by: auth.employeeId,
      admin_approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    const { error: entriesError } = await supabase
      .from('time_entries')
      .insert(rows);

    if (entriesError) return errorResponse(entriesError);

    const newUsed = (balance ? Number(balance.used_hours) : 0) + totalHours;
    const { error: balanceError } = await supabase
      .from('pto_balances')
      .upsert({
        employee_id: req.employee_id,
        year,
        allotment_hours: balance ? balance.allotment_hours : 0,
        used_hours: newUsed,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'employee_id,year' });

    if (balanceError) return errorResponse(balanceError);

    const { error: reqError } = await supabase
      .from('pto_requests')
      .update({
        status: 'approved',
        decided_by: auth.employeeId,
        decided_at: new Date().toISOString(),
        decision_note: note || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', requestId);

    if (reqError) return errorResponse(reqError);

    return { statusCode: 200, body: JSON.stringify({ ok: true, daysApproved: ptoDates.length, hoursDeducted: totalHours }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
