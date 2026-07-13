// Work Orders - tied to job locations, accessible under the Schedule tab.
// Admin/foreman create and assign; tech marks complete; admin marks billed.

// ---- Employee view: show WOs assigned to me ----
async function renderMyWorkOrders(container) {
  if (!container) return;
  const myRole = currentCompanyRole();

  try {
    const data = await api(withCompany('/work-orders?status=open'));
    const wos = data.workOrders || [];

    if (wos.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <div class="screen-sub" style="font-weight:600; color:var(--ink); margin-bottom:10px;">Your work orders</div>
      ${wos.map(wo => workOrderCardHtml(wo, myRole)).join('')}
    `;

    container.querySelectorAll('[data-wo-view]').forEach(btn => {
      btn.addEventListener('click', () => showWorkOrderDetail(btn.getAttribute('data-wo-view'), wos));
    });

    container.querySelectorAll('[data-wo-complete]').forEach(btn => {
      btn.addEventListener('click', () => completeWorkOrder(btn.getAttribute('data-wo-complete'), container));
    });
  } catch (err) {
    console.error('Could not load work orders:', err);
  }
}

function workOrderCardHtml(wo, myRole) {
  const statusLabel = { open: 'Open', ready_to_bill: 'Ready to bill', billed: 'Billed' }[wo.status] || wo.status;
  const statusColor = { open: 'var(--amber-dark)', ready_to_bill: '#16a34a', billed: 'var(--ink-soft)' }[wo.status];
  const canComplete = wo.status === 'open' && (myRole === 'admin' || myRole === 'foreman' || wo.assignedTo?.id === state.employee.id);

  return `
    <div class="day-stub" style="margin-bottom:10px;">
      <div class="day-stub-perf" style="background:${statusColor};"></div>
      <div class="day-stub-body">
        <div class="day-stub-top">
          <div class="day-stub-date">WO# ${escapeHtml(wo.woNumber)}</div>
          <div style="font-size:12px; color:${statusColor}; font-weight:600;">${statusLabel}</div>
        </div>
        <div class="day-stub-meta">
          ${wo.jobLocation ? `<span>${escapeHtml(wo.jobLocation.name)}</span>` : ''}
          ${wo.scheduledDate ? `<span>Scheduled: ${wo.scheduledDate}</span>` : ''}
          ${wo.assignedTo ? `<span>${escapeHtml(wo.assignedTo.name)}</span>` : ''}
        </div>
        <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
          ${wo.currentPhoto ? `<button class="btn btn-sm btn-ghost" data-wo-view="${wo.id}">View WO</button>` : ''}
          ${canComplete ? `<button class="btn btn-sm btn-primary" data-wo-complete="${wo.id}">Mark complete</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

function showWorkOrderDetail(workOrderId, wos) {
  const wo = wos.find(w => w.id === workOrderId);
  if (!wo || !wo.currentPhoto?.url) return;

  const myRole = currentCompanyRole();
  const canComplete = wo.status === 'open' && (myRole === 'admin' || myRole === 'foreman' || wo.assignedTo?.id === state.employee.id);
  const canReassign = (myRole === 'admin' || myRole === 'foreman') && wo.status === 'open';
  const canUpdatePhoto = myRole === 'admin' || myRole === 'foreman';
  const canBill = myRole === 'admin' && wo.status === 'ready_to_bill';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.95);display:flex;flex-direction:column;z-index:200;';
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--ink);">
      <div style="color:#fff;font-weight:700;">WO# ${escapeHtml(wo.woNumber)}</div>
      <button id="wo-close" style="background:none;border:none;color:#fff;font-size:24px;cursor:pointer;">&times;</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:16px;">
      <img src="${wo.currentPhoto.url}" style="width:100%;border-radius:8px;display:block;margin-bottom:16px;" />
      <div class="summary-card" style="margin-bottom:16px;">
        ${wo.jobLocation ? `<div class="summary-row"><span class="label">Location</span><span class="value">${escapeHtml(wo.jobLocation.name)}</span></div>` : ''}
        <div class="summary-row"><span class="label">Received</span><span class="value">${wo.dateReceived}</span></div>
        ${wo.scheduledDate ? `<div class="summary-row"><span class="label">Scheduled</span><span class="value">${wo.scheduledDate}</span></div>` : ''}
        ${wo.assignedTo ? `<div class="summary-row"><span class="label">Assigned to</span><span class="value">${escapeHtml(wo.assignedTo.name)}</span></div>` : ''}
        ${wo.completedAt ? `<div class="summary-row"><span class="label">Completed</span><span class="value">${wo.completedAt.slice(0,10)}</span></div>` : ''}
      </div>
      <div id="wo-detail-error"></div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${canComplete ? `<button class="btn btn-primary" id="wo-detail-complete">Mark complete &amp; ready to bill</button>` : ''}
        ${canBill ? `<button class="btn btn-primary" id="wo-detail-bill">Mark as billed</button>` : ''}
        ${canUpdatePhoto ? `<button class="btn btn-ghost" id="wo-detail-photo">Update work order photo</button>` : ''}
        ${canReassign ? `<button class="btn btn-ghost" id="wo-detail-reassign">Reassign</button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('wo-close').addEventListener('click', () => document.body.removeChild(overlay));

  if (canComplete) {
    document.getElementById('wo-detail-complete').addEventListener('click', async () => {
      try {
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'complete' }) });
        document.body.removeChild(overlay);
        render('approvals', { subView: 'schedule' });
      } catch (err) {
        document.getElementById('wo-detail-error').innerHTML = errorHtml(err.message);
      }
    });
  }

  if (canBill) {
    document.getElementById('wo-detail-bill').addEventListener('click', async () => {
      if (!confirm('Mark this work order as billed? This cannot be undone.')) return;
      try {
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'bill' }) });
        document.body.removeChild(overlay);
        render('approvals', { subView: 'schedule' });
      } catch (err) {
        document.getElementById('wo-detail-error').innerHTML = errorHtml(err.message);
      }
    });
  }

  if (canUpdatePhoto) {
    document.getElementById('wo-detail-photo').addEventListener('click', () => {
      document.body.removeChild(overlay);
      showUpdateWorkOrderPhotoDialog(wo.id);
    });
  }

  if (canReassign) {
    document.getElementById('wo-detail-reassign').addEventListener('click', () => {
      document.body.removeChild(overlay);
      showReassignDialog(wo.id);
    });
  }
}

async function completeWorkOrder(workOrderId, container) {
  if (!confirm('Mark this work order as complete and ready to bill?')) return;
  try {
    await api('/work-orders', {
      method: 'PATCH',
      body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId, action: 'complete' }),
    });
    // Refresh the work orders section
    await renderMyWorkOrders(container);
    // Update the ready-to-bill badge
    await checkPendingWorkOrders();
  } catch (err) {
    alert(err.message);
  }
}

// ---- Admin/foreman: create a new work order ----
function showCreateWorkOrderDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">New work order</div>

      <div class="field">
        <label>Work order photo</label>
        <input id="wo-photo-input" type="file" accept="image/*" capture="environment" />
      </div>
      <div id="wo-photo-preview" style="display:none;margin-bottom:12px;">
        <img id="wo-photo-img" style="width:100%;border-radius:8px;max-height:200px;object-fit:cover;" />
      </div>
      <div class="field">
        <label for="wo-number">Work order number</label>
        <input id="wo-number" type="text" placeholder="e.g. 8821" />
      </div>
      <div class="field">
        <label for="wo-date-received">Date received</label>
        <input id="wo-date-received" type="date" value="${todayStr()}" />
      </div>
      <div class="field">
        <label for="wo-scheduled-date">Scheduled date (optional)</label>
        <input id="wo-scheduled-date" type="date" />
      </div>
      <div class="field">
        <label for="wo-location">Job location (optional)</label>
        <select id="wo-location">
          <option value="">No location yet</option>
          ${(state.jobLocations || []).map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="wo-assigned">Assign to (optional)</label>
        <select id="wo-assigned">
          <option value="">Unassigned</option>
        </select>
      </div>
      <div id="wo-create-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="wo-create-cancel">Cancel</button>
        <button class="btn btn-primary" id="wo-create-save">Create work order</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Load people for assignment dropdown
  api(withCompany('/dashboard')).then(data => {
    const sel = document.getElementById('wo-assigned');
    if (!sel) return;
    (data.people || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.firstName} ${p.lastName} (${p.role})`;
      sel.appendChild(opt);
    });
  }).catch(() => {});

  // Photo preview
  let imageBase64 = null, imageMimeType = null;
  document.getElementById('wo-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      imageBase64 = dataUrl.split(',')[1];
      imageMimeType = file.type;
      document.getElementById('wo-photo-img').src = dataUrl;
      document.getElementById('wo-photo-preview').style.display = 'block';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('wo-create-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  document.getElementById('wo-create-save').addEventListener('click', async () => {
    const woNumber = document.getElementById('wo-number').value.trim();
    const dateReceived = document.getElementById('wo-date-received').value;
    const scheduledDate = document.getElementById('wo-scheduled-date').value || null;
    const jobLocationId = document.getElementById('wo-location').value || null;
    const assignedToId = document.getElementById('wo-assigned').value || null;
    const errorEl = document.getElementById('wo-create-error');
    errorEl.innerHTML = '';

    if (!woNumber) { errorEl.innerHTML = errorHtml('Work order number is required.'); return; }
    if (!dateReceived) { errorEl.innerHTML = errorHtml('Date received is required.'); return; }

    const btn = document.getElementById('wo-create-save');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      await api('/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          companyId: state.activeCompanyId,
          woNumber, dateReceived, scheduledDate, jobLocationId, assignedToId,
          imageBase64, mimeType: imageMimeType,
        }),
      });
      document.body.removeChild(overlay);
      render('approvals', { subView: 'schedule' });
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Create work order';
    }
  });
}

function showUpdateWorkOrderPhotoDialog(workOrderId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Update work order photo</div>
      <div class="screen-sub" style="margin-bottom:14px;">The previous photo will be kept in history. The new photo becomes the current version.</div>
      <div class="field">
        <label>New photo</label>
        <input id="wo-update-photo-input" type="file" accept="image/*" capture="environment" />
      </div>
      <div id="wo-update-preview" style="display:none;margin-bottom:12px;">
        <img id="wo-update-img" style="width:100%;border-radius:8px;max-height:200px;object-fit:cover;" />
      </div>
      <div id="wo-update-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="wo-update-cancel">Cancel</button>
        <button class="btn btn-primary" id="wo-update-save" disabled>Update photo</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let imageBase64 = null, imageMimeType = null;
  document.getElementById('wo-update-photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      imageBase64 = dataUrl.split(',')[1];
      imageMimeType = file.type;
      document.getElementById('wo-update-img').src = dataUrl;
      document.getElementById('wo-update-preview').style.display = 'block';
      document.getElementById('wo-update-save').disabled = false;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('wo-update-cancel').addEventListener('click', () => document.body.removeChild(overlay));
  document.getElementById('wo-update-save').addEventListener('click', async () => {
    const errorEl = document.getElementById('wo-update-error');
    const btn = document.getElementById('wo-update-save');
    btn.disabled = true;
    btn.textContent = 'Uploading...';
    try {
      await api('/work-orders', {
        method: 'PATCH',
        body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId, action: 'update_photo', imageBase64, mimeType: imageMimeType }),
      });
      document.body.removeChild(overlay);
      render('approvals', { subView: 'schedule' });
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Update photo';
    }
  });
}

function showReassignDialog(workOrderId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:380px;width:100%;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Reassign work order</div>
      <div class="field">
        <label for="reassign-select">Assign to</label>
        <select id="reassign-select"><option value="">Unassigned</option></select>
      </div>
      <div id="reassign-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="reassign-cancel">Cancel</button>
        <button class="btn btn-primary" id="reassign-save">Reassign</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  api(withCompany('/dashboard')).then(data => {
    const sel = document.getElementById('reassign-select');
    if (!sel) return;
    (data.people || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.firstName} ${p.lastName} (${p.role})`;
      sel.appendChild(opt);
    });
  }).catch(() => {});

  document.getElementById('reassign-cancel').addEventListener('click', () => document.body.removeChild(overlay));
  document.getElementById('reassign-save').addEventListener('click', async () => {
    const assignedToId = document.getElementById('reassign-select').value || null;
    try {
      await api('/work-orders', {
        method: 'PATCH',
        body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId, action: 'reassign', assignedToId }),
      });
      document.body.removeChild(overlay);
      render('approvals', { subView: 'schedule' });
    } catch (err) {
      document.getElementById('reassign-error').innerHTML = errorHtml(err.message);
    }
  });
}

// ---- Badge: check for WOs ready to bill (admin/foreman) ----
async function checkPendingWorkOrders() {
  const myRole = currentCompanyRole();
  if (myRole !== 'admin' && myRole !== 'foreman') return;
  try {
    const data = await api(withCompany('/work-orders?status=ready_to_bill'));
    const count = (data.workOrders || []).length;
    state.pendingWorkOrderCount = count;
    // Update badge on Schedule tab if visible
    const schedTab = document.querySelector('[data-tab="approvals"]');
    if (schedTab && count > 0) {
      const existing = schedTab.querySelector('.wo-badge');
      if (!existing) {
        const badge = document.createElement('span');
        badge.className = 'wo-badge';
        badge.style.cssText = 'background:#16a34a;color:#fff;border-radius:10px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:4px;';
        badge.textContent = count;
        schedTab.appendChild(badge);
      } else {
        existing.textContent = count;
      }
    }
  } catch (err) {
    console.error('Could not check work orders:', err);
  }
}
