const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const body = method !== 'GET' ? JSON.parse(event.body || '{}') : {};
  const companyId = params.companyId || body.companyId;
  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId required' }) };

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole) return forbidden('No access to this company');

  // ---- GET: fetch change orders for a home build or single CO ----
  if (method === 'GET') {
    if (params.id) {
      const { data, error } = await supabase
        .from('change_orders')
        .select('*, change_order_materials(*), change_order_labor(*, time_entries(entry_date, hours_worked, employees!time_entries_employee_id_fkey(first_name, last_name)))')
        .eq('id', params.id)
        .eq('company_id', companyId)
        .single();
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ changeOrder: data }) };
    }
    if (params.homeBuildId) {
      const { data, error } = await supabase
        .from('change_orders')
        .select('*, change_order_materials(*), change_order_labor(*, time_entries(entry_date, hours_worked, employees!time_entries_employee_id_fkey(first_name, last_name)))')
        .eq('home_build_id', params.homeBuildId)
        .eq('company_id', companyId)
        .order('co_number', { ascending: true });
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ changeOrders: data || [] }) };
    }
    return { statusCode: 400, body: JSON.stringify({ error: 'homeBuildId or id required' }) };
  }

  // Foremen and admins only for write operations
  if (myRole.role === 'employee') return forbidden('Only foremen and admins can manage change orders');

  // ---- POST: create change order ----
  if (method === 'POST') {
    const { homeBuildId, workOrderId, description, materials } = body;
    if (!homeBuildId) return { statusCode: 400, body: JSON.stringify({ error: 'homeBuildId required' }) };
    if (!workOrderId) return { statusCode: 400, body: JSON.stringify({ error: 'workOrderId required' }) };

    // Auto-generate CO number (CO-001, CO-002...)
    const { data: existing } = await supabase
      .from('change_orders')
      .select('co_number')
      .eq('home_build_id', homeBuildId)
      .order('created_at', { ascending: false })
      .limit(1);

    const lastNum = existing && existing.length > 0
      ? parseInt((existing[0].co_number || 'CO-000').replace('CO-', '')) : 0;
    const coNumber = `CO-${String(lastNum + 1).padStart(3, '0')}`;

    const { data: co, error } = await supabase
      .from('change_orders')
      .insert({
        company_id: companyId,
        home_build_id: homeBuildId,
        work_order_id: workOrderId,
        co_number: coNumber,
        description: description || null,
        crew_ids: (body.crewIds && body.crewIds.length > 0) ? body.crewIds : null,
        status: 'draft',
        created_by_id: auth.employeeId,
      })
      .select()
      .single();
    if (error) return errorResponse(error);

    // Insert materials if provided
    if (materials && materials.length > 0) {
      const matRows = materials.map(m => ({
        change_order_id: co.id,
        catalog_item_id: m.catalogItemId || null,
        part_number: m.partNumber || null,
        name: m.name,
        category: m.category || null,
        unit: m.unit || 'each',
        quantity: parseFloat(m.quantity) || 1,
        unit_cost: m.unitCost ? parseFloat(m.unitCost) : null,
      })).filter(r => r.name);
      if (matRows.length > 0) {
        await supabase.from('change_order_materials').insert(matRows);
      }
    }

    return { statusCode: 201, body: JSON.stringify({ ok: true, changeOrder: co }) };
  }

  // ---- PATCH: update change order status, signature, or materials ----
  if (method === 'PATCH') {
    const { id, action } = body;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };

    // Log labor against a change order
    if (action === 'log_labor') {
      const { employeeId, entryDate, hoursWorked, jobLocationId, activityDescription, foremanId } = body;
      if (!employeeId) return { statusCode: 400, body: JSON.stringify({ error: 'employeeId required' }) };
      if (!entryDate) return { statusCode: 400, body: JSON.stringify({ error: 'entryDate required' }) };
      if (!hoursWorked || hoursWorked <= 0) return { statusCode: 400, body: JSON.stringify({ error: 'hoursWorked must be > 0' }) };

      // Fetch the CO to get workOrderId
      const { data: co } = await supabase.from('change_orders').select('work_order_id').eq('id', id).single();
      if (!co) return { statusCode: 404, body: JSON.stringify({ error: 'Change order not found' }) };

      // Create the time entry — flows to employee My Hours
      const { data: te, error: teErr } = await supabase
        .from('time_entries')
        .insert({
          company_id: companyId,
          employee_id: employeeId,
          entry_date: entryDate,
          hours_worked: parseFloat(hoursWorked),
          hours_type: 'regular',
          job_location_id: jobLocationId || null,
          work_order_id: co.work_order_id,
          activity_description: activityDescription || `Change order labor — ${id}`,
          foreman_id: foremanId || auth.employeeId,
          is_weekend: [0, 6].includes(new Date(entryDate + 'T12:00:00Z').getUTCDay()),
          is_holiday: false,
          status: 'draft',
        })
        .select()
        .single();
      if (teErr) return errorResponse(teErr);

      // Link time entry to change order via change_order_labor
      await supabase.from('change_order_labor').insert({
        change_order_id: id,
        time_entry_id: te.id,
      });

      return { statusCode: 201, body: JSON.stringify({ ok: true, timeEntry: te }) };
    }

    // Sign in person
    if (action === 'sign_in_person') {
      const { approverName, signatureData } = body;
      if (!approverName) return { statusCode: 400, body: JSON.stringify({ error: 'approverName required' }) };
      if (!signatureData) return { statusCode: 400, body: JSON.stringify({ error: 'signatureData required' }) };
      const { error } = await supabase.from('change_orders').update({
        status: 'approved',
        approver_name: approverName,
        approved_at: new Date().toISOString(),
        signature_data: signatureData,
        approval_method: 'in_person',
        updated_at: new Date().toISOString(),
      }).eq('id', id).eq('company_id', companyId);
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // Send remote approval email
    if (action === 'send_remote_approval') {
      const { approvalEmail } = body;
      if (!approvalEmail) return { statusCode: 400, body: JSON.stringify({ error: 'approvalEmail required' }) };

      const token = crypto.randomUUID();
      const expires = new Date();
      expires.setDate(expires.getDate() + 7);

      const { data: co } = await supabase.from('change_orders')
        .select('*, change_order_materials(*)')
        .eq('id', id).single();
      if (!co) return { statusCode: 404, body: JSON.stringify({ error: 'Change order not found' }) };

      await supabase.from('change_orders').update({
        status: 'pending_approval',
        approval_method: 'remote_email',
        approval_email: approvalEmail,
        approval_token: token,
        approval_token_expires_at: expires.toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', id).eq('company_id', companyId);

      // Send email via Resend
      const approvalUrl = `https://isomtime.netlify.app/approve-co?token=${token}`;
      const matsList = (co.change_order_materials || []).map(m =>
        `${m.quantity} ${m.unit} ${m.name}${m.unit_cost ? ' @ $' + Number(m.unit_cost).toFixed(2) : ''}`
      ).join('\n');

      const emailBody = {
        from: 'Isom Electric <noreply@isomtime.netlify.app>',
        to: [approvalEmail],
        subject: `Change Order ${co.co_number} — Approval Required`,
        text: `You have a change order requiring your approval.\n\nChange Order: ${co.co_number}\nDescription: ${co.description || 'See details'}\n\nMaterials:\n${matsList || 'See attached'}\n\nBy approving, you agree to pay for all labor and materials associated with this change order.\n\nApprove here: ${approvalUrl}\n\nThis link expires in 7 days.`,
        html: `<p>You have a change order requiring your approval.</p><h3>${co.co_number}</h3><p><strong>Description:</strong> ${co.description || 'N/A'}</p>${matsList ? `<p><strong>Materials:</strong><br>${matsList.replace(/\n/g, '<br>')}</p>` : ''}<p style="background:#fef3c7;padding:12px;border-radius:6px;"><strong>By clicking Approve, you acknowledge and agree to pay for all labor and materials associated with this change order.</strong></p><p><a href="${approvalUrl}" style="background:#1a1208;color:#C47C1E;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Approve Change Order</a></p><p style="color:#666;font-size:12px;">This link expires in 7 days.</p>`,
      };

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(emailBody),
      });

      return { statusCode: 200, body: JSON.stringify({ ok: true, token }) };
    }

    // Update materials list
    if (action === 'update_materials') {
      const { materials } = body;
      // Delete existing and reinsert
      await supabase.from('change_order_materials').delete().eq('change_order_id', id);
      if (materials && materials.length > 0) {
        const matRows = materials.map(m => ({
          change_order_id: id,
          catalog_item_id: m.catalogItemId || null,
          part_number: m.partNumber || null,
          name: m.name,
          category: m.category || null,
          unit: m.unit || 'each',
          quantity: parseFloat(m.quantity) || 1,
          unit_cost: m.unitCost ? parseFloat(m.unitCost) : null,
        })).filter(r => r.name);
        if (matRows.length > 0) await supabase.from('change_order_materials').insert(matRows);
      }
      await supabase.from('change_orders').update({ updated_at: new Date().toISOString() }).eq('id', id);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // General status/description update
    const update = { updated_at: new Date().toISOString() };
    if (body.description !== undefined) update.description = body.description;
    if (body.status !== undefined) update.status = body.status;
    if (body.crewIds !== undefined) update.crew_ids = body.crewIds.length > 0 ? body.crewIds : null;
    const { error } = await supabase.from('change_orders').update(update).eq('id', id).eq('company_id', companyId);
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ---- DELETE: remove a draft change order ----
  if (method === 'DELETE') {
    const { id } = body;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    const { data: co } = await supabase.from('change_orders').select('status').eq('id', id).single();
    if (co && co.status !== 'draft') {
      return { statusCode: 409, body: JSON.stringify({ error: 'Only draft change orders can be deleted' }) };
    }
    const { error } = await supabase.from('change_orders').delete().eq('id', id).eq('company_id', companyId);
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
