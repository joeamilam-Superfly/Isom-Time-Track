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
    <div class="bottom-bar" style="display:flex; gap:10px;">
      <button class="btn btn-ghost" id="payout-btn" style="flex:1;">Request payout</button>
      <button class="btn btn-amber" id="new-pto-btn" style="flex:2;">+ Request time off</button>
    </div>
  `;

  attachTopbarHandlers();
  attachRoleTabHandlers();

  let currentBalance = null;

  document.getElementById('new-pto-btn').addEventListener('click', () => showNewPtoRequestDialog(currentBalance));
  document.getElementById('payout-btn').addEventListener('click', () => showPayoutRequestDialog(currentBalance));

  try {
    const balanceData = await api(withCompany(`/pto-balances?employeeId=${state.employee.id}`));
    currentBalance = balanceData;
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
  const utoDays = balance.utoDaysTaken || 0;
  document.getElementById('pto-balance-card').innerHTML = `
    <div class="summary-card">
      <div class="summary-row"><span class="label">${balance.year} allotment</span><span class="value">${balance.allotmentHours.toFixed(1)}h</span></div>
      <div class="summary-row"><span class="label">Used</span><span class="value">${balance.usedHours.toFixed(1)}h</span></div>
      <div class="summary-row total"><span class="label">Remaining</span><span class="value">${balance.remainingHours.toFixed(1)}h</span></div>
      ${utoDays > 0 ? `<div class="summary-row" style="margin-top:8px; border-top:1px solid var(--line); padding-top:8px;"><span class="label" style="color:var(--ink-soft);">Unpaid days taken (all time)</span><span class="value" style="color:var(--ink-soft);">${utoDays.toFixed(1)}</span></div>` : ''}
    </div>
  `;
}

function renderPendingPtoSection(requests) {
  const el = document.getElementById('pto-pending-section');
  const others = requests.filter(r => r.employee_id !== state.employee.id);

  if (others.length === 0) { el.innerHTML = ''; return; }

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
  const typeLabel = { leave: 'Leave', uto: 'Unpaid time off', payout: 'PTO payout request' }[r.request_type] || 'Leave';
  const statusLabel = { pending: 'Pending', approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled' }[r.status] || r.status;
  const statusClass = { pending: 'foreman_approved', approved: 'admin_approved', denied: 'rejected', cancelled: 'draft' }[r.status] || 'draft';
  const employeeName = r.employees ? `${r.employees.first_name} ${r.employees.last_name}` : '';
  const dateLabel = r.request_type === 'payout'
    ? 'Payout request'
    : r.start_date === r.end_date
      ? formatDateLabel(r.start_date)
      : `${formatDateLabel(r.start_date)} \u2013 ${formatDateLabel(r.end_date)}`;

  const advanceNotice = r.advance_notice_days != null && r.advance_notice_days < 14 && r.request_type !== 'payout'
    ? `<div class="screen-sub" style="color:var(--amber-dark); margin-top:4px; margin-bottom:0;">Only ${r.advance_notice_days} days notice${r.is_emergency ? ' (flagged as emergency)' : ''}</div>`
    : '';

  return `
    <div class="day-stub">
      <div class="day-stub-perf"></div>
      <div class="day-stub-body">
        <div class="day-stub-top">
          <div class="day-stub-date">${dateLabel}</div>
          ${r.request_type !== 'payout' ? `<div class="day-stub-hours">${Number(r.hours_per_day).toFixed(1)}h/day</div>` : ''}
        </div>
        <div class="day-stub-meta">
          ${employeeName ? `<span>${escapeHtml(employeeName)}</span>` : ''}
          <span style="color:var(--ink-soft);">${typeLabel}</span>
          ${r.reason ? `<span>${escapeHtml(r.reason)}</span>` : ''}
        </div>
        ${advanceNotice}
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
    // Recheck pending count so the Leave tab badge updates immediately
    state.pendingLeaveRequestCount = Math.max(0, (state.pendingLeaveRequestCount || 1) - 1);
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

// Payout request: only available when there's remaining leave balance.
function showPayoutRequestDialog(balance) {
  const remaining = balance ? balance.remainingHours : 0;

  if (remaining <= 0) {
    alert('You have no remaining leave balance to request a payout for.');
    return;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;">
      <div style="font-weight:700;font-size:17px;margin-bottom:6px;">Request leave payout</div>
      <div class="screen-sub" style="margin-bottom:14px;">You have <strong>${remaining.toFixed(1)} hours</strong> (${(remaining/8).toFixed(1)} days) of remaining leave. Submitting this requests that your unused leave be paid out instead of taken as time off. Your foreman or admin will review and approve. Payroll processing happens outside the app.</div>
      <div class="field">
        <label for="payout-reason">Reason (optional)</label>
        <textarea id="payout-reason" rows="2" placeholder="Optional note"></textarea>
      </div>
      <div id="payout-dialog-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="payout-dialog-cancel">Cancel</button>
        <button class="btn btn-primary" id="payout-dialog-submit">Submit payout request</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('payout-dialog-cancel').addEventListener('click', () => document.body.removeChild(overlay));
  document.getElementById('payout-dialog-submit').addEventListener('click', async () => {
    const reason = document.getElementById('payout-reason').value.trim();
    const errorEl = document.getElementById('payout-dialog-error');
    errorEl.innerHTML = '';

    const btn = document.getElementById('payout-dialog-submit');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
      await api('/pto-requests', {
        method: 'POST',
        body: JSON.stringify({ companyId: state.activeCompanyId, requestType: 'payout', reason }),
      });
      document.body.removeChild(overlay);
      render('timeoff');
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Submit payout request';
    }
  });
}

function showNewPtoRequestDialog(balance) {
  const remainingHours = balance ? balance.remainingHours : 0;

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
      <div id="pto-advance-warning" style="display:none;" class="banner banner-warn" style="margin-bottom:10px;"></div>
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

  // Live 2-week warning as dates are chosen
  function checkAdvanceNotice() {
    const startDate = document.getElementById('pto-start').value;
    const warningEl = document.getElementById('pto-advance-warning');
    if (!startDate) { warningEl.style.display = 'none'; return; }
    const daysAhead = Math.floor((new Date(startDate + 'T00:00:00Z') - new Date(todayMin + 'T00:00:00Z')) / (1000*60*60*24));
    if (daysAhead < 14) {
      warningEl.textContent = `This request is only ${daysAhead} day${daysAhead !== 1 ? 's' : ''} in advance. The policy requires at least 2 weeks notice except for emergencies. You can still submit \u2014 add a note explaining the circumstances.`;
      warningEl.style.display = 'block';
    } else {
      warningEl.style.display = 'none';
    }
  }

  document.getElementById('pto-start').addEventListener('change', checkAdvanceNotice);
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

    const btn = document.getElementById('pto-dialog-submit');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    // Check whether this should be a leave or UTO request.
    // UTO is only offered if leave balance is zero.
    const requestDays = Math.ceil((new Date(endDate) - new Date(startDate)) / (1000*60*60*24)) + 1;
    const requestedHours = requestDays * hoursPerDay;
    const isUto = remainingHours <= 0;

    if (remainingHours > 0 && requestedHours > remainingHours) {
      // Partial coverage - they have SOME leave but not enough for the full request
      const confirmed = confirm(
        `You have ${remainingHours.toFixed(1)} hours of leave remaining, but this request needs approximately ${requestedHours.toFixed(1)} hours. Your available leave will be used first.\n\nDo you want to continue? Your foreman can approve based on what's available.`
      );
      if (!confirmed) {
        btn.disabled = false;
        btn.textContent = 'Submit request';
        return;
      }
    }

    if (isUto) {
      const confirmed = confirm(
        'You have no leave balance remaining. This will be submitted as UNPAID time off. These days will be tracked permanently in your employment record. Continue?'
      );
      if (!confirmed) {
        btn.disabled = false;
        btn.textContent = 'Submit request';
        return;
      }
    }

    try {
      const result = await api('/pto-requests', {
        method: 'POST',
        body: JSON.stringify({
          companyId: state.activeCompanyId,
          startDate,
          endDate,
          hoursPerDay,
          reason,
          requestType: isUto ? 'uto' : 'leave',
          isEmergency: false,
        }),
      });

      document.body.removeChild(overlay);

      if (result.advanceNoticeWarning) {
        alert(result.advanceNoticeWarning);
      }

      render('timeoff');
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Submit request';
    }
  });
}
