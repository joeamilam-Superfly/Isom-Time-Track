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
        id, wo_number, date_received, scheduled_date, status, details,
        completed_at, created_at, updated_at,
        job_locations(id, name),
        employees!work_orders_assigned_to_id_fkey(id, first_name, last_name),
        completed_by:employees!work_orders_completed_by_id_fkey(id, first_name, last_name)
      `)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    // Employees only see WOs assigned to them.
    // Foremen and admins see all company WOs so the scheduling grid
    // correctly shows work orders assigned to any team member.
    if (myRole.role === 'employee') {
      query = query.eq('assigned_to_id', auth.employeeId);
    }

    if (params.status === 'open') query = query.in('status', ['open', 'submitted']);
    else if (params.status) query = query.eq('status', params.status);
    if (params.includeCompleted === 'true') query = query.in('status', ['open', 'submitted', 'ready_to_bill', 'billed']);
    if (params.locationId) query = query.eq('job_location_id', params.locationId);
    if (params.woNumber) query = query.eq('wo_number', params.woNumber);

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

    const workOrders = (data || []).map(w => ({
      id: w.id,
      woNumber: w.wo_number,
      dateReceived: w.date_received,
      scheduledDate: w.scheduled_date,
      details: w.details || null,
      status: w.status,
      completedAt: w.completed_at,
      createdAt: w.created_at,
      jobLocation: w.job_locations ? { id: w.job_locations.id, name: w.job_locations.name } : null,
      assignedTo: w.employees ? { id: w.employees.id, name: `${w.employees.first_name} ${w.employees.last_name}` } : null,
      completedBy: w.completed_by ? { id: w.completed_by.id, name: `${w.completed_by.first_name} ${w.completed_by.last_name}` } : null,
      currentPhoto: (photoMap[w.id] || []).find(p => p.isCurrent) || null,
      allPhotos: photoMap[w.id] || [],
      timeEntries: woTimeMap[w.id] || [],
      totalHours: (woTimeMap[w.id] || []).reduce((sum, e) => sum + e.hoursWorked, 0),
    }));

    return { statusCode: 200, body: JSON.stringify({ workOrders }) };
  }

  // ---- POST: create a new work order ----
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, jobLocationId, woNumber, dateReceived, scheduledDate, assignedToId, imageBase64, mimeType, details } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!woNumber) return { statusCode: 400, body: JSON.stringify({ error: 'Work order number is required' }) };
    if (!dateReceived) return { statusCode: 400, body: JSON.stringify({ error: 'Date received is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');
    if (myRole.role === 'employee') return forbidden('Only foremen and admins can create work orders');

    // Create the work order record
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
      const { jobLocationId, scheduledDate: newScheduledDate, assignedToId: newAssignedToId, details: newDetails, woNumber: newWoNumber } = body;
      const updateFields = { updated_at: new Date().toISOString() };
      if (newWoNumber !== undefined && newWoNumber.trim()) updateFields.wo_number = newWoNumber.trim();
      if (newScheduledDate !== undefined) updateFields.scheduled_date = newScheduledDate || null;
      if (jobLocationId !== undefined) updateFields.job_location_id = jobLocationId || null;
      if (newAssignedToId !== undefined) updateFields.assigned_to_id = newAssignedToId || null;
      if (newDetails !== undefined) updateFields.details = newDetails || null;
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
      const { error } = await supabase
        .from('work_orders')
        .update({ status: 'ready_to_bill', completed_at: now, completed_by_id: auth.employeeId, updated_at: now })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true, readyToBill: true }) };
    }

    // ---- mark billed (admin only) ----
    if (action === 'bill') {
      if (myRole.role !== 'admin') return forbidden('Only admins can mark a work order as billed');
      const { error } = await supabase
        .from('work_orders')
        .update({ status: 'billed', updated_at: new Date().toISOString() })
        .eq('id', workOrderId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
