const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');
const { sendSms } = require('./_sms');

function todayEtStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// Logs a schedule change event, determines whether it's a same-day
// change, and (if so) attempts an SMS. Every change gets a log row
// regardless of same-day status, since that row is also what powers the
// in-app "your schedule changed, please acknowledge" prompt for any
// future change, not just same-day ones.
async function logScheduleChange({ employeeId, companyId, scheduledDate, changeType, oldJobLocationId, newJobLocationId, oldNote, newNote, changedBy }) {
  const isSameDay = scheduledDate === todayEtStr();

  const { data: logRow, error: logError } = await supabase
    .from('schedule_change_log')
    .insert({
      employee_id: employeeId,
      company_id: companyId,
      scheduled_date: scheduledDate,
      change_type: changeType,
      old_job_location_id: oldJobLocationId || null,
      new_job_location_id: newJobLocationId || null,
      old_note: oldNote || null,
      new_note: newNote || null,
      changed_by: changedBy,
      is_same_day_change: isSameDay,
    })
    .select()
    .single();

  if (logError) return { error: logError };

  if (isSameDay) {
    const { data: employee } = await supabase
      .from('employees')
      .select('first_name, phone')
      .eq('id', employeeId)
      .maybeSingle();

    if (employee && employee.phone) {
      let locationName = null;
      if (newJobLocationId) {
        const { data: loc } = await supabase.from('job_locations').select('name').eq('id', newJobLocationId).maybeSingle();
        locationName = loc ? loc.name : null;
      }

      const changeDescription = changeType === 'deleted'
        ? 'has been removed'
        : locationName
          ? `is now ${locationName}`
          : 'has changed';

      const message = `Schedule update: your assignment for today ${changeDescription}. Check the app for details.`;
      const smsResult = await sendSms(employee.phone, message);

      await supabase
        .from('schedule_change_log')
        .update({ sms_status: smsResult.status })
        .eq('id', logRow.id);
    } else {
      await supabase
        .from('schedule_change_log')
        .update({ sms_status: 'skipped_no_phone' })
        .eq('id', logRow.id);
    }
  }

  return { logRow };
}

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  // ---------------- GET: view schedule entries, or pending unacknowledged changes ----------------
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const companyId = params.companyId;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (params.pendingChanges === 'true') {
      // Unacknowledged change notifications for the calling employee only
      // - this is always scoped to the caller, regardless of role, since
      // it represents "things I personally haven't confirmed seeing yet."
      const { data, error } = await supabase
        .from('schedule_change_log')
        .select('id, scheduled_date, change_type, is_same_day_change, new_job_location_id, job_locations!schedule_change_log_new_job_location_id_fkey(name)')
        .eq('employee_id', auth.employeeId)
        .eq('company_id', companyId)
        .is('acknowledged_at', null)
        .order('created_at', { ascending: false });

      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ pendingChanges: data }) };
    }

    const targetEmployeeId = params.employeeId || auth.employeeId;
    if (targetEmployeeId !== auth.employeeId && myRole.role === 'employee') {
      return forbidden('You can only view your own schedule');
    }

    let query = supabase
      .from('schedule_entries')
      .select('id, employee_id, scheduled_date, job_location_id, note, deviation_reason, job_locations(name)')
      .eq('company_id', companyId)
      .order('scheduled_date', { ascending: true });

    if (params.startDate) query = query.gte('scheduled_date', params.startDate);
    if (params.endDate) query = query.lte('scheduled_date', params.endDate);

    if (params.employeeId) {
      query = query.eq('employee_id', targetEmployeeId);
    } else if (myRole.role === 'employee') {
      query = query.eq('employee_id', auth.employeeId);
    }
    // foreman/admin with no employeeId filter sees everyone's schedule at this company

    const { data, error } = await query;
    if (error) return errorResponse(error);

    // For foreman/admin viewing the full company schedule, also include
    // pending leave requests that overlap the requested date range, so
    // the grid can show amber warning indicators without a second fetch.
    // Employees viewing their own schedule don't need this.
    let pendingLeave = [];
    if ((myRole.role === 'foreman' || myRole.role === 'admin') && params.startDate && params.endDate) {
      const { data: leaveData } = await supabase
        .from('pto_requests')
        .select('id, employee_id, start_date, end_date, hours_per_day')
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .lte('start_date', params.endDate)
        .gte('end_date', params.startDate);
      pendingLeave = leaveData || [];
    }

    return { statusCode: 200, body: JSON.stringify({ entries: data, pendingLeave }) };
  }

  // ---------------- POST: create a schedule entry (assignment) ----------------
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, employeeId, scheduledDate, jobLocationId, note } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!employeeId) return { statusCode: 400, body: JSON.stringify({ error: 'employeeId is required' }) };
    if (!scheduledDate) return { statusCode: 400, body: JSON.stringify({ error: 'scheduledDate is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role === 'employee') {
      return forbidden('Only a foreman or admin can assign a schedule');
    }

    const targetRole = await resolveCompanyRole(employeeId, companyId, false);
    if (!targetRole) {
      return { statusCode: 400, body: JSON.stringify({ error: 'That employee does not belong to this company' }) };
    }

    // Check for approved leave on this date before saving the assignment,
    // so the foreman is warned rather than accidentally scheduling someone
    // who has already-approved time off. Uses a confirmOverride flag so
    // the foreman can still save if they genuinely intend to (e.g. the
    // leave was approved in error and hasn't been revoked yet).
    if (!body.confirmOverride) {
      const { data: leaveConflict } = await supabase
        .from('time_entries')
        .select('entry_date, hours_worked')
        .eq('employee_id', employeeId)
        .eq('company_id', companyId)
        .eq('entry_date', scheduledDate)
        .eq('hours_type', 'pto')
        .eq('status', 'admin_approved')
        .maybeSingle();

      if (leaveConflict) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            leaveConflict: true,
            message: `This employee has approved leave on ${scheduledDate}.`,
          }),
        };
      }
    }

    if (jobLocationId) {
      const { data: locCheck } = await supabase
        .from('job_locations')
        .select('company_id')
        .eq('id', jobLocationId)
        .maybeSingle();
      if (!locCheck || locCheck.company_id !== companyId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'That job location does not belong to this company' }) };
      }
    }

    const { data, error } = await supabase
      .from('schedule_entries')
      .insert({
        employee_id: employeeId,
        company_id: companyId,
        scheduled_date: scheduledDate,
        job_location_id: jobLocationId || null,
        note: note || null,
        created_by: auth.employeeId,
      })
      .select('id, employee_id, scheduled_date, job_location_id, note, job_locations(name)')
      .single();

    if (error) return errorResponse(error);

    const logResult = await logScheduleChange({
      employeeId, companyId, scheduledDate,
      changeType: 'created',
      newJobLocationId: jobLocationId,
      newNote: note,
      changedBy: auth.employeeId,
    });
    if (logResult.error) console.error('Failed to log schedule change:', logResult.error);

    return { statusCode: 201, body: JSON.stringify({ entry: data }) };
  }

  // ---------------- PUT: edit an existing schedule entry ----------------
  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { entryId, companyId, jobLocationId, note } = body;
    if (!entryId) return { statusCode: 400, body: JSON.stringify({ error: 'entryId is required' }) };
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role === 'employee') {
      return forbidden('Only a foreman or admin can edit a schedule entry');
    }

    const { data: existing, error: fetchError } = await supabase
      .from('schedule_entries')
      .select('*')
      .eq('id', entryId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Schedule entry not found' }) };
    if (existing.company_id !== companyId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This entry does not belong to the specified company' }) };
    }

    if (jobLocationId) {
      const { data: locCheck } = await supabase
        .from('job_locations')
        .select('company_id')
        .eq('id', jobLocationId)
        .maybeSingle();
      if (!locCheck || locCheck.company_id !== companyId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'That job location does not belong to this company' }) };
      }
    }

    const finalJobLocationId = jobLocationId !== undefined ? jobLocationId : existing.job_location_id;
    const finalNote = note !== undefined ? note : existing.note;

    const { data, error } = await supabase
      .from('schedule_entries')
      .update({
        job_location_id: finalJobLocationId || null,
        note: finalNote || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entryId)
      .select('id, employee_id, scheduled_date, job_location_id, note, job_locations(name)')
      .single();

    if (error) return errorResponse(error);

    const logResult = await logScheduleChange({
      employeeId: existing.employee_id, companyId, scheduledDate: existing.scheduled_date,
      changeType: 'updated',
      oldJobLocationId: existing.job_location_id,
      newJobLocationId: finalJobLocationId,
      oldNote: existing.note,
      newNote: finalNote,
      changedBy: auth.employeeId,
    });
    if (logResult.error) console.error('Failed to log schedule change:', logResult.error);

    return { statusCode: 200, body: JSON.stringify({ entry: data }) };
  }

  // ---------------- DELETE: remove a schedule entry ----------------
  if (event.httpMethod === 'DELETE') {
    const params = event.queryStringParameters || {};
    const { entryId, companyId } = params;
    if (!entryId) return { statusCode: 400, body: JSON.stringify({ error: 'entryId is required' }) };
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role === 'employee') {
      return forbidden('Only a foreman or admin can remove a schedule entry');
    }

    const { data: existing, error: fetchError } = await supabase
      .from('schedule_entries')
      .select('*')
      .eq('id', entryId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Schedule entry not found' }) };
    if (existing.company_id !== companyId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This entry does not belong to the specified company' }) };
    }

    const { error } = await supabase.from('schedule_entries').delete().eq('id', entryId);
    if (error) return errorResponse(error);

    const logResult = await logScheduleChange({
      employeeId: existing.employee_id, companyId, scheduledDate: existing.scheduled_date,
      changeType: 'deleted',
      oldJobLocationId: existing.job_location_id,
      oldNote: existing.note,
      changedBy: auth.employeeId,
    });
    if (logResult.error) console.error('Failed to log schedule change:', logResult.error);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ---------------- PATCH: record a deviation reason ----------------
  // Called when an employee logs time at a different location than they
  // were scheduled - stores their explanation on the schedule_entries row
  // so foreman/admin can see it when reviewing. Only the employee the
  // entry belongs to can submit this - not a foreman on their behalf.
  if (event.httpMethod === 'PATCH') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, scheduleEntryId, deviationReason } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!scheduleEntryId) return { statusCode: 400, body: JSON.stringify({ error: 'scheduleEntryId is required' }) };
    if (!deviationReason || !deviationReason.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A reason is required' }) };
    }

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    const { data: entry, error: fetchError } = await supabase
      .from('schedule_entries')
      .select('employee_id, company_id')
      .eq('id', scheduleEntryId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);
    if (!entry) return { statusCode: 404, body: JSON.stringify({ error: 'Schedule entry not found' }) };
    if (entry.company_id !== companyId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This entry does not belong to the specified company' }) };
    }
    if (entry.employee_id !== auth.employeeId && myRole.role !== 'admin') {
      return forbidden('You can only submit a deviation reason for your own schedule entries');
    }

    const { error } = await supabase
      .from('schedule_entries')
      .update({ deviation_reason: deviationReason.trim(), updated_at: new Date().toISOString() })
      .eq('id', scheduleEntryId);

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
