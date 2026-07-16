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

    const { companyId, firstName, lastName, phone, email, pin, role, foremanId, employmentStartDate, billRate } = body;
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

    const EMPLOYEE_COLORS = [
      '#dbeafe','#d1fae5','#fef3c7','#e0e7ff','#ccfbf1','#ede9fe',
      '#ffedd5','#cffafe','#f0fdf4','#fef9c3','#f1f5f9','#e7e5e4',
      '#ecfdf5','#eff6ff','#f5f3ff','#fff7ed','#ecfeff','#f0fdfa',
      '#fef08a','#a7f3d0',
    ];

    // Pick a color not already in use at this company
    const { data: existingColors } = await supabase
      .from('employee_company_roles')
      .select('display_color')
      .eq('company_id', companyId)
      .not('display_color', 'is', null);
    const usedColors = new Set((existingColors || []).map(r => r.display_color));
    const autoColor = EMPLOYEE_COLORS.find(c => !usedColors.has(c)) || EMPLOYEE_COLORS[Math.floor(Math.random() * EMPLOYEE_COLORS.length)];

    const { data: roleRow, error: roleError } = await supabase
      .from('employee_company_roles')
      .upsert({
        employee_id: employeeId,
        company_id: companyId,
        role,
        foreman_id: foremanId || null,
        employment_start_date: employmentStartDate || null,
        bill_rate: billRate ? Number(billRate) : null,
        display_color: autoColor,
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

  // ---------------- PATCH: edit an existing employee's profile fields
  // and/or their role at this company. Separate from the PUT handler
  // above (which is purely the active/inactive toggle) to keep each
  // action focused. firstName/lastName/phone/email live on the shared
  // employees record (so changes apply everywhere that person works,
  // not just at this company); role and foremanId are specific to this
  // one company's employee_company_roles row. ----
  if (event.httpMethod === 'PATCH') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, employeeId, firstName, lastName, phone, email, role, foremanId, employmentStartDate, billRate } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!employeeId) return { statusCode: 400, body: JSON.stringify({ error: 'employeeId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role !== 'admin') {
      return forbidden('Only admins can edit an employee\'s profile');
    }

    const targetRole = await resolveCompanyRole(employeeId, companyId, false);
    if (!targetRole) {
      return { statusCode: 404, body: JSON.stringify({ error: 'That employee does not have a role at this company' }) };
    }

    // Block changing the only active admin at this company down to a
    // different role - same protection as the deactivate guard above,
    // so a company can never accidentally end up with zero admins.
    if (role && role !== 'admin' && targetRole.role === 'admin') {
      const { data: otherAdmins, error: countError } = await supabase
        .from('employee_company_roles')
        .select('employee_id')
        .eq('company_id', companyId)
        .eq('role', 'admin')
        .eq('active', true)
        .neq('employee_id', employeeId);

      if (countError) return errorResponse(countError);
      if (!otherAdmins || otherAdmins.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'This is the last active admin at this company. Assign another admin before changing this one\'s role.' }) };
      }
    }

    if (role && !['employee', 'foreman', 'admin'].includes(role)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'role must be employee, foreman, or admin' }) };
    }

    if (foremanId) {
      const foremanRole = await resolveCompanyRole(foremanId, companyId, false);
      if (!foremanRole) {
        return { statusCode: 400, body: JSON.stringify({ error: 'The selected foreman does not have a role at this company' }) };
      }
    }

    // Profile fields live on the shared employees record
    const profileUpdate = {};
    if (firstName !== undefined) profileUpdate.first_name = firstName;
    if (lastName !== undefined) profileUpdate.last_name = lastName;
    if (email !== undefined) profileUpdate.email = email || null;

    if (phone !== undefined) {
      const normalizedPhone = normalizePhone(phone);
      if (!normalizedPhone) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Could not understand that phone number - use a 10-digit US number' }) };
      }

      const { data: phoneOwner } = await supabase
        .from('employees')
        .select('id')
        .eq('phone', normalizedPhone)
        .maybeSingle();

      if (phoneOwner && phoneOwner.id !== employeeId) {
        return { statusCode: 409, body: JSON.stringify({ error: 'That phone number is already in use by a different employee.' }) };
      }

      profileUpdate.phone = normalizedPhone;
    }

    if (Object.keys(profileUpdate).length > 0) {
      profileUpdate.updated_at = new Date().toISOString();
      const { error: profileError } = await supabase
        .from('employees')
        .update(profileUpdate)
        .eq('id', employeeId);

      if (profileError) return errorResponse(profileError);
    }

    // Role/foreman live on employee_company_roles, scoped to this company
    const roleUpdate = {};
    if (role !== undefined) roleUpdate.role = role;
    if (foremanId !== undefined) roleUpdate.foreman_id = foremanId || null;
    if (employmentStartDate !== undefined) roleUpdate.employment_start_date = employmentStartDate || null;
    if (billRate !== undefined) roleUpdate.bill_rate = billRate ? Number(billRate) : null;
    if (body.displayColor !== undefined) roleUpdate.display_color = body.displayColor || null;
    if (body.queueEligible !== undefined) roleUpdate.queue_eligible = !!body.queueEligible;

    let updatedRoleRow = null;
    if (Object.keys(roleUpdate).length > 0) {
      const { data: roleData, error: roleError } = await supabase
        .from('employee_company_roles')
        .update(roleUpdate)
        .eq('employee_id', employeeId)
        .eq('company_id', companyId)
        .select()
        .single();

      if (roleError) return errorResponse(roleError);
      updatedRoleRow = roleData;
    }

    const { data: updatedEmployee, error: fetchError } = await supabase
      .from('employees')
      .select('id, first_name, last_name, phone, email')
      .eq('id', employeeId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);

    return {
      statusCode: 200,
      body: JSON.stringify({ employee: updatedEmployee, roleAssignment: updatedRoleRow }),
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
