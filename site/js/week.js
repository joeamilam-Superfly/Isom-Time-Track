async function renderWeek(opts) {
  const weekOf = state.currentWeekOf || sundayOf(todayStr());
  state.currentWeekOf = weekOf;

  root.innerHTML = `
    ${topbarHtml()}
    <main>
      ${roleTabsHtml('week')}
      <div class="week-nav">
        <button id="week-prev" aria-label="Previous week">&larr;</button>
        <div class="week-label">${formatWeekRange(weekOf)}</div>
        <button id="week-next" aria-label="Next week">&rarr;</button>
      </div>
      <div id="week-summary"></div>
      <div id="week-days">${loadingHtml()}</div>
    </main>
    <div class="bottom-bar" style="display:flex; gap:10px;">
      <button class="btn btn-ghost" id="view-schedule-btn" style="flex:1;">View my schedule</button>
      <button class="btn btn-amber" id="add-today-btn" style="flex:1.5;">+ Log today's hours</button>
    </div>
  `;

  attachTopbarHandlers();
  attachRoleTabHandlers();

  document.getElementById('week-prev').addEventListener('click', () => {
    state.currentWeekOf = addDaysStr(state.currentWeekOf, -7);
    render('week');
  });
  document.getElementById('week-next').addEventListener('click', () => {
    state.currentWeekOf = addDaysStr(state.currentWeekOf, 7);
    render('week');
  });
  document.getElementById('add-today-btn').addEventListener('click', () => {
    render('dayEdit', { date: todayStr(), autoAdd: true });
  });
  document.getElementById('view-schedule-btn').addEventListener('click', showUpcomingScheduleDialog);

  try {
    const data = await api(withCompany(`/weekly-summary?employeeId=${state.employee.id}&weekOf=${weekOf}`));
    const mySummary = (data.summaries || [])[0];
    renderWeekSummary(mySummary);
    renderWeekDays(weekOf, mySummary);
  } catch (err) {
    document.getElementById('week-days').innerHTML = errorHtml(err.message);
  }

  checkPendingScheduleChanges();
}

function renderWeekSummary(summary) {
  const t = summary ? summary.totals : { regularHoursWorked: 0, overtimeHoursWorked: 0, holidayHours: 0, ptoHours: 0, weeklyHours: 0 };
  document.getElementById('week-summary').innerHTML = `
    <div class="summary-card">
      <div class="summary-row"><span class="label">Regular hours worked</span><span class="value">${t.regularHoursWorked.toFixed(2)}</span></div>
      <div class="summary-row"><span class="label">Overtime hours worked</span><span class="value">${t.overtimeHoursWorked.toFixed(2)}</span></div>
      <div class="summary-row"><span class="label">Holiday hours</span><span class="value">${t.holidayHours.toFixed(2)}</span></div>
      <div class="summary-row"><span class="label">Leave hours</span><span class="value">${t.ptoHours.toFixed(2)}</span></div>
      <div class="summary-row total"><span class="label">Total weekly hours</span><span class="value">${t.weeklyHours.toFixed(2)}</span></div>
    </div>
  `;
}

function renderWeekDays(weekOf, summary) {
  const dayMap = {};
  if (summary) {
    for (const d of summary.days) dayMap[d.date] = d;
  }

  const rows = [];
  for (let i = 0; i < 7; i++) {
    const date = addDaysStr(weekOf, i);
    const entry = dayMap[date];
    rows.push(dayStubHtml(date, entry));
  }

  document.getElementById('week-days').innerHTML = rows.join('');

  document.querySelectorAll('[data-day-edit]').forEach(el => {
    el.addEventListener('click', () => {
      render('dayEdit', { date: el.getAttribute('data-day-edit') });
    });
  });
}

function dayStubHtml(date, day) {
  const label = formatDateLabel(date);
  const isToday = date === todayStr();
  const isFuture = date > todayStr();

  if (!day || !day.segments || day.segments.length === 0) {
    return `
      <div class="day-stub" data-day-edit="${date}">
        <div class="day-stub-perf"></div>
        <div class="day-stub-body">
          <div class="day-stub-top">
            <div class="day-stub-date">${label}${isToday ? ' &middot; Today' : ''}</div>
            <div class="day-stub-hours" style="color:var(--ink-soft);">&mdash;</div>
          </div>
          <div class="day-stub-meta">${isFuture ? 'Not yet worked' : 'No hours logged yet'}</div>
        </div>
      </div>
    `;
  }

  const statusLabel = {
    draft: 'Draft',
    foreman_approved: 'Foreman approved',
    admin_approved: 'Approved',
    rejected: 'Sent back',
  };

  const statuses = new Set(day.segments.map(s => s.status));
  // If every segment shares the same status, show that. Otherwise show a
  // neutral "mixed" indicator rather than picking one segment's status
  // and misleadingly implying it applies to the whole day.
  const overallStatusPill = statuses.size === 1
    ? `<span class="status-pill status-${day.segments[0].status}">${statusLabel[day.segments[0].status] || day.segments[0].status}</span>`
    : `<span class="status-pill status-draft">Mixed status</span>`;

  const segmentCount = day.segments.length;
  const siteNames = [...new Set(day.segments.map(s => s.jobLocation).filter(Boolean))];

  return `
    <div class="day-stub" data-day-edit="${date}">
      <div class="day-stub-perf"></div>
      <div class="day-stub-body">
        <div class="day-stub-top">
          <div class="day-stub-date">${label}${isToday ? ' &middot; Today' : ''}</div>
          <div class="day-stub-hours">${day.totalHoursWorked.toFixed(2)}h</div>
        </div>
        <div class="day-stub-meta">
          ${segmentCount > 1 ? `<span>${segmentCount} segments</span>` : ''}
          ${siteNames.length > 0 ? `<span>${siteNames.map(escapeHtml).join(', ')}</span>` : ''}
        </div>
        ${overallStatusPill}
      </div>
    </div>
  `;
}

function topbarHtml() {
  const emp = state.employee;
  const initials = emp ? `${emp.firstName[0]}${emp.lastName[0]}` : '';
  const company = activeCompany();
  const showSwitcher = state.companies.length > 1;

  return `
    <div class="topbar">
      <div class="mark">
        <div class="mark-box">I</div>
        <div>
          <span class="mark-text">${company ? escapeHtml(company.name) : 'Timesheet'}</span>
          <span class="mark-sub">Weekly Timesheet</span>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="user-chip" id="help-btn" style="border:none;" aria-label="Help">&#128172;</button>
        <button class="user-chip" id="logout-btn" style="border:none;">${initials} &middot; Log out</button>
      </div>
    </div>
    ${showSwitcher ? `
      <div style="padding:10px 18px; background:var(--paper-dim); border-bottom:1px solid var(--line);">
        <select id="company-switcher" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:#fff;">
          ${state.companies.map(c => `<option value="${c.id}" ${c.id === state.activeCompanyId ? 'selected' : ''}>${escapeHtml(c.name)} (${c.role})</option>`).join('')}
        </select>
      </div>
    ` : ''}
  `;
}

function attachTopbarHandlers() {
  const btn = document.getElementById('logout-btn');
  if (btn) btn.addEventListener('click', logout);

  const helpBtn = document.getElementById('help-btn');
  if (helpBtn) helpBtn.addEventListener('click', openAssistantPanel);

  const switcher = document.getElementById('company-switcher');
  if (switcher) {
    switcher.addEventListener('change', () => {
      setActiveCompany(switcher.value);
      render('week'); // switching companies always lands back on the main week view
    });
  }
}

function roleTabsHtml(active) {
  const role = currentCompanyRole();
  const tabs = [{ id: 'week', label: 'My Hours' }, { id: 'timeoff', label: 'Leave' }, { id: 'photolog', label: 'Photos' }];
  if (role === 'foreman' || role === 'admin') {
    tabs.push({ id: 'approvals', label: 'Approvals' });
    tabs.push({ id: 'team', label: 'Team' });
  }
  if (role === 'admin') tabs.push({ id: 'admin', label: 'Admin' });
  if (state.employee.superAdmin) tabs.push({ id: 'platform', label: 'Platform' });
  return `
    <div class="nav-tabs">
      ${tabs.map(t => `<button class="nav-tab ${t.id === active ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>
  `;
}

function attachRoleTabHandlers() {
  document.querySelectorAll('[data-tab]').forEach(el => {
    el.addEventListener('click', () => render(el.getAttribute('data-tab')));
  });
}

function loadingHtml() {
  return `<div class="empty-state">Loading...</div>`;
}

function errorHtml(message) {
  return `<div class="banner banner-warn">${escapeHtml(message)}</div>`;
}
