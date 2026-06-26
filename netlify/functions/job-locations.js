const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { normalize, findSimilarLocations } = require('./_location-match');
const { resolveCompanyRole, supabase } = require('./_company-role');

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const companyId = params.companyId;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    let query = supabase
      .from('job_locations')
      .select('id, name, address, active')
      .eq('company_id', companyId)
      .order('name', { ascending: true });

    // Default behavior (used by the day-edit autocomplete) only shows
    // active locations. Admin management views pass includeInactive=true
    // to also see and reactivate deactivated ones.
    if (params.includeInactive !== 'true') {
      query = query.eq('active', true);
    }

    const { data, error } = await query;
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ locations: data }) };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, name, address, confirmNew } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (myRole.role === 'employee') {
      return forbidden('Only a foreman or admin can add a new job location. Ask your foreman or admin to add it, then it will show up here.');
    }

    if (!name || !name.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Job location name is required' }) };
    }

    const { data: existingLocations, error: fetchError } = await supabase
      .from('job_locations')
      .select('id, name, address')
      .eq('company_id', companyId)
      .eq('active', true);

    if (fetchError) return errorResponse(fetchError);

    const similar = findSimilarLocations(name, existingLocations || []);

    if (similar.length > 0 && !confirmNew) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          needsConfirmation: true,
          suggestions: similar.map(s => ({ id: s.id, name: s.name, address: s.address, score: Math.round(s.score * 100) })),
        }),
      };
    }

    const { data, error } = await supabase
      .from('job_locations')
      .insert({
        company_id: companyId,
        name: name.trim(),
        normalized_name: normalize(name),
        address: address || null,
        created_by: auth.employeeId,
      })
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 201, body: JSON.stringify({ location: data }) };
  }

  // ---------------- PUT: activate or deactivate a job location. Never
  // deletes the row, since existing time_entries reference it by id and
  // still need to display its name correctly in history/exports. ----
  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, locationId, active } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!locationId) return { statusCode: 400, body: JSON.stringify({ error: 'locationId is required' }) };
    if (typeof active !== 'boolean') return { statusCode: 400, body: JSON.stringify({ error: 'active must be true or false' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role !== 'admin') {
      return forbidden('Only admins can activate or deactivate job locations');
    }

    const { data: existing, error: fetchError } = await supabase
      .from('job_locations')
      .select('company_id')
      .eq('id', locationId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Job location not found' }) };
    if (existing.company_id !== companyId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This job location does not belong to the specified company' }) };
    }

    const { data, error } = await supabase
      .from('job_locations')
      .update({ active })
      .eq('id', locationId)
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ location: data }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
