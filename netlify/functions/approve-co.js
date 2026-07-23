const { supabase } = require('./_company-role');

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const token = params.token;

  if (!token) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: errorPage('Invalid link', 'This approval link is missing required information.') };
  }

  // Look up the change order by token
  const { data: co, error } = await supabase
    .from('change_orders')
    .select('*, change_order_materials(*)')
    .eq('approval_token', token)
    .single();

  if (error || !co) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: errorPage('Link Not Found', 'This approval link is invalid or has already been used.') };
  }

  if (new Date(co.approval_token_expires_at) < new Date()) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: errorPage('Link Expired', 'This approval link has expired. Please contact Isom Electric for a new link.') };
  }

  if (co.status === 'approved') {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: successPage(co.co_number, co.approver_name, co.approved_at) };
  }

  // Handle POST approval submission
  if (event.httpMethod === 'POST') {
    const params2 = new URLSearchParams(event.body || '');
    const approverName = params2.get('approver_name')?.trim();
    if (!approverName) {
      return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: approvalPage(co, token, 'Please enter your name before approving.') };
    }

    await supabase.from('change_orders').update({
      status: 'approved',
      approver_name: approverName,
      approved_at: new Date().toISOString(),
      approval_method: 'remote_email',
      approval_token: null,
      updated_at: new Date().toISOString(),
    }).eq('id', co.id);

    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: successPage(co.co_number, approverName, new Date().toISOString()) };
  }

  // Show approval page
  return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: approvalPage(co, token, null) };
};

function approvalPage(co, token, errorMsg) {
  const matRows = (co.change_order_materials || []).map(m =>
    `<tr><td>${m.part_number || ''}</td><td>${m.name}</td><td>${m.quantity} ${m.unit}</td><td>${m.unit_cost ? '$' + Number(m.unit_cost).toFixed(2) : '—'}</td><td>${m.line_total ? '$' + Number(m.line_total).toFixed(2) : '—'}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Approve Change Order — ${co.co_number}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; color: #1a1208; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
    th { background: #1a1208; color: #C47C1E; padding: 8px 10px; text-align: left; }
    td { padding: 7px 10px; border-bottom: 1px solid #eee; }
    .legal { background: #fef3c7; border: 1px solid #fbbf24; border-radius: 8px; padding: 14px; margin: 20px 0; font-size: 13px; }
    input[type=text] { width: 100%; padding: 10px 12px; border: 1.5px solid #ddd; border-radius: 8px; font-size: 15px; box-sizing: border-box; margin-bottom: 12px; }
    button { background: #1a1208; color: #C47C1E; border: none; padding: 14px 28px; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; width: 100%; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #dc2626; margin-bottom: 12px; font-weight: 600; }
    .logo { font-weight: 900; font-size: 20px; color: #dc2626; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="logo">ISOM ELECTRIC</div>
  <h1>Change Order Approval</h1>
  <div class="subtitle">${co.co_number}</div>

  ${co.description ? `<p><strong>Description:</strong> ${co.description}</p>` : ''}

  ${matRows ? `
  <table>
    <thead><tr><th>Part #</th><th>Item</th><th>Qty</th><th>Unit Cost</th><th>Total</th></tr></thead>
    <tbody>${matRows}</tbody>
  </table>` : ''}

  <div class="legal">
    <strong>By approving this change order, you acknowledge and agree to pay for all labor and materials listed above. This constitutes a binding agreement for the additional work described.</strong>
  </div>

  ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}

  <form method="POST" action="/approve-co?token=${token}">
    <label style="font-weight:700;display:block;margin-bottom:6px;">Your full name *</label>
    <input type="text" name="approver_name" placeholder="Type your full name" required id="name-input" />
    <button type="submit" id="approve-btn" disabled>I Approve This Change Order</button>
  </form>

  <script>
    const input = document.getElementById('name-input');
    const btn = document.getElementById('approve-btn');
    input.addEventListener('input', () => { btn.disabled = input.value.trim().length < 2; });
  </script>
</body>
</html>`;
}

function successPage(coNumber, approverName, approvedAt) {
  const date = new Date(approvedAt).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Approved — ${coNumber}</title>
  <style>body { font-family: Arial, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; text-align: center; color: #1a1208; } .check { font-size: 60px; } h1 { color: #16a34a; } .logo { font-weight: 900; font-size: 20px; color: #dc2626; margin-bottom: 30px; }</style>
</head>
<body>
  <div class="logo">ISOM ELECTRIC</div>
  <div class="check">✅</div>
  <h1>Change Order Approved</h1>
  <p><strong>${coNumber}</strong> has been approved by <strong>${approverName}</strong>.</p>
  <p style="color:#666;font-size:13px;">${date}</p>
  <p style="color:#666;font-size:13px;">Isom Electric has been notified. You may close this page.</p>
</body>
</html>`;
}

function errorPage(title, message) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>body { font-family: Arial, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; text-align: center; color: #1a1208; } .logo { font-weight: 900; font-size: 20px; color: #dc2626; margin-bottom: 30px; }</style>
</head>
<body>
  <div class="logo">ISOM ELECTRIC</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <p style="color:#666;font-size:13px;">Please contact Isom Electric if you need assistance.</p>
</body>
</html>`;
}
