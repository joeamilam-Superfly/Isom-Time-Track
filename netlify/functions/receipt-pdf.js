const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');
const PDFDocument = require('pdfkit');

const PHOTO_BUCKET = 'job-site-photos';

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  const params = event.queryStringParameters || {};
  const companyId = params.companyId;
  const weekOf = params.weekOf; // Monday of the week, YYYY-MM-DD

  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
  if (!weekOf) return { statusCode: 400, body: JSON.stringify({ error: 'weekOf is required' }) };

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole || myRole.role !== 'admin') {
    return forbidden('Only admins can download the receipt PDF');
  }

  // Week range: Monday through Sunday
  const startDate = weekOf;
  const endDate = new Date(weekOf + 'T00:00:00Z');
  endDate.setUTCDate(endDate.getUTCDate() + 6);
  const endDateStr = endDate.toISOString().slice(0, 10);

  // Fetch all receipts for the week
  const { data: receipts, error } = await supabase
    .from('job_site_photos')
    .select('id, employee_id, storage_path, description, receipt_amount, taken_at, employees(first_name, last_name), job_locations(name)')
    .eq('company_id', companyId)
    .eq('is_receipt', true)
    .gte('taken_at', startDate + 'T00:00:00Z')
    .lte('taken_at', endDateStr + 'T23:59:59Z')
    .order('employees(last_name)', { ascending: true })
    .order('taken_at', { ascending: true });

  if (error) return errorResponse(error);

  if (!receipts || receipts.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No receipts found for this week', noReceipts: true }),
    };
  }

  const withData = receipts.map(r => ({
    ...r,
    employeeName: r.employees ? `${r.employees.first_name} ${r.employees.last_name}` : 'Unknown',
    locationName: r.job_locations?.name || 'No location',
    amount: r.receipt_amount ? Number(r.receipt_amount) : 0,
    date: r.taken_at ? r.taken_at.slice(0, 10) : '',
  }));

  // Build PDF — metadata only (no image embedding to stay within function timeout)
  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const pdfReady = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text('Receipt Report', { align: 'center' });
  doc.fontSize(12).font('Helvetica').text(`Week of ${weekOf} through ${endDateStr}`, { align: 'center' });
  doc.moveDown(0.5);

  // Grand total and per-employee summary
  const grandTotal = withData.reduce((sum, r) => sum + r.amount, 0);
  const byEmployee = {};
  for (const r of withData) {
    if (!byEmployee[r.employeeName]) byEmployee[r.employeeName] = 0;
    byEmployee[r.employeeName] += r.amount;
  }

  doc.moveTo(50, doc.y).lineTo(560, doc.y).stroke();
  doc.moveDown(0.5);
  doc.fontSize(13).font('Helvetica-Bold').text('Summary');
  doc.moveDown(0.25);
  for (const [name, total] of Object.entries(byEmployee).sort()) {
    doc.fontSize(11).font('Helvetica').text(name, 60, doc.y, { continued: true });
    doc.text(`$${total.toFixed(2)}`, { align: 'right' });
  }
  doc.moveDown(0.25);
  doc.moveTo(50, doc.y).lineTo(560, doc.y).stroke();
  doc.moveDown(0.25);
  doc.fontSize(12).font('Helvetica-Bold').text('Week Total', 60, doc.y, { continued: true });
  doc.text(`$${grandTotal.toFixed(2)}`, { align: 'right' });
  doc.moveDown(1);

  // Receipt detail lines
  doc.fontSize(13).font('Helvetica-Bold').text('Receipt Detail');
  doc.moveDown(0.5);

  for (const r of withData) {
    doc.moveTo(50, doc.y).lineTo(560, doc.y).stroke('#cccccc');
    doc.moveDown(0.25);
    doc.fontSize(11).font('Helvetica-Bold').text(r.employeeName, { continued: true });
    doc.font('Helvetica').fillColor('#16a34a').text(`  $${r.amount.toFixed(2)}`, { align: 'right' });
    doc.fillColor('#000000');
    doc.fontSize(10).font('Helvetica').fillColor('#666666').text(`${r.date}  |  ${r.locationName}`);
    if (r.description) doc.text(r.description);
    doc.fillColor('#000000');
    doc.moveDown(0.4);
  }

  doc.end();
  const pdfBuffer = await pdfReady;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="receipts-${weekOf}.pdf"`,
    },
    body: pdfBuffer.toString('base64'),
    isBase64Encoded: true,
  };
};
