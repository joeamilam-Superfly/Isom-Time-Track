// Employee-facing schedule viewing and change-acknowledgment. The
// foreman/admin scheduling tool (the weekly grid) lives in admin.js,
// since it's part of the same management surface as the rest of that
// tab - this file is specifically the employee's own view.

async function showUpcomingScheduleDialog() {
  const canCreateWo = currentCompanyRole() === 'admin' || currentCompanyRole() === 'foreman';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:flex-end;justify-content:center;z-index:150;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px 16px 0 0;width:100%;max-width:480px;max-height:82vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--line);">
        <div style="font-weight:700;font-size:16px;">My Work Orders</div>
        ${canCreateWo ? `<button id="wo-dialog-new-btn" class="btn btn-amber btn-sm">+ New WO</button>` : ''}
        <button id="schedule-dialog-close" style="background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:var(--ink-soft);padding:4px 8px;">&times;</button>
      </div>
      <div id="upcoming-schedule-list" style="flex:1;overflow-y:auto;padding:16px 18px;">${loadingHtml()}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#schedule-dialog-close').addEventListener('click', close);

  const newWoBtn = overlay.querySelector('#wo-dialog-new-btn');
  if (newWoBtn) {
    newWoBtn.addEventListener('click', () => {
      close();
      showCreateWorkOrderDialog();
    });
  }

  try {
    // Fetch open WOs assigned to this employee plus crew WOs
    const [openData, billedData, queueData] = await Promise.all([
      api(withCompany('/work-orders?status=open')).catch(() => ({ workOrders: [] })),
      api(withCompany('/work-orders?status=ready_to_bill')).catch(() => ({ workOrders: [] })),
      api(withCompany('/work-orders?queue=true')).catch(() => ({ workOrders: [] })),
    ]);

    const assignedWos = [
      ...(openData.workOrders || []),
      ...(billedData.workOrders || []),
    ].filter(wo =>
      wo.assignedTo?.id === state.employee.id ||
      (wo.crew || []).some(c => c.id === state.employee.id)
    );

    const queueWos = (queueData.workOrders || []);
    const allWos = [...assignedWos, ...queueWos];

    const listEl = overlay.querySelector('#upcoming-schedule-list');

    if (assignedWos.length === 0 && queueWos.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="icon">📋</div>No work orders assigned to you right now.</div>`;
      return;
    }

    const statusColor = { open: '#C47C1E', submitted: '#7c3aed', ready_to_bill: '#16a34a', billed: 'var(--ink-soft)' };
    const statusLabel = { open: 'Open', submitted: 'Pending review', ready_to_bill: 'Ready to bill', billed: 'Billed' };
    const myRole = currentCompanyRole();

    function woCardHtml(wo, isQueue) {
      const isCrewMember = !isQueue && (wo.crew || []).some(c => c.id === state.employee.id) && wo.assignedTo?.id !== state.employee.id;
      const bg = isQueue ? '#fef3c7' : (wo.assignedTo?.displayColor || 'var(--paper)');
      return `
        <div style="background:${bg};border-radius:8px;padding:12px 14px;margin-bottom:10px;border:1px solid var(--line);">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
            <div style="font-weight:700;font-size:15px;">WO# ${escapeHtml(wo.woNumber)}</div>
            <span style="font-size:12px;font-weight:600;color:${isQueue ? '#d97706' : (statusColor[wo.status] || 'var(--ink-soft))')};">${isQueue ? '📋 Available' : (statusLabel[wo.status] || wo.status)}</span>
          </div>
          ${wo.jobLocation ? `<div style="font-size:13px;color:var(--ink-soft);margin-bottom:2px;">${escapeHtml(wo.jobLocation.name)}</div>` : ''}
          ${isCrewMember ? `<div style="font-size:11px;color:var(--ink-soft);margin-bottom:4px;">You are on the crew — lead: ${escapeHtml(wo.assignedTo?.name || '')}</div>` : ''}
          ${wo.scheduledDate ? `<div style="font-size:12px;color:var(--ink-soft);">Scheduled: ${wo.scheduledDate}</div>` : ''}
          ${wo.details ? `<div style="font-size:12px;background:rgba(0,0,0,0.04);border-radius:4px;padding:6px 8px;margin-top:6px;white-space:pre-line;">${escapeHtml(wo.details.slice(0, 120))}${wo.details.length > 120 ? '…' : ''}</div>` : ''}
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-ghost" data-wo-view-id="${wo.id}" style="font-size:12px;">View WO</button>
            ${isQueue ? `<button class="btn btn-sm btn-primary" data-wo-grab-id="${wo.id}" style="background:#d97706;font-size:12px;">Grab this WO</button>` : ''}
            ${!isQueue && myRole !== 'employee' ? `<button class="btn btn-sm btn-ghost" data-wo-edit-id="${wo.id}" style="font-size:12px;">Edit</button>` : ''}
          </div>
        </div>`;
    }

    let html = '';
    if (assignedWos.length > 0) {
      html += `<div style="font-weight:700;font-size:13px;color:var(--ink-soft);margin-bottom:8px;">MY ASSIGNED WOs (${assignedWos.length})</div>`;
      html += assignedWos.map(wo => woCardHtml(wo, false)).join('');
    }
    if (queueWos.length > 0) {
      html += `<div style="font-weight:700;font-size:13px;color:#d97706;margin:${assignedWos.length > 0 ? '16px' : '0px'} 0 8px;">📋 AVAILABLE TO GRAB (${queueWos.length})</div>`;
      html += queueWos.map(wo => woCardHtml(wo, true)).join('');
    }
    listEl.innerHTML = html;

    // Wire view buttons
    listEl.querySelectorAll('[data-wo-view-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        close();
        showWorkOrderDetail(btn.getAttribute('data-wo-view-id'), allWos);
      });
    });

    // Wire edit buttons (foreman/admin only)
    listEl.querySelectorAll('[data-wo-edit-id]').forEach(btn => {
      const wo = assignedWos.find(w => w.id === btn.getAttribute('data-wo-edit-id'));
      if (wo) btn.addEventListener('click', () => {
        close();
        showEditWorkOrderDialog(wo);
      });
    });

    // Wire grab buttons (queue WOs)
    listEl.querySelectorAll('[data-wo-grab-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Grabbing...';
        try {
          await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: btn.getAttribute('data-wo-grab-id'), action: 'grab' }) });
          close();
          render(state.view);
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
          btn.textContent = 'Grab this WO';
        }
      });
    });

  } catch (err) {
    const listEl = overlay.querySelector('#upcoming-schedule-list');
    if (listEl) listEl.innerHTML = errorHtml(err.message);
  }
}



// Checks for any unacknowledged schedule changes for the current
// employee at the active company, and if any exist, shows a blocking
// prompt requiring an explicit tap to confirm - this acknowledgment is
// the actual proof-of-notification record, so it's deliberately not
// something that can be dismissed by just looking at the screen.
async function checkPendingScheduleChanges() {
  try {
    const data = await api(withCompany('/schedule?pendingChanges=true'));
    const pending = data.pendingChanges || [];
    if (pending.length > 0) {
      showScheduleChangePrompt(pending);
    }
  } catch (err) {
    console.error('Could not check for pending schedule changes:', err);
  }
}

function showScheduleChangePrompt(pendingChanges) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.6);display:flex;align-items:center;justify-content:center;z-index:200;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:80vh;overflow-y:auto;">
      <div style="font-weight:700;font-size:17px;margin-bottom:6px;">Your schedule changed</div>
      <div class="screen-sub" style="margin-bottom:14px;">Please review and confirm you've seen ${pendingChanges.length > 1 ? 'these changes' : 'this change'}.</div>
      ${pendingChanges.map(c => scheduleChangeRowHtml(c)).join('')}
      <button class="btn btn-primary" id="ack-all-changes-btn" style="margin-top:14px;">I understand, dismiss</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('ack-all-changes-btn').addEventListener('click', async () => {
    const btn = document.getElementById('ack-all-changes-btn');
    btn.disabled = true;
    btn.textContent = 'Confirming...';
    try {
      await Promise.all(pendingChanges.map(c =>
        api('/schedule-acknowledge', {
          method: 'PUT',
          body: JSON.stringify({ companyId: state.activeCompanyId, changeLogId: c.id }),
        })
      ));
      document.body.removeChild(overlay);
    } catch (err) {
      alert(`Could not confirm: ${err.message}`);
      btn.disabled = false;
      btn.textContent = 'I understand, dismiss';
    }
  });
}

function scheduleChangeRowHtml(c) {
  const dateLabel = formatDateLabel(c.scheduled_date);
  const sameDayNote = c.is_same_day_change ? ' (today)' : '';
  let description;
  if (c.change_type === 'deleted') {
    description = 'Your assignment was removed.';
  } else if (c.job_locations) {
    description = `You're now scheduled at ${escapeHtml(c.job_locations.name)}.`;
  } else {
    description = 'Your assignment was updated.';
  }

  return `
    <div class="day-stub">
      <div class="day-stub-perf"></div>
      <div class="day-stub-body">
        <div class="day-stub-top">
          <div class="day-stub-date">${dateLabel}${sameDayNote}</div>
        </div>
        <div class="day-stub-meta"><span>${description}</span></div>
      </div>
    </div>
  `;
}

// Checks for pending leave requests assigned to this foreman/admin,
// updates the badge count on the Leave tab, and (once per calendar day)
// shows a banner alerting them that requests need a decision.
async function checkPendingLeaveRequests() {
  const role = currentCompanyRole();
  if (role !== 'foreman' && role !== 'admin') return;

  try {
    const data = await api(withCompany('/pto-requests?status=pending'));
    const pending = (data.requests || []).filter(r => r.assigned_foreman_id === state.employee.id);
    state.pendingLeaveRequestCount = pending.length;

    if (pending.length === 0) return;

    // Re-render just the tab bar to show the updated badge without a
    // full page re-render - find and replace just the nav-tabs element.
    const navTabs = document.querySelector('.nav-tabs');
    if (navTabs) {
      const activeTab = document.querySelector('.nav-tab.active');
      const activeId = activeTab ? activeTab.getAttribute('data-tab') : 'week';
      navTabs.outerHTML = roleTabsHtml(activeId);
      attachRoleTabHandlers();
    }

    // Show the once-per-day banner. Key includes the date so it resets
    // each calendar day, and the employee ID so different users on the
    // same device each get their own flag.
    const today = new Date().toISOString().slice(0, 10);
    const bannerKey = `leave_pending_banner_${state.employee.id}_${today}`;
    if (localStorage.getItem(bannerKey)) return;
    localStorage.setItem(bannerKey, '1');

    showPendingLeaveBanner(pending.length);
  } catch (err) {
    console.error('Could not check pending leave requests:', err);
  }
}

function showPendingLeaveBanner(count) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.6);display:flex;align-items:center;justify-content:center;z-index:200;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:400px;width:100%;">
      <div style="font-weight:700;font-size:17px;margin-bottom:6px;">Leave request${count > 1 ? 's' : ''} awaiting your decision</div>
      <div class="screen-sub" style="margin-bottom:16px;">
        You have <strong>${count}</strong> pending leave request${count > 1 ? 's' : ''} that need${count === 1 ? 's' : ''} to be approved or denied.
        Go to the <strong>Leave</strong> tab to review ${count > 1 ? 'them' : 'it'}.
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="leave-banner-later">Remind me later</button>
        <button class="btn btn-primary" id="leave-banner-go">Go to Leave tab</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('leave-banner-later').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });

  document.getElementById('leave-banner-go').addEventListener('click', () => {
    document.body.removeChild(overlay);
    render('timeoff');
  });
}
