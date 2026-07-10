// Employee-facing schedule viewing and change-acknowledgment. The
// foreman/admin scheduling tool (the weekly grid) lives in admin.js,
// since it's part of the same management surface as the rest of that
// tab - this file is specifically the employee's own view.

async function showUpcomingScheduleDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:flex-end;justify-content:center;z-index:150;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px 16px 0 0;width:100%;max-width:480px;max-height:80vh;display:flex;flex-direction:column;">
      <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 18px; border-bottom:1px solid var(--line);">
        <div style="font-weight:700; font-size:16px;">My Schedule</div>
        <button id="schedule-dialog-close" style="background:none; border:none; font-size:22px; line-height:1; cursor:pointer; color:var(--ink-soft); padding:4px 8px;">&times;</button>
      </div>
      <div id="upcoming-schedule-list" style="flex:1; overflow-y:auto; padding:16px 18px;">${loadingHtml()}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('schedule-dialog-close').addEventListener('click', () => document.body.removeChild(overlay));

  try {
    const startDate = todayStr();
    const endDate = addDaysStr(startDate, 27); // 4 weeks out, "however far out it goes" within a reasonable, bounded window
    const data = await api(withCompany(`/schedule?employeeId=${state.employee.id}&startDate=${startDate}&endDate=${endDate}`));
    renderUpcomingScheduleList(data.entries || []);
  } catch (err) {
    document.getElementById('upcoming-schedule-list').innerHTML = errorHtml(err.message);
  }
}

function renderUpcomingScheduleList(entries) {
  const el = document.getElementById('upcoming-schedule-list');
  if (entries.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">&#128197;</div>No upcoming schedule has been entered yet.</div>`;
    return;
  }

  const byDate = {};
  for (const e of entries) {
    if (!byDate[e.scheduled_date]) byDate[e.scheduled_date] = [];
    byDate[e.scheduled_date].push(e);
  }

  el.innerHTML = Object.entries(byDate).map(([date, dayEntries]) => `
    <div class="day-stub">
      <div class="day-stub-perf"></div>
      <div class="day-stub-body">
        <div class="day-stub-top">
          <div class="day-stub-date">${formatDateLabel(date)}${date === todayStr() ? ' &middot; Today' : ''}</div>
        </div>
        <div class="day-stub-meta">
          ${dayEntries.map(e => {
            const loc = e.job_locations ? escapeHtml(e.job_locations.name) : 'No location set';
            const note = e.note ? ` &mdash; ${escapeHtml(e.note)}` : '';
            return `<span>${loc}${note}</span>`;
          }).join('')}
        </div>
      </div>
    </div>
  `).join('');
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
