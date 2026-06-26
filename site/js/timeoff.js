async function renderTimeOff(opts) {
  root.innerHTML = `
    ${topbarHtml()}
    <main>
      ${roleTabsHtml('timeoff')}
      <div class="screen-title">Leave</div>
      <div class="screen-sub">Request leave and track your balance.</div>
      <div id="pto-balance-card">${loadingHtml()}</div>
      <div id="pto-pending-section"></div>
      <div id="pto-my-requests">${loadingHtml()}</div>
    </main>
    <div class="bottom-bar">
      <button class="btn btn-amber" id="new-pto-btn">+ Request time off</button>
    </div>
  `;

  attachTopbarHandlers();
  attachRoleTabHandlers();

  document.getElementById('new-pto-btn').addEventListener('click', showNewPtoRequestDialog);

  try {
    const balanceData = await api(withCompany(`/pto-balances?employeeId=${state.employee.id}`));
    renderPtoBalanceCard(balanceData);
  } catch (err) {
    document.getElementById('pto-balance-card').innerHTML = errorHtml(err.message);
  }

  const myRole = currentCompanyRole();
  if (myRole === 'foreman' || myRole === 'admin') {
    try {
      const pendingData = await api(withCompany('/pto-requests?status=pending'));
      renderPendingPtoSection(pendingData.requests || []);
    } catch (err) {
      document.getElementById('pto-pending-section').innerHTML = errorHtml(err.message);
    }
  }

  try {
    const myData = await api(withCompany(`/pto-requests?employeeId=${state.employee.id}`));
    renderMyPtoRequests(myData.requests || []);
  } catch (err) {
    document.getElementById('pto-my-requests').innerHTML = errorHtml(err.message);
  }
}

function renderPtoBalanceCard(balance) {
  document.getElementById('pto-balance-card').innerHTML = `
    <div class="summary-card">
      <div class="summary-row"><span class="label">${balance.year} allotment</span><span class="value">${balance.allotmentHours.toFixed(1)}h</span></div>
      <div class="summary-row"><span class="label">Used</span><span class="value">${balance.usedHours.toFixed(1)}h</span></div>
      <div class="summary-row total"><span class="label">Remaining</span><span class="value">${balance.remainingHours.toFixed(1)}h</span></div>
    </div>
  `;
}

function renderPendingPtoSection(requests) {
  const el = document.getElementById('pto-pending-section');
  const others = requests.filter(r => r.employee_id !== state.employee.id);

  if (others.length === 0) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div class="screen-sub" style="margin-top:8px; margin-bottom:10px; font-weight:600; color:var(--ink);">Awaiting your decision</div>
    ${others.map(r => ptoRequestRowHtml(r, true)).join('')}
  `;

  el.querySelectorAll('[data-pto-approve]').forEach(btn => {
    btn.addEventListener('click', () => decidePtoRequest(btn.getAttribute('data-pto-approve'), 'approve'));
  });
  el.querySelectorAll('[data-pto-deny]').forEach(btn => {
    btn.addEventListener('click', () => decidePtoRequest(btn.getAttribute('data-pto-deny'), 'deny'));
  });
}

function renderMyPtoRequests(requests) {
  const el = document.getElementById('pto-my-requests');
  const mine = requests.filter(r => r.employee_id === state.employee.id);

  if (mine.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">&#127962;</div>No time off requests yet.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="screen-sub" style="margin-top:8px; margin-bottom:10px; font-weight:600; color:var(--ink);">Your requests</div>
    ${mine.map(r => ptoRequestRowHtml(r, false)).join('')}
  `;

  el.querySelectorAll('[data-pto-cancel]').forEach(btn => {
    btn.addEventListener('click', () => cancelPtoRequest(btn.getAttribute('data-pto-cancel')));
  });
}

function ptoRequestRowHtml(r, showDecisionButtons) {
  const statusLabel = { pending: 'Pending', approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled' }[r.status] || r.status;
  const statusClass = { pending: 'foreman_approved', approved: 'admin_approved', denied: 'rejected', cancelled: 'draft' }[r.status] || 'draft';
  const employeeName = r.employees ? `${r.employees.first_name} ${r.employees.last_name}` : '';
  const dateLabel = r.start_date === r.end_date
    ? formatDateLabel(r.start_date)
    : `${formatDateLabel(r.start_date)} - ${formatDateLabel(r.end_date)}`;

  return `
    <div class="day-stub">
      <div class="day-stub-perf"></div>
      <div class="day-stub-body">
        <div class="day-stub-top">
          <div class="day-stub-date">${dateLabel}</div>
          <div class="day-stub-hours">${Number(r.hours_per_day).toFixed(1)}h/day</div>
        </div>
        <div class="day-stub-meta">
          ${employeeName ? `<span>${escapeHtml(employeeName)}</span>` : ''}
          ${r.reason ? `<span>${escapeHtml(r.reason)}</span>` : ''}
        </div>
        <span class="status-pill status-${statusClass}">${statusLabel}</span>
        ${r.decision_note ? `<div class="screen-sub" style="margin-top:6px; margin-bottom:0;">Note: ${escapeHtml(r.decision_note)}</div>` : ''}
        ${showDecisionButtons && r.status === 'pending' ? `
          <div class="btn-row" style="margin-top:10px;">
            <button class="btn btn-sm btn-ghost" data-pto-deny="${r.id}">Deny</button>
            <button class="btn btn-sm btn-primary" data-pto-approve="${r.id}">Approve</button>
          </div>
        ` : ''}
        ${!showDecisionButtons && r.status === 'pending' ? `
          <div style="margin-top:10px;">
            <button class="btn btn-sm btn-ghost" data-pto-cancel="${r.id}">Cancel request</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

async function decidePtoRequest(requestId, action) {
  let note = null;
  if (action === 'deny') {
    note = prompt('Optional note for the employee about why this was denied:') || null;
  }
  try {
    await api('/pto-requests', {
      method: 'PUT',
      body: JSON.stringify({ requestId, action, note }),
    });
    render('timeoff');
  } catch (err) {
    alert(err.message);
  }
}

async function cancelPtoRequest(requestId) {
  if (!confirm('Cancel this time off request?')) return;
  try {
    await api('/pto-requests', {
      method: 'PUT',
      body: JSON.stringify({ requestId, action: 'cancel' }),
    });
    render('timeoff');
  } catch (err) {
    alert(err.message);
  }
}

function showNewPtoRequestDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Request time off</div>
      <div class="field">
        <label for="pto-start">Start date</label>
        <input id="pto-start" type="date" />
      </div>
      <div class="field">
        <label for="pto-end">End date</label>
        <input id="pto-end" type="date" />
      </div>
      <div class="field">
        <label for="pto-hours-per-day">Hours per day</label>
        <input id="pto-hours-per-day" type="number" min="1" max="24" step="0.5" value="8" />
      </div>
      <div class="field">
        <label for="pto-reason">Reason (optional)</label>
        <textarea id="pto-reason" rows="2" placeholder="Optional note for your foreman"></textarea>
      </div>
      <div id="pto-dialog-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="pto-dialog-cancel">Cancel</button>
        <button class="btn btn-primary" id="pto-dialog-submit">Submit request</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const todayMin = todayStr();
  document.getElementById('pto-start').min = todayMin;
  document.getElementById('pto-end').min = todayMin;

  document.getElementById('pto-dialog-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  document.getElementById('pto-dialog-submit').addEventListener('click', async () => {
    const startDate = document.getElementById('pto-start').value;
    const endDate = document.getElementById('pto-end').value;
    const hoursPerDay = Number(document.getElementById('pto-hours-per-day').value || 8);
    const reason = document.getElementById('pto-reason').value.trim();
    const errorEl = document.getElementById('pto-dialog-error');
    errorEl.innerHTML = '';

    if (!startDate || !endDate) {
      errorEl.innerHTML = errorHtml('Please choose both a start and end date.');
      return;
    }

    try {
      await api('/pto-requests', {
        method: 'POST',
        body: JSON.stringify({ companyId: state.activeCompanyId, startDate, endDate, hoursPerDay, reason }),
      });
      document.body.removeChild(overlay);
      render('timeoff');
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
    }
  });
}
