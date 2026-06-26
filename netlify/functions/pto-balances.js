const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const year = params.year ? Number(params.year) : new Date().getUTCFullYear();
    const targetEmployeeId = params.employeeId || auth.employeeId;

    // PTO balance is person-level, not company-scoped, but we still gate
    // access: you can always see your own; to see someone else's you need
    // an admin role at ANY company that person also belongs to (checked
    // via companyId being passed, since that's the context the caller is
    // viewing from).
    if (targetEmployeeId !== auth.employeeId) {
      const companyId = params.companyId;
      if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required when viewing another employee\'s balance' }) };
      const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
      if (!myRole || myRole.role === 'employee') {
        return forbidden('You do not have permission to view this balance');
      }
    }

    const { data, error } = await supabase
      .from('pto_balances')
      .select('*')
      .eq('employee_id', targetEmployeeId)
      .eq('year', year)
      .maybeSingle();

    if (error) return errorResponse(error);

    const allotment = data ? Number(data.allotment_hours) : 0;
    const used = data ? Number(data.used_hours) : 0;

    return {
      statusCode: 200,
      body: JSON.stringify({
        year,
        allotmentHours: allotment,
        usedHours: used,
        remainingHours: Math.round((allotment - used) * 100) / 100,
      }),
    };
  }

  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { employeeId, companyId, year, allotmentHours, usedHours } = body;
    if (!employeeId || !companyId || !year || allotmentHours == null) {
      return { statusCode: 400, body: JSON.stringify({ error: 'employeeId, companyId, year, and allotmentHours are required' }) };
    }

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role !== 'admin') {
      return forbidden('Only admins can set PTO allotments');
    }

    // sanity check: the target employee should actually belong to this company
    const targetRole = await resolveCompanyRole(employeeId, companyId, false);
    if (!targetRole) {
      return { statusCode: 400, body: JSON.stringify({ error: 'That employee does not belong to this company' }) };
    }

    if (usedHours != null && usedHours < 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'usedHours cannot be negative' }) };
    }

    const { data: existing } = await supabase
      .from('pto_balances')
      .select('used_hours')
      .eq('employee_id', employeeId)
      .eq('year', year)
      .maybeSingle();

    // usedHours is optional - if the admin only wants to change the
    // allotment, omitting it preserves whatever was already there
    // (e.g. hours deducted automatically by approved PTO requests).
    // If provided, this is a direct override - useful for backfilling
    // history from before this system existed, or correcting a mistake
    // that didn't go through the normal request/approval flow.
    const finalUsedHours = usedHours != null ? usedHours : (existing ? existing.used_hours : 0);

    const { data, error } = await supabase
      .from('pto_balances')
      .upsert({
        employee_id: employeeId,
        year,
        allotment_hours: allotmentHours,
        used_hours: finalUsedHours,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'employee_id,year' })
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ balance: data }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
