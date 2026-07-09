const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const companyId = params.companyId;
    const year = params.year ? Number(params.year) : new Date().getUTCFullYear();
    const targetEmployeeId = params.employeeId || auth.employeeId;

    if (targetEmployeeId !== auth.employeeId) {
      if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required when viewing another employee\'s balance' }) };
      const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
      if (!myRole || myRole.role === 'employee') {
        return forbidden('You do not have permission to view this balance');
      }
    }

    let query = supabase
      .from('pto_balances')
      .select('*')
      .eq('employee_id', targetEmployeeId)
      .eq('year', year);

    if (companyId) query = query.eq('company_id', companyId);

    const { data, error } = await query.maybeSingle();
    if (error) return errorResponse(error);

    const allotment = data ? Number(data.allotment_hours) : 0;
    const used = data ? Number(data.used_hours) : 0;
    const uto = data ? Number(data.uto_days_taken) : 0;

    return {
      statusCode: 200,
      body: JSON.stringify({
        year,
        allotmentHours: allotment,
        usedHours: used,
        remainingHours: Math.round((allotment - used) * 100) / 100,
        utoDaysTaken: uto,
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

    const { employeeId, companyId, year, allotmentHours, usedHours, utoDaysTaken } = body;
    if (!employeeId || !companyId || !year) {
      return { statusCode: 400, body: JSON.stringify({ error: 'employeeId, companyId, and year are required' }) };
    }

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role !== 'admin') {
      return forbidden('Only admins can edit leave balances');
    }

    const targetRole = await resolveCompanyRole(employeeId, companyId, false);
    if (!targetRole) {
      return { statusCode: 400, body: JSON.stringify({ error: 'That employee does not belong to this company' }) };
    }

    if (usedHours != null && usedHours < 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'usedHours cannot be negative' }) };
    }
    if (utoDaysTaken != null && utoDaysTaken < 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'utoDaysTaken cannot be negative' }) };
    }

    const { data: existing } = await supabase
      .from('pto_balances')
      .select('used_hours, allotment_hours, uto_days_taken')
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .eq('year', year)
      .maybeSingle();

    const finalAllotmentHours = allotmentHours != null ? allotmentHours : (existing ? existing.allotment_hours : 0);
    const finalUsedHours = usedHours != null ? usedHours : (existing ? existing.used_hours : 0);
    const finalUtoDays = utoDaysTaken != null ? utoDaysTaken : (existing ? existing.uto_days_taken : 0);

    const { data, error } = await supabase
      .from('pto_balances')
      .upsert({
        employee_id: employeeId,
        company_id: companyId,
        year,
        allotment_hours: finalAllotmentHours,
        used_hours: finalUsedHours,
        uto_days_taken: finalUtoDays,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'employee_id,company_id,year' })
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ balance: data }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
