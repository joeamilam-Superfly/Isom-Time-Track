const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');
const bcrypt = require('bcryptjs');

function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  // ---------------- POST: create a new employee + assign a company role,
  // OR add a company role to an employee who already exists (matched by
  // phone), mirroring scripts/create-employee.js but callable in-app. ----
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, firstName, lastName, phone, email, pin, role, foremanId } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role !== 'admin') {
      return forbidden('Only admins can add employees');
    }

    if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'phone is required' }) };
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return { statusCode: 400, body: JSON.stringify({ error: 'Could not understand that phone number - use a 10-digit US number' }) };

    if (!['employee', 'foreman', 'admin'].includes(role)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'role must be employee, foreman, or admin' }) };
    }

    // foremanId, if given, must already have an active role at this company
    if (foremanId) {
      const foremanRole = await resolveCompanyRole(foremanId, companyId, false);
      if (!foremanRole) {
        return { statusCode: 400, body: JSON.stringify({ error: 'The selected foreman does not have a role at this company' }) };
      }
    }

    const { data: existingEmployee, error: lookupError } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (lookupError) return errorResponse(lookupError);

    let employeeId;

    if (existingEmployee) {
      employeeId = existingEmployee.id;
    } else {
      if (!firstName || !lastName || !pin) {
        return { statusCode: 400, body: JSON.stringify({ error: 'firstName, lastName, and pin are required to create a new employee' }) };
      }
      if (!/^\d{4,6}$/.test(String(pin))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'PIN must be 4-6 digits' }) };
      }

      const pinHash = bcrypt.hashSync(String(pin), 10);
      const { data: created, error: createError } = await supabase
        .from('employees')
        .insert({
          first_name: firstName,
          last_name: lastName,
          phone: normalizedPhone,
          email: email || null,
          pin_hash: pinHash,
        })
        .select()
        .single();

      if (createError) return errorResponse(createError);
      employeeId = created.id;
    }

    const { data: roleRow, error: roleError } = await supabase
      .from('employee_company_roles')
      .upsert({
        employee_id: employeeId,
        company_id: companyId,
        role,
        foreman_id: foremanId || null,
        active: true,
      }, { onConflict: 'employee_id,company_id' })
      .select()
      .single();

    if (roleError) return errorResponse(roleError);

    return {
      statusCode: 201,
      body: JSON.stringify({
        employeeId,
        wasExistingEmployee: !!existingEmployee,
        roleAssignment: roleRow,
      }),
    };
  }

  // ---------------- PUT: deactivate or reactivate an employee's role at
  // a specific company. This never deletes the employee record itself or
  // any of their history - it only flips employee_company_roles.active,
  // which removes them from active directory lists, approval queues, and
  // reminder scheduling for that company, while every past time_entries
  // and pto_requests row tied to them remains exactly as it was. ----
  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, employeeId, active } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!employeeId) return { statusCode: 400, body: JSON.stringify({ error: 'employeeId is required' }) };
    if (typeof active !== 'boolean') return { statusCode: 400, body: JSON.stringify({ error: 'active must be true or false' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role !== 'admin') {
      return forbidden('Only admins can deactivate or reactivate employees');
    }

    if (employeeId === auth.employeeId && active === false) {
      return { statusCode: 400, body: JSON.stringify({ error: 'You cannot deactivate your own account' }) };
    }

    const targetRole = await resolveCompanyRole(employeeId, companyId, false);
    if (!targetRole) {
      return { statusCode: 404, body: JSON.stringify({ error: 'That employee does not have a role at this company' }) };
    }

    // Block deactivating the last active admin at this company, so the
    // company can never accidentally end up with no one able to manage
    // it (short of a super admin stepping in, which still works even if
    // every explicit admin role at a company is deactivated, but that's
    // a recovery path, not something to rely on routinely).
    if (active === false && targetRole.role === 'admin') {
      const { data: otherAdmins, error: countError } = await supabase
        .from('employee_company_roles')
        .select('employee_id')
        .eq('company_id', companyId)
        .eq('role', 'admin')
        .eq('active', true)
        .neq('employee_id', employeeId);

      if (countError) return errorResponse(countError);
      if (!otherAdmins || otherAdmins.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'This is the last active admin at this company. Assign another admin before deactivating this one.' }) };
      }
    }

    const { data, error } = await supabase
      .from('employee_company_roles')
      .update({ active })
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .select()
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ roleAssignment: data }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
