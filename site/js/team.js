async function renderTeam(opts) {
  if (opts.employeeId) {
    return renderTeamDetail(opts.employeeId);
  }

  const isAdmin = currentCompanyRole() === 'admin';

  root.innerHTML = `
    ${topbarHtml()}
    <main>
      ${roleTabsHtml('team')}
      <div class="screen-title">Team</div>
      <div class="screen-sub">${isAdmin ? 'Everyone at this company.' : 'Your assigned crew.'}</div>
      ${isAdmin ? `
        <div class="btn-row" style="margin-bottom:16px;">
          <button class="btn btn-amber" id="add-employee-btn">+ Add employee</button>
          <button class="btn btn-ghost" id="show-inactive-btn">Show deactivated</button>
        </div>
      ` : ''}
      <div id="team-list">${loadingHtml()}</div>
    </main>
  `;

  attachTopbarHandlers();
  attachRoleTabHandlers();

  let showingInactive = false;

  async function loadTeamList() {
    try {
      const path = showingInactive ? withCompany('/dashboard') + '&includeInactive=true' : withCompany('/dashboard');
      const data = await api(path);
      renderTeamList(data.people || []);
    } catch (err) {
      document.getElementById('team-list').innerHTML = errorHtml(err.message);
    }
  }

  if (isAdmin) {
    document.getElementById('add-employee-btn').addEventListener('click', () => showAddEmployeeDialog());
    const inactiveBtn = document.getElementById('show-inactive-btn');
    inactiveBtn.addEventListener('click', () => {
      showingInactive = !showingInactive;
      inactiveBtn.textContent = showingInactive ? 'Hide deactivated' : 'Show deactivated';
      loadTeamList();
    });
  }

  loadTeamList();
}

function renderTeamList(people) {
  const el = document.getElementById('team-list');
  if (people.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">&#128101;</div>No one assigned yet.</div>`;
    return;
  }

  const roleLabel = { employee: 'Employee', foreman: 'Foreman', admin: 'Admin' };

  el.innerHTML = people.map(p => `
    <div class="day-stub" data-person-id="${p.id}" style="cursor:pointer; ${p.roleActive === false ? 'opacity:0.55;' : ''}">
      <div class="day-stub-perf"></div>
      <div class="day-stub-body">
        <div class="day-stub-top">
          <div class="day-stub-date">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}${p.roleActive === false ? ' (deactivated)' : ''}</div>
          <div class="day-stub-hours">${p.currentWeekHours.toFixed(1)}h</div>
        </div>
        <div class="day-stub-meta">
          <span>${roleLabel[p.role] || p.role}</span>
          <span>Leave remaining: ${p.ptoBalance.remainingHours.toFixed(1)}h</span>
        </div>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('[data-person-id]').forEach(card => {
    card.addEventListener('click', () => render('team', { employeeId: card.getAttribute('data-person-id') }));
  });
}

async function renderTeamDetail(employeeId) {
  root.innerHTML = `
    ${topbarHtml()}
    <main>
      <button class="btn btn-ghost btn-sm" id="back-to-team" style="margin-bottom:16px;">&larr; Back to team</button>
      <div id="team-detail">${loadingHtml()}</div>
    </main>
  `;

  attachTopbarHandlers();
  document.getElementById('back-to-team').addEventListener('click', () => render('team'));

  try {
    const data = await api(withCompany(`/dashboard?employeeId=${employeeId}`));
    renderTeamDetailContent(data);
  } catch (err) {
    document.getElementById('team-detail').innerHTML = errorHtml(err.message);
  }
}

function renderTeamDetailContent(data) {
  const { employee, currentWeekTotals, ptoBalance, recentPtoRequests, entries } = data;
  const isAdmin = currentCompanyRole() === 'admin';

  const ptoStatusLabel = { pending: 'Pending', approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled' };
  const ptoStatusClass = { pending: 'foreman_approved', approved: 'admin_approved', denied: 'rejected', cancelled: 'draft' };
  const entryStatusLabel = { draft: 'Draft', foreman_approved: 'Foreman approved', admin_approved: 'Approved', rejected: 'Sent back' };

  document.getElementById('team-detail').innerHTML = `
    <div class="screen-title">${escapeHtml(employee.firstName)} ${escapeHtml(employee.lastName)}</div>
    <div class="screen-sub">${employee.role.charAt(0).toUpperCase() + employee.role.slice(1)} &middot; ${escapeHtml(employee.phone)}</div>
    ${employee.roleActive === false ? `<div class="banner banner-warn">This person is deactivated at this company. They cannot log in to act here, but their history below is preserved.</div>` : ''}

    ${isAdmin ? `<button class="btn btn-ghost btn-sm" id="edit-profile-btn" style="margin-bottom:14px;">Edit profile</button>` : ''}

    <div class="summary-card">
      <div class="summary-row"><span class="label">Regular hours (this week)</span><span class="value">${currentWeekTotals.regularHoursWorked.toFixed(2)}</span></div>
      <div class="summary-row"><span class="label">Overtime</span><span class="value">${currentWeekTotals.overtimeHoursWorked.toFixed(2)}</span></div>
      <div class="summary-row"><span class="label">Holiday</span><span class="value">${currentWeekTotals.holidayHours.toFixed(2)}</span></div>
      <div class="summary-row"><span class="label">Leave</span><span class="value">${currentWeekTotals.ptoHours.toFixed(2)}</span></div>
      <div class="summary-row total"><span class="label">Weekly total</span><span class="value">${currentWeekTotals.weeklyHours.toFixed(2)}</span></div>
    </div>

    <div class="screen-sub" style="font-weight:600; color:var(--ink); margin-bottom:8px;">Leave Balance (${ptoBalance.year}) &middot; combined across all companies</div>
    <div class="summary-card">
      <div class="summary-row"><span class="label">Allotment</span><span class="value">${ptoBalance.allotmentHours.toFixed(1)}h</span></div>
      <div class="summary-row"><span class="label">Used</span><span class="value">${ptoBalance.usedHours.toFixed(1)}h</span></div>
      <div class="summary-row total"><span class="label">Remaining</span><span class="value">${ptoBalance.remainingHours.toFixed(1)}h</span></div>
      ${((ptoBalance.utoDaysTaken || 0) > 0 || isAdmin) ? `
        <div class="summary-row" style="border-top:1px solid var(--line); margin-top:6px; padding-top:6px;">
          <span class="label" style="color:var(--ink-soft);">Unpaid days taken (all time)</span>
          <span class="value" style="color:var(--ink-soft);">${(ptoBalance.utoDaysTaken || 0).toFixed(1)}</span>
        </div>
      ` : ''}
    </div>
    ${isAdmin ? `
      <div class="btn-row" style="margin-bottom:20px;">
        <button class="btn btn-ghost btn-sm" id="edit-allotment-btn">Edit leave balance</button>
        <button class="btn btn-sm ${employee.roleActive === false ? 'btn-primary' : 'btn-danger'}" id="toggle-active-btn">${employee.roleActive === false ? 'Reactivate' : 'Deactivate'}</button>
      </div>
    ` : ''}

    <div class="screen-sub" style="font-weight:600; color:var(--ink); margin-bottom:8px;">Recent time off requests (this company)</div>
    ${recentPtoRequests.length === 0
      ? `<div class="empty-state" style="padding:20px;">No requests yet.</div>`
      : recentPtoRequests.map(r => `
        <div class="day-stub">
          <div class="day-stub-perf"></div>
          <div class="day-stub-body">
            <div class="day-stub-top">
              <div class="day-stub-date">${formatDateLabel(r.start_date)}${r.start_date !== r.end_date ? ' - ' + formatDateLabel(r.end_date) : ''}</div>
              <div class="day-stub-hours">${Number(r.hours_per_day).toFixed(1)}h/day</div>
            </div>
            <span class="status-pill status-${ptoStatusClass[r.status] || 'draft'}">${ptoStatusLabel[r.status] || r.status}</span>
          </div>
        </div>
      `).join('')
    }

    <div class="screen-sub" style="font-weight:600; color:var(--ink); margin: 20px 0 8px;">Recent timesheet history (this company)</div>
    ${entries.length === 0
      ? `<div class="empty-state" style="padding:20px;">No entries in this range.</div>`
      : entries.slice().reverse().map(e => `
        <div class="day-stub">
          <div class="day-stub-perf"></div>
          <div class="day-stub-body">
            <div class="day-stub-top">
              <div class="day-stub-date">${formatDateLabel(e.date)}</div>
              <div class="day-stub-hours">${Number(e.hoursWorked).toFixed(2)}h</div>
            </div>
            <div class="day-stub-meta">
              ${e.jobLocation ? `<span>${escapeHtml(e.jobLocation)}</span>` : ''}
              ${e.hoursType !== 'regular' ? `<span>${e.hoursType.toUpperCase()}</span>` : ''}
            </div>
            <span class="status-pill status-${e.status}">${entryStatusLabel[e.status] || e.status}</span>
          </div>
        </div>
      `).join('')
    }
  `;

  if (isAdmin) {
    document.getElementById('edit-profile-btn').addEventListener('click', () => showEditProfileDialog(employee));
    document.getElementById('edit-allotment-btn').addEventListener('click', () => showEditAllotmentDialog(employee, ptoBalance));
    document.getElementById('toggle-active-btn').addEventListener('click', () => toggleEmployeeActive(employee));
  }
}

async function toggleEmployeeActive(employee) {
  const willActivate = employee.roleActive === false;
  const verb = willActivate ? 'reactivate' : 'deactivate';
  if (!confirm(`Are you sure you want to ${verb} ${employee.firstName} ${employee.lastName} at this company?`)) return;

  try {
    await api('/employee-management', {
      method: 'PUT',
      body: JSON.stringify({ companyId: state.activeCompanyId, employeeId: employee.id, active: willActivate }),
    });
    render('team', { employeeId: employee.id });
  } catch (err) {
    alert(err.message);
  }
}

function showEditAllotmentDialog(employee, currentBalance) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:380px;width:100%;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Edit leave balance</div>
      <div class="screen-sub">${escapeHtml(employee.firstName)} ${escapeHtml(employee.lastName)} &middot; ${currentBalance.year}</div>
      <div class="field">
        <label for="allotment-hours">Annual allotment (hours)</label>
        <input id="allotment-hours" type="number" min="0" step="1" value="${currentBalance.allotmentHours}" />
      </div>
      <div class="field">
        <label for="used-hours">Used this year (hours)</label>
        <input id="used-hours" type="number" min="0" step="0.5" value="${currentBalance.usedHours}" />
      </div>
      <div class="screen-sub">Used hours normally update automatically when a leave request is approved. Changing this number directly overrides that - use this for backfilling history or correcting a mistake.</div>
      <div class="field" style="margin-top:14px; border-top:1px solid var(--line); padding-top:14px;">
        <label for="uto-days">Unpaid time off days (all time, never resets)</label>
        <input id="uto-days" type="number" min="0" step="0.5" value="${currentBalance.utoDaysTaken || 0}" />
      </div>
      <div class="screen-sub">This tracks unpaid days taken over the employee's entire tenure, for performance record purposes. Only adjustable here by admin.</div>
      <div id="allotment-dialog-error"></div>
      <div class="btn-row" style="margin-top:12px;">
        <button class="btn btn-ghost" id="allotment-cancel">Cancel</button>
        <button class="btn btn-primary" id="allotment-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('allotment-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  document.getElementById('allotment-save').addEventListener('click', async () => {
    const allotmentHours = Number(document.getElementById('allotment-hours').value || 0);
    const usedHours = Number(document.getElementById('used-hours').value || 0);
    const utoDaysTaken = Number(document.getElementById('uto-days').value || 0);
    const errorEl = document.getElementById('allotment-dialog-error');
    try {
      await api('/pto-balances', {
        method: 'PUT',
        body: JSON.stringify({ employeeId: employee.id, companyId: state.activeCompanyId, year: currentBalance.year, allotmentHours, usedHours, utoDaysTaken }),
      });
      document.body.removeChild(overlay);
      render('team', { employeeId: employee.id });
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
    }
  });
}

async function showAddEmployeeDialog() {
  // Fetch the current team first so we can offer a real dropdown of
  // existing foremen/admins to assign as this new person's foreman,
  // rather than asking the admin to type a phone number and trying to
  // (unreliably) resolve it client-side.
  let existingPeople = [];
  try {
    const teamData = await api(withCompany('/dashboard'));
    existingPeople = teamData.people || [];
  } catch (err) {
    alert(`Could not load the current team list: ${err.message}`);
    return;
  }

  const possibleForemen = existingPeople.filter(p => p.role === 'foreman' || p.role === 'admin');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Add employee</div>
      <div class="screen-sub">If the phone number matches someone who already exists, this just adds them to this company - their name and PIN stay what they already had.</div>

      <div class="field">
        <label for="new-emp-phone">Mobile number</label>
        <input id="new-emp-phone" type="tel" inputmode="tel" placeholder="(864) 555-0123" />
      </div>
      <div class="field-row">
        <div class="field">
          <label for="new-emp-first">First name</label>
          <input id="new-emp-first" type="text" />
        </div>
        <div class="field">
          <label for="new-emp-last">Last name</label>
          <input id="new-emp-last" type="text" />
        </div>
      </div>
      <div class="field">
        <label for="new-emp-pin">PIN (4-6 digits)</label>
        <input id="new-emp-pin" class="pin-input" type="text" inputmode="numeric" maxlength="6" />
      </div>
      <div class="screen-sub">First name, last name, and PIN are only needed if this phone number is brand new. If it already belongs to someone here, leave those blank.</div>
      <div class="field">
        <label for="new-emp-email">Email (optional)</label>
        <input id="new-emp-email" type="email" />
      </div>
      <div class="field">
        <label for="new-emp-role">Role at this company</label>
        <select id="new-emp-role">
          <option value="employee">Employee</option>
          <option value="foreman">Foreman</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div class="field">
        <label for="new-emp-foreman">Foreman (optional)</label>
        <select id="new-emp-foreman">
          <option value="">No foreman</option>
          ${possibleForemen.map(p => `<option value="${p.id}">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)} (${p.role})</option>`).join('')}
        </select>
      </div>

      <div id="add-emp-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="add-emp-cancel">Cancel</button>
        <button class="btn btn-primary" id="add-emp-save">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('add-emp-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  document.getElementById('add-emp-save').addEventListener('click', async () => {
    const phone = document.getElementById('new-emp-phone').value.trim();
    const firstName = document.getElementById('new-emp-first').value.trim();
    const lastName = document.getElementById('new-emp-last').value.trim();
    const pin = document.getElementById('new-emp-pin').value.trim();
    const email = document.getElementById('new-emp-email').value.trim();
    const role = document.getElementById('new-emp-role').value;
    const foremanId = document.getElementById('new-emp-foreman').value || null;
    const errorEl = document.getElementById('add-emp-error');
    errorEl.innerHTML = '';

    if (!phone) {
      errorEl.innerHTML = errorHtml('Mobile number is required.');
      return;
    }

    const saveBtn = document.getElementById('add-emp-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Adding...';

    try {
      await api('/employee-management', {
        method: 'POST',
        body: JSON.stringify({
          companyId: state.activeCompanyId,
          phone,
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          pin: pin || undefined,
          email: email || undefined,
          role,
          foremanId,
        }),
      });

      document.body.removeChild(overlay);
      render('team');
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Add';
    }
  });
}

async function showEditProfileDialog(employee) {
  // Fetch the current team list to populate the foreman dropdown, same
  // pattern as the Add Employee dialog.
  let existingPeople = [];
  try {
    const teamData = await api(withCompany('/dashboard'));
    existingPeople = teamData.people || [];
  } catch (err) {
    alert(`Could not load the current team list: ${err.message}`);
    return;
  }

  const possibleForemen = existingPeople.filter(p => (p.role === 'foreman' || p.role === 'admin') && p.id !== employee.id);

  // currentForemanId isn't part of the drill-down response today, so the
  // dropdown can't be pre-selected to their existing assignment - it
  // just defaults to "no foreman" and the admin picks explicitly if
  // they want to set or change it. Leaving foremanId out of the PATCH
  // body entirely (rather than sending null) means an unrelated edit,
  // like fixing a typo in the name, won't accidentally clear an
  // existing foreman assignment.
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Edit profile</div>

      <div class="field-row">
        <div class="field">
          <label for="edit-first-name">First name</label>
          <input id="edit-first-name" type="text" value="${escapeHtml(employee.firstName)}" />
        </div>
        <div class="field">
          <label for="edit-last-name">Last name</label>
          <input id="edit-last-name" type="text" value="${escapeHtml(employee.lastName)}" />
        </div>
      </div>
      <div class="field">
        <label for="edit-phone">Mobile number</label>
        <input id="edit-phone" type="tel" inputmode="tel" value="${escapeHtml(employee.phone)}" />
      </div>
      <div class="screen-sub">Changing this changes their login number and where text messages go - they'll need to use the new number to log in afterward.</div>
      <div class="field">
        <label for="edit-email">Email (optional)</label>
        <input id="edit-email" type="email" value="${employee.email ? escapeHtml(employee.email) : ''}" />
      </div>
      <div class="field">
        <label for="edit-role">Role at this company</label>
        <select id="edit-role">
          <option value="employee" ${employee.role === 'employee' ? 'selected' : ''}>Employee</option>
          <option value="foreman" ${employee.role === 'foreman' ? 'selected' : ''}>Foreman</option>
          <option value="admin" ${employee.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
      </div>
      <div class="field">
        <label for="edit-foreman">Default assigned foreman (optional)</label>
        <select id="edit-foreman">
          <option value="">No change / no foreman</option>
          ${possibleForemen.map(p => `<option value="${p.id}">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)} (${p.role})</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="edit-start-date">Employment start date (optional)</label>
        <input id="edit-start-date" type="date" value="${employee.employmentStartDate || ''}" />
        <div class="screen-sub">Used to auto-calculate annual PTO allotment on their work anniversary.</div>
      </div>

      <div id="pto-calc-section" style="display:none; background:var(--paper-dim); border-radius:8px; padding:14px; margin-top:4px;">
        <div style="font-size:13px; font-weight:600; margin-bottom:10px;" id="pto-calc-label"></div>
        <div class="field">
          <label for="edit-allotment-hours">Annual allotment (hours)</label>
          <input id="edit-allotment-hours" type="number" min="0" step="1" />
        </div>
        <div class="field">
          <label for="edit-used-hours">Already used this year (hours)</label>
          <input id="edit-used-hours" type="number" min="0" step="0.5" value="0" />
          <div class="screen-sub">Enter any leave already taken before this system tracked it.</div>
        </div>
      </div>

      <div id="edit-profile-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="edit-profile-cancel">Cancel</button>
        <button class="btn btn-primary" id="edit-profile-save">Save changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Same accrual rules as scheduled-pto-accrual.js - must stay in sync.
  function calcAllotmentHours(startDateStr) {
    if (!startDateStr) return null;
    const startYear = parseInt(startDateStr.slice(0, 4), 10);
    const currentYear = new Date().getFullYear();
    const yearsOfService = currentYear - startYear;
    if (yearsOfService < 1) return 0;
    if (yearsOfService >= 5) return 80; // 10 days
    return (5 + (yearsOfService - 1)) * 8; // 1yr=40h, 2yr=48h, 3yr=56h, 4yr=64h
  }

  function updatePtoCalc() {
    const startDate = document.getElementById('edit-start-date').value;
    const section = document.getElementById('pto-calc-section');
    const label = document.getElementById('pto-calc-label');
    const allotmentInput = document.getElementById('edit-allotment-hours');

    if (!startDate) {
      section.style.display = 'none';
      return;
    }

    const hours = calcAllotmentHours(startDate);
    const startYear = parseInt(startDate.slice(0, 4), 10);
    const years = new Date().getFullYear() - startYear;
    const days = hours / 8;

    section.style.display = 'block';

    if (hours === 0) {
      label.textContent = `Less than 1 year of service — no PTO entitlement yet for ${new Date().getFullYear()}.`;
      allotmentInput.value = 0;
    } else {
      label.textContent = `${years} year${years !== 1 ? 's' : ''} of service — ${days} day${days !== 1 ? 's' : ''} (${hours}h) for ${new Date().getFullYear()}.`;
      allotmentInput.value = hours;
    }
  }

  // Trigger immediately if start date already set
  updatePtoCalc();
  document.getElementById('edit-start-date').addEventListener('change', updatePtoCalc);

  document.getElementById('edit-profile-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  document.getElementById('edit-profile-save').addEventListener('click', async () => {
    const firstName = document.getElementById('edit-first-name').value.trim();
    const lastName = document.getElementById('edit-last-name').value.trim();
    const phone = document.getElementById('edit-phone').value.trim();
    const email = document.getElementById('edit-email').value.trim();
    const role = document.getElementById('edit-role').value;
    const foremanId = document.getElementById('edit-foreman').value || undefined;
    const employmentStartDate = document.getElementById('edit-start-date').value || undefined;
    const errorEl = document.getElementById('edit-profile-error');
    errorEl.innerHTML = '';

    if (!firstName || !lastName) {
      errorEl.innerHTML = errorHtml('First and last name are required.');
      return;
    }
    if (!phone) {
      errorEl.innerHTML = errorHtml('Mobile number is required.');
      return;
    }

    const saveBtn = document.getElementById('edit-profile-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      await api('/employee-management', {
        method: 'PATCH',
        body: JSON.stringify({
          companyId: state.activeCompanyId,
          employeeId: employee.id,
          firstName,
          lastName,
          phone,
          email: email || null,
          role,
          foremanId,
          employmentStartDate,
        }),
      });

      // If a start date is set and the PTO calc section is visible,
      // also save the allotment and used hours to pto_balances so the
      // balance is set correctly right now rather than waiting until
      // the next anniversary run.
      const calcSection = document.getElementById('pto-calc-section');
      if (employmentStartDate && calcSection && calcSection.style.display !== 'none') {
        const allotmentHours = Number(document.getElementById('edit-allotment-hours').value || 0);
        const usedHours = Number(document.getElementById('edit-used-hours').value || 0);
        await api('/pto-balances', {
          method: 'PUT',
          body: JSON.stringify({
            employeeId: employee.id,
            companyId: state.activeCompanyId,
            year: new Date().getFullYear(),
            allotmentHours,
            usedHours,
          }),
        });
      }

      document.body.removeChild(overlay);
      render('team', { employeeId: employee.id });
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save changes';
    }
  });
}
