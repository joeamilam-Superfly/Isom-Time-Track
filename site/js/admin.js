async function renderAdmin(opts) {
  const weekOf = state.currentWeekOf || sundayOf(todayStr());
  state.currentWeekOf = weekOf;

  root.innerHTML = `
    ${topbarHtml()}
    <main>
      ${roleTabsHtml('admin')}
      <div class="week-nav">
        <button id="week-prev" aria-label="Previous week">&larr;</button>
        <div class="week-label">${formatWeekRange(weekOf)}</div>
        <button id="week-next" aria-label="Next week">&rarr;</button>
      </div>
      <button class="btn btn-amber" id="export-btn" style="margin-bottom:20px;">Export this week (CSV)</button>
      <div id="admin-summary">${loadingHtml()}</div>

      <div class="screen-sub" style="font-weight:600; color:var(--ink); margin: 24px 0 8px;">Job locations</div>
      <button class="btn btn-ghost btn-sm" id="find-duplicates-btn" style="margin-bottom:14px;">Find possible duplicates</button>
      <div id="duplicates-section"></div>
      <div id="job-locations-admin">${loadingHtml()}</div>
    </main>
  `;

  attachTopbarHandlers();
  attachRoleTabHandlers();

  document.getElementById('week-prev').addEventListener('click', () => {
    state.currentWeekOf = addDaysStr(state.currentWeekOf, -7);
    render('admin');
  });
  document.getElementById('week-next').addEventListener('click', () => {
    state.currentWeekOf = addDaysStr(state.currentWeekOf, 7);
    render('admin');
  });

  let summaries = [];
  try {
    const data = await api(withCompany(`/weekly-summary?weekOf=${weekOf}`));
    summaries = data.summaries || [];
    renderAdminSummary(summaries);
  } catch (err) {
    document.getElementById('admin-summary').innerHTML = errorHtml(err.message);
  }

  document.getElementById('export-btn').addEventListener('click', () => exportWeekCsv(weekOf, summaries));
  document.getElementById('find-duplicates-btn').addEventListener('click', loadDuplicateGroups);

  loadJobLocationsAdmin();
}

async function loadDuplicateGroups() {
  const section = document.getElementById('duplicates-section');
  section.innerHTML = loadingHtml();
  try {
    const data = await api(withCompany('/job-locations-dedup'));
    renderDuplicateGroups(data.groups || []);
  } catch (err) {
    section.innerHTML = errorHtml(err.message);
  }
}

function renderDuplicateGroups(groups) {
  const section = document.getElementById('duplicates-section');

  if (groups.length === 0) {
    section.innerHTML = `<div class="banner banner-ok" style="margin-bottom:14px;">No likely duplicates found.</div>`;
    return;
  }

  section.innerHTML = `
    <div class="screen-sub" style="margin-bottom:10px;">
      Found ${groups.length} possible duplicate group${groups.length > 1 ? 's' : ''}. Review each one carefully -
      this groups names that LOOK similar, but it can occasionally group things that aren't actually the same
      job site. Uncheck anything that doesn't belong before merging.
    </div>
    ${groups.map((group, gi) => duplicateGroupHtml(group, gi)).join('')}
  `;

  groups.forEach((group, gi) => {
    const mergeBtn = document.getElementById(`merge-group-${gi}`);
    if (mergeBtn) {
      mergeBtn.addEventListener('click', () => mergeDuplicateGroup(group, gi));
    }
  });
}

function duplicateGroupHtml(group, groupIndex) {
  return `
    <div class="day-stub">
      <div class="day-stub-perf"></div>
      <div class="day-stub-body">
        <div class="day-stub-top">
          <div class="day-stub-date">Group ${groupIndex + 1}</div>
        </div>
        <div class="screen-sub" style="margin-bottom:10px;">Pick which one to KEEP. Everything else checked will be merged into it - their history moves over, and they're deactivated.</div>
        ${group.map((loc, li) => `
          <div class="checkbox-row" style="margin-bottom:8px;">
            <input type="radio" name="keep-group-${groupIndex}" id="keep-${groupIndex}-${li}" value="${loc.id}" ${li === 0 ? 'checked' : ''} style="width:22px; height:22px; accent-color: var(--ink);" />
            <label for="keep-${groupIndex}-${li}" style="flex:1;">
              <strong>${escapeHtml(loc.name)}</strong>${!loc.active ? ' (currently deactivated)' : ''}
              ${loc.address ? `<div class="employee-meta">${escapeHtml(loc.address)}</div>` : ''}
            </label>
            <input type="checkbox" data-include-${groupIndex}="${loc.id}" checked title="Include in this merge" />
          </div>
        `).join('')}
        <button class="btn btn-sm btn-primary" id="merge-group-${groupIndex}" style="margin-top:8px;">Merge selected into the chosen one</button>
      </div>
    </div>
  `;
}

async function mergeDuplicateGroup(group, groupIndex) {
  const keepRadio = document.querySelector(`input[name="keep-group-${groupIndex}"]:checked`);
  if (!keepRadio) {
    alert('Pick which location to keep first.');
    return;
  }
  const keepId = keepRadio.value;

  const includeCheckboxes = document.querySelectorAll(`[data-include-${groupIndex}]`);
  const duplicateIds = [];
  includeCheckboxes.forEach(cb => {
    const locId = cb.getAttribute(`data-include-${groupIndex}`);
    if (cb.checked && locId !== keepId) {
      duplicateIds.push(locId);
    }
  });

  if (duplicateIds.length === 0) {
    alert('Nothing else is selected to merge - check at least one other location in this group, or skip this group.');
    return;
  }

  const keptName = group.find(l => l.id === keepId)?.name || 'the selected location';
  const mergedNames = group.filter(l => duplicateIds.includes(l.id)).map(l => l.name).join(', ');

  if (!confirm(`Merge "${mergedNames}" into "${keptName}"?\n\nAll their logged hours and photos will move to "${keptName}", and they'll be deactivated. This cannot be undone automatically.`)) {
    return;
  }

  try {
    await api('/job-locations-dedup', {
      method: 'PUT',
      body: JSON.stringify({ companyId: state.activeCompanyId, keepId, duplicateIds }),
    });
    loadDuplicateGroups();
    loadJobLocationsAdmin();
  } catch (err) {
    alert(err.message);
  }
}

async function loadJobLocationsAdmin() {
  try {
    const data = await api(withCompany('/job-locations') + '&includeInactive=true');
    renderJobLocationsAdmin(data.locations || []);
  } catch (err) {
    document.getElementById('job-locations-admin').innerHTML = errorHtml(err.message);
  }
}

function renderJobLocationsAdmin(locations) {
  const el = document.getElementById('job-locations-admin');

  const listHtml = locations.length === 0
    ? `<div class="empty-state" style="padding:20px;">No job locations yet.</div>`
    : locations.map(loc => `
      <div class="employee-row">
        <div style="${loc.active ? '' : 'opacity:0.55;'}">
          <div class="employee-name">${escapeHtml(loc.name)}${!loc.active ? ' (deactivated)' : ''}</div>
          ${loc.address ? `<div class="employee-meta">${escapeHtml(loc.address)}</div>` : ''}
        </div>
        <button class="btn btn-sm ${loc.active ? 'btn-danger' : 'btn-primary'}" data-toggle-loc="${loc.id}" data-currently-active="${loc.active}">${loc.active ? 'Deactivate' : 'Reactivate'}</button>
      </div>
    `).join('');

  el.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="add-location-btn" style="margin-bottom:14px;">+ Add job location</button>
    ${listHtml}
  `;

  document.getElementById('add-location-btn').addEventListener('click', showAddJobLocationDialog);

  el.querySelectorAll('[data-toggle-loc]').forEach(btn => {
    btn.addEventListener('click', () => {
      const locationId = btn.getAttribute('data-toggle-loc');
      const currentlyActive = btn.getAttribute('data-currently-active') === 'true';
      toggleJobLocationActive(locationId, !currentlyActive);
    });
  });
}

async function toggleJobLocationActive(locationId, newActive) {
  const verb = newActive ? 'reactivate' : 'deactivate';
  if (!confirm(`Are you sure you want to ${verb} this job location?`)) return;

  try {
    await api('/job-locations', {
      method: 'PUT',
      body: JSON.stringify({ companyId: state.activeCompanyId, locationId, active: newActive }),
    });
    loadJobLocationsAdmin();
  } catch (err) {
    alert(err.message);
  }
}

function showAddJobLocationDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:380px;width:100%;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Add job location</div>
      <div class="field">
        <label for="new-loc-name">Name</label>
        <input id="new-loc-name" type="text" placeholder="e.g. Anderson-DuBose Warehouse" />
      </div>
      <div class="field">
        <label for="new-loc-address">Address (optional)</label>
        <input id="new-loc-address" type="text" />
      </div>
      <div id="new-loc-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="new-loc-cancel">Cancel</button>
        <button class="btn btn-primary" id="new-loc-save">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('new-loc-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  document.getElementById('new-loc-save').addEventListener('click', async () => {
    const name = document.getElementById('new-loc-name').value.trim();
    const address = document.getElementById('new-loc-address').value.trim();
    const errorEl = document.getElementById('new-loc-error');
    errorEl.innerHTML = '';

    if (!name) {
      errorEl.innerHTML = errorHtml('Name is required.');
      return;
    }

    try {
      const result = await api('/job-locations', {
        method: 'POST',
        body: JSON.stringify({ companyId: state.activeCompanyId, name, address }),
      });

      if (result.needsConfirmation) {
        const proceed = confirm(
          `This looks similar to an existing location (${result.suggestions[0].name}, ${result.suggestions[0].score}% match). Add it as a new location anyway?`
        );
        if (!proceed) return;
        await api('/job-locations', {
          method: 'POST',
          body: JSON.stringify({ companyId: state.activeCompanyId, name, address, confirmNew: true }),
        });
      }

      document.body.removeChild(overlay);
      loadJobLocationsAdmin();
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
    }
  });
}

function renderAdminSummary(summaries) {
  const el = document.getElementById('admin-summary');
  if (summaries.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">&#128203;</div>No entries for this week yet.</div>`;
    return;
  }

  el.innerHTML = summaries.map(s => `
    <div class="employee-row">
      <div>
        <div class="employee-name">${escapeHtml(s.employeeName || 'Unknown')}</div>
        <div class="employee-meta">Reg ${s.totals.regularHoursWorked.toFixed(2)} &middot; OT ${s.totals.overtimeHoursWorked.toFixed(2)} &middot; Hol ${s.totals.holidayHours.toFixed(2)} &middot; Leave ${s.totals.ptoHours.toFixed(2)}</div>
      </div>
      <div class="employee-name">${s.totals.weeklyHours.toFixed(2)}h</div>
    </div>
  `).join('');
}

function exportWeekCsv(weekOf, summaries) {
  const rows = [
    ['Employee', 'Date', 'Job Location', 'Activity', 'Time In', 'Time Out', 'Hours Worked', 'Status'],
  ];

  for (const s of summaries) {
    for (const day of s.days) {
      for (const seg of day.segments) {
        if (!seg.hoursWorked) continue;
        rows.push([
          s.employeeName || '',
          day.date,
          seg.jobLocation || '',
          seg.activityDescription || '',
          seg.timeIn ? seg.timeIn.slice(0, 5) : '',
          seg.timeOut ? seg.timeOut.slice(0, 5) : '',
          Number(seg.hoursWorked).toFixed(2),
          seg.status,
        ]);
      }
    }
    rows.push([]);
    rows.push([s.employeeName, '', '', '', '', 'Regular', s.totals.regularHoursWorked.toFixed(2)]);
    rows.push([s.employeeName, '', '', '', '', 'Overtime', s.totals.overtimeHoursWorked.toFixed(2)]);
    rows.push([s.employeeName, '', '', '', '', 'Holiday', s.totals.holidayHours.toFixed(2)]);
    rows.push([s.employeeName, '', '', '', '', 'Leave', s.totals.ptoHours.toFixed(2)]);
    rows.push([s.employeeName, '', '', '', '', 'Total weekly hours', s.totals.weeklyHours.toFixed(2)]);
    rows.push([]);
  }

  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `isom-timesheet-${weekOf}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const str = String(value == null ? '' : value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
