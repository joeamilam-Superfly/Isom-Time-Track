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
      ${subView === 'schedule' ? weekJumpDropdownHtml(weekOf, 0, 6) : weekJumpDropdownHtml(weekOf, 8, 1)}
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
    loadWorkOrdersSection();
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

  // Store the summaries on state so the detail screen can access them
  // without an extra API call - all the day/segment data is already here.
  state.approvalSummaries = others;

  listEl.innerHTML = others.map((s, idx) => {
    const allSegments = s.days.flatMap(day => day.segments);
    const workedSegments = allSegments.filter(seg => seg.hoursWorked > 0);
    const allDraft = workedSegments.length > 0 && workedSegments.every(seg => seg.status === 'draft' || seg.status === 'rejected');
    const allForemanApproved = workedSegments.length > 0 && workedSegments.every(seg => seg.status === 'foreman_approved');
    const allAdminApproved = workedSegments.length > 0 && workedSegments.every(seg => seg.status === 'admin_approved');

    let statusHtml = '';
    if (allAdminApproved) {
      statusHtml = `<span class="status-pill status-admin_approved">Fully approved</span>`;
    } else if (allForemanApproved) {
      statusHtml = `<span class="status-pill status-foreman_approved">Awaiting final approval</span>`;
    } else if (allDraft) {
      statusHtml = `<span class="status-pill status-draft">Awaiting foreman</span>`;
    } else if (workedSegments.length > 0) {
      statusHtml = `<span class="status-pill status-draft">Mixed status</span>`;
    }

    return `
      <div class="day-stub" data-approval-idx="${idx}" style="cursor:pointer;">
        <div class="day-stub-perf"></div>
        <div class="day-stub-body">
          <div class="day-stub-top">
            <div class="day-stub-date">${escapeHtml(s.employeeName || 'Unknown')}</div>
            <div class="day-stub-hours">${s.totals.weeklyHours.toFixed(2)}h</div>
          </div>
          <div class="day-stub-meta">
            Reg ${s.totals.regularHoursWorked.toFixed(2)} &middot; OT ${s.totals.overtimeHoursWorked.toFixed(2)} &middot; Hol ${s.totals.holidayHours.toFixed(2)} &middot; Leave ${s.totals.ptoHours.toFixed(2)}
          </div>
          <div style="margin-top:6px;">${statusHtml}</div>
          <div style="font-size:12px; color:var(--ink-soft); margin-top:4px;">Tap to review and approve &rarr;</div>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-approval-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.getAttribute('data-approval-idx'));
      render('approvalDetail', { summary: state.approvalSummaries[idx] });
    });
  });
}

async function approveEmployee(employeeId, action) {
  const entriesData = await api(withCompany(`/time-entries?employeeId=${employeeId}&startDate=${state.currentWeekOf}&endDate=${addDaysStr(state.currentWeekOf, 6)}`));
  const entryIds = (entriesData.entries || []).filter(e => e.hours_worked > 0).map(e => e.id);
  if (entryIds.length === 0) return;

  await api('/approvals', {
    method: 'POST',
    body: JSON.stringify({ companyId: state.activeCompanyId, action, entryIds }),
  });
  render('approvals');
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
    // Three 7-day weeks: prior week (left), current week (middle, where
    // assignments are made), next week (right). Showing prior week lets
    // the admin/foreman see last week's assignments for context without
    // having to navigate away. Weekend columns included for weekend work.
    const startOffset = activeWeekStartDay() === 1 ? 0 : 1;
    const priorWeekStart = addDaysStr(weekOf, -7);
    const week0Days = [0,1,2,3,4,5,6].map(i => addDaysStr(priorWeekStart, startOffset + i));
    const week1Days = [0,1,2,3,4,5,6].map(i => addDaysStr(weekOf, startOffset + i));
    const week2Days = [0,1,2,3,4,5,6].map(i => addDaysStr(weekOf, startOffset + i + 7));
    const allDays = [...week0Days, ...week1Days, ...week2Days];

    const startDate = allDays[0];
    const endDate = allDays[allDays.length - 1];

    const [peopleData, scheduleData, locationsData, woData] = await Promise.all([
      api(withCompany('/dashboard')),
      api(withCompany(`/schedule?startDate=${startDate}&endDate=${endDate}`)),
      api(withCompany('/job-locations')),
      api(withCompany('/work-orders?status=open')).catch(() => ({ workOrders: [] })),
    ]);

    state.jobLocations = locationsData.locations || [];
    state.lastPeopleList = peopleData.people || [];
    state.scheduleWeekDays = week1Days; // dialog advances through current week
    renderScheduleGrid(peopleData.people || [], scheduleData.entries || [], week0Days, week1Days, week2Days, scheduleData.pendingLeave || [], woData.workOrders || []);
  } catch (err) {
    listEl.innerHTML = errorHtml(err.message);
  }
}

function renderScheduleGrid(people, entries, week0Days, week1Days, week2Days, pendingLeave, workOrders) {
  const listEl = document.getElementById('approvals-list');
  const allDays = [...week0Days, ...week1Days, ...week2Days];
  const priorDaySet = new Set(week0Days); // prior week cells are read-only

  if (people.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="icon">&#128197;</div>No one to schedule yet.</div>`;
    return;
  }

  const entriesByKey = {};
  for (const e of entries) {
    const key = `${e.employee_id}|${e.scheduled_date}`;
    if (!entriesByKey[key]) entriesByKey[key] = [];
    entriesByKey[key].push(e);
  }

  // Build work order lookup: assignedTo.id|scheduledDate -> [workOrders]
  const woByKey = {};
  for (const wo of (workOrders || [])) {
    if (wo.assignedTo?.id && wo.scheduledDate) {
      const key = `${wo.assignedTo.id}|${wo.scheduledDate}`;
      if (!woByKey[key]) woByKey[key] = [];
      woByKey[key].push(wo);
    }
  }


  const pendingLeaveKeys = new Set();
  for (const req of (pendingLeave || [])) {
    let d = req.start_date;
    while (d <= req.end_date) {
      pendingLeaveKeys.add(`${req.employee_id}|${d}`);
      const next = new Date(d + 'T00:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      d = next.toISOString().slice(0, 10);
    }
  }

  function weekLabel(days) {
    return days[0].slice(5).replace('-','/') + ' \u2013 ' + days[6].slice(5).replace('-','/');
  }

  function isWeekendDate(dateStr) {
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    return dow === 0 || dow === 6; // Sun or Sat
  }

  function cellHtml(personId, d, idx) {
    const key = `${personId}|${d}`;
    const dayEntries = entriesByKey[key] || [];
    const dayWos = woByKey[key] || [];
    const isOff = dayEntries.some(e => e.job_locations?.name?.toUpperCase() === 'OFF');
    const hasPendingLeave = pendingLeaveKeys.has(key);
    const isPrior = priorDaySet.has(d);
    const isWknd = isWeekendDate(d);

    const entryText = dayEntries.length > 0
      ? dayEntries.map(e => (e.job_locations ? escapeHtml(e.job_locations.name) : '(no site)') + (e.deviation_reason ? ' ⚠' : '')).join(', ')
      : hasPendingLeave ? '⏳ Leave pending' : '';

    // Work order badges shown in green below any schedule entries
    const woText = dayWos.map(wo =>
      `<div style="background:#16a34a; color:#fff; border-radius:3px; padding:1px 4px; margin-top:2px; font-size:10px; font-weight:600;" data-wo-cell="${wo.id}">WO# ${escapeHtml(wo.woNumber)}</div>`
    ).join('');

    const cellBg = isOff ? '#e53e3e'
      : hasPendingLeave && !dayEntries.length && !dayWos.length ? '#fef3c7'
      : dayEntries.length ? 'var(--paper-dim)'
      : isWknd && !isPrior ? '#f5f0e8'
      : 'transparent';
    const cellColor = isOff ? '#fff' : hasPendingLeave && !dayEntries.length ? '#92400e' : 'inherit';
    const cellBorder = isOff || dayEntries.length ? 'transparent' : hasPendingLeave ? '#fbbf24' : 'var(--line)';
    const weekBorder = (idx === 7 || idx === 14) ? 'border-left:2px solid var(--amber);' : '';
    const priorStyle = isPrior ? 'opacity:0.7;' : '';
    const dataAttr = isPrior ? '' : `data-grid-cell="${personId}|${d}"`;
    const cursor = isPrior ? 'default' : 'pointer';
    return `<td style="padding:3px; border-bottom:1px solid var(--line); cursor:${cursor}; vertical-align:top; ${weekBorder}${priorStyle}" ${dataAttr}>
      <div style="min-height:28px; padding:3px 4px; border-radius:4px; background:${cellBg}; border:1px dashed ${cellBorder}; color:${cellColor}; font-weight:${isOff?'600':'normal'}; font-size:11px;">
        ${entryText || (isPrior ? '' : (!woText ? '<span style="color:var(--line);">+</span>' : ''))}
        ${woText}
      </div>
    </td>`;
  }

  function personRowHtml(p) {
    return `<tr>
      <td style="padding:5px 8px; border-bottom:1px solid var(--line); position:sticky; left:0; background:var(--paper); white-space:nowrap; font-size:12px; min-width:120px; max-width:140px; overflow:hidden; text-overflow:ellipsis;">
        ${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}
      </td>
      ${allDays.map((d, i) => cellHtml(p.id, d, i)).join('')}
    </tr>`;
  }

  // Group by foreman. Foremen are shown as section headers AND get their
  // own schedulable row so they can be assigned to job sites like anyone else.
  const foremanMap = {};
  for (const p of people) {
    if (p.role === 'foreman' || p.role === 'admin') {
      if (!foremanMap[p.id]) foremanMap[p.id] = { foreman: p, crew: [] };
    }
  }
  const unassigned = [];
  for (const p of people) {
    if (p.role === 'foreman' || p.role === 'admin') continue;
    if (p.foremanId && foremanMap[p.foremanId]) {
      foremanMap[p.foremanId].crew.push(p);
    } else {
      unassigned.push(p);
    }
  }

  const colCount = allDays.length + 1;
  function sectionHeaderHtml(name, label) {
    return `<tr>
      <td colspan="${colCount}" style="padding:6px 8px; background:var(--ink); color:#fff; font-weight:700; font-size:12px; letter-spacing:0.03em; border-top:2px solid var(--amber);">
        ${escapeHtml(name)} <span style="font-weight:400; opacity:0.7;">(${label})</span>
      </td>
    </tr>`;
  }

  const sections = Object.values(foremanMap)
    .sort((a, b) => a.foreman.lastName.localeCompare(b.foreman.lastName))
    .map(g => `
      ${sectionHeaderHtml(g.foreman.firstName + ' ' + g.foreman.lastName, g.foreman.role === 'admin' ? 'Admin' : 'Foreman')}
      ${personRowHtml(g.foreman)}
      ${g.crew.sort((a,b) => a.lastName.localeCompare(b.lastName)).map(p => personRowHtml(p)).join('')}
    `).join('');

  const unassignedSection = unassigned.length ? `
    ${sectionHeaderHtml('Unassigned', 'no foreman set')}
    ${unassigned.sort((a,b) => a.lastName.localeCompare(b.lastName)).map(p => personRowHtml(p)).join('')}
  ` : '';


  const allPeopleFlat = [...Object.values(foremanMap).flatMap(g => [g.foreman, ...g.crew]), ...unassigned];

  // ---- Mobile week view (hidden on desktop via CSS) ----
  function mobileCellHtml(personId, d, isPrior) {
    const key = `${personId}|${d}`;
    const dayEntries = entriesByKey[key] || [];
    const dayWos = woByKey[key] || [];
    const isOff = dayEntries.some(e => e.job_locations?.name?.toUpperCase() === 'OFF');
    const hasPendingLeave = pendingLeaveKeys.has(key);
    const isWknd = isWeekendDate(d);
    const cellText = dayEntries.length > 0
      ? dayEntries.map(e => (e.job_locations ? escapeHtml(e.job_locations.name) : '(no site)') + (e.deviation_reason ? ' ⚠' : '')).join(', ')
      : hasPendingLeave ? '⏳' : '';
    const woText = dayWos.map(wo =>
      `<div style="background:#16a34a;color:#fff;border-radius:3px;padding:1px 3px;margin-top:2px;font-size:9px;font-weight:600;" data-wo-cell="${wo.id}">WO#${escapeHtml(wo.woNumber)}</div>`
    ).join('');
    const cellBg = isOff ? '#e53e3e'
      : hasPendingLeave && !dayEntries.length ? '#fef3c7'
      : dayEntries.length ? 'var(--paper-dim)'
      : isWknd && !isPrior ? '#f5f0e8'
      : 'transparent';
    const cellColor = isOff ? '#fff' : hasPendingLeave && !dayEntries.length ? '#92400e' : 'inherit';
    const dataAttr = isPrior ? '' : `data-grid-cell="${personId}|${d}"`;
    return `<td style="padding:2px; border:1px solid var(--line); vertical-align:top; ${isPrior?'opacity:0.7;':''} cursor:${isPrior?'default':'pointer'};" ${dataAttr}>
      <div style="min-height:44px; padding:3px 4px; border-radius:3px; background:${cellBg}; color:${cellColor}; font-size:10px; font-weight:${isOff?'600':'normal'}; line-height:1.3; word-break:break-word;">
        ${cellText || (isPrior ? '' : '<span style="color:var(--line);font-size:16px;">+</span>')}
        ${woText}
      </div>
    </td>`;
  }

  function mobileWeekTableHtml(weekDays, isPrior) {
    const dayHeaders = weekDays.map(d => `
      <th style="padding:4px 2px; font-size:10px; font-weight:700; text-align:center; background:${isWeekendDate(d)?'#f5f0e8':'var(--paper-dim)'}; border:1px solid var(--line); min-width:42px;">
        ${new Date(d+'T00:00:00').toLocaleDateString('en-US',{weekday:'short'})}<br>
        <span style="font-weight:400; color:var(--ink-soft);">${d.slice(5)}</span>
      </th>`).join('');

    const groupRows = Object.values(foremanMap)
      .sort((a,b) => a.foreman.lastName.localeCompare(b.foreman.lastName))
      .map(g => {
        const people = [g.foreman, ...g.crew.sort((a,b) => a.lastName.localeCompare(b.lastName))];
        return `
          <tr><td colspan="${weekDays.length + 1}" style="padding:5px 6px; background:var(--ink); color:#fff; font-weight:700; font-size:11px;">
            ${escapeHtml(g.foreman.firstName)} ${escapeHtml(g.foreman.lastName)} <span style="font-weight:400; opacity:0.7;">(${g.foreman.role==='admin'?'Admin':'Foreman'})</span>
          </td></tr>
          ${people.map(p => `<tr>
            <td style="padding:4px 5px; border:1px solid var(--line); font-size:11px; font-weight:600; white-space:nowrap; position:sticky; left:0; background:var(--paper); min-width:65px; max-width:80px; overflow:hidden; text-overflow:ellipsis;">
              ${escapeHtml(p.firstName)}<br><span style="font-weight:400; font-size:10px; color:var(--ink-soft);">${escapeHtml(p.lastName)}</span>
            </td>
            ${weekDays.map(d => mobileCellHtml(p.id, d, isPrior)).join('')}
          </tr>`).join('')}`;
      }).join('');

    const unassignedRows = unassigned.length ? `
      <tr><td colspan="${weekDays.length+1}" style="padding:5px 6px; background:var(--ink-soft); color:#fff; font-weight:700; font-size:11px;">Unassigned</td></tr>
      ${unassigned.sort((a,b) => a.lastName.localeCompare(b.lastName)).map(p => `<tr>
        <td style="padding:4px 5px; border:1px solid var(--line); font-size:11px; font-weight:600; white-space:nowrap; position:sticky; left:0; background:var(--paper); min-width:65px; max-width:80px; overflow:hidden; text-overflow:ellipsis;">
          ${escapeHtml(p.firstName)}<br><span style="font-weight:400; font-size:10px; color:var(--ink-soft);">${escapeHtml(p.lastName)}</span>
        </td>
        ${weekDays.map(d => mobileCellHtml(p.id, d, isPrior)).join('')}
      </tr>`).join('')}` : '';

    return `<div style="overflow-x:auto; -webkit-overflow-scrolling:touch;">
      <table style="border-collapse:collapse; font-size:11px; width:100%;">
        <thead><tr>
          <th style="padding:4px 5px; font-size:10px; border:1px solid var(--line); position:sticky; left:0; background:var(--paper); min-width:65px;">Name</th>
          ${dayHeaders}
        </tr></thead>
        <tbody>${groupRows}${unassignedRows}</tbody>
      </table>
    </div>`;
  }

  const mobileWeeks = [
    { days: week0Days, label: 'Prior', sublabel: weekLabel(week0Days), isPrior: true },
    { days: week1Days, label: 'This week', sublabel: weekLabel(week1Days), isPrior: false },
    { days: week2Days, label: 'Next week', sublabel: weekLabel(week2Days), isPrior: false },
  ];

  // Week header labels for desktop
  const weekMeta = [
    { days: week0Days, label: 'Prior week', note: 'read only' },
    { days: week1Days, label: 'This week', note: 'scheduling' },
    { days: week2Days, label: 'Next week', note: 'planning' },
  ];

  listEl.innerHTML = `
    <!-- MOBILE VIEW -->
    <div class="schedule-mobile-view">
      <div style="display:flex; border-bottom:2px solid var(--line); margin-bottom:12px;" id="mobile-week-tabs">
        ${mobileWeeks.map((wk, i) => `
          <button data-week-idx="${i}" style="flex:1; padding:8px 2px; border:none; background:${i===1?'var(--amber)':'transparent'}; color:${i===1?'#fff':'var(--ink)'}; font-size:11px; font-weight:${i===1?'700':'400'}; cursor:pointer; line-height:1.3;">
            ${wk.label}<br><span style="font-size:9px; opacity:0.85;">${wk.sublabel}</span>
          </button>`).join('')}
      </div>
      <div id="mobile-week-content"></div>
      <div style="display:flex; gap:10px; margin-top:14px;">
        <button class="btn btn-ghost" id="mobile-prev-week" style="flex:1;">&#8592; Prior</button>
        <button class="btn btn-ghost" id="mobile-next-week" style="flex:1;">Next &#8594;</button>
      </div>
    </div>

    <!-- DESKTOP VIEW -->
    <div class="schedule-grid-fullwidth">
      <table style="width:100%; border-collapse:collapse; font-size:12px; table-layout:fixed;">
        <thead class="schedule-sticky-head">
          <tr>
            <th style="text-align:left; padding:6px 8px; border-bottom:2px solid var(--line); position:sticky; left:0; top:0; z-index:12; background:var(--paper); width:130px;"></th>
            ${weekMeta.map((wk, wi) => `
              <th colspan="7" style="text-align:center; padding:4px 6px; border-bottom:2px solid var(--line); ${wi>0?'border-left:2px solid var(--amber);':''} background:${wi===0?'var(--line)':'var(--paper-dim)'}; font-size:11px; font-weight:700; opacity:${wi===0?'0.7':'1'}; position:sticky; top:0; z-index:11;">
                ${wk.label} &nbsp;<span style="font-weight:400;">${weekLabel(wk.days)}</span>
              </th>`).join('')}
          </tr>
          <tr>
            <th style="position:sticky; left:0; top:31px; z-index:12; background:var(--paper); border-bottom:1px solid var(--line); padding:4px 8px; font-size:11px; color:var(--ink-soft);">Name</th>
            ${allDays.map((d, i) => {
              const isWknd = isWeekendDate(d);
              const isPrior = priorDaySet.has(d);
              return `<th style="text-align:left; padding:3px 3px; border-bottom:1px solid var(--line); font-size:10px; font-weight:600; position:sticky; top:31px; z-index:10; ${i===7||i===14?'border-left:2px solid var(--amber);':''} background:${isWknd?'#f5f0e8':'var(--paper)'}; ${isPrior?'opacity:0.7;':''}">
                ${new Date(d+'T00:00:00').toLocaleDateString('en-US',{weekday:'short'})}<br>
                <span style="font-weight:400; color:var(--ink-soft);">${d.slice(5)}</span>
              </th>`;
            }).join('')}
          </tr>
        </thead>
        <tbody>${sections}${unassignedSection}</tbody>
      </table>
    </div>
  `;

  // Mobile tab/swipe logic
  let mobileWeekIdx = 1;
  function renderMobileWeek(idx) {
    mobileWeekIdx = idx;
    const wk = mobileWeeks[idx];
    document.getElementById('mobile-week-content').innerHTML = mobileWeekTableHtml(wk.days, wk.isPrior);
    document.querySelectorAll('#mobile-week-tabs button').forEach((btn, i) => {
      const active = i === idx;
      btn.style.background = active ? 'var(--amber)' : 'transparent';
      btn.style.color = active ? '#fff' : 'var(--ink)';
      btn.style.fontWeight = active ? '700' : '400';
    });
    document.querySelectorAll('#mobile-week-content [data-grid-cell]').forEach(cell => {
      cell.addEventListener('click', () => {
        const [personId, date] = cell.getAttribute('data-grid-cell').split('|');
        const person = allPeopleFlat.find(p => p.id === personId);
        state.scheduleWeekDays = wk.days;
        showScheduleCellDialog(personId, person, date, entriesByKey[`${personId}|${date}`] || []);
      });
    });
    document.querySelectorAll('#mobile-week-content [data-wo-cell]').forEach(badge => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const woId = badge.getAttribute('data-wo-cell');
        const allWos = Object.values(woByKey).flat();
        showWorkOrderDetail(woId, allWos);
      });
    });
  }
  renderMobileWeek(1);

  document.querySelectorAll('#mobile-week-tabs button').forEach(btn => {
    btn.addEventListener('click', () => renderMobileWeek(parseInt(btn.getAttribute('data-week-idx'))));
  });
  document.getElementById('mobile-prev-week').addEventListener('click', () => { if (mobileWeekIdx > 0) renderMobileWeek(mobileWeekIdx - 1); });
  document.getElementById('mobile-next-week').addEventListener('click', () => { if (mobileWeekIdx < 2) renderMobileWeek(mobileWeekIdx + 1); });

  // Swipe detection
  let touchStartX = 0;
  const mobileContent = document.getElementById('mobile-week-content');
  mobileContent.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  mobileContent.addEventListener('touchend', e => {
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) {
      if (diff > 0 && mobileWeekIdx < 2) renderMobileWeek(mobileWeekIdx + 1);
      if (diff < 0 && mobileWeekIdx > 0) renderMobileWeek(mobileWeekIdx - 1);
    }
  }, { passive: true });

  // Desktop cell click handlers
  listEl.querySelectorAll('.schedule-grid-fullwidth [data-grid-cell]').forEach(cell => {
    cell.addEventListener('click', () => {
      const [personId, date] = cell.getAttribute('data-grid-cell').split('|');
      const person = allPeopleFlat.find(p => p.id === personId);
      state.scheduleWeekDays = [week1Days, week2Days].find(wk => wk.includes(date)) || week1Days;
      showScheduleCellDialog(personId, person, date, entriesByKey[`${personId}|${date}`] || []);
    });
  });

  // Work order badge click handlers - open WO detail without triggering cell dialog
  listEl.querySelectorAll('[data-wo-cell]').forEach(badge => {
    badge.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent cell dialog from opening
      const woId = badge.getAttribute('data-wo-cell');
      const allWos = Object.values(woByKey).flat();
      showWorkOrderDetail(woId, allWos);
    });
  });
}


// Loads and renders the work orders section below the scheduling grid.
// Shows all open + ready_to_bill WOs for admin/foreman, and only
// assigned WOs for employees. Includes a "Create work order" button for
// admin and foreman.
async function loadWorkOrdersSection() {
  const listEl = document.getElementById('approvals-list');
  if (!listEl) return;

  const myRole = currentCompanyRole();
  const canCreate = myRole === 'admin' || myRole === 'foreman';

  // Create or reuse the WO section below the grid
  let woSection = document.getElementById('wo-section');
  if (!woSection) {
    woSection = document.createElement('div');
    woSection.id = 'wo-section';
    woSection.style.marginTop = '24px';
    listEl.after(woSection);
  }

  woSection.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
      <div style="font-weight:700; font-size:16px;">Work Orders</div>
      ${canCreate ? `<button class="btn btn-amber btn-sm" id="wo-create-btn">+ New work order</button>` : ''}
    </div>
    <div id="wo-list-content">${loadingHtml()}</div>
  `;

  if (canCreate) {
    document.getElementById('wo-create-btn').addEventListener('click', showCreateWorkOrderDialog);
  }

  try {
    const [openData, billingData] = await Promise.all([
      api(withCompany('/work-orders?status=open')),
      myRole === 'admin' ? api(withCompany('/work-orders?status=ready_to_bill')) : Promise.resolve({ workOrders: [] }),
    ]);

    let allWos = [...(billingData.workOrders || []), ...(openData.workOrders || [])];

    // Foremen only see WOs assigned to themselves or their crew.
    // Admins see all WOs. The backend returns all for foremen so the
    // scheduling grid badges work, but the card list should be scoped.
    if (myRole === 'foreman') {
      // Get this foreman's crew IDs from the people list already fetched for the grid
      const crewIds = new Set(
        (state.lastPeopleList || [])
          .filter(p => p.foremanId === state.employee.id || p.id === state.employee.id)
          .map(p => p.id)
      );
      // If crew list isn't available yet, fall back to just showing own WOs
      if (crewIds.size > 0) {
        allWos = allWos.filter(wo =>
          wo.assignedTo?.id === state.employee.id ||
          crewIds.has(wo.assignedTo?.id)
        );
      } else {
        allWos = allWos.filter(wo => wo.assignedTo?.id === state.employee.id);
      }
    }
    const woContent = document.getElementById('wo-list-content');
    if (!woContent) return;

    if (allWos.length === 0) {
      woContent.innerHTML = `<div class="screen-sub">No open work orders.</div>`;
      return;
    }

    woContent.innerHTML = allWos.map(wo => workOrderCardHtml(wo, myRole)).join('');

    woContent.querySelectorAll('[data-wo-view]').forEach(btn => {
      btn.addEventListener('click', () => showWorkOrderDetail(btn.getAttribute('data-wo-view'), allWos));
    });
    woContent.querySelectorAll('[data-wo-submit]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Submit this work order to your foreman for approval?')) return;
        try {
          await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: btn.getAttribute('data-wo-submit'), action: 'submit' }) });
          loadWorkOrdersSection();
        } catch (err) { alert(err.message); }
      });
    });
    woContent.querySelectorAll('[data-wo-complete]').forEach(btn => {
      btn.addEventListener('click', () => completeWorkOrder(btn.getAttribute('data-wo-complete'), woContent));
    });
    woContent.querySelectorAll('[data-wo-bill]').forEach(btn => {
      const wo = allWos.find(w => w.id === btn.getAttribute('data-wo-bill'));
      if (wo) btn.addEventListener('click', () => showBillWorkOrderDialog(wo));
    });
    woContent.querySelectorAll('[data-wo-edit]').forEach(btn => {
      const wo = allWos.find(w => w.id === btn.getAttribute('data-wo-edit'));
      if (wo) btn.addEventListener('click', () => showEditWorkOrderDialog(wo));
    });
  } catch (err) {
    const woContent = document.getElementById('wo-list-content');
    if (woContent) woContent.innerHTML = errorHtml(err.message);
  }
}

// Refreshes just the schedule grid in place after an assignment save,
// preserving the scroll position so the admin stays at the same row
// rather than jumping back to the top after each cell is saved.
async function refreshScheduleGridInPlace() {
  const listEl = document.getElementById('approvals-list');
  if (!listEl) return;
  const week1Days = state.scheduleWeekDays; // current week days (already have correct dates)
  if (!week1Days || week1Days.length === 0) return;
  // Derive prior and next weeks by shifting exactly 7 days from each
  // day in week1Days. Do NOT re-apply startOffset — it's already baked
  // into week1Days from when loadScheduleGrid ran.
  const week0Days = week1Days.map(d => addDaysStr(d, -7));
  const week2Days = week1Days.map(d => addDaysStr(d, 7));
  const startDate = week0Days[0];
  const endDate = week2Days[6];
  try {
    const scrollY = window.scrollY;
    const [peopleData, scheduleData, locationsData, woData] = await Promise.all([
      api(withCompany('/dashboard')),
      api(withCompany(`/schedule?startDate=${startDate}&endDate=${endDate}`)),
      api(withCompany('/job-locations')),
      api(withCompany('/work-orders?status=open')).catch(() => ({ workOrders: [] })),
    ]);
    state.jobLocations = locationsData.locations || [];
    renderScheduleGrid(peopleData.people || [], scheduleData.entries || [], week0Days, week1Days, week2Days, scheduleData.pendingLeave || [], woData.workOrders || []);
    window.scrollTo(0, scrollY);
  } catch (err) {
    console.error('Grid refresh failed:', err);
  }
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
                ${e.deviation_reason ? `<div class="employee-meta" style="color:var(--amber-dark);">Not attended &mdash; ${escapeHtml(e.deviation_reason)}</div>` : ''}
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

  // Closes the dialog and refreshes the grid in place, preserving the
  // scroll position so the admin stays at the same row in the list
  // rather than jumping back to the top after each assignment.
  async function closeAndRefresh() {
    document.body.removeChild(overlay);
    await refreshScheduleGridInPlace(state.currentWeekOf);
  }

  document.getElementById('sched-dialog-close').addEventListener('click', () => closeAndRefresh());

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
      const result = await api('/schedule', {
        method: 'POST',
        body: JSON.stringify({ companyId: state.activeCompanyId, employeeId, scheduledDate: date, jobLocationId, note }),
      });

      if (result.leaveConflict) {
        btn.disabled = false;
        btn.textContent = 'Add assignment';
        const confirmed = confirm(`${result.message}\n\nDo you still want to schedule them on this day anyway?`);
        if (confirmed) {
          btn.disabled = true;
          btn.textContent = 'Adding...';
          try {
            await api('/schedule', {
              method: 'POST',
              body: JSON.stringify({ companyId: state.activeCompanyId, employeeId, scheduledDate: date, jobLocationId, note, confirmOverride: true }),
            });
            closeAndRefresh();
          } catch (overrideErr) {
            errorEl.innerHTML = errorHtml(overrideErr.message);
            btn.disabled = false;
            btn.textContent = 'Add assignment';
          }
        }
      } else {
        closeAndRefresh();
      }
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
// weeksBack: how many weeks before today to include (Approvals needs past weeks)
// weeksForward: how many weeks after today to include (Schedule needs future weeks)
function weekJumpDropdownHtml(currentWeekOf, weeksBack = 0, weeksForward = 6) {
  const baseWeek = sundayOf(todayStr());
  const options = [];

  // Past weeks first (oldest to newest)
  for (let i = weeksBack; i > 0; i--) {
    options.push(addDaysStr(baseWeek, -i * 7));
  }
  // Current week
  options.push(baseWeek);
  // Future weeks
  for (let i = 1; i <= weeksForward; i++) {
    options.push(addDaysStr(baseWeek, i * 7));
  }

  // If the currently-selected week isn't in the list (e.g. navigated
  // further back than the dropdown covers), add it so the dropdown
  // accurately reflects what's actually showing.
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

// ---------------- Approval Detail Screen ----------------
// Shows every day and segment for one employee in the selected week,
// so a foreman or admin can review the actual detail before approving,
// rather than only seeing aggregated totals. The approve button is fixed
// at the bottom of the screen so it's always reachable after scrolling
// through the entries.

async function renderApprovalDetail(opts) {
  const s = opts.summary;
  if (!s) { render('approvals'); return; }

  const myRole = currentCompanyRole();
  const allSegments = s.days.flatMap(day => day.segments);
  const workedSegments = allSegments.filter(seg => seg.hoursWorked > 0);
  const allDraft = workedSegments.length > 0 && workedSegments.every(seg => seg.status === 'draft' || seg.status === 'rejected');
  const allForemanApproved = workedSegments.length > 0 && workedSegments.every(seg => seg.status === 'foreman_approved');

  const canForemanApprove = myRole === 'foreman' && allDraft;
  const canAdminApprove = myRole === 'admin' && allForemanApproved;
  const canApprove = canForemanApprove || canAdminApprove;

  const statusLabel = {
    draft: 'Draft',
    foreman_approved: 'Foreman approved',
    admin_approved: 'Approved',
    rejected: 'Sent back',
  };

  const daysHtml = s.days.length === 0
    ? `<div class="empty-state" style="padding:30px;">No hours logged this week.</div>`
    : s.days.map(day => `
        <div style="margin-bottom:20px;">
          <div style="font-weight:600; font-size:14px; color:var(--ink-soft); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px;">${formatDateLabel(day.date)}</div>
          ${day.segments.filter(seg => seg.hoursWorked > 0).map(seg => `
            <div class="day-stub" style="margin-bottom:8px;">
              <div class="day-stub-perf"></div>
              <div class="day-stub-body">
                <div class="day-stub-top">
                  <div class="day-stub-date">${seg.jobLocation ? escapeHtml(seg.jobLocation) : 'No location'}</div>
                  <div class="day-stub-hours">${Number(seg.hoursWorked).toFixed(2)}h</div>
                </div>
                <div class="day-stub-meta">
                  ${seg.timeIn ? `<span>${seg.timeIn.slice(0,5)} &ndash; ${seg.timeOut ? seg.timeOut.slice(0,5) : '?'}</span>` : ''}
                  ${seg.activityDescription ? `<span>${escapeHtml(seg.activityDescription)}</span>` : ''}
                </div>
                <span class="status-pill status-${seg.status}">${statusLabel[seg.status] || seg.status}</span>
              </div>
            </div>
          `).join('')}
        </div>
      `).join('');

  root.innerHTML = `
    ${topbarHtml()}
    <main style="padding-bottom:80px;">
      <div class="screen-title">${escapeHtml(s.employeeName || 'Unknown')}</div>
      <div class="screen-sub">${formatWeekRange(state.currentWeekOf)}</div>

      <div class="summary-card" style="margin-bottom:20px;">
        <div class="summary-row"><span class="label">Regular</span><span class="value">${s.totals.regularHoursWorked.toFixed(2)}h</span></div>
        <div class="summary-row"><span class="label">Overtime</span><span class="value">${s.totals.overtimeHoursWorked.toFixed(2)}h</span></div>
        <div class="summary-row"><span class="label">Holiday</span><span class="value">${s.totals.holidayHours.toFixed(2)}h</span></div>
        <div class="summary-row"><span class="label">Leave</span><span class="value">${s.totals.ptoHours.toFixed(2)}h</span></div>
        <div class="summary-row total"><span class="label">Total</span><span class="value">${s.totals.weeklyHours.toFixed(2)}h</span></div>
      </div>

      ${daysHtml}
    </main>
    <div class="bottom-bar" style="display:flex; gap:10px;">
      <button class="btn btn-ghost" id="approval-back-btn" style="flex:1;">&larr; Back</button>
      ${canApprove ? `
        <button class="btn btn-amber" id="approval-approve-btn" style="flex:2;">
          ${canForemanApprove ? 'Approve week' : 'Final approve'}
        </button>
      ` : `
        <div style="flex:2; display:flex; align-items:center; justify-content:center; font-size:13px; color:var(--ink-soft);">
          ${workedSegments.length === 0 ? 'No hours to approve' :
            allForemanApproved && myRole === 'foreman' ? 'Awaiting final admin approval' :
            allDraft && myRole === 'admin' ? 'Awaiting foreman approval first' :
            'Fully approved'}
        </div>
      `}
    </div>
  `;

  attachTopbarHandlers();

  document.getElementById('approval-back-btn').addEventListener('click', () => render('approvals'));

  if (canApprove) {
    document.getElementById('approval-approve-btn').addEventListener('click', async () => {
      const btn = document.getElementById('approval-approve-btn');
      btn.disabled = true;
      btn.textContent = 'Approving...';
      try {
        await approveEmployee(s.employeeId, canForemanApprove ? 'foreman_approve' : 'admin_approve');
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = canForemanApprove ? 'Approve week' : 'Final approve';
      }
    });
  }
}
