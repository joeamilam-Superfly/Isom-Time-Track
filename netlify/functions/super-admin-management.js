const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { supabase } = require('./_company-role');

function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

// Granting or revoking super_admin is intentionally NOT scoped to any one
// company - it's a platform-wide capability, so only an existing super
// admin can grant it to someone else. A regular company admin, even one
// with the admin role at every company, can never reach this endpoint,
// since auth.superAdmin comes from the employees table directly and
// cannot be set by anything a company-scoped admin controls.
exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  if (!auth.superAdmin) {
    return forbidden('Only an existing super admin can grant or revoke super admin status');
  }

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('employees')
      .select('id, first_name, last_name, phone, super_admin')
      .eq('super_admin', true)
      .eq('active', true)
      .order('first_name', { ascending: true });

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ superAdmins: data }) };
  }

  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { phone, employeeId, superAdmin } = body;
    if (typeof superAdmin !== 'boolean') {
      return { statusCode: 400, body: JSON.stringify({ error: 'superAdmin must be true or false' }) };
    }
    if (!phone && !employeeId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Provide either phone or employeeId' }) };
    }

    let targetId = employeeId;
    if (!targetId) {
      const normalizedPhone = normalizePhone(phone);
      if (!normalizedPhone) return { statusCode: 400, body: JSON.stringify({ error: 'Could not understand that phone number' }) };

      const { data: existing, error: lookupError } = await supabase
        .from('employees')
        .select('id')
        .eq('phone', normalizedPhone)
        .maybeSingle();

      if (lookupError) return errorResponse(lookupError);
      if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'No employee found with that phone number. They need to already exist as an employee somewhere before becoming a super admin.' }) };
      targetId = existing.id;
    }

    // Revoking your own super admin status this way is intentionally
    // blocked - per the explicit decision this endpoint only GRANTS to
    // others while the caller keeps their own status, so self-revocation
    // isn't part of this flow and would need a deliberate separate action
    // (e.g. another super admin revoking it, or a direct database edit).
    if (targetId === auth.employeeId && superAdmin === false) {
      return { statusCode: 400, body: JSON.stringify({ error: 'You cannot revoke your own super admin status here. Have another super admin do it if needed.' }) };
    }

    const { data, error } = await supabase
      .from('employees')
      .update({ super_admin: superAdmin, updated_at: new Date().toISOString() })
      .eq('id', targetId)
      .select('id, first_name, last_name, phone, super_admin')
      .single();

    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ employee: data }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
