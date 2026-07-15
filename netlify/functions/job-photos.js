const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

const PHOTO_BUCKET = 'job-site-photos';
const MAX_BASE64_LENGTH = 6_000_000; // ~4.3MB decoded, safely under Netlify's ~4.5MB binary limit after base64 overhead

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  // ---------------- GET: browse the feed, optionally filtered by location ----------------
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const companyId = params.companyId;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');
    // Any active role (including plain employee) can browse, per explicit decision.

    let query = supabase
      .from('job_site_photos')
      .select('id, employee_id, job_location_id, storage_path, description, is_receipt, receipt_amount, taken_at, employees(first_name, last_name), job_locations(name)')
      .eq('company_id', companyId)
      .order('taken_at', { ascending: false });
      // No limit — return all photos

    if (params.jobLocationId === 'none') {
      query = query.is('job_location_id', null); // photos with no location
    } else if (params.jobLocationId) {
      query = query.eq('job_location_id', params.jobLocationId);
    }
    if (params.receiptsOnly === 'true') query = query.eq('is_receipt', true);
    if (params.photosOnly === 'true') query = query.eq('is_receipt', false);
    if (params.startDate) query = query.gte('taken_at', params.startDate + 'T00:00:00Z');
    if (params.endDate) query = query.lte('taken_at', params.endDate + 'T23:59:59Z');

    const { data, error } = await query;
    if (error) return errorResponse(error);

    const withUrls = await Promise.all((data || []).map(async (p) => {
      const { data: signed, error: signError } = await supabase.storage
        .from(PHOTO_BUCKET)
        .createSignedUrl(p.storage_path, 60 * 30);
      return {
        id: p.id,
        jobLocationId: p.job_location_id,
        jobLocationName: p.job_locations?.name || null,
        employeeName: p.employees ? `${p.employees.first_name} ${p.employees.last_name}` : null,
        description: p.description,
        isReceipt: p.is_receipt,
        receiptAmount: p.receipt_amount ? Number(p.receipt_amount) : null,
        takenAt: p.taken_at,
        url: signError ? null : signed.signedUrl,
      };
    }));

    return { statusCode: 200, body: JSON.stringify({ photos: withUrls }) };
  }

  // ---------------- POST: upload a new photo ----------------
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { companyId, jobLocationId, description, imageBase64, mimeType, isReceipt, receiptAmount } = body;
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (!imageBase64) return { statusCode: 400, body: JSON.stringify({ error: 'imageBase64 is required' }) };
    if (imageBase64.length > MAX_BASE64_LENGTH) {
      return { statusCode: 413, body: JSON.stringify({ error: 'That photo is too large. Please use a smaller image (the app should compress photos automatically - if you are seeing this, try a different photo).' }) };
    }
    if (!mimeType || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Only JPEG, PNG, or WebP images are supported' }) };
    }

    if (jobLocationId) {
      const { data: locCheck } = await supabase
        .from('job_locations')
        .select('company_id')
        .eq('id', jobLocationId)
        .maybeSingle();
      if (!locCheck || locCheck.company_id !== companyId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'That job location does not belong to this company' }) };
      }
    }

    let buffer;
    try {
      buffer = Buffer.from(imageBase64, 'base64');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Could not decode the image data' }) };
    }

    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const storagePath = `${companyId}/${auth.employeeId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(storagePath, buffer, { contentType: mimeType });

    if (uploadError) return errorResponse(uploadError);

    const { data, error } = await supabase
      .from('job_site_photos')
      .insert({
        employee_id: auth.employeeId,
        company_id: companyId,
        job_location_id: jobLocationId || null,
        storage_path: storagePath,
        description: description || null,
        is_receipt: !!isReceipt,
        receipt_amount: isReceipt && receiptAmount ? Number(receiptAmount) : null,
      })
      .select()
      .single();

    if (error) {
      // Roll back the uploaded file if the metadata row failed to insert,
      // so we don't leave an orphaned, unreferenced file in storage.
      await supabase.storage.from(PHOTO_BUCKET).remove([storagePath]);
      return errorResponse(error);
    }

    return { statusCode: 201, body: JSON.stringify({ photo: data }) };
  }

  // ---------------- DELETE: remove a photo (the uploader or an admin) ----------------
  // ---------------- PATCH: edit photo metadata ----------------
  if (event.httpMethod === 'PATCH') {
    if (myRole.role === 'employee') return forbidden('Only foremen and admins can edit photos');
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }
    const { photoId, jobLocationId: newLocId, description: newDesc, receiptAmount: newAmount } = body;
    if (!photoId) return { statusCode: 400, body: JSON.stringify({ error: 'photoId is required' }) };
    const updateFields = { updated_at: new Date().toISOString() };
    if (newLocId !== undefined) updateFields.job_location_id = newLocId || null;
    if (newDesc !== undefined) updateFields.description = newDesc || null;
    if (newAmount !== undefined) updateFields.receipt_amount = newAmount ? Number(newAmount) : null;
    const { error } = await supabase.from('job_site_photos').update(updateFields).eq('id', photoId).eq('company_id', companyId);
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod === 'DELETE') {
    const params = event.queryStringParameters || {};
    const { photoId, companyId } = params;
    if (!photoId) return { statusCode: 400, body: JSON.stringify({ error: 'photoId is required' }) };
    if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };

    const { data: existing, error: fetchError } = await supabase
      .from('job_site_photos')
      .select('employee_id, company_id, storage_path')
      .eq('id', photoId)
      .maybeSingle();

    if (fetchError) return errorResponse(fetchError);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Photo not found' }) };
    if (existing.company_id !== companyId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This photo does not belong to the specified company' }) };
    }

    const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
    if (!myRole) return forbidden('You do not have access to this company');

    if (existing.employee_id !== auth.employeeId && myRole.role !== 'admin') {
      return forbidden('You can only delete your own photos unless you are an admin');
    }

    const { error: deleteRowError } = await supabase.from('job_site_photos').delete().eq('id', photoId);
    if (deleteRowError) return errorResponse(deleteRowError);

    await supabase.storage.from(PHOTO_BUCKET).remove([existing.storage_path]);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
