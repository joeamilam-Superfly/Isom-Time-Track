const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

// Records that the employee actively confirmed seeing a schedule change.
// This timestamp is the actual proof-of-notification record - it is only
// ever set here, in response to an explicit action from the employee,
// never automatically just because the change was technically displayed
// somewhere in the app.
exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  if (event.httpMethod !== 'PUT') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { companyId, changeLogId } = body;
  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
  if (!changeLogId) return { statusCode: 400, body: JSON.stringify({ error: 'changeLogId is required' }) };

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole) return forbidden('You do not have access to this company');

  const { data: existing, error: fetchError } = await supabase
    .from('schedule_change_log')
    .select('employee_id, company_id, acknowledged_at')
    .eq('id', changeLogId)
    .maybeSingle();

  if (fetchError) return errorResponse(fetchError);
  if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Change record not found' }) };
  if (existing.company_id !== companyId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'This record does not belong to the specified company' }) };
  }

  // Only the employee the change is about can acknowledge it - this is
  // their own confirmation, not something anyone else can do on their
  // behalf, since the whole point is proof THEY were told.
  if (existing.employee_id !== auth.employeeId) {
    return forbidden('You can only acknowledge your own schedule change notifications');
  }

  if (existing.acknowledged_at) {
    // Already acknowledged - idempotent, not an error, just return success
    return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyAcknowledged: true }) };
  }

  const { error } = await supabase
    .from('schedule_change_log')
    .update({ acknowledged_at: new Date().toISOString() })
    .eq('id', changeLogId);

  if (error) return errorResponse(error);
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
