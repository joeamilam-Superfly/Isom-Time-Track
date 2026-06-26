const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');
const { clusterDuplicateLocations } = require('./_location-match');

// ---------------- GET: scan for likely-duplicate groups ----------------
// Returns groups of job locations at this company that look like
// duplicates of each other. This is a SCAN only - it never changes
// anything. Admin reviews the groups and decides what to merge via the
// PUT action below. Deactivated locations are included in the scan too,
// since an old duplicate that was already deactivated by hand should
// still show up so its history can be properly merged into the keeper
// rather than left orphaned under a dead location.
async function scanForDuplicates(companyId) {
  const { data: locations, error } = await supabase
    .from('job_locations')
    .select('id, name, address, active')
    .eq('company_id', companyId);

  if (error) return { error };

  const groups = clusterDuplicateLocations(locations || []);
  return { groups };
}

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const companyId = params.companyId;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role !== 'admin') {
      return forbidden('Only admins can review job location duplicates');
    }

    const result = await scanForDuplicates(companyId);
    if (result.error) return errorResponse(result.error);

    return {
      statusCode: 200,
      body: JSON.stringify({
        groups: result.groups.map(g => g.map(loc => ({ id: loc.id, name: loc.name, address: loc.address, active: loc.active }))),
      }),
    };
  }

  // ---------------- PUT: merge a chosen set of duplicates into one keeper ----------------
  // Reassigns every time_entries and job_site_photos row pointing at any
  // of the "duplicateIds" over to "keepId" instead, then deactivates the
  // duplicates (never deletes them - their name needs to keep showing
  // correctly on any historical record that already referenced them
  // before the merge, and deactivating rather than deleting means
  // nothing breaks if something was missed).
  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, keepId, duplicateIds } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
    if (!keepId) return { statusCode: 400, body: JSON.stringify({ error: 'keepId is required' }) };
    if (!Array.isArray(duplicateIds) || duplicateIds.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'duplicateIds must be a non-empty array' }) };
    }
    if (duplicateIds.includes(keepId)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'keepId cannot also appear in duplicateIds' }) };
    }

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole || myRole.role !== 'admin') {
      return forbidden('Only admins can merge job locations');
    }

    // Verify every location involved (the keeper AND every duplicate)
    // actually belongs to this company, so an admin at one company can
    // never merge or reassign data belonging to a different company by
    // guessing IDs.
    const allIds = [keepId, ...duplicateIds];
    const { data: checkLocations, error: checkError } = await supabase
      .from('job_locations')
      .select('id, company_id')
      .in('id', allIds);

    if (checkError) return errorResponse(checkError);
    if (!checkLocations || checkLocations.length !== allIds.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'One or more of the specified locations could not be found' }) };
    }
    if (checkLocations.some(loc => loc.company_id !== companyId)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'One or more of the specified locations do not belong to this company' }) };
    }

    // Reassign time_entries
    const { error: entriesError } = await supabase
      .from('time_entries')
      .update({ job_location_id: keepId })
      .in('job_location_id', duplicateIds);

    if (entriesError) return errorResponse(entriesError);

    // Reassign job_site_photos
    const { error: photosError } = await supabase
      .from('job_site_photos')
      .update({ job_location_id: keepId })
      .in('job_location_id', duplicateIds);

    if (photosError) return errorResponse(photosError);

    // Deactivate the merged-away duplicates so they stop appearing in
    // autocomplete and the active locations list, without deleting them.
    const { error: deactivateError } = await supabase
      .from('job_locations')
      .update({ active: false })
      .in('id', duplicateIds);

    if (deactivateError) return errorResponse(deactivateError);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, keptLocationId: keepId, mergedCount: duplicateIds.length }),
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
