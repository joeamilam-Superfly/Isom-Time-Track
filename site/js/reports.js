// Reports - admin only. Accessible from the Admin tab.
// Currently supports: Billing Report (labor + materials by location or employee).

let reportState = {
  period: 'month',
  periodValue: new Date().toISOString().slice(0, 7), // YYYY-MM
  groupBy: 'location',
  locationId: 'all',
  data: null,
};

async function renderReports() {
  const myRole = currentCompanyRole();
  if (myRole !== 'admin') return;

  // Fetch job locations directly - can't rely on state.jobLocations
  // since it's only populated when the Schedule tab has been visited
  let locations = [];
  try {
    const locData = await api(withCompany('/job-locations'));
    locations = locData.locations || [];
  } catch (err) {
    console.error('Could not load job locations for reports:', err);
  }

  // Build period value selectors
  const today = new Date();
  const currentYear = today.getFullYear();
  const months = [];
  for (let y = currentYear; y >= currentYear - 2; y--) {
    for (let m = 12; m >= 1; m--) {
      if (y === currentYear && m > today.getMonth() + 1) continue;
      months.push(`${y}-${String(m).padStart(2,'0')}`);
    }
  }
  const years = [currentYear, currentYear - 1, currentYear - 2].map(y => y.toString());

  root.innerHTML = `
    ${topbarHtml()}
    <main>
      ${roleTabsHtml('reports')}
      <div class="screen-title">Reports</div>

      <div style="background:#1a1a1a; border-radius:12px; padding:20px; margin-bottom:16px; color:#fff;">
        <div style="font-weight:700; font-size:15px; margin-bottom:12px;">Billing Report</div>

        <div class="field">
          <label style="color:#fff;">Time period</label>
          <div style="display:flex; gap:8px; margin-bottom:8px;">
            ${['week','month','year'].map(p => {
              const active = reportState.period === p;
              return `<button data-period-type="${p}" style="flex:1; padding:12px; border-radius:8px; border:1.5px solid ${active ? '#c47c1e' : 'rgba(255,255,255,0.3)'}; background:${active ? '#c47c1e' : 'transparent'}; color:#fff; font-size:14px; font-weight:${active ? '700' : '400'}; cursor:pointer;">
                ${p.charAt(0).toUpperCase() + p.slice(1)}
              </button>`;
            }).join('')}
          </div>
          <div id="period-value-container"></div>
        </div>

        <div class="field">
          <label for="report-location" style="color:#fff;">Job location</label>
          <select id="report-location">
            <option value="all">All locations</option>
            ${locations.map(l => `<option value="${l.id}" ${reportState.locationId === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
          </select>
        </div>

        <div class="field">
          <label style="color:#fff;">Group by</label>
          <div style="display:flex; gap:8px;">
            ${['location','employee'].map(g => {
              const active = reportState.groupBy === g;
              const label = g === 'location' ? 'Job Location' : 'Employee';
              return `<button data-groupby="${g}" style="flex:1; padding:12px; border-radius:8px; border:1.5px solid ${active ? '#c47c1e' : 'rgba(255,255,255,0.3)'}; background:${active ? '#c47c1e' : 'transparent'}; color:#fff; font-size:14px; font-weight:${active ? '700' : '400'}; cursor:pointer;">${label}</button>`;
            }).join('')}
          </div>
        </div>

        <button class="btn btn-amber" id="run-report-btn" style="margin-top:4px;">Run report</button>
      </div>

      <div id="report-output"></div>

      <div style="margin-top:24px;border-top:1px solid var(--line);padding-top:20px;">
        <div id="wo-search-section"></div>
      </div>
    </main>
  `;

  attachTopbarHandlers();
  attachRoleTabHandlers();
  renderPeriodValueSelector();
  renderWorkOrderSearch(document.getElementById('wo-search-section'));

  document.querySelectorAll('[data-period-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      reportState.period = btn.getAttribute('data-period-type');
      // Reset period value to current when switching type
      if (reportState.period === 'month') reportState.periodValue = today.toISOString().slice(0, 7);
      if (reportState.period === 'year') reportState.periodValue = String(currentYear);
      if (reportState.period === 'week') {
        // Default to current week Monday
        const d = new Date();
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        reportState.periodValue = d.toISOString().slice(0, 10);
      }
      render('reports');
    });
  });

  document.querySelectorAll('[data-groupby]').forEach(btn => {
    btn.addEventListener('click', () => {
      reportState.groupBy = btn.getAttribute('data-groupby');
      render('reports');
    });
  });

  document.getElementById('report-location').addEventListener('change', e => {
    reportState.locationId = e.target.value;
  });

  document.getElementById('run-report-btn').addEventListener('click', runBillingReport);
}

function renderPeriodValueSelector() {
  const container = document.getElementById('period-value-container');
  if (!container) return;
  const today = new Date();
  const currentYear = today.getFullYear();

  if (reportState.period === 'week') {
    container.innerHTML = `<input id="period-week" type="date" value="${reportState.periodValue}" style="width:100%;" />`;
    document.getElementById('period-week').addEventListener('change', e => {
      // Snap to Monday of selected week
      const d = new Date(e.target.value + 'T00:00:00');
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      reportState.periodValue = d.toISOString().slice(0, 10);
    });
  } else if (reportState.period === 'month') {
    const months = [];
    for (let y = currentYear; y >= currentYear - 2; y--) {
      for (let m = 12; m >= 1; m--) {
        if (y === currentYear && m > today.getMonth() + 1) continue;
        months.push(`${y}-${String(m).padStart(2,'0')}`);
      }
    }
    container.innerHTML = `
      <select id="period-month">
        ${months.map(m => `<option value="${m}" ${reportState.periodValue === m ? 'selected' : ''}>${m}</option>`).join('')}
      </select>`;
    document.getElementById('period-month').addEventListener('change', e => { reportState.periodValue = e.target.value; });
  } else {
    const years = [currentYear, currentYear-1, currentYear-2];
    container.innerHTML = `
      <select id="period-year">
        ${years.map(y => `<option value="${y}" ${reportState.periodValue === String(y) ? 'selected' : ''}>${y}</option>`).join('')}
      </select>`;
    document.getElementById('period-year').addEventListener('change', e => { reportState.periodValue = e.target.value; });
  }
}

async function runBillingReport() {
  const btn = document.getElementById('run-report-btn');
  const output = document.getElementById('report-output');
  btn.disabled = true;
  btn.textContent = 'Running...';
  output.innerHTML = loadingHtml();

  try {
    const params = new URLSearchParams({
      companyId: state.activeCompanyId,
      reportType: 'billing',
      groupBy: reportState.groupBy,
      period: reportState.period,
      periodValue: reportState.periodValue,
      locationId: reportState.locationId,
    });

    const data = await api(`/reports?${params}`);
    reportState.data = data;
    renderBillingReportOutput(data, output);
  } catch (err) {
    output.innerHTML = errorHtml(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run report';
  }
}

function renderBillingReportOutput(data, container) {
  const { groups, totals, startDate, endDate, groupBy, unassigned, receiptByEmp } = data;

  function dollars(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function hours(n) { return Number(n || 0).toFixed(2) + 'h'; }
  function budgetBar(spent, budget, label) {
    if (budget == null) return '';
    const pct = Math.min(Math.round((spent / budget) * 100), 100);
    const color = spent > budget ? '#e53e3e' : pct >= 70 ? '#d97706' : '#16a34a';
    const remaining = budget - spent;
    return `
      <div style="margin-top:6px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
          <span style="color:var(--ink-soft);">${label} budget</span>
          <span style="color:${color};font-weight:600;">${dollars(spent)} / ${dollars(budget)} (${pct}%)</span>
        </div>
        <div style="background:var(--line);border-radius:3px;height:5px;overflow:hidden;">
          <div style="background:${color};width:${pct}%;height:100%;border-radius:3px;"></div>
        </div>
        <div style="font-size:10px;color:var(--ink-soft);margin-top:2px;">${dollars(Math.max(remaining,0))} remaining${remaining < 0 ? ' — OVER BUDGET' : ''}</div>
      </div>`;
  }

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;">
      <div style="font-weight:700;font-size:15px;">Billing Report</div>
      <div style="font-size:12px;color:var(--ink-soft);">${startDate} to ${endDate}</div>
    </div>

    <!-- Totals summary -->
    <div class="summary-card" style="margin-bottom:16px;background:var(--ink);color:#fff;">
      <div class="summary-row" style="border-color:rgba(255,255,255,0.15);">
        <span style="color:rgba(255,255,255,0.7);">Total labor hours</span>
        <span style="font-weight:700;">${hours(totals.laborHours)}</span>
      </div>
      <div class="summary-row" style="border-color:rgba(255,255,255,0.15);">
        <span style="color:rgba(255,255,255,0.7);">Total labor billed</span>
        <span style="font-weight:700;">${dollars(totals.laborDollars)}</span>
      </div>
      <div class="summary-row" style="border-color:rgba(255,255,255,0.15);">
        <span style="color:rgba(255,255,255,0.7);">Total materials</span>
        <span style="font-weight:700;">${dollars(totals.materialsDollars)}</span>
      </div>
      <div class="summary-row total" style="border-color:rgba(255,255,255,0.2);border-top-width:2px;">
        <span style="color:#fff;font-weight:700;">Total billed</span>
        <span style="font-weight:700;font-size:18px;">${dollars(totals.totalDollars)}</span>
      </div>
    </div>`;

  if (groupBy === 'location') {
    if (groups.length === 0) {
      html += `<div class="empty-state"><div class="icon">📊</div>No billable activity for this period.</div>`;
    } else {
      html += groups.map(g => `
        <div class="summary-card" style="margin-bottom:12px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;">${escapeHtml(g.locationName)}</div>
          <div class="summary-row"><span class="label">Labor hours</span><span class="value">${hours(g.laborHours)}</span></div>
          <div class="summary-row"><span class="label">Labor billed</span><span class="value">${dollars(g.laborDollars)}</span></div>
          <div class="summary-row"><span class="label">Materials</span><span class="value">${dollars(g.materialsDollars)}</span></div>
          <div class="summary-row total"><span class="label">Total</span><span class="value">${dollars(g.totalDollars)}</span></div>
          ${budgetBar(g.laborDollars, g.budgetLabor, 'Labor')}
          ${budgetBar(g.materialsDollars, g.budgetMaterials, 'Materials')}
          ${g.employees.length > 0 ? `
            <details style="margin-top:10px;">
              <summary style="font-size:12px;font-weight:600;cursor:pointer;color:var(--ink-soft);">Employees (${g.employees.length})</summary>
              <div style="margin-top:8px;">
                ${g.employees.map(e => `
                  <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--line);">
                    <span>${escapeHtml(e.name)}</span>
                    <span>${hours(e.hours)} &middot; ${dollars(e.dollars)}${e.rate ? ` @ $${e.rate}/hr` : ''}</span>
                  </div>`).join('')}
              </div>
            </details>` : ''}
          ${g.locationId && g.locationId !== 'unassigned' ? `
            <div id="receipts-${g.locationId}" style="margin-top:8px;">
              <button class="btn btn-sm btn-ghost" style="font-size:11px;width:100%;" data-load-receipts="${g.locationId}">View receipts for this location</button>
            </div>` : ''}
        </div>`).join('');
    }
  } else {
    // Employee view with foreman hierarchy
    if (groups.length === 0 && (!unassigned || unassigned.length === 0)) {
      html += `<div class="empty-state"><div class="icon">📊</div>No billable activity for this period.</div>`;
    } else {
      html += groups.map(g => `
        <div class="summary-card" style="margin-bottom:12px;">
          <div style="background:var(--ink);color:#fff;border-radius:6px;padding:8px 10px;margin-bottom:10px;">
            <div style="font-weight:700;font-size:13px;">${escapeHtml(g.foreman?.name || 'Unknown')} <span style="font-weight:400;opacity:0.7;">(Foreman)</span></div>
            <div style="font-size:12px;opacity:0.8;margin-top:2px;">Team: ${hours(g.teamHours)} &middot; ${dollars(g.teamDollars)}</div>
          </div>
          ${[g.foreman, ...g.crew].filter(Boolean).map(e => `
            <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--line);">
              <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600;">
                <span>${escapeHtml(e.name)}</span>
                <span>${dollars(e.dollars)}</span>
              </div>
              <div style="font-size:11px;color:var(--ink-soft);">${hours(e.hours)}${e.billRate ? ` @ $${e.billRate}/hr` : ' (no bill rate set)'}</div>
              ${e.locations?.length > 0 ? e.locations.map(l => `
                <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-soft);padding-left:12px;margin-top:2px;">
                  <span>${escapeHtml(l.name)}</span><span>${hours(l.hours)} &middot; ${dollars(l.dollars)}</span>
                </div>`).join('') : ''}
            </div>`).join('')}
        </div>`).join('');

      if (unassigned && unassigned.length > 0) {
        html += `
          <div class="summary-card" style="margin-bottom:12px;">
            <div style="font-weight:700;font-size:13px;margin-bottom:10px;color:var(--ink-soft);">Unassigned</div>
            ${unassigned.map(e => `
              <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--line);">
                <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600;">
                  <span>${escapeHtml(e.name)}</span><span>${dollars(e.dollars)}</span>
                </div>
                <div style="font-size:11px;color:var(--ink-soft);">${hours(e.hours)}${e.billRate ? ` @ $${e.billRate}/hr` : ' (no bill rate set)'}</div>
              </div>`).join('')}
          </div>`;
      }
    }
  }

  // Export buttons
  html += `
    <div class="btn-row" style="margin-top:16px;">
      <button class="btn btn-ghost" id="report-csv-btn">Download CSV</button>
      <button class="btn btn-ghost" id="report-pdf-btn">Download PDF</button>
    </div>`;

  container.innerHTML = html;

  document.getElementById('report-csv-btn').addEventListener('click', () => downloadReportCsv(data));
  document.getElementById('report-pdf-btn').addEventListener('click', () => downloadReportPdf(data));

  // Wire receipt view buttons for each location
  container.querySelectorAll('[data-load-receipts]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const locId = btn.getAttribute('data-load-receipts');
      const receiptEl = document.getElementById(`receipts-${locId}`);
      if (!receiptEl) return;
      btn.disabled = true;
      btn.textContent = 'Loading...';
      try {
        const rData = await api(withCompany(`/job-photos?jobLocationId=${locId}&receiptsOnly=true`));
        const receipts = rData.photos || [];
        if (receipts.length === 0) {
          receiptEl.innerHTML = `<div style="font-size:12px;color:var(--ink-soft);padding:6px 0;">No receipts for this location in this period.</div>`;
          return;
        }
        receiptEl.innerHTML = `
          <div style="font-size:12px;font-weight:600;margin:8px 0 6px;">Receipts (${receipts.length})</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            ${receipts.map(r => `
              <div style="border:1px solid var(--line);border-radius:6px;overflow:hidden;">
                ${r.url ? `<img src="${r.url}" style="width:100%;display:block;max-height:120px;object-fit:cover;" />` : ''}
                <div style="padding:4px 6px;">
                  <div style="font-size:11px;font-weight:600;color:#16a34a;">${r.receiptAmount ? '$' + Number(r.receiptAmount).toFixed(2) : 'No amount'}</div>
                  <div style="font-size:10px;color:var(--ink-soft);">${escapeHtml(r.employeeName || '')} &middot; ${r.takenAt ? r.takenAt.slice(0,10) : ''}</div>
                  ${r.description ? `<div style="font-size:10px;color:var(--ink-soft);">${escapeHtml(r.description)}</div>` : ''}
                </div>
              </div>`).join('')}
          </div>`;
      } catch (err) {
        receiptEl.innerHTML = errorHtml(err.message);
      }
    });
  });
}

function downloadReportCsv(data) {
  const { groups, totals, startDate, endDate, groupBy, unassigned } = data;
  function csvEscape(v) { const s = String(v == null ? '' : v); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s; }
  function d(n) { return Number(n||0).toFixed(2); }
  const rows = [
    [`Billing Report — ${startDate} to ${endDate}`],
    [`Grouped by: ${groupBy}`],
    [],
    ['Total Labor Hours', d(totals.laborHours)],
    ['Total Labor Billed', d(totals.laborDollars)],
    ['Total Materials', d(totals.materialsDollars)],
    ['Total Billed', d(totals.totalDollars)],
    [],
  ];

  if (groupBy === 'location') {
    rows.push(['Job Location', 'Labor Hours', 'Labor $', 'Materials $', 'Total $', 'Labor Budget', 'Labor Remaining', 'Materials Budget', 'Materials Remaining']);
    for (const g of groups) {
      rows.push([g.locationName, d(g.laborHours), d(g.laborDollars), d(g.materialsDollars), d(g.totalDollars),
        g.budgetLabor != null ? d(g.budgetLabor) : '', g.laborBudgetRemaining != null ? d(g.laborBudgetRemaining) : '',
        g.budgetMaterials != null ? d(g.budgetMaterials) : '', g.materialsBudgetRemaining != null ? d(g.materialsBudgetRemaining) : '']);
      for (const e of g.employees) {
        rows.push(['  ' + e.name, d(e.hours), d(e.dollars), '', '', '', '', '', '']);
      }
      rows.push([]);
    }
  } else {
    rows.push(['Foreman / Employee', 'Hours', 'Bill Rate', 'Labor $', 'Job Locations']);
    for (const g of groups) {
      rows.push([`${g.foreman?.name} (Foreman) — Team total`, d(g.teamHours), '', d(g.teamDollars), '']);
      for (const e of [g.foreman, ...g.crew].filter(Boolean)) {
        rows.push([`  ${e.name}`, d(e.hours), e.billRate ? `$${e.billRate}/hr` : 'not set', d(e.dollars),
          (e.locations || []).map(l => `${l.name}: ${d(l.hours)}h`).join('; ')]);
      }
      rows.push([]);
    }
    if (unassigned?.length > 0) {
      rows.push(['Unassigned']);
      for (const e of unassigned) {
        rows.push([`  ${e.name}`, d(e.hours), e.billRate ? `$${e.billRate}/hr` : 'not set', d(e.dollars), '']);
      }
    }
  }

  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `billing-report-${startDate}-to-${endDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function downloadReportPdf(data) {
  const { groups, totals, startDate, endDate, groupBy, unassigned } = data;
  function d(n) { return '$' + Number(n||0).toLocaleString('en-US', {minimumFractionDigits:2}); }
  function h(n) { return Number(n||0).toFixed(2) + 'h'; }

  let body = `
    <h1 style="font-size:18px; margin-bottom:4px;">Billing Report</h1>
    <p style="color:#666; margin-bottom:16px;">${startDate} to ${endDate} &middot; Grouped by ${groupBy}</p>
    <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
      <tr style="background:#222; color:#fff;">
        <td style="padding:8px;">Total Labor Hours</td><td style="padding:8px; text-align:right;">${h(totals.laborHours)}</td>
      </tr>
      <tr style="background:#f5f5f5;">
        <td style="padding:8px;">Total Labor Billed</td><td style="padding:8px; text-align:right;">${d(totals.laborDollars)}</td>
      </tr>
      <tr>
        <td style="padding:8px;">Total Materials</td><td style="padding:8px; text-align:right;">${d(totals.materialsDollars)}</td>
      </tr>
      <tr style="background:#222; color:#fff; font-weight:bold;">
        <td style="padding:8px;">Total Billed</td><td style="padding:8px; text-align:right; font-size:16px;">${d(totals.totalDollars)}</td>
      </tr>
    </table>`;

  if (groupBy === 'location') {
    for (const g of groups) {
      body += `
        <div style="margin-bottom:16px; break-inside:avoid;">
          <h3 style="margin-bottom:6px; font-size:14px;">${g.locationName}</h3>
          <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <tr><td style="padding:4px 8px; background:#f5f5f5;">Labor hours</td><td style="padding:4px 8px; text-align:right;">${h(g.laborHours)}</td></tr>
            <tr><td style="padding:4px 8px;">Labor billed</td><td style="padding:4px 8px; text-align:right;">${d(g.laborDollars)}</td></tr>
            <tr><td style="padding:4px 8px; background:#f5f5f5;">Materials</td><td style="padding:4px 8px; text-align:right;">${d(g.materialsDollars)}</td></tr>
            <tr style="font-weight:bold;"><td style="padding:4px 8px;">Total</td><td style="padding:4px 8px; text-align:right;">${d(g.totalDollars)}</td></tr>
            ${g.budgetLabor != null ? `<tr><td style="padding:4px 8px; color:#666;">Labor budget remaining</td><td style="padding:4px 8px; text-align:right; color:${g.laborBudgetRemaining < 0 ? '#e53e3e' : '#16a34a'};">${d(g.laborBudgetRemaining)}</td></tr>` : ''}
            ${g.budgetMaterials != null ? `<tr><td style="padding:4px 8px; color:#666;">Materials budget remaining</td><td style="padding:4px 8px; text-align:right; color:${g.materialsBudgetRemaining < 0 ? '#e53e3e' : '#16a34a'};">${d(g.materialsBudgetRemaining)}</td></tr>` : ''}
          </table>
          ${g.employees.map(e => `<div style="padding:2px 8px; font-size:11px; color:#666;">${e.name}: ${h(e.hours)} @ ${e.rate ? '$'+e.rate+'/hr' : 'no rate'} = ${d(e.dollars)}</div>`).join('')}
        </div>`;
    }
  } else {
    for (const g of groups) {
      body += `
        <div style="margin-bottom:16px; break-inside:avoid;">
          <h3 style="margin-bottom:6px; font-size:14px; background:#222; color:#fff; padding:6px 8px;">${g.foreman?.name} (Foreman) — ${h(g.teamHours)} &middot; ${d(g.teamDollars)}</h3>
          ${[g.foreman, ...g.crew].filter(Boolean).map(e => `
            <div style="padding:4px 8px; border-bottom:1px solid #eee; font-size:12px; display:flex; justify-content:space-between;">
              <span>${e.name}${e.billRate ? ' @ $'+e.billRate+'/hr' : ''}</span>
              <span>${h(e.hours)} = ${d(e.dollars)}</span>
            </div>`).join('')}
        </div>`;
    }
  }

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html><html><head>
    <title>Billing Report ${startDate} to ${endDate}</title>
    <style>body{font-family:Arial,sans-serif;padding:20px;max-width:800px;margin:0 auto;} @media print{button{display:none;}}</style>
    </head><body>
    <button onclick="window.print()" style="margin-bottom:16px;padding:8px 16px;background:#222;color:#fff;border:none;border-radius:4px;cursor:pointer;">Print / Save as PDF</button>
    ${body}
    </body></html>`);
  win.document.close();
}

// ---- Work Order Search ----
// Added at the bottom of the Reports tab for admins.
// Searches by WO number or invoice number across all statuses.

async function renderWorkOrderSearch(container) {
  if (!container) return;
  container.innerHTML = `
    <div style="font-weight:700;font-size:16px;margin-bottom:12px;">Work Order Search</div>
    <div class="field">
      <label for="wo-search-input">Search by WO number or invoice number</label>
      <input id="wo-search-input" type="text" placeholder="e.g. 8821 or INV-2026-0042" />
    </div>
    <button class="btn btn-amber" id="wo-search-btn" style="margin-bottom:16px;">Search</button>
    <div id="wo-search-results"></div>
  `;

  const doSearch = async () => {
    const query = container.querySelector('#wo-search-input').value.trim();
    const resultsEl = container.querySelector('#wo-search-results');
    if (!query) { resultsEl.innerHTML = ''; return; }

    resultsEl.innerHTML = loadingHtml();
    try {
      const data = await api(withCompany(`/work-orders?includeCompleted=true&search=${encodeURIComponent(query)}`));
      const wos = data.workOrders || [];

      if (wos.length === 0) {
        resultsEl.innerHTML = `<div class="empty-state"><div class="icon">🔍</div>No work orders found for "${escapeHtml(query)}".</div>`;
        return;
      }

      resultsEl.innerHTML = wos.map(wo => {
        const statusLabel = { open: 'Open', submitted: 'Pending review', ready_to_bill: 'Ready to bill', billed: 'Billed' }[wo.status] || wo.status;
        const statusColor = { open: 'var(--amber-dark)', submitted: '#7c3aed', ready_to_bill: '#16a34a', billed: 'var(--ink-soft)' }[wo.status];
        return `
          <div class="day-stub" style="margin-bottom:10px;cursor:pointer;" data-wo-search-view="${wo.id}">
            <div class="day-stub-perf" style="background:${statusColor};"></div>
            <div class="day-stub-body">
              <div class="day-stub-top">
                <div class="day-stub-date">WO# ${escapeHtml(wo.woNumber)}</div>
                <div style="font-size:12px;color:${statusColor};font-weight:600;">${statusLabel}</div>
              </div>
              <div class="day-stub-meta">
                ${wo.jobLocation ? `<span>${escapeHtml(wo.jobLocation.name)}</span>` : ''}
                ${wo.assignedTo ? `<span>${escapeHtml(wo.assignedTo.name)}</span>` : ''}
                ${wo.scheduledDate ? `<span>Scheduled: ${wo.scheduledDate}</span>` : ''}
              </div>
              ${wo.invoiceNumber ? `<div style="font-size:12px;margin-top:4px;color:#16a34a;font-weight:600;">Invoice #${escapeHtml(wo.invoiceNumber)}</div>` : ''}
              ${wo.completedAt ? `<div style="font-size:12px;color:var(--ink-soft);margin-top:2px;">Completed: ${wo.completedAt.slice(0,10)}</div>` : ''}
              ${wo.details ? `<div style="font-size:11px;color:var(--ink-soft);margin-top:4px;white-space:pre-line;overflow:hidden;text-overflow:ellipsis;max-height:48px;">${escapeHtml(wo.details)}</div>` : ''}
              <div style="font-size:12px;color:var(--ink-soft);margin-top:6px;">Tap to view full details &rarr;</div>
            </div>
          </div>
        `;
      }).join('');

      resultsEl.querySelectorAll('[data-wo-search-view]').forEach(card => {
        card.addEventListener('click', () => showWorkOrderDetail(card.getAttribute('data-wo-search-view'), wos));
      });
    } catch (err) {
      resultsEl.innerHTML = errorHtml(err.message);
    }
  };

  container.querySelector('#wo-search-btn').addEventListener('click', doSearch);
  container.querySelector('#wo-search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
  });
}
