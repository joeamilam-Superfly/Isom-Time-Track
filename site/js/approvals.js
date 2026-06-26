async function renderApprovals(opts) {
  const weekOf = state.currentWeekOf || sundayOf(todayStr());
  state.currentWeekOf = weekOf;
  const subView = state.approvalsSubView || 'approvals'; // 'approvals' | 'schedule'

  root.innerHTML = `
    ${topbarHtml()}
    <main>
      ${roleTabsHtml('approvals')}
      <div class="week-nav">
        <button id="week-prev" aria-label="Previous week">&larr;</button>
        <div class="week-label">${formatWeekRange(weekOf)}</div>
        <button id="week-next" aria-label="Next week">&rarr;</button>
      </div>
      <div class="nav-tabs" style="margin-bottom:16px;">
        <button class="nav-tab ${subView === 'approvals' ? 'active' : ''}" data-subview="approvals">Approvals</button>
        <button class="nav-tab ${subView === 'schedule' ? 'active' : ''}" data-subview="schedule">Schedule</button>
      </div>
      ${subView === 'schedule' ? weekJumpDropdownHtml(weekOf) : ''}
      <div id="approvals-list">${loadingHtml()}</div>
    </main>
  `;

  attachTopbarHandlers();
  attachRoleTabHandlers();

  document.getElementById('week-prev').addEventListener('click', () => {
    state.currentWeekOf = addDaysStr(state.currentWeekOf, -7);
    render('approvals');
  });
  document.getElementById('week-next').addEventListener('click', () => {
    state.currentWeekOf = addDaysStr(state.currentWeekOf, 7);
    render('approvals');
  });
  document.querySelectorAll('[data-subview]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.approvalsSubView = btn.getAttribute('data-subview');
      render('approvals');
    });
  });

  const jumpSelect = document.getElementById('week-jump-select');
  if (jumpSelect) {
    jumpSelect.addEventListener('change', () => {
      state.currentWeekOf = jumpSelect.value;
      render('approvals');
    });
  }

  if (subView === 'schedule') {
    loadScheduleGrid(weekOf);
    return;
  }

  try {
    const data = await api(withCompany(`/weekly-summary?weekOf=${weekOf}`));
    renderApprovalsList(data.summaries || []);
  } catch (err) {
    document.getElementById('approvals-list').innerHTML = errorHtml(err.message);
  }
}

function renderApprovalsList(summaries) {
  const listEl = document.getElementById('approvals-list');

  if (summaries.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="icon">&#128203;</div>No entries for this week yet.</div>`;
    return;
  }

  const myRole = currentCompanyRole();
  // exclude the viewer's own row if they're a foreman so they're not approving themselves
  const others = summaries.filter(s => s.employeeId !== state.employee.id);

  listEl.innerHTML = others.map(s => {
    const allSegments = s.days.flatMap(day => day.segments);
    const workedSegments = allSegments.filter(seg => seg.hoursWorked > 0);
    const allDraft = workedSegments.length > 0 && workedSegments.every(seg => seg.status === 'draft' || seg.status === 'rejected');
    const allForemanApproved = workedSegments.length > 0 && workedSegments.every(seg => seg.status === 'foreman_approved');
    const allAdminApproved = workedSegments.length > 0 && workedSegments.every(seg => seg.status === 'admin_approved');

    let actionHtml = '';
    if (myRole === 'foreman' && allDraft) {
      actionHtml = `<button class="btn btn-sm btn-primary" data-foreman-approve="${s.employeeId}">Approve week</button>`;
    } else if (myRole === 'admin' && allForemanApproved) {
      actionHtml = `<button class="btn btn-sm btn-primary" data-admin-approve="${s.employeeId}">Final approve</button>`;
    } else if (allAdminApproved) {
      actionHtml = `<span class="status-pill status-admin_approved">Fully approved</span>`;
    } else if (!allDraft && !allForemanApproved) {
      actionHtml = `<span class="status-pill status-foreman_approved">Awaiting foreman</span>`;
    }

    return `
      <div class="day-stub">
        <div class="day-stub-perf"></div>
        <div class="day-stub-body">
          <div class="day-stub-top">
            <div class="day-stub-date">${escapeHtml(s.employeeName || 'Unknown')}</div>
            <div class="day-stub-hours">${s.totals.weeklyHours.toFixed(2)}h</div>
          </div>
          <div class="day-stub-meta">
            Reg ${s.totals.regularHoursWorked.toFixed(2)} &middot; OT ${s.totals.overtimeHoursWorked.toFixed(2)} &middot; Hol ${s.totals.holidayHours.toFixed(2)} &middot; Leave ${s.totals.ptoHours.toFixed(2)}
          </div>
          <div style="margin-top:10px;">${actionHtml}</div>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-foreman-approve]').forEach(btn => {
    btn.addEventListener('click', () => approveEmployee(btn.getAttribute('data-foreman-approve'), 'foreman_approve'));
  });
  listEl.querySelectorAll('[data-admin-approve]').forEach(btn => {
    btn.addEventListener('click', () => approveEmployee(btn.getAttribute('data-admin-approve'), 'admin_approve'));
  });
}

async function approveEmployee(employeeId, action) {
  try {
    const entriesData = await api(withCompany(`/time-entries?employeeId=${employeeId}&startDate=${state.currentWeekOf}&endDate=${addDaysStr(state.currentWeekOf, 6)}`));
    const entryIds = (entriesData.entries || []).filter(e => e.hours_worked > 0).map(e => e.id);
    if (entryIds.length === 0) return;

    await api('/approvals', {
      method: 'POST',
      body: JSON.stringify({ companyId: state.activeCompanyId, action, entryIds }),
    });
    render('approvals');
  } catch (err) {
    alert(err.message);
  }
}

// ---------------- Weekly scheduling grid ----------------
// Everyone at the company down the side, Mon-Fri across the top (the
// schedule covers workdays, matching how the original spreadsheet this
// replaced was laid out). Click any cell to assign or edit that day.
// Any foreman or admin can assign anyone at the company - no per-foreman
// scoping here, per explicit decision.

async function loadScheduleGrid(weekOf) {
  const listEl = document.getElementById('approvals-list');
  listEl.innerHTML = loadingHtml();

  try {
    const weekDays = [1, 2, 3, 4, 5].map(i => addDaysStr(weekOf, i)); // Mon-Fri

    const [peopleData, scheduleData, locationsData] = await Promise.all([
      api(withCompany('/dashboard')),
      api(withCompany(`/schedule?startDate=${weekDays[0]}&endDate=${weekDays[4]}`)),
      api(withCompany('/job-locations')),
    ]);

    state.jobLocations = locationsData.locations || [];
    renderScheduleGrid(peopleData.people || [], scheduleData.entries || [], weekDays);
  } catch (err) {
    listEl.innerHTML = errorHtml(err.message);
  }
}

function renderScheduleGrid(people, entries, weekDays) {
  const listEl = document.getElementById('approvals-list');

  if (people.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="icon">&#128197;</div>No one to schedule yet.</div>`;
    return;
  }

  // Group entries by employee+date for quick lookup. A cell can have
  // multiple entries (multiple job sites in one day), same as time
  // segments - show all of them, comma-joined, in the grid cell.
  const entriesByKey = {};
  for (const e of entries) {
    const key = `${e.employee_id}|${e.scheduled_date}`;
    if (!entriesByKey[key]) entriesByKey[key] = [];
    entriesByKey[key].push(e);
  }

  const dayLabels = weekDays.map(d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }));

  listEl.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <thead>
          <tr>
            <th style="text-align:left; padding:8px 6px; border-bottom:2px solid var(--line); position:sticky; left:0; background:var(--paper); min-width:110px;">Name</th>
            ${weekDays.map((d, i) => `<th style="text-align:left; padding:8px 6px; border-bottom:2px solid var(--line); min-width:120px;">${dayLabels[i]}<br><span style="font-weight:400; color:var(--ink-soft);">${d.slice(5)}</span></th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${people.map(p => `
            <tr>
              <td style="padding:8px 6px; border-bottom:1px solid var(--line); position:sticky; left:0; background:var(--paper); font-weight:600;">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</td>
              ${weekDays.map(d => {
                const key = `${p.id}|${d}`;
                const dayEntries = entriesByKey[key] || [];
                const cellText = dayEntries.length > 0
                  ? dayEntries.map(e => e.job_locations ? escapeHtml(e.job_locations.name) : '(no site)').join(', ')
                  : '';
                return `<td style="padding:6px; border-bottom:1px solid var(--line); cursor:pointer; vertical-align:top;" data-grid-cell="${p.id}|${d}">
                  <div style="min-height:36px; padding:4px 6px; border-radius:6px; background:${dayEntries.length > 0 ? 'var(--paper-dim)' : 'transparent'}; border:1px dashed ${dayEntries.length > 0 ? 'transparent' : 'var(--line)'};">
                    ${cellText || '<span style="color:var(--ink-soft);">+ assign</span>'}
                  </div>
                </td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  listEl.querySelectorAll('[data-grid-cell]').forEach(cell => {
    cell.addEventListener('click', () => {
      const [employeeId, date] = cell.getAttribute('data-grid-cell').split('|');
      const key = `${employeeId}|${date}`;
      const person = people.find(p => p.id === employeeId);
      showScheduleCellDialog(employeeId, person, date, entriesByKey[key] || []);
    });
  });
}

function showScheduleCellDialog(employeeId, person, date, existingEntries) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;';

  const personName = person ? `${person.firstName} ${person.lastName}` : 'this person';

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="font-weight:700;font-size:17px;margin-bottom:2px;">${escapeHtml(personName)}</div>
      <div style="font-size:14px;color:var(--amber-dark);font-weight:600;margin-bottom:14px;">${formatDateLabel(date)}</div>

      <div id="existing-schedule-entries">
        ${existingEntries.length === 0
          ? `<div class="screen-sub" style="margin-bottom:14px;">No assignment yet for this day.</div>`
          : existingEntries.map(e => `
            <div class="employee-row" style="margin-bottom:8px;">
              <div>
                <div class="employee-name">${e.job_locations ? escapeHtml(e.job_locations.name) : 'No location set'}</div>
                ${e.note ? `<div class="employee-meta">${escapeHtml(e.note)}</div>` : ''}
              </div>
              <button class="btn btn-sm btn-ghost" data-remove-sched="${e.id}">Remove</button>
            </div>
          `).join('')
        }
      </div>

      <div class="screen-sub" style="font-weight:600; color:var(--ink); margin:14px 0 8px;">Add an assignment</div>
      <div class="field">
        <label for="sched-location-select">Job location</label>
        <select id="sched-location-select">
          <option value="">No specific location</option>
          ${(state.jobLocations || []).map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="sched-note">Note (optional)</label>
        <input id="sched-note" type="text" placeholder="e.g. bring the lift" />
      </div>
      <div id="sched-dialog-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="sched-dialog-close">Close</button>
        <button class="btn btn-primary" id="sched-dialog-add">Add assignment</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function closeAndRefresh() {
    document.body.removeChild(overlay);
    render('approvals');
  }

  document.getElementById('sched-dialog-close').addEventListener('click', () => document.body.removeChild(overlay));

  overlay.querySelectorAll('[data-remove-sched]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const entryId = btn.getAttribute('data-remove-sched');
      if (!confirm('Remove this assignment? The employee will be notified of the change.')) return;
      try {
        await api(`/schedule?entryId=${entryId}&companyId=${state.activeCompanyId}`, { method: 'DELETE' });
        closeAndRefresh();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.getElementById('sched-dialog-add').addEventListener('click', async () => {
    const jobLocationId = document.getElementById('sched-location-select').value || null;
    const note = document.getElementById('sched-note').value.trim();
    const errorEl = document.getElementById('sched-dialog-error');
    errorEl.innerHTML = '';

    const btn = document.getElementById('sched-dialog-add');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
      await api('/schedule', {
        method: 'POST',
        body: JSON.stringify({ companyId: state.activeCompanyId, employeeId, scheduledDate: date, jobLocationId, note }),
      });
      closeAndRefresh();
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Add assignment';
    }
  });
}

// A quick week-jump dropdown for the Schedule sub-view, since scheduling
// ahead a month means jumping forward several weeks at once - clicking
// the single-week arrow 4-5 times to get there is exactly the friction
// this avoids. Lists this week plus the next 5 (6 weeks total, a bit
// over a month of runway), anchored to TODAY rather than whatever week
// is currently selected, so the option list stays stable as the person
// jumps around rather than shifting under them. Not used in the
// Approvals sub-view, since reviewing/approving hours that haven't been
// worked yet doesn't apply there.
function weekJumpDropdownHtml(currentWeekOf) {
  const baseWeek = sundayOf(todayStr());
  const options = [];
  for (let i = 0; i < 6; i++) {
    options.push(addDaysStr(baseWeek, i * 7));
  }

  // If the currently-selected week isn't in the normal forward-looking
  // range (e.g. reached by navigating backward in Approvals before
  // switching to the Schedule sub-view), add it anyway so the dropdown
  // accurately reflects what's actually showing, rather than silently
  // defaulting to whatever option happens to render first.
  if (!options.includes(currentWeekOf)) {
    options.unshift(currentWeekOf);
  }

  return `
    <div class="field" style="margin-bottom:14px;">
      <label for="week-jump-select">Jump to week</label>
      <select id="week-jump-select">
        ${options.map(w => `<option value="${w}" ${w === currentWeekOf ? 'selected' : ''}>${formatWeekRange(w)}</option>`).join('')}
      </select>
    </div>
  `;
}
