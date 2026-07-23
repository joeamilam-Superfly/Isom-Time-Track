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
      <div style="display:flex; gap:10px; margin-bottom:20px;">
        <button class="btn btn-amber" id="export-btn" style="flex:1;">Export this week (CSV)</button>
        <button class="btn btn-ghost" id="export-pdf-btn" style="flex:1;">Receipt PDF</button>
      </div>
      <div id="admin-summary">${loadingHtml()}</div>

      <div class="screen-sub" style="font-weight:600; color:var(--ink); margin: 24px 0 8px;">Receipts</div>
      <div id="receipts-admin-section">
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
          <select id="receipts-location-filter" style="flex:2;min-width:140px;">
            <option value="">All locations</option>
          </select>
          <select id="receipts-period-filter" style="flex:1;min-width:100px;">
            <option value="week">This week</option>
            <option value="month">This month</option>
            <option value="all">All time</option>
          </select>
          <button class="btn btn-sm btn-ghost" id="load-receipts-btn">View</button>
        </div>
        <div id="receipts-admin-grid"></div>
      </div>

      <div class="screen-sub" style="font-weight:600; color:var(--ink); margin: 24px 0 8px;">Job locations</div>
      <button class="btn btn-ghost btn-sm" id="find-duplicates-btn" style="margin-bottom:14px;">Find possible duplicates</button>
      <div id="duplicates-section"></div>
      <div id="job-locations-admin">${loadingHtml()}</div>

      <div class="screen-sub" style="font-weight:600; color:var(--ink); margin: 24px 0 8px;">🔩 Materials Catalog</div>
      <div id="materials-catalog-section">
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
          <button class="btn btn-amber btn-sm" id="new-material-btn">+ Add item</button>
          <button class="btn btn-ghost btn-sm" id="import-material-btn">↑ Import CSV</button>
        </div>
        <input id="catalog-search" type="text" placeholder="Search catalog..." style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;margin-bottom:10px;box-sizing:border-box;" />
        <div id="materials-catalog-list">${loadingHtml()}</div>
      </div>

      <div class="screen-sub" style="font-weight:600; color:var(--ink); margin: 24px 0 8px;">📢 Broadcast Messages</div>
      <div id="broadcast-section">
        <button class="btn btn-amber btn-sm" id="new-message-btn" style="margin-bottom:14px;">+ New message</button>
        <div id="broadcast-message-list">${loadingHtml()}</div>
      </div>
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
  document.getElementById('export-pdf-btn').addEventListener('click', () => downloadReceiptPdf(weekOf));
  document.getElementById('find-duplicates-btn').addEventListener('click', loadDuplicateGroups);
  document.getElementById('new-message-btn').addEventListener('click', () => showMessageDialog(null));
  document.getElementById('new-material-btn').addEventListener('click', () => showMaterialDialog(null));
  document.getElementById('import-material-btn').addEventListener('click', showMaterialImportDialog);
  document.getElementById('catalog-search').addEventListener('input', e => loadMaterialsCatalog(e.target.value));
  loadMaterialsCatalog();
  loadBroadcastMessages();

  // Populate receipts location filter and wire load button
  api(withCompany('/job-locations')).then(d => {
    const sel = document.getElementById('receipts-location-filter');
    if (!sel) return;
    (d.locations || []).forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name;
      sel.appendChild(opt);
    });
  }).catch(() => {});

  document.getElementById('load-receipts-btn').addEventListener('click', loadAdminReceipts);

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
  const active = locations.filter(l => l.active);
  const inactive = locations.filter(l => !l.active);

  function locationRowHtml(loc) {
    const hasLaborBudget = loc.budget_amount != null;
    const hasMaterialsBudget = loc.budget_materials != null;
    return `
      <div class="employee-row" data-loc-name="${escapeHtml(loc.name.toLowerCase())}" style="align-items:flex-start; padding:10px 0;">
        <div style="flex:1;">
          <div class="employee-name">${escapeHtml(loc.name)}</div>
          ${loc.address ? `<div class="employee-meta">${escapeHtml(loc.address)}</div>` : ''}
          ${hasLaborBudget ? `<div class="employee-meta" style="color:var(--ink-soft);">Labor: $${Number(loc.budget_amount).toLocaleString('en-US',{minimumFractionDigits:2})} <span id="burn-labor-${loc.id}" style="font-style:italic;">Loading...</span></div>` : ''}
          ${hasMaterialsBudget ? `<div class="employee-meta" style="color:var(--ink-soft);">Materials: $${Number(loc.budget_materials).toLocaleString('en-US',{minimumFractionDigits:2})} <span id="burn-materials-${loc.id}" style="font-style:italic;">Loading...</span></div>` : ''}
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button class="btn btn-sm btn-ghost" data-edit-budget="${loc.id}" data-budget-amount="${loc.budget_amount || ''}" data-budget-materials="${loc.budget_materials || ''}">Budget</button>
          <button class="btn btn-sm ${loc.active ? 'btn-danger' : 'btn-primary'}" data-toggle-loc="${loc.id}" data-currently-active="${loc.active}">${loc.active ? 'Off' : 'On'}</button>
        </div>
      </div>`;
  }

  el.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="add-location-btn" style="margin-bottom:14px;">+ Add job location</button>
    <input id="loc-search" type="text" placeholder="Search locations..." style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;margin-bottom:12px;box-sizing:border-box;" />
    <div style="display:flex;gap:0;border-bottom:2px solid var(--line);margin-bottom:14px;">
      <button id="loc-tab-active" style="flex:1;padding:8px;background:none;border:none;border-bottom:2px solid var(--amber);margin-bottom:-2px;font-weight:700;font-size:13px;cursor:pointer;color:var(--ink);">Active (${active.length})</button>
      <button id="loc-tab-inactive" style="flex:1;padding:8px;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;font-weight:400;font-size:13px;cursor:pointer;color:var(--ink-soft);">Inactive (${inactive.length})</button>
    </div>
    <div id="loc-list-active">${active.length === 0 ? '<div class="screen-sub">No active locations.</div>' : active.map(locationRowHtml).join('')}</div>
    <div id="loc-list-inactive" style="display:none;">${inactive.length === 0 ? '<div class="screen-sub">No inactive locations.</div>' : inactive.map(locationRowHtml).join('')}</div>
  `;

  document.getElementById('add-location-btn').addEventListener('click', showAddJobLocationDialog);

  // Tab switching
  let currentTab = 'active';
  document.getElementById('loc-tab-active').addEventListener('click', () => {
    currentTab = 'active';
    document.getElementById('loc-list-active').style.display = '';
    document.getElementById('loc-list-inactive').style.display = 'none';
    document.getElementById('loc-tab-active').style.borderBottomColor = 'var(--amber)';
    document.getElementById('loc-tab-active').style.fontWeight = '700';
    document.getElementById('loc-tab-active').style.color = 'var(--ink)';
    document.getElementById('loc-tab-inactive').style.borderBottomColor = 'transparent';
    document.getElementById('loc-tab-inactive').style.fontWeight = '400';
    document.getElementById('loc-tab-inactive').style.color = 'var(--ink-soft)';
    document.getElementById('loc-search').dispatchEvent(new Event('input'));
  });
  document.getElementById('loc-tab-inactive').addEventListener('click', () => {
    currentTab = 'inactive';
    document.getElementById('loc-list-active').style.display = 'none';
    document.getElementById('loc-list-inactive').style.display = '';
    document.getElementById('loc-tab-inactive').style.borderBottomColor = 'var(--amber)';
    document.getElementById('loc-tab-inactive').style.fontWeight = '700';
    document.getElementById('loc-tab-inactive').style.color = 'var(--ink)';
    document.getElementById('loc-tab-active').style.borderBottomColor = 'transparent';
    document.getElementById('loc-tab-active').style.fontWeight = '400';
    document.getElementById('loc-tab-active').style.color = 'var(--ink-soft)';
    document.getElementById('loc-search').dispatchEvent(new Event('input'));
  });

  // Live search
  document.getElementById('loc-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    const listId = currentTab === 'active' ? 'loc-list-active' : 'loc-list-inactive';
    const rows = document.querySelectorAll(`#${listId} [data-loc-name]`);
    let visible = 0;
    rows.forEach(row => {
      const match = !q || row.getAttribute('data-loc-name').includes(q);
      row.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    const emptyMsg = document.querySelector(`#${listId} .screen-sub`);
    if (!emptyMsg && visible === 0) {
      const div = document.createElement('div');
      div.className = 'screen-sub';
      div.id = 'loc-no-results';
      div.textContent = 'No locations match your search.';
      document.getElementById(listId).appendChild(div);
    } else if (document.getElementById('loc-no-results')) {
      document.getElementById('loc-no-results').remove();
    }
  });

  // Load budget burn for active locations with budgets
  active.filter(l => l.budget_amount != null || l.budget_materials != null).forEach(loc => {
    loadBudgetBurn(loc.id);
  });

  el.querySelectorAll('[data-toggle-loc]').forEach(btn => {
    btn.addEventListener('click', () => {
      const locationId = btn.getAttribute('data-toggle-loc');
      const currentlyActive = btn.getAttribute('data-currently-active') === 'true';
      toggleJobLocationActive(locationId, !currentlyActive);
    });
  });

  el.querySelectorAll('[data-edit-budget]').forEach(btn => {
    btn.addEventListener('click', () => {
      const locationId = btn.getAttribute('data-edit-budget');
      const budgetAmount = btn.getAttribute('data-budget-amount');
      const budgetMaterials = btn.getAttribute('data-budget-materials');
      const loc = locations.find(l => l.id === locationId);
      showEditBudgetDialog(locationId, loc ? loc.name : '', budgetAmount, budgetMaterials);
    });
  });
}

async function loadBudgetBurn(locationId) {
  try {
    const data = await api(withCompany(`/job-locations?budgetBurn=true&locationId=${locationId}`));

    function burnText(bucket, label) {
      if (!bucket || bucket.budget == null) return;
      const el = document.getElementById(`burn-${label}-${locationId}`);
      if (!el) return;
      const color = bucket.overBudget ? '#e53e3e' : bucket.warning ? '#d97706' : 'var(--ink-soft)';
      const icon = bucket.overBudget ? ' ⚠ OVER' : bucket.warning ? ' ⚠' : '';
      el.textContent = `— $${bucket.spent.toFixed(2)} spent (${bucket.percentSpent}%)${icon}`;
      el.style.color = color;
    }

    burnText(data.labor, 'labor');
    burnText(data.materials, 'materials');
  } catch (err) {
    ['labor', 'materials'].forEach(t => {
      const el = document.getElementById(`burn-${t}-${locationId}`);
      if (el) el.textContent = '';
    });
  }
}

function showEditBudgetDialog(locationId, locationName, currentBudgetAmount, currentBudgetMaterials) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:380px;width:100%;">
      <div style="font-weight:700;font-size:17px;margin-bottom:4px;">Set project budgets</div>
      <div class="screen-sub" style="margin-bottom:14px;">${escapeHtml(locationName)}</div>
      <div class="field">
        <label for="edit-budget-labor">Labor budget ($, optional)</label>
        <input id="edit-budget-labor" type="number" min="0" step="0.01" placeholder="0.00" value="${currentBudgetAmount || ''}" />
        <div class="screen-sub">Burns down as employee hours × bill rate are logged here.</div>
      </div>
      <div class="field">
        <label for="edit-budget-materials">Materials budget ($, optional)</label>
        <input id="edit-budget-materials" type="number" min="0" step="0.01" placeholder="0.00" value="${currentBudgetMaterials || ''}" />
        <div class="screen-sub">Burns down as receipts are submitted against this location.</div>
      </div>
      <div id="edit-budget-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="edit-budget-cancel">Cancel</button>
        <button class="btn btn-primary" id="edit-budget-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('edit-budget-cancel').addEventListener('click', () => document.body.removeChild(overlay));
  document.getElementById('edit-budget-save').addEventListener('click', async () => {
    const budgetAmount = document.getElementById('edit-budget-labor').value.trim() || null;
    const budgetMaterials = document.getElementById('edit-budget-materials').value.trim() || null;
    const errorEl = document.getElementById('edit-budget-error');
    try {
      await api('/job-locations', {
        method: 'PUT',
        body: JSON.stringify({ companyId: state.activeCompanyId, locationId, budgetAmount, budgetMaterials }),
      });
      document.body.removeChild(overlay);
      loadJobLocationsAdmin();
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
    }
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
      <div class="field">
        <label for="new-loc-budget">Labor budget ($, optional)</label>
        <input id="new-loc-budget" type="number" min="0" step="0.01" placeholder="0.00" />
        <div class="screen-sub">Burns down as employee hours × bill rate are logged here.</div>
      </div>
      <div class="field">
        <label for="new-loc-budget-materials">Materials budget ($, optional)</label>
        <input id="new-loc-budget-materials" type="number" min="0" step="0.01" placeholder="0.00" />
        <div class="screen-sub">Burns down as receipts are submitted against this location.</div>
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
    const budgetAmount = document.getElementById('new-loc-budget').value.trim() || null;
    const budgetMaterials = document.getElementById('new-loc-budget-materials').value.trim() || null;
    const errorEl = document.getElementById('new-loc-error');
    errorEl.innerHTML = '';

    if (!name) {
      errorEl.innerHTML = errorHtml('Name is required.');
      return;
    }

    try {
      const result = await api('/job-locations', {
        method: 'POST',
        body: JSON.stringify({ companyId: state.activeCompanyId, name, address, budgetAmount, budgetMaterials }),
      });

      if (result.needsConfirmation) {
        const proceed = confirm(
          `This looks similar to an existing location (${result.suggestions[0].name}, ${result.suggestions[0].score}% match). Add it as a new location anyway?`
        );
        if (!proceed) return;
        await api('/job-locations', {
          method: 'POST',
          body: JSON.stringify({ companyId: state.activeCompanyId, name, address, budgetAmount, budgetMaterials, confirmNew: true }),
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

  // Show budget burn for locations that appear in this week's entries and have a budget.
  // Collect unique job location IDs from all segments this week.
  const locationIds = [...new Set(
    summaries.flatMap(s => s.days.flatMap(d => d.segments.map(seg => seg.jobLocationId).filter(Boolean)))
  )];

  if (locationIds.length > 0) {
    const burnSection = document.createElement('div');
    burnSection.style.cssText = 'margin-top:20px; border-top:1px solid var(--line); padding-top:14px;';
    burnSection.innerHTML = `<div class="screen-sub" style="font-weight:600; color:var(--ink); margin-bottom:10px;">Project Budget Status</div><div id="admin-budget-burns">${loadingHtml()}</div>`;
    el.appendChild(burnSection);

    Promise.all(locationIds.map(id => api(withCompany(`/job-locations?budgetBurn=true&locationId=${id}`)).catch(() => null)))
      .then(results => {
        const withBudget = results.filter(r => r && (r.labor?.budget != null || r.materials?.budget != null));
        const burnEl = document.getElementById('admin-budget-burns');
        if (!burnEl) return;
        if (withBudget.length === 0) {
          burnEl.innerHTML = `<div class="screen-sub">No budgeted locations in this week's entries.</div>`;
          return;
        }

        function bucketBar(bucket, label) {
          if (!bucket || bucket.budget == null) return '';
          const pct = bucket.percentSpent;
          const barColor = bucket.overBudget ? '#e53e3e' : bucket.warning ? '#d97706' : 'var(--amber)';
          const flagLabel = bucket.overBudget ? ' ⚠ Over budget' : bucket.warning ? ' ⚠ Low budget' : '';
          return `
            <div style="margin-bottom:8px;">
              <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:3px;">
                <span style="color:var(--ink-soft);">${label}</span>
                <span style="color:${barColor}; font-weight:${flagLabel?'700':'400'};">$${bucket.spent.toFixed(2)} / $${bucket.budget.toFixed(2)}${flagLabel}</span>
              </div>
              <div style="background:var(--line); border-radius:4px; height:5px; overflow:hidden;">
                <div style="background:${barColor}; width:${Math.min(pct, 100)}%; height:100%; border-radius:4px;"></div>
              </div>
              <div style="font-size:11px; color:var(--ink-soft); margin-top:2px;">$${Math.max(bucket.remaining, 0).toFixed(2)} remaining (${Math.min(pct, 100)}%)</div>
            </div>
          `;
        }

        burnEl.innerHTML = withBudget.map(r => `
          <div style="margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid var(--line);">
            <div style="font-weight:600; font-size:13px; margin-bottom:6px;">${escapeHtml(r.locationName)}</div>
            ${bucketBar(r.labor, 'Labor')}
            ${bucketBar(r.materials, 'Materials')}
          </div>
        `).join('');
      });
  }
}

async function exportWeekCsv(weekOf, summaries) {
  // Fetch receipt photos for this week alongside the time entry data
  const weekEnd = addDaysStr(weekOf, 6);
  let receipts = [];
  try {
    const receiptData = await api(withCompany(
      `/job-photos?receiptsOnly=true&startDate=${weekOf}&endDate=${weekEnd}`
    ));
    receipts = receiptData.photos || [];
  } catch (err) {
    console.error('Could not fetch receipts for CSV:', err);
  }

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

  // Receipts section - separate from hours, grouped by employee
  if (receipts.length > 0) {
    rows.push([]);
    rows.push(['--- RECEIPTS ---', '', '', '', '', '', '']);
    rows.push(['Employee', 'Date', 'Job Location', 'Description', 'Amount ($)', '', '']);
    rows.push([]);

    // Group receipts by employee name
    const receiptsByEmployee = {};
    for (const r of receipts) {
      const name = r.employeeName || 'Unknown';
      if (!receiptsByEmployee[name]) receiptsByEmployee[name] = [];
      receiptsByEmployee[name].push(r);
    }

    for (const [employeeName, empReceipts] of Object.entries(receiptsByEmployee).sort()) {
      let employeeTotal = 0;
      for (const r of empReceipts) {
        const amount = r.receiptAmount ? Number(r.receiptAmount) : 0;
        employeeTotal += amount;
        rows.push([
          employeeName,
          r.takenAt ? r.takenAt.slice(0, 10) : '',
          r.jobLocationName || '',
          r.description || '',
          amount.toFixed(2),
          '',
          '',
        ]);
      }
      rows.push([employeeName, '', '', 'Total receipts', employeeTotal.toFixed(2), '', '']);
      rows.push([]);
    }

    // Grand total across all employees
    const grandTotal = receipts.reduce((sum, r) => sum + (r.receiptAmount ? Number(r.receiptAmount) : 0), 0);
    rows.push(['ALL EMPLOYEES', '', '', 'Week receipt total', grandTotal.toFixed(2), '', '']);
  }

  // Work orders section - completed WOs ready to bill this week
  try {
    const woData = await api(withCompany('/work-orders?status=ready_to_bill'));
    const wos = (woData.workOrders || []).filter(wo => {
      if (!wo.completedAt) return false;
      const completedDate = wo.completedAt.slice(0, 10);
      return completedDate >= weekOf && completedDate <= weekEnd;
    });

    if (wos.length > 0) {
      rows.push([]);
      rows.push(['--- WORK ORDERS READY TO BILL ---', '', '', '', '']);
      rows.push(['WO Number', 'Job Location', 'Completed By', 'Completed Date', 'Status']);
      rows.push([]);

      for (const wo of wos) {
        rows.push([
          wo.woNumber,
          wo.jobLocation ? wo.jobLocation.name : '',
          wo.completedBy ? wo.completedBy.name : '',
          wo.completedAt ? wo.completedAt.slice(0, 10) : '',
          'READY TO BILL',
        ]);
      }

      rows.push([]);
      rows.push([`${wos.length} work order${wos.length !== 1 ? 's' : ''} ready to bill`, '', '', '', '']);
    }
  } catch (err) {
    console.error('Could not fetch work orders for CSV:', err);
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

async function downloadReceiptPdf(weekOf) {
  const btn = document.getElementById('export-pdf-btn');
  btn.disabled = true;
  btn.textContent = 'Opening report...';

  try {
    const response = await fetch(
      `/.netlify/functions/receipt-pdf?companyId=${encodeURIComponent(state.activeCompanyId)}&weekOf=${encodeURIComponent(weekOf)}`,
      { headers: { 'Authorization': `Bearer ${state.token}` } }
    );

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.noReceipts) { alert('No receipts found for this week.'); return; }
      throw new Error(data.error || `Server error ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      if (data.noReceipts) { alert('No receipts found for this week.'); return; }
      throw new Error(data.error || 'No receipts found');
    }

    // HTML report — open in new tab so user can Print → Save as PDF
    const html = await response.text();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    alert(`Could not generate receipt report: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Receipt PDF';
  }
}

async function loadAdminReceipts() {
  const gridEl = document.getElementById('receipts-admin-grid');
  const locId = document.getElementById('receipts-location-filter')?.value || '';
  const period = document.getElementById('receipts-period-filter')?.value || 'week';
  if (!gridEl) return;
  gridEl.innerHTML = loadingHtml();

  try {
    let url = withCompany('/job-photos?receiptsOnly=true');
    if (locId) url += `&jobLocationId=${locId}`;
    const data = await api(url);
    let receipts = data.photos || [];

    // Filter by period client-side
    const now = new Date();
    if (period === 'week') {
      const weekStart = sundayOf(todayStr());
      receipts = receipts.filter(r => r.takenAt && r.takenAt.slice(0,10) >= weekStart);
    } else if (period === 'month') {
      const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
      receipts = receipts.filter(r => r.takenAt && r.takenAt.slice(0,10) >= monthStart);
    }

    if (receipts.length === 0) {
      gridEl.innerHTML = `<div class="empty-state"><div class="icon">🧾</div>No receipts found for this selection.</div>`;
      return;
    }

    const total = receipts.reduce((sum, r) => sum + (r.receiptAmount || 0), 0);

    gridEl.innerHTML = `
      <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:#16a34a;">
        ${receipts.length} receipt${receipts.length !== 1 ? 's' : ''} &middot; Total: $${total.toFixed(2)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${receipts.map(r => `
          <div style="border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--paper);">
            ${r.url ? `<a href="${r.url}" target="_blank"><img src="${r.url}" style="width:100%;display:block;max-height:140px;object-fit:cover;" /></a>` : '<div style="height:60px;background:var(--paper-dim);display:flex;align-items:center;justify-content:center;font-size:20px;">🧾</div>'}
            <div style="padding:6px 8px;">
              <div style="font-size:13px;font-weight:700;color:#16a34a;">${r.receiptAmount ? '$'+Number(r.receiptAmount).toFixed(2) : 'No amount'}</div>
              <div style="font-size:11px;color:var(--ink-soft);">${escapeHtml(r.jobLocationName || 'No location')}</div>
              <div style="font-size:11px;color:var(--ink-soft);">${escapeHtml(r.employeeName || '')} &middot; ${r.takenAt ? r.takenAt.slice(0,10) : ''}</div>
              ${r.description ? `<div style="font-size:11px;color:var(--ink);margin-top:2px;">${escapeHtml(r.description)}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>`;
  } catch (err) {
    gridEl.innerHTML = errorHtml(err.message);
  }
}

// ---- Broadcast Messages ----

async function loadBroadcastMessages() {
  const listEl = document.getElementById('broadcast-message-list');
  if (!listEl) return;
  try {
    const data = await api(withCompany('/broadcast-messages'));
    const messages = data.messages || [];
    if (messages.length === 0) {
      listEl.innerHTML = '<div class="screen-sub">No messages yet. Create one to notify your team.</div>';
      return;
    }
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    listEl.innerHTML = messages.map(m => {
      const schedule = m.is_recurring
        ? `Recurring ${m.recurrence_type}${m.recurrence_type === 'weekly' ? ' (' + (m.recurrence_days || []).map(d => dayNames[d]).join(', ') + ')' : ''}`
        : `One-time${m.send_once_date ? ' — ' + m.send_once_date : ''}`;
      const recipients = m.recipient_type === 'all' ? 'All employees' : `${(m.recipient_ids || []).length} specific employee(s)`;
      return `
        <div style="border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px;background:${m.active ? 'var(--paper)' : 'var(--paper-dim)'};">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
            <div style="font-weight:700;font-size:14px;">${m.title ? escapeHtml(m.title) : 'Message'}</div>
            <span style="font-size:11px;font-weight:600;color:${m.active ? '#16a34a' : 'var(--ink-soft)'};">${m.active ? 'Active' : 'Inactive'}</span>
          </div>
          <div style="font-size:13px;color:var(--ink);margin-bottom:6px;background:var(--paper-dim);border-radius:6px;padding:8px 10px;">${escapeHtml(m.message)}</div>
          <div style="font-size:11px;color:var(--ink-soft);">${schedule} &middot; ${recipients}</div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-ghost" data-msg-edit="${m.id}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-msg-toggle="${m.id}" data-msg-active="${m.active}">${m.active ? 'Deactivate' : 'Activate'}</button>
            <button class="btn btn-sm btn-ghost" data-msg-delete="${m.id}" style="color:#dc2626;border-color:#dc2626;">Delete</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('[data-msg-edit]').forEach(btn => {
      const msg = messages.find(m => m.id === btn.getAttribute('data-msg-edit'));
      if (msg) btn.addEventListener('click', () => showMessageDialog(msg));
    });
    listEl.querySelectorAll('[data-msg-toggle]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const active = btn.getAttribute('data-msg-active') === 'true';
        await api('/broadcast-messages', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, messageId: btn.getAttribute('data-msg-toggle'), active: !active }) });
        loadBroadcastMessages();
      });
    });
    listEl.querySelectorAll('[data-msg-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this message?')) return;
        await api('/broadcast-messages', { method: 'DELETE', body: JSON.stringify({ companyId: state.activeCompanyId, messageId: btn.getAttribute('data-msg-delete') }) });
        loadBroadcastMessages();
      });
    });
  } catch (err) {
    listEl.innerHTML = errorHtml(err.message);
  }
}

async function showMessageDialog(existing) {
  let allPeople = [];
  try {
    const d = await api(withCompany('/dashboard'));
    allPeople = (d.people || []).filter(p => p.roleActive !== false);
  } catch (e) {}

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:150;padding:20px;';
  const isRecurring = existing?.is_recurring || false;
  const recType = existing?.recurrence_type || 'daily';
  const recDays = existing?.recurrence_days || [];
  const recipType = existing?.recipient_type || 'all';
  const recipIds = existing?.recipient_ids || [];

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:100%;max-width:500px;max-height:90vh;overflow-y:auto;padding:20px;">
      <div style="font-weight:700;font-size:18px;margin-bottom:16px;">${existing ? 'Edit message' : 'New broadcast message'}</div>

      <div class="field">
        <label>Title (optional)</label>
        <input id="msg-title" type="text" placeholder="e.g. Safety reminder" value="${existing?.title ? escapeHtml(existing.title) : ''}" />
      </div>

      <div class="field">
        <label>Message</label>
        <textarea id="msg-body" rows="4" placeholder="Type your message here...">${existing?.message ? escapeHtml(existing.message) : ''}</textarea>
      </div>

      <div class="field">
        <label>Recipients</label>
        <select id="msg-recipient-type" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;margin-bottom:8px;">
          <option value="all" ${recipType === 'all' ? 'selected' : ''}>All employees</option>
          <option value="specific" ${recipType === 'specific' ? 'selected' : ''}>Specific employees</option>
        </select>
        <div id="msg-specific-people" style="${recipType === 'specific' ? '' : 'display:none;'}border:1px solid var(--line);border-radius:8px;overflow:hidden;max-height:180px;overflow-y:auto;">
          ${allPeople.map(p => `
            <label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer;font-size:13px;">
              <input type="checkbox" value="${p.id}" ${recipIds.includes(p.id) ? 'checked' : ''} style="width:16px;height:16px;" />
              ${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)} (${p.role})
            </label>`).join('')}
        </div>
      </div>

      <div class="field">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px;">
          <input type="checkbox" id="msg-is-recurring" ${isRecurring ? 'checked' : ''} style="width:18px;height:18px;" />
          Recurring message
        </label>
      </div>

      <div id="msg-recurring-options" style="${isRecurring ? '' : 'display:none;'}">
        <div class="field">
          <label>Repeat</label>
          <select id="msg-recurrence-type" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;">
            <option value="daily" ${recType === 'daily' ? 'selected' : ''}>Daily</option>
            <option value="weekly" ${recType === 'weekly' ? 'selected' : ''}>Weekly (select days)</option>
            <option value="monthly" ${recType === 'monthly' ? 'selected' : ''}>Monthly (select days of month)</option>
          </select>
        </div>
        <div id="msg-weekly-days" style="${recType === 'weekly' ? '' : 'display:none;'}display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
          ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d,i) => `
            <label style="display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;">
              <input type="checkbox" value="${i}" ${recDays.includes(i) ? 'checked' : ''} style="width:16px;height:16px;" />
              <span style="font-size:11px;">${d}</span>
            </label>`).join('')}
        </div>
      </div>

      <div id="msg-once-options" style="${isRecurring ? 'display:none;' : ''}">
        <div class="field">
          <label>Send date</label>
          <input id="msg-send-date" type="date" value="${existing?.send_once_date || todayStr()}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;" />
        </div>
      </div>

      <div id="msg-error" style="color:#dc2626;font-size:13px;margin-bottom:8px;"></div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="msg-cancel">Cancel</button>
        <button class="btn btn-primary" id="msg-save">${existing ? 'Save changes' : 'Send message'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => document.body.removeChild(overlay);
  overlay.querySelector('#msg-cancel').addEventListener('click', close);

  overlay.querySelector('#msg-recipient-type').addEventListener('change', e => {
    overlay.querySelector('#msg-specific-people').style.display = e.target.value === 'specific' ? '' : 'none';
  });
  overlay.querySelector('#msg-is-recurring').addEventListener('change', e => {
    overlay.querySelector('#msg-recurring-options').style.display = e.target.checked ? '' : 'none';
    overlay.querySelector('#msg-once-options').style.display = e.target.checked ? 'none' : '';
  });
  overlay.querySelector('#msg-recurrence-type').addEventListener('change', e => {
    overlay.querySelector('#msg-weekly-days').style.display = e.target.value === 'weekly' ? '' : 'none';
  });

  overlay.querySelector('#msg-save').addEventListener('click', async () => {
    const message = overlay.querySelector('#msg-body').value.trim();
    const title = overlay.querySelector('#msg-title').value.trim();
    const recipientType = overlay.querySelector('#msg-recipient-type').value;
    const isRecurringChecked = overlay.querySelector('#msg-is-recurring').checked;
    const recurrenceType = overlay.querySelector('#msg-recurrence-type').value;
    const sendOnceDate = overlay.querySelector('#msg-send-date')?.value || null;
    const errorEl = overlay.querySelector('#msg-error');

    if (!message) { errorEl.textContent = 'Message is required.'; return; }

    const recipientIds = recipientType === 'specific'
      ? [...overlay.querySelectorAll('#msg-specific-people input:checked')].map(cb => cb.value)
      : null;
    if (recipientType === 'specific' && (!recipientIds || recipientIds.length === 0)) {
      errorEl.textContent = 'Select at least one recipient.'; return;
    }

    const recurrenceDays = isRecurringChecked && recurrenceType === 'weekly'
      ? [...overlay.querySelectorAll('#msg-weekly-days input:checked')].map(cb => parseInt(cb.value))
      : null;

    const payload = { companyId: state.activeCompanyId, message, title: title || null, recipientType, recipientIds, isRecurring: isRecurringChecked, recurrenceType: isRecurringChecked ? recurrenceType : null, recurrenceDays, sendOnceDate: !isRecurringChecked ? sendOnceDate : null };
    if (existing) payload.messageId = existing.id;

    const btn = overlay.querySelector('#msg-save');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      await api('/broadcast-messages', { method: existing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      close();
      loadBroadcastMessages();
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false; btn.textContent = existing ? 'Save changes' : 'Send message';
    }
  });
}

// ---- Materials Catalog ----

async function loadMaterialsCatalog(searchQ) {
  const listEl = document.getElementById('materials-catalog-list');
  if (!listEl) return;
  try {
    const q = searchQ ? `&q=${encodeURIComponent(searchQ)}&limit=50` : '&limit=50';
    const data = await api(withCompany(`/materials-catalog?activeOnly=false${q}`));
    const items = data.items || [];
    if (items.length === 0) {
      listEl.innerHTML = `<div class="screen-sub">${searchQ ? 'No items match your search.' : 'No catalog items yet. Add items or import a CSV.'}</div>`;
      return;
    }
    listEl.innerHTML = `
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px;">${items.length} item${items.length !== 1 ? 's' : ''}</div>
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:500px;">
        <thead>
          <tr style="background:var(--paper-dim);font-size:11px;font-weight:700;color:var(--ink-soft);">
            <th style="padding:6px 8px;text-align:left;">Part #</th>
            <th style="padding:6px 8px;text-align:left;">Name</th>
            <th style="padding:6px 8px;text-align:left;">Category</th>
            <th style="padding:6px 8px;text-align:left;">Unit</th>
            <th style="padding:6px 8px;text-align:right;">Unit Cost</th>
            <th style="padding:6px 8px;text-align:center;">Active</th>
            <th style="padding:6px 8px;"></th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item, i) => `
            <tr style="background:${i % 2 === 0 ? '#fff' : 'var(--paper-dim)'};${item.active ? '' : 'opacity:0.5;'}">
              <td style="padding:6px 8px;">${item.part_number ? escapeHtml(item.part_number) : '—'}</td>
              <td style="padding:6px 8px;font-weight:600;">${escapeHtml(item.name)}</td>
              <td style="padding:6px 8px;">${item.category ? escapeHtml(item.category) : '—'}</td>
              <td style="padding:6px 8px;">${item.unit || 'each'}</td>
              <td style="padding:6px 8px;text-align:right;">${item.unit_cost ? '$' + Number(item.unit_cost).toFixed(2) : '—'}</td>
              <td style="padding:6px 8px;text-align:center;">${item.active ? '✓' : '—'}</td>
              <td style="padding:6px 8px;">
                <button class="btn btn-sm btn-ghost" data-edit-material="${item.id}" style="font-size:11px;padding:2px 8px;">Edit</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
    `;
    listEl.querySelectorAll('[data-edit-material]').forEach(btn => {
      const item = items.find(i => i.id === btn.getAttribute('data-edit-material'));
      if (item) btn.addEventListener('click', () => showMaterialDialog(item));
    });
  } catch (err) {
    listEl.innerHTML = errorHtml(err.message);
  }
}

function showMaterialDialog(existing) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:150;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:100%;max-width:420px;padding:20px;">
      <div style="font-weight:700;font-size:17px;margin-bottom:16px;">${existing ? 'Edit catalog item' : 'Add catalog item'}</div>
      <div class="field">
        <label>Part number (optional)</label>
        <input id="mat-part-number" type="text" value="${existing?.part_number ? escapeHtml(existing.part_number) : ''}" placeholder="e.g. 14-2-NM" />
      </div>
      <div class="field">
        <label>Name *</label>
        <input id="mat-name" type="text" value="${existing?.name ? escapeHtml(existing.name) : ''}" placeholder="e.g. 14/2 Romex Wire" />
      </div>
      <div class="field">
        <label>Category (optional)</label>
        <input id="mat-category" type="text" value="${existing?.category ? escapeHtml(existing.category) : ''}" placeholder="e.g. Wire, Boxes, Devices" />
      </div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;">
          <label>Unit</label>
          <select id="mat-unit" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;">
            ${['each','box','roll','ft','bag','pack','pair','lb'].map(u => `<option ${(existing?.unit||'each')===u?'selected':''}>${u}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="flex:1;">
          <label>Unit cost (optional)</label>
          <input id="mat-unit-cost" type="number" step="0.01" min="0" value="${existing?.unit_cost || ''}" placeholder="0.00" />
        </div>
      </div>
      ${existing ? `
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="mat-active" ${existing.active ? 'checked' : ''} style="width:16px;height:16px;" />
          Active (appears in change order autofill)
        </label>
      </div>` : ''}
      <div id="mat-error" style="color:#dc2626;font-size:13px;margin-bottom:8px;"></div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="mat-cancel">Cancel</button>
        <button class="btn btn-primary" id="mat-save">${existing ? 'Save changes' : 'Add item'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => document.body.removeChild(overlay);
  overlay.querySelector('#mat-cancel').addEventListener('click', close);
  overlay.querySelector('#mat-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#mat-name').value.trim();
    const errorEl = overlay.querySelector('#mat-error');
    if (!name) { errorEl.textContent = 'Name is required.'; return; }
    const payload = {
      companyId: state.activeCompanyId,
      partNumber: overlay.querySelector('#mat-part-number').value.trim() || null,
      name,
      category: overlay.querySelector('#mat-category').value.trim() || null,
      unit: overlay.querySelector('#mat-unit').value,
      unitCost: overlay.querySelector('#mat-unit-cost').value || null,
    };
    if (existing) {
      payload.id = existing.id;
      payload.active = overlay.querySelector('#mat-active').checked;
    }
    const btn = overlay.querySelector('#mat-save');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      await api('/materials-catalog', { method: existing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      close();
      loadMaterialsCatalog(document.getElementById('catalog-search')?.value || '');
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false; btn.textContent = existing ? 'Save changes' : 'Add item';
    }
  });
}

function showMaterialImportDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:150;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:100%;max-width:480px;padding:20px;">
      <div style="font-weight:700;font-size:17px;margin-bottom:8px;">Import CSV</div>
      <div class="screen-sub" style="margin-bottom:14px;">CSV must have columns: <strong>name</strong> (required), part_number, category, unit, unit_cost. First row is headers.</div>
      <input type="file" id="mat-csv-file" accept=".csv,.txt" style="margin-bottom:12px;" />
      <div id="mat-preview" style="max-height:200px;overflow-y:auto;margin-bottom:12px;font-size:12px;"></div>
      <div id="mat-import-error" style="color:#dc2626;font-size:13px;margin-bottom:8px;"></div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="mat-import-cancel">Cancel</button>
        <button class="btn btn-primary" id="mat-import-save" disabled>Import</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => document.body.removeChild(overlay);
  overlay.querySelector('#mat-import-cancel').addEventListener('click', close);

  let parsedRows = [];
  overlay.querySelector('#mat-csv-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const lines = ev.target.result.split('\n').filter(l => l.trim());
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
      parsedRows = lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const row = {};
        headers.forEach((h, i) => { row[h] = vals[i] || ''; });
        return row;
      }).filter(r => r.name);

      overlay.querySelector('#mat-preview').innerHTML = `
        <div style="color:var(--ink-soft);margin-bottom:6px;">${parsedRows.length} items found</div>
        ${parsedRows.slice(0,5).map(r => `<div style="padding:3px 0;border-bottom:1px solid var(--line);">${r.part_number ? r.part_number + ' — ' : ''}${r.name}${r.category ? ' [' + r.category + ']' : ''}${r.unit_cost ? ' $' + r.unit_cost : ''}</div>`).join('')}
        ${parsedRows.length > 5 ? `<div style="color:var(--ink-soft);">...and ${parsedRows.length - 5} more</div>` : ''}
      `;
      overlay.querySelector('#mat-import-save').disabled = parsedRows.length === 0;
    };
    reader.readAsText(file);
  });

  overlay.querySelector('#mat-import-save').addEventListener('click', async () => {
    const btn = overlay.querySelector('#mat-import-save');
    const errorEl = overlay.querySelector('#mat-import-error');
    btn.disabled = true; btn.textContent = 'Importing...';
    try {
      const result = await api('/materials-catalog', { method: 'POST', body: JSON.stringify({ companyId: state.activeCompanyId, items: parsedRows }) });
      close();
      loadMaterialsCatalog();
      alert(`Imported ${result.count} items successfully.`);
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Import';
    }
  });
}
