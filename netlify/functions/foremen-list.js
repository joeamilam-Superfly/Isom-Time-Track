const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

// Returns every active foreman (and admin, since admins can also be
// picked as the foreman on a segment) at a company. Available to ANY
// active role at that company, including plain employees - this is
// deliberately not scoped the way dashboard.js is, since every employee
// needs to see the full foreman list to populate the per-segment
// foreman dropdown, not just admins/foremen managing others.
exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const params = event.queryStringParameters || {};
  const companyId = params.companyId;
  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole) return forbidden('You do not have access to this company');

  const { data, error } = await supabase
    .from('employee_company_roles')
    .select('employee_id, role, employees!employee_company_roles_employee_id_fkey(first_name, last_name, active)')
    .eq('company_id', companyId)
    .eq('active', true)
    .in('role', ['foreman', 'admin']);

  if (error) return errorResponse(error);

  const foremen = (data || [])
    .filter(r => r.employees?.active)
    .map(r => ({
      id: r.employee_id,
      name: `${r.employees.first_name} ${r.employees.last_name}`,
      role: r.role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { statusCode: 200, body: JSON.stringify({ foremen }) };
};
