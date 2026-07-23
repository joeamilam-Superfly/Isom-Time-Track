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

  // ---- GET: search or list catalog items ----
  if (method === 'GET') {
    let query = supabase
      .from('materials_catalog')
      .select('id, part_number, name, category, unit, unit_cost, active')
      .eq('company_id', companyId)
      .order('name', { ascending: true });

    if (params.activeOnly !== 'false') query = query.eq('active', true);

    if (params.q) {
      // Search across name, part_number, category
      const q = params.q.toLowerCase();
      query = query.or(`name.ilike.%${q}%,part_number.ilike.%${q}%,category.ilike.%${q}%`);
    }

    if (params.limit) query = query.limit(parseInt(params.limit));

    const { data, error } = await query;
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ items: data || [] }) };
  }

  // Admin-only for all write operations
  if (myRole.role !== 'admin') return forbidden('Only admins can manage the materials catalog');

  // ---- POST: create single item or bulk import ----
  if (method === 'POST') {
    // Bulk import via CSV rows
    if (body.items && Array.isArray(body.items)) {
      const rows = body.items.map(item => ({
        company_id: companyId,
        part_number: item.part_number?.trim() || null,
        name: item.name?.trim(),
        category: item.category?.trim() || null,
        unit: item.unit?.trim() || 'each',
        unit_cost: item.unit_cost ? parseFloat(item.unit_cost) : null,
        active: true,
      })).filter(r => r.name);

      if (rows.length === 0) return { statusCode: 400, body: JSON.stringify({ error: 'No valid items to import' }) };

      const { data, error } = await supabase.from('materials_catalog').insert(rows).select();
      if (error) return errorResponse(error);
      return { statusCode: 201, body: JSON.stringify({ ok: true, count: data.length }) };
    }

    // Single item
    const { partNumber, name, category, unit, unitCost } = body;
    if (!name) return { statusCode: 400, body: JSON.stringify({ error: 'name is required' }) };

    const { data, error } = await supabase
      .from('materials_catalog')
      .insert({
        company_id: companyId,
        part_number: partNumber?.trim() || null,
        name: name.trim(),
        category: category?.trim() || null,
        unit: unit?.trim() || 'each',
        unit_cost: unitCost ? parseFloat(unitCost) : null,
        active: true,
      })
      .select()
      .single();
    if (error) return errorResponse(error);
    return { statusCode: 201, body: JSON.stringify({ item: data }) };
  }

  // ---- PATCH: update item ----
  if (method === 'PATCH') {
    const { id, partNumber, name, category, unit, unitCost, active } = body;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };

    const update = { updated_at: new Date().toISOString() };
    if (partNumber !== undefined) update.part_number = partNumber?.trim() || null;
    if (name !== undefined) update.name = name.trim();
    if (category !== undefined) update.category = category?.trim() || null;
    if (unit !== undefined) update.unit = unit?.trim() || 'each';
    if (unitCost !== undefined) update.unit_cost = unitCost ? parseFloat(unitCost) : null;
    if (active !== undefined) update.active = active;

    const { error } = await supabase.from('materials_catalog').update(update).eq('id', id).eq('company_id', companyId);
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ---- DELETE: deactivate item (soft delete) ----
  if (method === 'DELETE') {
    const { id } = body;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    const { error } = await supabase
      .from('materials_catalog')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
