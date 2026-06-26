const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('./_jwt');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
});

function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { phone, pin } = body;
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone || !pin) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Phone number and PIN are required' }) };
  }

  const { data: employee, error } = await supabase
    .from('employees')
    .select('id, first_name, last_name, phone, email, pin_hash, super_admin, active')
    .eq('phone', normalizedPhone)
    .maybeSingle();

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed' }) };
  }

  if (!employee || !employee.active) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No active account found for that phone number' }) };
  }

  const pinMatches = bcrypt.compareSync(String(pin), employee.pin_hash);
  if (!pinMatches) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Incorrect PIN' }) };
  }

  // Load every company this person has a role at, so the frontend can
  // show a company switcher. Super admins implicitly have admin-level
  // access everywhere, even at companies without an explicit role row,
  // but we still only list companies they have an explicit membership in
  // here, plus all companies if super_admin (so they can switch into any
  // company, not just ones they're separately assigned to).
  const { data: roles, error: rolesError } = await supabase
    .from('employee_company_roles')
    .select('company_id, role, foreman_id, active, companies(id, name)')
    .eq('employee_id', employee.id)
    .eq('active', true);

  if (rolesError) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load company roles' }) };
  }

  let companies = (roles || [])
    .filter(r => r.companies)
    .map(r => ({ id: r.companies.id, name: r.companies.name, role: r.role, defaultForemanId: r.foreman_id }));

  if (employee.super_admin) {
    const { data: allCompanies } = await supabase.from('companies').select('id, name').eq('active', true);
    const ownedIds = new Set(companies.map(c => c.id));
    for (const c of allCompanies || []) {
      if (!ownedIds.has(c.id)) {
        companies.push({ id: c.id, name: c.name, role: 'admin', defaultForemanId: null }); // super admin acts as admin anywhere they don't have an explicit role
      }
    }
  }

  if (companies.length === 0) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Your account is not assigned to any company yet. Contact an admin.' }) };
  }

  // Token is intentionally company-agnostic: it only proves WHO is logged
  // in. WHICH company they're acting in is sent per-request by the
  // frontend (after the company switcher) and re-validated against
  // employee_company_roles on every call, so role can never be spoofed
  // by the client and switching companies never requires a new login.
  const token = jwt.sign({
    employeeId: employee.id,
    superAdmin: employee.super_admin,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      token,
      employee: {
        id: employee.id,
        firstName: employee.first_name,
        lastName: employee.last_name,
        phone: employee.phone,
        email: employee.email,
        superAdmin: employee.super_admin,
      },
      companies,
    }),
  };
};
