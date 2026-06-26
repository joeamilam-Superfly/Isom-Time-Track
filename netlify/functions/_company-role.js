const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
});

// Resolves what role (if any) an employee has at a given company, right
// now, fresh from the database. The JWT only proves identity (employeeId)
// and whether they're a super_admin overall; it never carries a role,
// since role is per-company and can change without requiring re-login.
//
// Returns { role: 'employee'|'foreman'|'admin', foremanId } or null if the
// employee has no active role at this company (and isn't a super admin).
// Super admins who lack an explicit row are treated as 'admin' at any
// company, matching the company list shown at login.
async function resolveCompanyRole(employeeId, companyId, isSuperAdmin) {
  if (!companyId) return null;

  const { data: roleRow } = await supabase
    .from('employee_company_roles')
    .select('role, foreman_id, active')
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (roleRow && roleRow.active) {
    return { role: roleRow.role, foremanId: roleRow.foreman_id };
  }

  if (isSuperAdmin) {
    return { role: 'admin', foremanId: null };
  }

  return null;
}

module.exports = { resolveCompanyRole, supabase };
