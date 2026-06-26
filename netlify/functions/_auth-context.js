const jwt = require('./_jwt');

// Pulls the bearer token off the request, verifies it, and returns the
// decoded payload, or null if missing/invalid/expired.
function getAuthContext(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length);
  return jwt.verify(token);
}

function unauthorized(message = 'Unauthorized') {
  return { statusCode: 401, body: JSON.stringify({ error: message }) };
}

function forbidden(message = 'Forbidden') {
  return { statusCode: 403, body: JSON.stringify({ error: message }) };
}

// Wraps a Supabase query error into a 500 response. Recognizes a few
// known Supabase/PostgREST error patterns and rewrites them into a
// clearer message rather than passing through their internal wording
// verbatim. Add more patterns here as they come up.
function errorResponse(error, statusCode = 500) {
  const msg = error && error.message ? error.message : 'Unknown database error';

  if (msg.includes('more than one relationship')) {
    return {
      statusCode,
      body: JSON.stringify({
        error: 'Internal query error: an embedded table join was ambiguous because the target table has more than one foreign key pointing to it. This is a bug in the function code, not a data problem - the join needs to specify which foreign key constraint to use (e.g. employees!table_column_fkey(...) instead of employees(...)).',
      }),
    };
  }

  if (msg.includes('violates foreign key constraint')) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'This action references something that does not exist or has been removed. Double-check the IDs involved.' }),
    };
  }

  if (msg.includes('violates unique constraint') || msg.includes('duplicate key value')) {
    return {
      statusCode: 409,
      body: JSON.stringify({ error: 'A matching record already exists. This is likely a duplicate submission.' }),
    };
  }

  return { statusCode, body: JSON.stringify({ error: msg }) };
}

module.exports = { getAuthContext, unauthorized, forbidden, errorResponse };
