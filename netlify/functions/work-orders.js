const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

const WO_BUCKET = 'job-site-photos'; // reuse existing private bucket

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  // ---- GET: list work orders ----
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const companyId = params.companyId;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    let query = supabase
      .from('work_orders')
      .select(`
        id, wo_number, date_received, scheduled_date, status, details, invoice_number,
        is_estimate, linked_wo_number,
        queue_visible, self_assigned_at, completed_at, created_at, updated_at,
        job_locations(id, name),
        employees!work_orders_assigned_to_id_fkey(id, first_name, last_name),
        completed_by:employees!work_orders_completed_by_id_fkey(id, first_name, last_name)
      `)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    // Queue mode: return unassigned queue-visible WOs for eligible employees
    if (params.queue === 'true') {
      const { data: eligRow } = await supabase
        .from('employee_company_roles')
        .select('queue_eligible')
        .eq('employee_id', auth.employeeId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (!eligRow?.queue_eligible && myRole.role === 'employee') {
        return { statusCode: 200, body: JSON.stringify({ workOrders: [] }) };
      }
      // Queue mode: return ALL unassigned open WOs — no queue_visible gate needed
      // Exclude WOs that have crew members assigned (they're not truly unassigned)
      query = query.is('assigned_to_id', null).in('status', ['open']);
      // Filter out crew-assigned WOs after fetch (crew check requires separate query)
    } else if (myRole.role === 'employee') {
      // Employees see WOs assigned to them directly OR where they are crew members
      const { data: crewWos } = await supabase
        .from('work_order_assignments')
        .select('work_order_id')
        .eq('employee_id', auth.employeeId)
        .eq('company_id', companyId);
      const crewWoIds = (crewWos || []).map(r => r.work_order_id);
      if (crewWoIds.length > 0) {
        query = query.or(`assigned_to_id.eq.${auth.employeeId},id.in.(${crewWoIds.join(',')})`);
      } else {
        query = query.eq('assigned_to_id', auth.employeeId);
      }
    }

    if (params.status === 'open') query = query.in('status', ['open', 'submitted']);
    else if (params.status === 'billed') query = query.in('status', ['billed', 'cancelled']);
    else if (params.status) query = query.eq('status', params.status);
    if (params.includeCompleted === 'true') query = query.in('status', ['open', 'submitted', 'ready_to_bill', 'billed']);
    if (params.locationId) query = query.eq('job_location_id', params.locationId);
    if (params.woNumber) query = query.eq('wo_number', params.woNumber);
    // Search: match WO number OR invoice number (partial, case-insensitive)
    if (params.search) {
      query = query.or(`wo_number.ilike.%${params.search}%,invoice_number.ilike.%${params.search}%`);
    }

    const { data, error } = await query;
    if (error) return errorResponse(error);

    // Fetch ALL photos per WO (current + historical) for display in detail view
    const woIds = (data || []).map(w => w.id);
    let photoMap = {};
    if (woIds.length > 0) {
      const { data: photos } = await supabase
        .from('work_order_photos')
        .select('work_order_id, storage_path, is_current, uploaded_at')
        .in('work_order_id', woIds)
        .order('uploaded_at', { ascending: false });

      const withUrls = await Promise.all((photos || []).map(async p => {
        const { data: signed } = await supabase.storage
          .from(WO_BUCKET)
          .createSignedUrl(p.storage_path, 60 * 30);
        return {
          workOrderId: p.work_order_id,
          url: signed?.signedUrl || null,
          isCurrent: p.is_current,
          uploadedAt: p.uploaded_at,
        };
      }));

      for (const p of withUrls) {
        if (!photoMap[p.workOrderId]) photoMap[p.workOrderId] = [];
        photoMap[p.workOrderId].push(p);
      }
    }

    // Fetch time entries associated with each WO
    let woTimeMap = {};
    if (woIds.length > 0) {
      const { data: woEntries } = await supabase
        .from('time_entries')
        .select('id, work_order_id, employee_id, entry_date, time_in, time_out, hours_worked, activity_description, status, employees!time_entries_employee_id_fkey(first_name, last_name)')
        .in('work_order_id', woIds)
        .order('entry_date', { ascending: true });
      for (const e of woEntries || []) {
        if (!woTimeMap[e.work_order_id]) woTimeMap[e.work_order_id] = [];
        woTimeMap[e.work_order_id].push({
          id: e.id,
          employeeName: e.employees ? `${e.employees.first_name} ${e.employees.last_name}` : 'Unknown',
          date: e.entry_date,
          timeIn: e.time_in,
          timeOut: e.time_out,
          hoursWorked: Number(e.hours_worked),
          activityDescription: e.activity_description,
          status: e.status,
        });
      }
    }

    // Fetch display colors for all assigned employees separately to avoid ambiguous join
    const assignedEmpIds = [...new Set((data || []).map(w => w.assigned_to_id).filter(Boolean))];
    let colorMap = {};
    if (assignedEmpIds.length > 0) {
      const { data: colorRows } = await supabase
        .from('employee_company_roles')
        .select('employee_id, display_color')
        .eq('company_id', companyId)
        .in('employee_id', assignedEmpIds);
      for (const r of colorRows || []) {
        colorMap[r.employee_id] = r.display_color || null;
      }
    }

    // Fetch crew assignments for each WO
    let assignmentsMap = {};
    if (woIds.length > 0) {
      const { data: assignments } = await supabase
        .from('work_order_assignments')
        .select('work_order_id, employee_id, employees!work_order_assignments_employee_id_fkey(id, first_name, last_name)')
        .in('work_order_id', woIds);
      for (const a of assignments || []) {
        if (!assignmentsMap[a.work_order_id]) assignmentsMap[a.work_order_id] = [];
        if (a.employees) {
          assignmentsMap[a.work_order_id].push({
            id: a.employees.id,
            name: `${a.employees.first_name} ${a.employees.last_name}`,
          });
        }
      }
    }

    let workOrders = (data || []).map(w => ({
      id: w.id,
      woNumber: w.wo_number,
      dateReceived: w.date_received,
      scheduledDate: w.scheduled_date,
      details: w.details || null,
      status: w.status,
      completedAt: w.completed_at,
      createdAt: w.created_at,
      jobLocation: w.job_locations ? { id: w.job_locations.id, name: w.job_locations.name } : null,
      assignedTo: w.employees ? {
        id: w.employees.id,
        name: `${w.employees.first_name} ${w.employees.last_name}`,
        displayColor: colorMap[w.employees.id] || null,
      } : null,
      crew: assignmentsMap[w.id] || [],
      completedBy: w.completed_by ? { id: w.completed_by.id, name: `${w.completed_by.first_name} ${w.completed_by.last_name}` } : null,
      queueVisible: w.queue_visible || false,
      selfAssignedAt: w.self_assigned_at || null,
      isEstimate: w.is_estimate || false,
      linkedWoNumber: w.linked_wo_number || null,
      invoiceNumber: w.invoice_number || null,
      currentPhoto: (photoMap[w.id] || []).find(p => p.isCurrent) || null,
      allPhotos: photoMap[w.id] || [],
      timeEntries: woTimeMap[w.id] || [],
      totalHours: (woTimeMap[w.id] || []).reduce((sum, e) => sum + e.hoursWorked, 0),
    }));

    // For queue mode: exclude WOs that have crew members — they are not truly unassigned
    if (params.queue === 'true') {
      workOrders = workOrders.filter(w => w.crew.length === 0);
    }

    return { statusCode: 200, body: JSON.stringify({ workOrders }) };
  }

  // ---- POST: create a new work order ----
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, jobLocationId, woNumber, dateReceived, scheduledDate, assignedToId, imageBase64, mimeType, details, isEstimate, linkedWoNumber } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!woNumber) return { statusCode: 400, body: JSON.stringify({ error: 'Work order number is required' }) };
    if (!dateReceived) return { statusCode: 400, body: JSON.stringify({ error: 'Date received is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');
    if (myRole.role === 'employee') return forbidden('Only foremen and admins can create work orders');

    const { data: wo, error: woError } = await supabase
      .from('work_orders')
      .insert({
        company_id: companyId,
        job_location_id: jobLocationId || null,
        wo_number: woNumber.trim(),
        date_received: dateReceived,
        scheduled_date: scheduledDate || null,
        assigned_to_id: assignedToId || null,
        details: details || null,
        is_estimate: !!isEstimate,
        linked_wo_number: linkedWoNumber || null,
        status: 'open',
        created_by_id: auth.employeeId,
      })
      .select()
      .single();

    if (woError) return errorResponse(woError);

    // Upload the photo if provided
    if (imageBase64 && mimeType) {
      const buffer = Buffer.from(imageBase64, 'base64');
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const storagePath = `work-orders/${companyId}/${wo.id}/${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(WO_BUCKET)
        .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

      if (!uploadError) {
        await supabase.from('work_order_photos').insert({
          work_order_id: wo.id,
          company_id: companyId,
          storage_path: storagePath,
          is_current: true,
          uploaded_by_id: auth.employeeId,
        });
      }
    }

    return { statusCode: 201, body: JSON.stringify({ workOrder: wo }) };
  }

  // ---- PATCH: update a work order (reassign, new photo, mark complete, mark billed) ----
  if (event.httpMethod === 'PATCH') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, workOrderId, action, assignedToId, scheduledDate, imageBase64, mimeType } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!workOrderId) return { statusCode: 400, body: JSON.stringify({ error: 'workOrderId is required' }) };
    if (!action) return { statusCode: 400, body: JSON.stringify({ error: 'action is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    // ---- check_conflicts runs before WO fetch — doesn't need a valid workOrderId ----
    if (action === 'check_conflicts') {
      const { employeeId: checkEmpId, scheduledDate: checkDate } = body;
      if (!checkEmpId || !checkDate) return { statusCode: 200, body: JSON.stringify({ conflicts: [] }) };
      // Get assigned employee's foreman contact for conflict warnings
      const { data: empRole } = await supabase
        .from('employee_company_roles')
        .select('foreman_id, employees!employee_company_roles_foreman_id_fkey(first_name, last_name, phone)')
        .eq('employee_id', checkEmpId)
        .eq('company_id', companyId)
        .maybeSingle();

      const foremanName = empRole?.employees ? `${empRole.employees.first_name} ${empRole.employees.last_name}` : null;
      const foremanPhone = empRole?.employees?.phone || null;

      const conflicts = [];
      const { data: schedEntries } = await supabase
        .from('schedule_entries')
        .select('scheduled_date, job_locations(name)')
        .eq('company_id', companyId)
        .eq('employee_id', checkEmpId)
        .eq('scheduled_date', checkDate);
      for (const entry of schedEntries || []) {
        const locName = entry.job_locations?.name?.toUpperCase();
        if (locName === 'OFF') conflicts.push({ type: 'scheduled_off', message: 'This employee is scheduled OFF on this date', foremanName, foremanPhone });
        else if (locName) conflicts.push({ type: 'scheduled_elsewhere', message: `This employee is already scheduled at ${entry.job_locations.name} on this date`, foremanName, foremanPhone });
      }
      const { data: leaveRequests } = await supabase
        .from('pto_requests')
        .select('start_date, end_date, status')
        .eq('employee_id', checkEmpId)
        .in('status', ['pending', 'approved'])
        .lte('start_date', checkDate)
        .gte('end_date', checkDate);
      for (const req of leaveRequests || []) {
        conflicts.push({ type: 'leave_request', message: `This employee has a ${req.status === 'pending' ? 'pending' : 'approved'} leave request covering this date`, foremanName, foremanPhone });
      }
      return { statusCode: 200, body: JSON.stringify({ conflicts }) };
    }

    const { data: wo, error: fetchError } = await supabase
      .from('work_orders')
      .select('*')
      .eq('id', workOrderId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);
    if (!wo) return { statusCode: 404, body: JSON.stringify({ error: 'Work order not found' }) };

    // ---- update details (scheduled date, location, assignment, notes) ----
    if (action === 'update_details') {
      if (myRole.role === 'employee') return forbidden('Only foremen and admins can update work orders');
      const { jobLocationId, scheduledDate: newScheduledDate, assignedToId: newAssignedToId, details: newDetails, woNumber: newWoNumber, isEstimate: newIsEstimate, linkedWoNumber: newLinkedWoNumber } = body;
      const updateFields = { updated_at: new Date().toISOString() };
      if (newWoNumber !== undefined && newWoNumber.trim()) updateFields.wo_number = newWoNumber.trim();
      if (newScheduledDate !== undefined) updateFields.scheduled_date = newScheduledDate || null;
      if (jobLocationId !== undefined) updateFields.job_location_id = jobLocationId || null;
      if (newAssignedToId !== undefined) updateFields.assigned_to_id = newAssignedToId || null;
      if (newDetails !== undefined) updateFields.details = newDetails || null;
      if (newIsEstimate !== undefined) updateFields.is_estimate = !!newIsEstimate;
      if (newLinkedWoNumber !== undefined) updateFields.linked_wo_number = newLinkedWoNumber || null;
      // If converting to estimate and currently ready_to_bill, reopen it
      // so the tech can properly mark it complete through the normal flow
      if (newIsEstimate && wo.status === 'ready_to_bill') {
        updateFields.status = 'open';
        updateFields.completed_at = null;
        updateFields.completed_by_id = null;
      }
      const { error } = await supabase.from('work_orders').update(updateFields).eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ---- reassign ----
    if (action === 'reassign') {
      if (myRole.role === 'employee') return forbidden('Only foremen and admins can reassign work orders');
      const { error } = await supabase
        .from('work_orders')
        .update({ assigned_to_id: assignedToId || null, updated_at: new Date().toISOString() })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ---- update scheduled date ----
    if (action === 'schedule') {
      if (myRole.role === 'employee') return forbidden('Only foremen and admins can update the scheduled date');
      const { error } = await supabase
        .from('work_orders')
        .update({ scheduled_date: scheduledDate || null, updated_at: new Date().toISOString() })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ---- add new photo (keeps history, marks old as not current) ----
    if (action === 'update_photo') {
      if (!imageBase64 || !mimeType) return { statusCode: 400, body: JSON.stringify({ error: 'imageBase64 and mimeType are required' }) };

      // Mark all existing photos for this WO as not current
      await supabase
        .from('work_order_photos')
        .update({ is_current: false })
        .eq('work_order_id', workOrderId);

      const buffer = Buffer.from(imageBase64, 'base64');
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const storagePath = `work-orders/${companyId}/${workOrderId}/${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(WO_BUCKET)
        .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

      if (uploadError) return errorResponse(uploadError);

      await supabase.from('work_order_photos').insert({
        work_order_id: workOrderId,
        company_id: companyId,
        storage_path: storagePath,
        is_current: true,
        uploaded_by_id: auth.employeeId,
      });

      await supabase.from('work_orders')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', workOrderId);

      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }



    // ---- grab from queue (employee self-assigns) ----
    if (action === 'grab') {
      if (wo.assigned_to_id) return { statusCode: 409, body: JSON.stringify({ error: 'This work order was just grabbed by someone else.' }) };
      const { error } = await supabase.from('work_orders')
        .update({ assigned_to_id: auth.employeeId, self_assigned_at: new Date().toISOString(), queue_visible: false, updated_at: new Date().toISOString() })
        .eq('id', workOrderId).is('assigned_to_id', null);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ---- return to queue (manual) ----
    if (action === 'return_to_queue') {
      if (myRole.role === 'employee' && wo.assigned_to_id !== auth.employeeId) {
        return forbidden('You can only return work orders assigned to you');
      }
      const { error } = await supabase.from('work_orders')
        .update({ assigned_to_id: null, self_assigned_at: null, queue_visible: true, updated_at: new Date().toISOString() })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ---- cancel (admin/foreman only) ----
    if (action === 'cancel') {
      if (myRole.role === 'employee') return forbidden('Only foremen and admins can cancel work orders');
      if (wo.status === 'cancelled') return { statusCode: 409, body: JSON.stringify({ error: 'Work order is already cancelled' }) };
      if (wo.status === 'billed') return { statusCode: 409, body: JSON.stringify({ error: 'Cannot cancel a billed work order' }) };
      const cancellationNote = body.cancellationNote || null;
      const { error } = await supabase.from('work_orders')
        .update({
          status: 'cancelled',
          details: cancellationNote
            ? `${wo.details ? wo.details + '\n\n' : ''}CANCELLED: ${cancellationNote}`
            : wo.details,
          updated_at: new Date().toISOString(),
        })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ---- reopen (foreman/admin only) ----
    if (action === 'reopen') {
      if (myRole.role === 'employee') return forbidden('Only foremen and admins can reopen work orders');
      const { data: current } = await supabase.from('work_orders').select('status, invoice_number, is_estimate').eq('id', workOrderId).single();
      if (!current) return { statusCode: 404, body: JSON.stringify({ error: 'Work order not found' }) };
      // Block reopening billed WOs that have an invoice — estimates can be reopened from billed since they have no invoice
      if (current.status === 'billed' && !current.is_estimate && current.invoice_number) {
        return { statusCode: 409, body: JSON.stringify({ error: 'Cannot reopen a billed work order — it has already been invoiced' }) };
      }
      if (current.status !== 'ready_to_bill' && current.status !== 'submitted' && current.status !== 'billed' && current.status !== 'cancelled') {
        return { statusCode: 409, body: JSON.stringify({ error: 'Work order is already open' }) };
      }
      const { error } = await supabase
        .from('work_orders')
        .update({ status: 'open', completed_at: null, completed_by_id: null, updated_at: new Date().toISOString() })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ---- update_crew: replace all crew assignments for a WO ----
    if (action === 'update_crew') {
      if (myRole.role === 'employee') return forbidden('Only foremen and admins can assign crew to work orders');
      const { employeeIds } = body; // array of employee UUIDs
      if (!Array.isArray(employeeIds)) return { statusCode: 400, body: JSON.stringify({ error: 'employeeIds must be an array' }) };
      // Delete existing assignments then insert new ones
      await supabase.from('work_order_assignments').delete().eq('work_order_id', workOrderId);
      if (employeeIds.length > 0) {
        const rows = employeeIds.map(empId => ({
          work_order_id: workOrderId,
          employee_id: empId,
          company_id: companyId,
          assigned_by_id: auth.employeeId,
        }));
        const { error } = await supabase.from('work_order_assignments').insert(rows);
        if (error) return errorResponse(error);
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ---- submit for foreman approval (employee action) ----
    if (action === 'submit') {
      if (wo.status !== 'open') {
        return { statusCode: 409, body: JSON.stringify({ error: 'This work order has already been submitted or completed' }) };
      }
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('work_orders')
        .update({ status: 'submitted', updated_at: now })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ---- mark complete — foreman/admin only ----
    if (action === 'complete') {
      if (myRole.role === 'employee') {
        return forbidden('Only a foreman or admin can mark a work order as complete. Contact your foreman to approve it.');
      }
      if (wo.status !== 'open' && wo.status !== 'submitted') {
        return { statusCode: 409, body: JSON.stringify({ error: 'This work order is already completed' }) };
      }
      const now = new Date().toISOString();
      // Estimates skip ready_to_bill — no invoice needed, close directly to billed
      const newStatus = wo.is_estimate ? 'billed' : 'ready_to_bill';
      const { error } = await supabase
        .from('work_orders')
        .update({ status: newStatus, completed_at: now, completed_by_id: auth.employeeId, updated_at: now })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true, readyToBill: !wo.is_estimate, isEstimate: !!wo.is_estimate }) };
    }

    // ---- mark billed (admin only) — requires invoice number ----
    if (action === 'bill') {
      if (myRole.role !== 'admin') return forbidden('Only admins can mark a work order as billed');
      const { invoiceNumber } = body;
      if (!invoiceNumber || !invoiceNumber.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invoice number is required to mark a work order as billed' }) };
      }
      const { error } = await supabase
        .from('work_orders')
        .update({ status: 'billed', invoice_number: invoiceNumber.trim(), updated_at: new Date().toISOString() })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
