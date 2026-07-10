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

    const isAdmin = myRole.role === 'admin';

    // Budget burn report for a specific location - admin only.
    // Computes spent amount in real time from time_entries × employee
    // bill rates, so it's always accurate even if entries are edited.
    if (params.budgetBurn === 'true' && params.locationId) {
      if (!isAdmin) return forbidden('Only admins can view budget information');

      const { data: location, error: locError } = await supabase
        .from('job_locations')
        .select('id, name, budget_amount, budget_materials')
        .eq('id', params.locationId)
        .eq('company_id', companyId)
        .maybeSingle();

      if (locError) return errorResponse(locError);
      if (!location) return { statusCode: 404, body: JSON.stringify({ error: 'Location not found' }) };

      // ---- Labor burn: sum of hours_worked × employee bill_rate ----
      let laborSpent = 0;
      if (location.budget_amount) {
        const { data: entries } = await supabase
          .from('time_entries')
          .select('employee_id, hours_worked')
          .eq('job_location_id', params.locationId)
          .eq('company_id', companyId)
          .neq('hours_type', 'pto');

        const employeeIds = [...new Set((entries || []).map(e => e.employee_id))];
        let billRateMap = {};
        if (employeeIds.length > 0) {
          const { data: roles } = await supabase
            .from('employee_company_roles')
            .select('employee_id, bill_rate')
            .eq('company_id', companyId)
            .in('employee_id', employeeIds);
          for (const r of roles || []) {
            billRateMap[r.employee_id] = r.bill_rate ? Number(r.bill_rate) : 0;
          }
        }
        laborSpent = (entries || []).reduce((sum, e) => {
          return sum + (Number(e.hours_worked) * (billRateMap[e.employee_id] || 0));
        }, 0);
      }

      // ---- Materials burn: sum of receipt_amount for receipts at this location ----
      let materialsSpent = 0;
      if (location.budget_materials) {
        const { data: receipts } = await supabase
          .from('job_site_photos')
          .select('receipt_amount')
          .eq('job_location_id', params.locationId)
          .eq('company_id', companyId)
          .eq('is_receipt', true);
        materialsSpent = (receipts || []).reduce((sum, r) => sum + (r.receipt_amount ? Number(r.receipt_amount) : 0), 0);
      }

      const laborBudget = location.budget_amount ? Number(location.budget_amount) : null;
      const materialsBudget = location.budget_materials ? Number(location.budget_materials) : null;

      function burnStats(budget, spent) {
        if (!budget) return { budget: null, spent: 0, remaining: null, percentSpent: 0, overBudget: false, warning: false };
        const remaining = budget - spent;
        const percentSpent = Math.round((spent / budget) * 100);
        return {
          budget: Math.round(budget * 100) / 100,
          spent: Math.round(spent * 100) / 100,
          remaining: Math.round(remaining * 100) / 100,
          percentSpent,
          overBudget: remaining < 0,
          warning: percentSpent >= 70 && remaining >= 0,
        };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          locationId: location.id,
          locationName: location.name,
          labor: burnStats(laborBudget, laborSpent),
          materials: burnStats(materialsBudget, materialsSpent),
        }),
      };
    }

    // Standard location list - budget_amount only returned to admin.
    let query = supabase
      .from('job_locations')
      .select(isAdmin ? 'id, name, address, active, budget_amount, budget_materials' : 'id, name, address, active')
      .eq('company_id', companyId)
      .order('name', { ascending: true });

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

    const { companyId, name, address, confirmNew, budgetAmount, budgetMaterials } = body;
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

    // Only admin can set a budget - foreman can create locations but not set budgets
    const isAdmin = myRole.role === 'admin';
    const { data, error } = await supabase
      .from('job_locations')
      .insert({
        company_id: companyId,
        name: name.trim(),
        normalized_name: normalize(name),
        address: address || null,
        budget_amount: isAdmin && budgetAmount ? Number(budgetAmount) : null,
        budget_materials: isAdmin && budgetMaterials ? Number(budgetMaterials) : null,
        created_by: auth.employeeId,
      })
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 201, body: JSON.stringify({ location: data }) };
  }

  // PUT: update a job location (active/inactive toggle OR budget update)
  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, locationId, active, budgetAmount, budgetMaterials } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!locationId) return { statusCode: 400, body: JSON.stringify({ error: 'locationId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role !== 'admin') {
      return forbidden('Only admins can update job locations');
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

    const updateFields = {};
    if (typeof active === 'boolean') updateFields.active = active;
    if (budgetAmount !== undefined) updateFields.budget_amount = budgetAmount ? Number(budgetAmount) : null;
    if (budgetMaterials !== undefined) updateFields.budget_materials = budgetMaterials ? Number(budgetMaterials) : null;

    const { data, error } = await supabase
      .from('job_locations')
      .update(updateFields)
      .eq('id', locationId)
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ location: data }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
