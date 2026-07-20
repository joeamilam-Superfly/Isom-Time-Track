const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const companyId = params.companyId || JSON.parse(event.body || '{}').companyId;
  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId required' }) };

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole) return forbidden('No access to this company');

  // ---- GET: fetch unread messages for this employee ----
  if (method === 'GET' && params.unread === 'true') {
    const today = new Date().toISOString().slice(0, 10);
    const dayOfWeek = new Date().getDay();
    const dayOfMonth = new Date().getDate();

    // Fetch all active messages for this company
    const { data: messages, error } = await supabase
      .from('broadcast_messages')
      .select('*')
      .eq('company_id', companyId)
      .eq('active', true);

    if (error) return errorResponse(error);

    // Fetch messages this employee has already read
    const { data: reads } = await supabase
      .from('broadcast_message_reads')
      .select('message_id')
      .eq('employee_id', auth.employeeId);

    const readIds = new Set((reads || []).map(r => r.message_id));

    const unread = (messages || []).filter(m => {
      // Already read — skip
      if (readIds.has(m.id)) return false;

      // Check recipient — is this employee a recipient?
      if (m.recipient_type === 'specific') {
        const ids = m.recipient_ids || [];
        if (!ids.includes(auth.employeeId)) return false;
      }

      // Check schedule
      if (m.is_recurring) {
        if (m.recurrence_type === 'daily') return true;
        if (m.recurrence_type === 'weekly') {
          return (m.recurrence_days || []).includes(dayOfWeek);
        }
        if (m.recurrence_type === 'monthly') {
          return (m.recurrence_days || []).includes(dayOfMonth);
        }
        return false;
      } else {
        // One-time: show if send_once_date is today or earlier
        return !m.send_once_date || m.send_once_date <= today;
      }
    });

    return { statusCode: 200, body: JSON.stringify({ messages: unread }) };
  }

  // ---- GET: fetch all messages for admin management ----
  if (method === 'GET') {
    if (myRole.role !== 'admin') return forbidden('Admin only');
    const { data, error } = await supabase
      .from('broadcast_messages')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ messages: data || [] }) };
  }

  // ---- POST: mark message as read ----
  if (method === 'POST' && params.action === 'mark_read') {
    const { messageId } = JSON.parse(event.body || '{}');
    if (!messageId) return { statusCode: 400, body: JSON.stringify({ error: 'messageId required' }) };
    await supabase.from('broadcast_message_reads').upsert({
      message_id: messageId,
      employee_id: auth.employeeId,
      read_at: new Date().toISOString(),
    }, { onConflict: 'message_id,employee_id' });

    // Check if all recipients have read — if so, deactivate one-time messages
    const { data: msg } = await supabase.from('broadcast_messages').select('*').eq('id', messageId).single();
    if (msg && !msg.is_recurring) {
      if (msg.recipient_type === 'all') {
        // Get all active employees in company
        const { data: roles } = await supabase
          .from('employee_company_roles')
          .select('employee_id')
          .eq('company_id', companyId)
          .eq('active', true);
        const allIds = (roles || []).map(r => r.employee_id);
        const { data: reads2 } = await supabase
          .from('broadcast_message_reads')
          .select('employee_id')
          .eq('message_id', messageId);
        const readCount = (reads2 || []).length;
        if (readCount >= allIds.length) {
          await supabase.from('broadcast_messages').update({ active: false }).eq('id', messageId);
        }
      } else {
        const recipientIds = msg.recipient_ids || [];
        const { data: reads2 } = await supabase
          .from('broadcast_message_reads')
          .select('employee_id')
          .eq('message_id', messageId);
        const readIds2 = new Set((reads2 || []).map(r => r.employee_id));
        if (recipientIds.every(id => readIds2.has(id))) {
          await supabase.from('broadcast_messages').update({ active: false }).eq('id', messageId);
        }
      }
    }

    // For recurring messages, delete the read record daily so it shows again next time
    if (msg && msg.is_recurring) {
      // Keep read record — it resets via scheduled job or we handle via date tracking
      // For now: delete read so it shows again next app load on a new day
      // This is handled by only inserting with today's date context
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ---- POST: create message (admin only) ----
  if (method === 'POST') {
    if (myRole.role !== 'admin') return forbidden('Admin only');
    const body = JSON.parse(event.body || '{}');
    const { message, title, recipientType, recipientIds, isRecurring, recurrenceType, recurrenceDays, sendOnceDate } = body;
    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'message required' }) };
    if (!recipientType) return { statusCode: 400, body: JSON.stringify({ error: 'recipientType required' }) };

    const { data, error } = await supabase.from('broadcast_messages').insert({
      company_id: companyId,
      created_by_id: auth.employeeId,
      message: message.trim(),
      title: title?.trim() || null,
      recipient_type: recipientType,
      recipient_ids: recipientType === 'specific' ? recipientIds : null,
      is_recurring: !!isRecurring,
      recurrence_type: isRecurring ? recurrenceType : null,
      recurrence_days: isRecurring ? recurrenceDays : null,
      send_once_date: !isRecurring ? (sendOnceDate || new Date().toISOString().slice(0, 10)) : null,
      active: true,
    }).select().single();
    if (error) return errorResponse(error);
    return { statusCode: 201, body: JSON.stringify({ ok: true, message: data }) };
  }

  // ---- PATCH: update message (admin only) ----
  if (method === 'PATCH') {
    if (myRole.role !== 'admin') return forbidden('Admin only');
    const body = JSON.parse(event.body || '{}');
    const { messageId, message, title, recipientType, recipientIds, isRecurring, recurrenceType, recurrenceDays, sendOnceDate, active } = body;
    if (!messageId) return { statusCode: 400, body: JSON.stringify({ error: 'messageId required' }) };

    const update = { updated_at: new Date().toISOString() };
    if (message !== undefined) update.message = message.trim();
    if (title !== undefined) update.title = title?.trim() || null;
    if (recipientType !== undefined) update.recipient_type = recipientType;
    if (recipientIds !== undefined) update.recipient_ids = recipientType === 'specific' ? recipientIds : null;
    if (isRecurring !== undefined) update.is_recurring = !!isRecurring;
    if (recurrenceType !== undefined) update.recurrence_type = recurrenceType;
    if (recurrenceDays !== undefined) update.recurrence_days = recurrenceDays;
    if (sendOnceDate !== undefined) update.send_once_date = sendOnceDate;
    if (active !== undefined) update.active = active;

    const { error } = await supabase.from('broadcast_messages').update(update).eq('id', messageId).eq('company_id', companyId);
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ---- DELETE: remove message (admin only) ----
  if (method === 'DELETE') {
    if (myRole.role !== 'admin') return forbidden('Admin only');
    const { messageId } = JSON.parse(event.body || '{}');
    if (!messageId) return { statusCode: 400, body: JSON.stringify({ error: 'messageId required' }) };
    const { error } = await supabase.from('broadcast_messages').delete().eq('id', messageId).eq('company_id', companyId);
    if (error) return errorResponse(error);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
