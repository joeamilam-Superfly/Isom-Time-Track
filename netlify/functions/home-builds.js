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
  if (myRole.role === 'employee') return forbidden('Only foremen and admins can access home builds');

  // ---- GET: fetch a single home build or list ----
  if (method === 'GET') {
    if (params.id) {
      const { data, error } = await supabase
        .from('home_builds')
        .select(`
          *,
          job_locations(id, name),
          rough_in_wo:work_orders!home_builds_rough_in_wo_id_fkey(id, wo_number, status, assigned_to_id),
          trim_wo:work_orders!home_builds_trim_wo_id_fkey(id, wo_number, status, assigned_to_id),
          change_orders(
            id, co_number, description, status, approver_name, approved_at,
            approval_method, created_at,
            change_order_materials(id, part_number, name, category, unit, quantity, unit_cost, line_total)
          )
        `)
        .eq('id', params.id)
        .eq('company_id', companyId)
        .single();
      if (error) return errorResponse(error);
      return { statusCode: 200, body: JSON.stringify({ homeBuild: data }) };
    }

    const { data, error } = await supabase
      .from('home_builds')
      .select('*, job_locations(id, name)')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ homeBuilds: data || [] }) };
  }

  // ---- POST: create home build ----
  if (method === 'POST') {
    const {
      jobLocationId, builderName, builderEmail, builderPhone,
      homeownerName, homeownerEmail, homeownerPhone, roughInWoId,
    } = body;

    const { data, error } = await supabase
      .from('home_builds')
      .insert({
        company_id: companyId,
        job_location_id: jobLocationId || null,
        builder_name: builderName || null,
        builder_email: builderEmail || null,
        builder_phone: builderPhone || null,
        homeowner_name: homeownerName || null,
        homeowner_email: homeownerEmail || null,
        homeowner_phone: homeownerPhone || null,
        rough_in_wo_id: roughInWoId || null,
        status: 'rough_in_active',
      })
      .select()
      .single();
    if (error) return errorResponse(error);
    return { statusCode: 201, body: JSON.stringify({ homeBuild: data }) };
  }

  // ---- PATCH: update home build or start trim phase ----
  if (method === 'PATCH') {
    const { id, action } = body;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };

    if (action === 'start_trim') {
      const { trimWoNumber } = body;
      if (!trimWoNumber) return { statusCode: 400, body: JSON.stringify({ error: 'trimWoNumber required' }) };

      const { data: hb } = await supabase.from('home_builds').select('*').eq('id', id).single();
      if (!hb) return { statusCode: 404, body: JSON.stringify({ error: 'Home build not found' }) };

      const { data: trimWo, error: woErr } = await supabase
        .from('work_orders')
        .insert({
          company_id: companyId,
          wo_number: trimWoNumber.trim(),
          date_received: new Date().toISOString().slice(0, 10),
          job_location_id: hb.job_location_id,
          is_new_home_build: true,
          home_build_id: id,
          build_phase: 'trim',
          status: 'open',
          created_by_id: auth.employeeId,
        })
        .select()
        .single();
      if (woErr) return errorResponse(woErr);

      const { error: hbErr } = await supabase
        .from('home_builds')
        .update({ trim_wo_id: trimWo.id, status: 'trim_active', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (hbErr) return errorResponse(hbErr);

      return { statusCode: 200, body: JSON.stringify({ ok: true, trimWo }) };
    }

    // General field update
    const update = { updated_at: new Date().toISOString() };
    const fieldMap = {
      jobLocationId: 'job_location_id', builderName: 'builder_name',
      builderEmail: 'builder_email', builderPhone: 'builder_phone',
      homeownerName: 'homeowner_name', homeownerEmail: 'homeowner_email',
      homeownerPhone: 'homeowner_phone', roughInWoId: 'rough_in_wo_id', status: 'status',
    };
    for (const [camel, snake] of Object.entries(fieldMap)) {
      if (body[camel] !== undefined) update[snake] = body[camel] || null;
    }
    const { error } = await supabase.from('home_builds').update(update).eq('id', id).eq('company_id', companyId);
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
