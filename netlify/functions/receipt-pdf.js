const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  const params = event.queryStringParameters || {};
  const companyId = params.companyId;
  const weekOf = params.weekOf;

  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
  if (!weekOf) return { statusCode: 400, body: JSON.stringify({ error: 'weekOf is required' }) };

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole || myRole.role !== 'admin') return forbidden('Only admins can download the receipt report');

  const endDate = new Date(weekOf + 'T00:00:00Z');
  endDate.setUTCDate(endDate.getUTCDate() + 6);
  const endDateStr = endDate.toISOString().slice(0, 10);

  const { data: receipts, error } = await supabase
    .from('job_site_photos')
    .select('id, storage_path, description, receipt_amount, taken_at, employees(first_name, last_name), job_locations(name)')
    .eq('company_id', companyId)
    .eq('is_receipt', true)
    .gte('taken_at', weekOf + 'T00:00:00Z')
    .lte('taken_at', endDateStr + 'T23:59:59Z')
    .order('taken_at', { ascending: true });

  if (error) return errorResponse(error);

  if (!receipts || receipts.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No receipts found for this week', noReceipts: true }),
    };
  }

  // Get signed URLs for images
  const withUrls = await Promise.all(receipts.map(async (r) => {
    const { data: signed } = await supabase.storage
      .from('job-site-photos')
      .createSignedUrl(r.storage_path, 3600);
    return {
      employeeName: r.employees ? `${r.employees.first_name} ${r.employees.last_name}` : 'Unknown',
      locationName: r.job_locations?.name || 'No location',
      amount: r.receipt_amount ? Number(r.receipt_amount) : 0,
      date: r.taken_at ? r.taken_at.slice(0, 10) : '',
      description: r.description || '',
      imageUrl: signed?.signedUrl || null,
    };
  }));

  const grandTotal = withUrls.reduce((sum, r) => sum + r.amount, 0);
  const byEmployee = {};
  for (const r of withUrls) {
    if (!byEmployee[r.employeeName]) byEmployee[r.employeeName] = 0;
    byEmployee[r.employeeName] += r.amount;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Receipt Report — ${weekOf}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; margin: 0; padding: 20px; }
    h1 { font-size: 20px; text-align: center; margin-bottom: 4px; }
    .subtitle { text-align: center; color: #666; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { background: #1a1208; color: #fff; padding: 8px 10px; text-align: left; font-size: 11px; }
    td { padding: 7px 10px; border-bottom: 1px solid #e5e5e5; }
    .total-row td { font-weight: bold; background: #f5f5f5; }
    .grand-total td { font-weight: bold; font-size: 14px; background: #1a1208; color: #C47C1E; }
    .amount { text-align: right; color: #16a34a; font-weight: 600; }
    .receipt-card { page-break-inside: avoid; border: 1px solid #ddd; border-radius: 6px; padding: 12px; margin-bottom: 16px; }
    .receipt-card img { width: 100%; max-height: 400px; object-fit: contain; margin-top: 8px; border-radius: 4px; }
    .receipt-header { display: flex; justify-content: space-between; align-items: flex-start; }
    .receipt-name { font-weight: bold; font-size: 13px; }
    .receipt-amount { font-size: 15px; font-weight: bold; color: #16a34a; }
    .receipt-meta { color: #666; font-size: 11px; margin-top: 2px; }
    @media print {
      body { padding: 10px; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="text-align:center;margin-bottom:16px;">
    <button onclick="window.print()" style="background:#C47C1E;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:14px;cursor:pointer;">🖨 Print / Save as PDF</button>
  </div>

  <h1>Receipt Report</h1>
  <div class="subtitle">Week of ${weekOf} through ${endDateStr}</div>

  <table>
    <thead><tr><th>Employee</th><th style="text-align:right;">Total</th></tr></thead>
    <tbody>
      ${Object.entries(byEmployee).sort().map(([name, total]) => `
        <tr><td>${name}</td><td class="amount">$${total.toFixed(2)}</td></tr>
      `).join('')}
      <tr class="grand-total"><td>WEEK TOTAL</td><td class="amount" style="color:#C47C1E;">$${grandTotal.toFixed(2)}</td></tr>
    </tbody>
  </table>

  <h2 style="font-size:14px;margin-bottom:12px;">Receipt Detail (${withUrls.length})</h2>
  ${withUrls.map(r => `
    <div class="receipt-card">
      <div class="receipt-header">
        <div>
          <div class="receipt-name">${r.employeeName}</div>
          <div class="receipt-meta">${r.date} &middot; ${r.locationName}</div>
          ${r.description ? `<div class="receipt-meta">${r.description}</div>` : ''}
        </div>
        <div class="receipt-amount">$${r.amount.toFixed(2)}</div>
      </div>
      ${r.imageUrl ? `<img src="${r.imageUrl}" alt="Receipt" />` : '<div style="color:#999;font-size:11px;margin-top:6px;">No image</div>'}
    </div>
  `).join('')}
</body>
</html>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };
};
