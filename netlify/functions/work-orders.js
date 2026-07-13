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
        id, wo_number, date_received, scheduled_date, status,
        completed_at, created_at, updated_at,
        job_locations(id, name),
        employees!work_orders_assigned_to_id_fkey(id, first_name, last_name),
        completed_by:employees!work_orders_completed_by_id_fkey(id, first_name, last_name)
      `)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    // Employees and foremen only see WOs assigned to them
    if (myRole.role === 'employee' || myRole.role === 'foreman') {
      query = query.eq('assigned_to_id', auth.employeeId);
    }

    if (params.status) query = query.eq('status', params.status);
    if (params.locationId) query = query.eq('job_location_id', params.locationId);

    const { data, error } = await query;
    if (error) return errorResponse(error);

    // Fetch current photo for each WO and generate signed URLs
    const woIds = (data || []).map(w => w.id);
    let photoMap = {};
    if (woIds.length > 0) {
      const { data: photos } = await supabase
        .from('work_order_photos')
        .select('work_order_id, storage_path, uploaded_at')
        .in('work_order_id', woIds)
        .eq('is_current', true);

      await Promise.all((photos || []).map(async p => {
        const { data: signed } = await supabase.storage
          .from(WO_BUCKET)
          .createSignedUrl(p.storage_path, 60 * 30);
        photoMap[p.work_order_id] = {
          url: signed?.signedUrl || null,
          uploadedAt: p.uploaded_at,
        };
      }));
    }

    const workOrders = (data || []).map(w => ({
      id: w.id,
      woNumber: w.wo_number,
      dateReceived: w.date_received,
      scheduledDate: w.scheduled_date,
      status: w.status,
      completedAt: w.completed_at,
      createdAt: w.created_at,
      jobLocation: w.job_locations ? { id: w.job_locations.id, name: w.job_locations.name } : null,
      assignedTo: w.employees ? { id: w.employees.id, name: `${w.employees.first_name} ${w.employees.last_name}` } : null,
      completedBy: w.completed_by ? { id: w.completed_by.id, name: `${w.completed_by.first_name} ${w.completed_by.last_name}` } : null,
      currentPhoto: photoMap[w.id] || null,
    }));

    return { statusCode: 200, body: JSON.stringify({ workOrders }) };
  }

  // ---- POST: create a new work order ----
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, jobLocationId, woNumber, dateReceived, scheduledDate, assignedToId, imageBase64, mimeType } = body;
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

    // ---- mark complete (tech action - immediately sets ready_to_bill) ----
    if (action === 'complete') {
      // The assigned tech can complete, or a foreman/admin
      if (myRole.role === 'employee' && wo.assigned_to_id !== auth.employeeId) {
        return forbidden('You can only complete work orders assigned to you');
      }
      if (wo.status !== 'open') {
        return { statusCode: 409, body: JSON.stringify({ error: 'This work order is already completed' }) };
      }
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('work_orders')
        .update({
          status: 'ready_to_bill',
          completed_at: now,
          completed_by_id: auth.employeeId,
          updated_at: now,
        })
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
