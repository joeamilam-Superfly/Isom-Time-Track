// Work Orders - tied to job locations, accessible under the Schedule tab.
// Admin/foreman create and assign; tech marks complete; admin marks billed.
// All dialogs use overlay-scoped querySelector to avoid ID conflicts.

// ---- Image compression helper ----
// Resizes large photos before base64 encoding to stay under Netlify's
// 6MB function body limit. iPhone photos can be 8-10MB uncompressed.
// Targets max 1600px on longest side at 82% JPEG quality (~200-400KB).
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1600;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width); width = MAX; }
          else { width = Math.round(width * MAX / height); height = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---- Shared helper: location autocomplete (same pattern as day-edit screen) ----
// Fetches locations fresh, renders a text input with live suggestions,
// calls onSelect(locationId, locationName) when user picks one.
async function setupWoLocationAutocomplete(overlay, inputId, suggestionsId, onSelect, initialName) {
  // Fetch locations fresh so we always have the full list
  let locations = [];
  try {
    const data = await api(withCompany('/job-locations'));
    locations = data.locations || [];
  } catch (err) {
    console.error('Could not load locations:', err);
  }

  const input = overlay.querySelector(`#${inputId}`);
  const suggestionsEl = overlay.querySelector(`#${suggestionsId}`);
  if (!input || !suggestionsEl) return;

  if (initialName) input.value = initialName;

  input.addEventListener('input', () => {
    onSelect(null, null); // clear selection when user types
    const query = input.value.trim().toLowerCase();
    suggestionsEl.innerHTML = '';
    if (!query) return;

    const matches = locations
      .filter(l => l.name.toLowerCase().includes(query))
      .slice(0, 6);

    if (matches.length === 0) return;

    suggestionsEl.innerHTML = `
      <div style="border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-top:4px;background:#fff;">
        ${matches.map(m => `
          <div style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--line);font-size:13px;" data-loc-id="${m.id}" data-loc-name="${escapeHtml(m.name)}">
            ${escapeHtml(m.name)}
          </div>`).join('')}
        <div style="padding:10px 12px;cursor:pointer;font-size:13px;color:var(--amber-dark);font-weight:600;" data-loc-id="__new__" data-loc-name="${escapeHtml(input.value.trim())}">
          + Add "${escapeHtml(input.value.trim())}" as new location
        </div>
      </div>`;

    suggestionsEl.querySelectorAll('[data-loc-id]').forEach(el => {
      el.addEventListener('click', () => {
        const locId = el.getAttribute('data-loc-id');
        const locName = el.getAttribute('data-loc-name');
        input.value = locName;
        suggestionsEl.innerHTML = '';
        onSelect(locId === '__new__' ? null : locId, locName);
      });
    });
  });
}
async function populatePeopleSelect(selectEl, selectedId) {
  if (!selectEl) return;
  try {
    const data = await api(withCompany('/dashboard'));
    (data.people || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.firstName} ${p.lastName} (${p.role})`;
      if (selectedId && p.id === selectedId) opt.selected = true;
      selectEl.appendChild(opt);
    });
  } catch (err) {
    console.error('Could not load people for dropdown:', err);
  }
}

// ---- Employee view: show WOs assigned to me ----
async function renderMyWorkOrders(container) {
  if (!container) return;
  const myRole = currentCompanyRole();
  try {
    const data = await api(withCompany('/work-orders?status=open'));
    const wos = data.workOrders || [];
    if (wos.length === 0) { container.innerHTML = ''; return; }

    container.innerHTML = `
      <div class="screen-sub" style="font-weight:600; color:var(--ink); margin-bottom:10px;">Your work orders</div>
      ${wos.map(wo => workOrderCardHtml(wo, myRole)).join('')}
    `;

    container.querySelectorAll('[data-wo-view]').forEach(btn => {
      btn.addEventListener('click', () => showWorkOrderDetail(btn.getAttribute('data-wo-view'), wos));
    });
    container.querySelectorAll('[data-wo-submit]').forEach(btn => {
      btn.addEventListener('click', () => submitWorkOrder(btn.getAttribute('data-wo-submit'), container, wos));
    });
    container.querySelectorAll('[data-wo-complete]').forEach(btn => {
      btn.addEventListener('click', () => completeWorkOrder(btn.getAttribute('data-wo-complete'), container));
    });
    container.querySelectorAll('[data-wo-bill]').forEach(btn => {
      const wo = wos.find(w => w.id === btn.getAttribute('data-wo-bill'));
      if (wo) btn.addEventListener('click', () => showBillWorkOrderDialog(wo));
    });
    container.querySelectorAll('[data-wo-edit]').forEach(btn => {
      const wo = wos.find(w => w.id === btn.getAttribute('data-wo-edit'));
      if (wo) btn.addEventListener('click', () => showEditWorkOrderDialog(wo));
    });
    container.querySelectorAll('[data-wo-queue-toggle]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const wo = wos.find(w => w.id === btn.getAttribute('data-wo-queue-toggle'));
        if (!wo) return;
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'toggle_queue_visible' }) });
        await renderMyWorkOrders(container);
      });
    });
    container.querySelectorAll('[data-wo-return-queue]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Return this work order to the unassigned queue?')) return;
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: btn.getAttribute('data-wo-return-queue'), action: 'return_to_queue' }) });
        await renderMyWorkOrders(container);
      });
    });
  } catch (err) {
    console.error('Could not load work orders:', err);
  }
}

function workOrderCardHtml(wo, myRole) {
  const isUnassigned = !wo.assignedTo;
  const isQueued = wo.queueVisible && isUnassigned;
  const statusLabel = { open: 'Open', submitted: 'Pending review', ready_to_bill: 'Ready to bill', billed: 'Billed' }[wo.status] || wo.status;
  const statusColor = { open: 'var(--amber-dark)', submitted: '#7c3aed', ready_to_bill: '#16a34a', billed: 'var(--ink-soft)' }[wo.status];
  const canComplete = (wo.status === 'open' || wo.status === 'submitted') && (myRole === 'admin' || myRole === 'foreman');
  const canSubmit = wo.status === 'open' && myRole === 'employee' && wo.assignedTo?.id === state.employee.id;
  const canBillCard = myRole === 'admin' && wo.status === 'ready_to_bill';
  const canManage = myRole === 'admin' || myRole === 'foreman';
  const pendingReview = wo.status === 'submitted' && (myRole === 'admin' || myRole === 'foreman');

  // Color: unassigned queue = amber tint, assigned = employee color, otherwise default
  const cardBg = isQueued
    ? '#fef3c7'
    : (wo.assignedTo?.displayColor || 'var(--paper)');

  const queueBadge = isQueued
    ? `<div style="background:#d97706;color:#fff;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;margin-bottom:6px;display:inline-block;">📋 In queue — available to grab</div>`
    : (isUnassigned && canManage ? `<div style="font-size:11px;color:var(--ink-soft);margin-bottom:4px;">Unassigned</div>` : '');

  return `
    <div class="day-stub" style="margin-bottom:10px; background:${cardBg}; border-radius:8px; overflow:hidden;">
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
          ${wo.crew && wo.crew.length > 0 ? `<span>+${wo.crew.length} crew: ${wo.crew.map(c => escapeHtml(c.name.split(' ')[0])).join(', ')}</span>` : ''}
        </div>
        ${wo.details ? `<div style="margin-top:6px; font-size:12px; color:var(--ink); white-space:pre-line; background:var(--paper-dim); border-radius:6px; padding:8px 10px;">${escapeHtml(wo.details)}</div>` : ''}
        ${pendingReview ? `<div style="background:#7c3aed;color:#fff;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;margin-bottom:6px;">⏳ Submitted by tech — awaiting your approval</div>` : ''}
        ${canBillCard ? `<div style="background:#16a34a;color:#fff;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;margin-bottom:6px;">💰 Ready to bill — enter invoice number to archive</div>` : ''}
        ${queueBadge}
        <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
          <button class="btn btn-sm btn-ghost" data-wo-view="${wo.id}">View WO</button>
          ${canSubmit ? `<button class="btn btn-sm btn-primary" data-wo-submit="${wo.id}">Submit for approval</button>` : ''}
          ${canComplete ? `<button class="btn btn-sm btn-primary" data-wo-complete="${wo.id}">${wo.status === 'submitted' ? 'Approve &amp; complete' : 'Mark complete'}</button>` : ''}
          ${canBillCard ? `<button class="btn btn-sm btn-primary" data-wo-bill="${wo.id}" style="background:#16a34a;">Mark as billed</button>` : ''}
          ${canManage && wo.status === 'open' && isUnassigned ? `<button class="btn btn-sm ${isQueued ? 'btn-ghost' : 'btn-primary'}" data-wo-queue-toggle="${wo.id}">${isQueued ? 'Remove from queue' : 'Add to queue'}</button>` : ''}
          ${canManage && !isUnassigned ? `<button class="btn btn-sm btn-ghost" data-wo-return-queue="${wo.id}">Return to queue</button>` : ''}
          ${canManage ? `<button class="btn btn-sm btn-ghost" data-wo-edit="${wo.id}">Edit</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

// ---- WO Detail full-screen overlay ----
function showWorkOrderDetail(workOrderId, wos) {
  const wo = wos.find(w => w.id === workOrderId);
  if (!wo) return;

  const myRole = currentCompanyRole();
  const canComplete = (wo.status === 'open' || wo.status === 'submitted') && (myRole === 'admin' || myRole === 'foreman');
  const canSubmit = wo.status === 'open' && myRole === 'employee' && wo.assignedTo?.id === state.employee.id;
  const canManage = myRole === 'admin' || myRole === 'foreman';
  const canBill = myRole === 'admin' && wo.status === 'ready_to_bill';
  const canReopen = (wo.status === 'ready_to_bill' || wo.status === 'submitted') && (myRole === 'admin' || myRole === 'foreman');
  const pendingReview = wo.status === 'submitted' && (myRole === 'admin' || myRole === 'foreman');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#1a1a1a;display:flex;flex-direction:column;z-index:200;';
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#111;flex-shrink:0;">
      <div style="color:#fff;font-weight:700;font-size:16px;">WO# ${escapeHtml(wo.woNumber)}</div>
      <button id="wo-close" style="background:rgba(255,255,255,0.15);border:none;color:#fff;font-size:24px;cursor:pointer;width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;line-height:1;">&times;</button>
    </div>
    <div style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px;color:#fff;">
      ${wo.currentPhoto?.url
        ? `<img src="${wo.currentPhoto.url}" style="width:100%;border-radius:8px;display:block;margin-bottom:16px;" />`
        : `<div style="background:rgba(255,255,255,0.08);border-radius:8px;padding:20px;text-align:center;color:rgba(255,255,255,0.4);margin-bottom:16px;font-size:13px;">No photo attached yet</div>`}

      ${wo.allPhotos && wo.allPhotos.filter(p => !p.isCurrent).length > 0 ? `
        <div style="margin-bottom:16px;">
          <button id="wo-history-toggle" style="background:rgba(255,255,255,0.1);border:none;color:rgba(255,255,255,0.7);font-size:12px;padding:8px 12px;border-radius:6px;cursor:pointer;width:100%;text-align:left;">
            &#9654; Previous versions (${wo.allPhotos.filter(p => !p.isCurrent).length}) — tap to view
          </button>
          <div id="wo-history-photos" style="display:none;margin-top:8px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              ${wo.allPhotos.filter(p => !p.isCurrent).map((p, i) => `
                <div>
                  <img src="${p.url}" data-history-img="${i}" style="width:100%;border-radius:6px;display:block;cursor:pointer;" />
                  <div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:3px;text-align:center;">${p.uploadedAt ? p.uploadedAt.slice(0,10) : ''}</div>
                </div>`).join('')}
            </div>
          </div>
        </div>` : ''}

      <div style="background:rgba(255,255,255,0.08);border-radius:10px;padding:12px;margin-bottom:16px;">
        ${wo.jobLocation ? `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);"><span style="color:rgba(255,255,255,0.5);">Location</span><span style="font-weight:700;">${escapeHtml(wo.jobLocation.name)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);"><span style="color:rgba(255,255,255,0.5);">Received</span><span style="font-weight:700;">${wo.dateReceived}</span></div>
        ${wo.scheduledDate ? `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);"><span style="color:rgba(255,255,255,0.5);">Scheduled</span><span style="font-weight:700;">${wo.scheduledDate}</span></div>` : ''}
        ${wo.assignedTo ? `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);"><span style="color:rgba(255,255,255,0.5);">Assigned to</span><span style="font-weight:700;">${escapeHtml(wo.assignedTo.name)}</span></div>` : ''}
        ${wo.crew && wo.crew.length > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);"><span style="color:rgba(255,255,255,0.5);">Crew</span><span style="font-weight:700;text-align:right;">${wo.crew.map(c => escapeHtml(c.name)).join('<br>')}</span></div>` : ''}
        ${wo.completedAt ? `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);"><span style="color:rgba(255,255,255,0.5);">Completed</span><span style="font-weight:700;">${wo.completedAt.slice(0,10)}</span></div>` : ''}
        ${wo.invoiceNumber ? `<div style="display:flex;justify-content:space-between;padding:6px 0;"><span style="color:rgba(255,255,255,0.5);">Invoice #</span><span style="font-weight:700;color:#16a34a;">${escapeHtml(wo.invoiceNumber)}</span></div>` : ''}
      </div>

      ${wo.details ? `
        <div style="font-weight:600;font-size:13px;margin-bottom:6px;">Work order details</div>
        <div style="background:rgba(255,255,255,0.08);border-radius:8px;padding:12px;font-size:13px;white-space:pre-line;margin-bottom:16px;">${escapeHtml(wo.details)}</div>` : ''}

      <div style="font-weight:600;font-size:13px;margin-bottom:8px;">Time logged${wo.totalHours ? ` — ${Number(wo.totalHours).toFixed(2)}h total` : ''}</div>
      ${wo.timeEntries && wo.timeEntries.length > 0 ? `
        <div style="background:rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;margin-bottom:16px;">
          ${wo.timeEntries.map(e => `
            <div style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);font-size:12px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span style="font-weight:600;">${escapeHtml(e.employeeName)}</span>
                <span style="color:rgba(255,255,255,0.6);">${e.hoursWorked.toFixed(2)}h</span>
              </div>
              <div style="color:rgba(255,255,255,0.5);">${e.date} &middot; ${e.timeIn ? e.timeIn.slice(0,5) : ''} – ${e.timeOut ? e.timeOut.slice(0,5) : ''}</div>
              ${e.activityDescription ? `<div style="color:rgba(255,255,255,0.7);margin-top:3px;font-style:italic;">${escapeHtml(e.activityDescription)}</div>` : ''}
            </div>`).join('')}
        </div>` : `<div style="color:rgba(255,255,255,0.4);font-size:13px;margin-bottom:16px;">No time logged yet.</div>`}

      <div id="wo-detail-error"></div>
      <div style="display:flex;flex-direction:column;gap:10px;padding-bottom:20px;">
        ${pendingReview ? `<div style="background:#7c3aed;border-radius:8px;padding:12px;font-size:13px;font-weight:600;text-align:center;">⏳ Tech has submitted — awaiting your approval</div>` : ''}
        ${canComplete ? `<button id="wo-detail-complete" style="background:#16a34a;color:#fff;border:none;padding:14px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">${wo.status === 'submitted' ? 'Approve &amp; mark complete' : 'Mark complete &amp; ready to bill'}</button>` : ''}
        ${canSubmit ? `<button id="wo-detail-submit" style="background:#7c3aed;color:#fff;border:none;padding:14px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">Submit for foreman approval</button>` : ''}
        ${canBill ? `<button id="wo-detail-bill" style="background:#16a34a;color:#fff;border:none;padding:14px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">Mark as billed</button>` : ''}
        <button id="wo-add-time-btn" style="background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.3);padding:14px;border-radius:8px;font-size:14px;cursor:pointer;">+ Log time toward this WO</button>
        <button id="wo-add-site-photos-btn" style="background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.3);padding:14px;border-radius:8px;font-size:14px;cursor:pointer;">📷 Add job site photos</button>
        ${canManage ? `<button id="wo-detail-edit" style="background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.3);padding:14px;border-radius:8px;font-size:14px;cursor:pointer;">Edit work order</button>` : ''}
        ${canManage ? `<button id="wo-detail-photo" style="background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.3);padding:14px;border-radius:8px;font-size:14px;cursor:pointer;">Update photo</button>` : ''}
        ${canReopen ? `<button id="wo-detail-reopen" style="background:rgba(255,165,0,0.2);color:#f59e0b;border:1px solid #f59e0b;padding:14px;border-radius:8px;font-size:14px;cursor:pointer;">↩ Reopen work order</button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Wire history photo toggle
  const historyToggle = overlay.querySelector('#wo-history-toggle');
  if (historyToggle) {
    const historyPhotos = overlay.querySelector('#wo-history-photos');
    const histCount = (wo.allPhotos || []).filter(p => !p.isCurrent).length;
    historyToggle.addEventListener('click', () => {
      const showing = historyPhotos.style.display === 'block';
      historyPhotos.style.display = showing ? 'none' : 'block';
      historyToggle.innerHTML = showing
        ? `&#9654; Previous versions (${histCount}) — tap to view`
        : `&#9660; Previous versions (${histCount}) — tap to hide`;
    });

    // Tap any thumbnail to view fullscreen
    overlay.querySelectorAll('[data-history-img]').forEach(img => {
      img.addEventListener('click', () => {
        const lightbox = document.createElement('div');
        lightbox.style.cssText = 'position:fixed;inset:0;background:#000;z-index:300;display:flex;align-items:center;justify-content:center;cursor:pointer;';
        lightbox.innerHTML = `<img src="${img.src}" style="max-width:100%;max-height:100%;object-fit:contain;" />`;
        lightbox.addEventListener('click', () => document.body.removeChild(lightbox));
        document.body.appendChild(lightbox);
      });
    });
  }

  // All handlers scoped to overlay — safe on mobile with multiple overlays
  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };

  overlay.querySelector('#wo-close').addEventListener('click', close);

  if (canComplete) {
    overlay.querySelector('#wo-detail-complete').addEventListener('click', async () => {
      try {
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'complete' }) });
        close();
        refreshAndReopenWo(wo.id);
      } catch (err) {
        overlay.querySelector('#wo-detail-error').innerHTML = errorHtml(err.message);
      }
    });
  }

  if (canBill) {
    overlay.querySelector('#wo-detail-bill').addEventListener('click', () => {
      close();
      showBillWorkOrderDialog(wo);
    });
  }

  overlay.querySelector('#wo-add-time-btn').addEventListener('click', () => { close(); showLogWoTimeDialog(wo); });
  overlay.querySelector('#wo-add-site-photos-btn').addEventListener('click', () => { close(); showWoSitePhotosDialog(wo); });

  if (canSubmit) {
    overlay.querySelector('#wo-detail-submit').addEventListener('click', async () => {
      if (!confirm('Submit this work order to your foreman for approval?')) return;
      try {
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'submit' }) });
        close();
        refreshAndReopenWo(wo.id);
      } catch (err) {
        overlay.querySelector('#wo-detail-error').innerHTML = errorHtml(err.message);
      }
    });
  }

  if (canReopen) {
    overlay.querySelector('#wo-detail-reopen').addEventListener('click', async () => {
      if (!confirm('Reopen this work order? Status will return to Open so changes can be made.')) return;
      try {
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'reopen' }) });
        close();
        refreshAndReopenWo(wo.id);
      } catch (err) {
        overlay.querySelector('#wo-detail-error').innerHTML = errorHtml(err.message);
      }
    });
  }

  if (canManage) {
    overlay.querySelector('#wo-detail-edit').addEventListener('click', () => { close(); showEditWorkOrderDialog(wo); });
    overlay.querySelector('#wo-detail-photo').addEventListener('click', () => { close(); showUpdateWorkOrderPhotoDialog(wo.id); });
    overlay.querySelector('#wo-detail-reassign').addEventListener('click', () => { close(); showReassignDialog(wo.id); });
  }
}

async function submitWorkOrder(workOrderId, container, wos) {
  if (!confirm('Submit this work order to your foreman for approval?')) return;
  try {
    await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId, action: 'submit' }) });
    await renderMyWorkOrders(container);
  } catch (err) {
    alert(err.message);
  }
}

async function completeWorkOrder(workOrderId, container) {
  if (!confirm('Mark this work order as complete and ready to bill?')) return;
  try {
    await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId, action: 'complete' }) });
    await renderMyWorkOrders(container);
    await checkPendingWorkOrders();
  } catch (err) {
    alert(err.message);
  }
}

// ---- Create work order ----
function showCreateWorkOrderDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;-webkit-overflow-scrolling:touch;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="font-weight:700;font-size:17px;">New work order</div>
        <button id="wo-create-close" style="background:none;border:none;font-size:24px;cursor:pointer;color:var(--ink);">&times;</button>
      </div>
      <div class="field">
        <label>Work order photo (optional)</label>
        <input id="wo-photo-input" type="file" accept="image/*" />
      </div>
      <div id="wo-photo-preview" style="display:none;margin-bottom:12px;">
        <img id="wo-photo-img" style="width:100%;border-radius:8px;max-height:200px;object-fit:cover;" />
      </div>
      <div class="field">
        <label for="wo-number">Work order number *</label>
        <input id="wo-number" type="text" placeholder="e.g. 8821" />
      </div>
      <div class="field">
        <label for="wo-date-received">Date received *</label>
        <input id="wo-date-received" type="date" value="${todayStr()}" />
      </div>
      <div class="field">
        <label for="wo-scheduled-date">Scheduled date (optional)</label>
        <input id="wo-scheduled-date" type="date" />
      </div>
      <div class="field">
        <label for="wo-location-input">Job location (optional)</label>
        <input id="wo-location-input" type="text" placeholder="Start typing a job site..." autocomplete="off" />
        <div id="wo-location-suggestions"></div>
      </div>
      <div class="field">
        <label for="wo-assigned">Primary assignee (optional)</label>
        <select id="wo-assigned"><option value="">Unassigned</option></select>
      </div>
      <div class="field">
        <label>Crew members (optional)</label>
        <div class="screen-sub" style="margin-bottom:8px;">Tap to select everyone working this job.</div>
        <div id="wo-crew-checklist" style="border:1px solid var(--line);border-radius:8px;overflow:hidden;max-height:220px;overflow-y:auto;">
          <div style="padding:12px;color:var(--ink-soft);font-size:12px;">Loading employees...</div>
        </div>
      </div>
      <div class="field">
        <label for="wo-details">Work order details (optional)</label>
        <textarea id="wo-details" rows="5" placeholder="Address, phone number, job description, special instructions..."></textarea>
        <div class="screen-sub">Visible to the tech on their schedule without tapping.</div>
      </div>
      <div id="wo-conflict-warning" style="display:none;background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:#92400e;"></div>
      <div id="wo-create-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="wo-create-cancel">Cancel</button>
        <button class="btn btn-primary" id="wo-create-save">Create work order</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#wo-create-close').addEventListener('click', close);
  overlay.querySelector('#wo-create-cancel').addEventListener('click', close);

  // Populate primary assignee dropdown and crew checklist together
  let allPeople = [];
  let createCrewIds = new Set();

  function renderCreateCrewChecklist() {
    const checklistEl = overlay.querySelector('#wo-crew-checklist');
    if (!checklistEl) return;
    const primaryId = overlay.querySelector('#wo-assigned')?.value;
    const people = allPeople.filter(p => p.id !== primaryId);
    if (people.length === 0) {
      checklistEl.innerHTML = `<div style="padding:12px;color:var(--ink-soft);font-size:12px;">No other employees to assign.</div>`;
      return;
    }
    checklistEl.innerHTML = people.map(p => {
      const checked = createCrewIds.has(p.id);
      return `
        <div data-crew-toggle="${p.id}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;background:${checked ? 'var(--paper-dim)' : 'transparent'};">
          <div style="width:20px;height:20px;border-radius:4px;border:2px solid ${checked ? 'var(--amber)' : 'var(--line)'};background:${checked ? 'var(--amber)' : 'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            ${checked ? '<svg width="12" height="12" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" fill="none" stroke="#1A1208" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
          </div>
          <div>
            <div style="font-size:13px;font-weight:${checked ? '600' : '400'};">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</div>
            <div style="font-size:11px;color:var(--ink-soft);">${p.role}</div>
          </div>
        </div>`;
    }).join('');
    checklistEl.querySelectorAll('[data-crew-toggle]').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-crew-toggle');
        if (createCrewIds.has(id)) createCrewIds.delete(id);
        else createCrewIds.add(id);
        renderCreateCrewChecklist();
      });
    });
  }

  overlay.querySelector('#wo-scheduled-date').addEventListener('change', () => checkWoConflicts(overlay));

  api(withCompany('/dashboard')).then(data => {
    allPeople = data.people || [];
    const sel = overlay.querySelector('#wo-assigned');
    allPeople.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.firstName} ${p.lastName} (${p.role})`;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      const primaryId = sel.value;
      if (primaryId) createCrewIds.delete(primaryId);
      renderCreateCrewChecklist();
      checkWoConflicts(overlay);
    });
    renderCreateCrewChecklist();
  }).catch(() => {});

  // Location autocomplete
  let selectedLocationId = null, selectedLocationName = null;
  setupWoLocationAutocomplete(overlay, 'wo-location-input', 'wo-location-suggestions', (id, name) => {
    selectedLocationId = id;
    selectedLocationName = name;
  });

  let imageBase64 = null, imageMimeType = null;
  overlay.querySelector('#wo-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file);
      imageBase64 = compressed.base64;
      imageMimeType = compressed.mimeType;
      overlay.querySelector('#wo-photo-img').src = `data:${imageMimeType};base64,${imageBase64}`;
      overlay.querySelector('#wo-photo-preview').style.display = 'block';
    } catch (err) { console.error('Photo compression failed:', err); }
  });

  overlay.querySelector('#wo-create-save').addEventListener('click', async () => {
    const woNumber = overlay.querySelector('#wo-number').value.trim();
    const dateReceived = overlay.querySelector('#wo-date-received').value;
    const scheduledDate = overlay.querySelector('#wo-scheduled-date').value || null;
    const assignedToId = overlay.querySelector('#wo-assigned').value || null;
    const details = overlay.querySelector('#wo-details').value.trim() || null;
    const errorEl = overlay.querySelector('#wo-create-error');
    const btn = overlay.querySelector('#wo-create-save');
    errorEl.innerHTML = '';

    // Resolve job location — create new if typed but not selected from list
    let jobLocationId = selectedLocationId;
    const typedLocationName = overlay.querySelector('#wo-location-input').value.trim();
    if (typedLocationName && !jobLocationId) {
      // Create the new location on the fly
      try {
        const locResult = await api('/job-locations', { method: 'POST', body: JSON.stringify({ companyId: state.activeCompanyId, name: typedLocationName, confirmNew: true }) });
        jobLocationId = locResult.location?.id || null;
      } catch (err) {
        errorEl.innerHTML = errorHtml('Could not create job location: ' + err.message);
        return;
      }
    }

    if (!woNumber) { errorEl.innerHTML = errorHtml('Work order number is required.'); return; }
    if (!dateReceived) { errorEl.innerHTML = errorHtml('Date received is required.'); return; }

    btn.disabled = true;
    btn.textContent = 'Checking...';

    try {
      const existing = await api(withCompany(`/work-orders?woNumber=${encodeURIComponent(woNumber)}`));
      const existingWo = (existing.workOrders || [])[0];

      if (existingWo) {
        btn.disabled = false;
        btn.textContent = 'Create work order';
        const update = confirm(`Work order #${woNumber} already exists (assigned to ${existingWo.assignedTo?.name || 'unassigned'}, scheduled ${existingWo.scheduledDate || 'no date'}).\n\nUpdate the existing work order instead of creating a duplicate?`);
        if (!update) return;
        btn.disabled = true;
        btn.textContent = 'Updating...';
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: existingWo.id, action: 'update_details', scheduledDate, jobLocationId, assignedToId, details }) });
        if (imageBase64) {
          await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: existingWo.id, action: 'update_photo', imageBase64, mimeType: imageMimeType }) });
        }
        close();
        render('approvals', { subView: 'schedule' });
        return;
      }

      btn.textContent = 'Creating...';
      const created = await api('/work-orders', { method: 'POST', body: JSON.stringify({ companyId: state.activeCompanyId, woNumber, dateReceived, scheduledDate, jobLocationId, assignedToId, details, imageBase64, mimeType: imageMimeType }) });
      // Save crew assignments if any were selected
      if (createCrewIds.size > 0 && created.workOrder?.id) {
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: created.workOrder.id, action: 'update_crew', employeeIds: [...createCrewIds] }) }).catch(() => {});
      }
      close();
      render('approvals', { subView: 'schedule' });
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Create work order';
    }
  });
}

// ---- Update photo ----
function showUpdateWorkOrderPhotoDialog(workOrderId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="font-weight:700;font-size:17px;">Update work order photo</div>
        <button id="wo-update-close" style="background:none;border:none;font-size:24px;cursor:pointer;">&times;</button>
      </div>
      <div class="screen-sub" style="margin-bottom:14px;">Previous photo is kept in history. New photo becomes the current version.</div>
      <div class="field">
        <label>New photo</label>
        <input id="wo-update-photo-input" type="file" accept="image/*" />
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

  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#wo-update-close').addEventListener('click', close);
  overlay.querySelector('#wo-update-cancel').addEventListener('click', close);

  let imageBase64 = null, imageMimeType = null;
  overlay.querySelector('#wo-update-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file);
      imageBase64 = compressed.base64;
      imageMimeType = compressed.mimeType;
      overlay.querySelector('#wo-update-img').src = `data:${imageMimeType};base64,${imageBase64}`;
      overlay.querySelector('#wo-update-preview').style.display = 'block';
      overlay.querySelector('#wo-update-save').disabled = false;
    } catch (err) { console.error('Photo compression failed:', err); }
  });

  overlay.querySelector('#wo-update-save').addEventListener('click', async () => {
    const errorEl = overlay.querySelector('#wo-update-error');
    const btn = overlay.querySelector('#wo-update-save');
    btn.disabled = true;
    btn.textContent = 'Uploading...';
    try {
      await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId, action: 'update_photo', imageBase64, mimeType: imageMimeType }) });
      close();
      refreshAndReopenWo(workOrderId);
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Update photo';
    }
  });
}

// ---- Reassign ----
function showReassignDialog(workOrderId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:380px;width:100%;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="font-weight:700;font-size:17px;">Reassign work order</div>
        <button id="reassign-close" style="background:none;border:none;font-size:24px;cursor:pointer;">&times;</button>
      </div>
      <div class="field">
        <label for="reassign-select">Assign to</label>
        <select id="reassign-select"><option value="">Unassigned</option></select>
      </div>
      <div id="reassign-loading" style="font-size:12px;color:var(--ink-soft);padding:4px 0;">Loading employees...</div>
      <div id="reassign-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="reassign-cancel">Cancel</button>
        <button class="btn btn-primary" id="reassign-save">Reassign</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#reassign-close').addEventListener('click', close);
  overlay.querySelector('#reassign-cancel').addEventListener('click', close);

  // Load people using overlay-scoped select
  const sel = overlay.querySelector('#reassign-select');
  populatePeopleSelect(sel).then(() => {
    const loadingEl = overlay.querySelector('#reassign-loading');
    if (loadingEl) loadingEl.style.display = 'none';
  });

  overlay.querySelector('#reassign-save').addEventListener('click', async () => {
    const assignedToId = overlay.querySelector('#reassign-select').value || null;
    const errorEl = overlay.querySelector('#reassign-error');
    const btn = overlay.querySelector('#reassign-save');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId, action: 'reassign', assignedToId }) });
      close();
      render('approvals', { subView: 'schedule' });
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Reassign';
    }
  });
}

// ---- Edit work order ----
function showEditWorkOrderDialog(wo) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;-webkit-overflow-scrolling:touch;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div style="font-weight:700;font-size:17px;">Edit work order</div>
        <button id="edit-wo-close" style="background:none;border:none;font-size:24px;cursor:pointer;">&times;</button>
      </div>
      <div class="screen-sub" style="margin-bottom:14px;">WO# ${escapeHtml(wo.woNumber)}</div>
      <div class="field">
        <label for="edit-wo-number">Work order number</label>
        <input id="edit-wo-number" type="text" value="${escapeHtml(wo.woNumber)}" />
      </div>
      <div class="field">
        <label for="edit-wo-scheduled">Scheduled date</label>
        <input id="edit-wo-scheduled" type="date" value="${wo.scheduledDate || ''}" />
      </div>
      <div class="field">
        <label for="edit-wo-location-input">Job location</label>
        <input id="edit-wo-location-input" type="text" placeholder="Start typing a job site..." autocomplete="off" />
        <div id="edit-wo-location-suggestions"></div>
      </div>
      <div class="field">
        <label for="edit-wo-assigned">Assigned to</label>
        <select id="edit-wo-assigned"><option value="">Unassigned</option></select>
      </div>
      <div class="field">
        <label for="edit-wo-details">Work order details</label>
        <textarea id="edit-wo-details" rows="5" placeholder="Address, phone number, job description...">${wo.details ? escapeHtml(wo.details) : ''}</textarea>
      </div>
      <div class="field">
        <label>Crew members (optional)</label>
        <div class="screen-sub" style="margin-bottom:8px;">Tap to select everyone working this job. Checkmark = assigned.</div>
        <div id="edit-wo-crew-checklist" style="border:1px solid var(--line);border-radius:8px;overflow:hidden;max-height:220px;overflow-y:auto;">
          <div style="padding:12px;color:var(--ink-soft);font-size:12px;">Loading employees...</div>
        </div>
      </div>
      <div class="field">
        <label>Update photo (optional)</label>
        <input id="edit-wo-photo" type="file" accept="image/*" />
        <div class="screen-sub">Previous photo kept in history.</div>
      </div>
      <div id="wo-conflict-warning" style="display:none;background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:#92400e;"></div>
      <div id="edit-wo-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="edit-wo-cancel">Cancel</button>
        <button class="btn btn-primary" id="edit-wo-save">Save changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#edit-wo-close').addEventListener('click', close);
  overlay.querySelector('#edit-wo-cancel').addEventListener('click', close);

  // Location autocomplete pre-filled with current location
  let editLocationId = wo.jobLocation?.id || null;
  setupWoLocationAutocomplete(overlay, 'edit-wo-location-input', 'edit-wo-location-suggestions', (id, name) => {
    editLocationId = id;
  }, wo.jobLocation?.name || '');

  populatePeopleSelect(overlay.querySelector('#edit-wo-assigned'), wo.assignedTo?.id).then ? null : null;
  api(withCompany('/dashboard')).then(data => {
    const sel = overlay.querySelector('#edit-wo-assigned');
    if (!sel) return;
    data.people.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.firstName} ${p.lastName} (${p.role})`;
      if (p.id === wo.assignedTo?.id) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => checkWoConflicts(overlay));
  }).catch(() => {});

  overlay.querySelector('#edit-wo-scheduled').addEventListener('change', () => checkWoConflicts(overlay));

  // Crew checklist — all employees shown, tap to toggle
  let crewIds = new Set((wo.crew || []).map(c => c.id));
  const checklistEl = overlay.querySelector('#edit-wo-crew-checklist');

  api(withCompany('/dashboard')).then(data => {
    const people = (data.people || []).filter(p => p.id !== wo.assignedTo?.id);
    if (people.length === 0) {
      checklistEl.innerHTML = `<div style="padding:12px;color:var(--ink-soft);font-size:12px;">No other employees found.</div>`;
      return;
    }

    function renderChecklist() {
      checklistEl.innerHTML = people.map(p => {
        const checked = crewIds.has(p.id);
        return `
          <div data-crew-toggle="${p.id}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;background:${checked ? 'var(--paper-dim)' : 'transparent'};">
            <div style="width:20px;height:20px;border-radius:4px;border:2px solid ${checked ? 'var(--amber)' : 'var(--line)'};background:${checked ? 'var(--amber)' : 'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              ${checked ? '<svg width="12" height="12" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" fill="none" stroke="#1A1208" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
            </div>
            <div>
              <div style="font-size:13px;font-weight:${checked ? '600' : '400'};">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</div>
              <div style="font-size:11px;color:var(--ink-soft);">${p.role}</div>
            </div>
          </div>`;
      }).join('');

      checklistEl.querySelectorAll('[data-crew-toggle]').forEach(row => {
        row.addEventListener('click', () => {
          const id = row.getAttribute('data-crew-toggle');
          if (crewIds.has(id)) crewIds.delete(id);
          else crewIds.add(id);
          renderChecklist();
        });
      });
    }
    renderChecklist();
  }).catch(() => {
    checklistEl.innerHTML = `<div style="padding:12px;color:var(--ink-soft);font-size:12px;">Could not load employees.</div>`;
  });

  let newImageBase64 = null, newMimeType = null;
  overlay.querySelector('#edit-wo-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file);
      newImageBase64 = compressed.base64;
      newMimeType = compressed.mimeType;
    } catch (err) { console.error('Photo compression failed:', err); }
  });

  overlay.querySelector('#edit-wo-save').addEventListener('click', async () => {
    const woNumber = overlay.querySelector('#edit-wo-number').value.trim();
    const scheduledDate = overlay.querySelector('#edit-wo-scheduled').value || null;
    const assignedToId = overlay.querySelector('#edit-wo-assigned').value || null;
    const details = overlay.querySelector('#edit-wo-details').value.trim() || null;
    const errorEl = overlay.querySelector('#edit-wo-error');
    const btn = overlay.querySelector('#edit-wo-save');

    // Resolve job location — create new if typed but not selected from list
    let jobLocationId = editLocationId;
    const typedLocationName = overlay.querySelector('#edit-wo-location-input').value.trim();
    if (typedLocationName && !jobLocationId) {
      try {
        const locResult = await api('/job-locations', { method: 'POST', body: JSON.stringify({ companyId: state.activeCompanyId, name: typedLocationName, confirmNew: true }) });
        jobLocationId = locResult.location?.id || null;
      } catch (err) {
        errorEl.innerHTML = errorHtml('Could not create job location: ' + err.message);
        return;
      }
    }
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'update_details', woNumber, scheduledDate, jobLocationId, assignedToId, details }) });
      // Save crew assignments
      await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'update_crew', employeeIds: [...crewIds] }) });
      if (newImageBase64) {
        await api('/work-orders', { method: 'PATCH', body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'update_photo', imageBase64: newImageBase64, mimeType: newMimeType }) });
      }
      close();
      refreshAndReopenWo(wo.id);
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Save changes';
    }
  });
}

// ---- Badge: ready-to-bill count ----
async function checkPendingWorkOrders() {
  const myRole = currentCompanyRole();
  if (myRole !== 'admin' && myRole !== 'foreman') return;
  try {
    const data = await api(withCompany('/work-orders?status=ready_to_bill'));
    const count = (data.workOrders || []).length;
    state.pendingWorkOrderCount = count;
    const schedTab = document.querySelector('[data-tab="approvals"]');
    if (schedTab && count > 0) {
      let badge = schedTab.querySelector('.wo-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'wo-badge';
        badge.style.cssText = 'background:#16a34a;color:#fff;border-radius:10px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:4px;';
        schedTab.appendChild(badge);
      }
      badge.textContent = count;
    }
  } catch (err) {
    console.error('Could not check work orders:', err);
  }
}

// ---- Log time toward a WO ----
function showLogWoTimeDialog(wo) {
  const times = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const hh = String(h).padStart(2,'0'), mm = String(m).padStart(2,'0');
      const label = `${h===0?12:h>12?h-12:h}:${mm} ${h<12?'AM':'PM'}`;
      times.push({ value: `${hh}:${mm}`, label });
    }
  }
  const timeOptions = times.map(t => `<option value="${t.value}">${t.label}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div style="font-weight:700;font-size:17px;">Log time</div>
        <button id="wo-log-close" style="background:none;border:none;font-size:24px;cursor:pointer;">&times;</button>
      </div>
      <div class="screen-sub" style="margin-bottom:14px;">WO# ${escapeHtml(wo.woNumber)}${wo.jobLocation ? ' &middot; ' + escapeHtml(wo.jobLocation.name) : ''}</div>
      <div class="field">
        <label for="wo-time-date">Date</label>
        <input id="wo-time-date" type="date" value="${todayStr()}" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="field">
          <label for="wo-time-in">Time in</label>
          <select id="wo-time-in">${timeOptions}</select>
        </div>
        <div class="field">
          <label for="wo-time-out">Time out</label>
          <select id="wo-time-out">${timeOptions}</select>
        </div>
      </div>
      <div id="wo-time-hours" style="text-align:center;padding:10px;background:var(--paper-dim);border-radius:8px;font-weight:600;margin-bottom:12px;"></div>
      <div class="field">
        <label for="wo-time-desc">Work performed (optional)</label>
        <textarea id="wo-time-desc" rows="3" placeholder="Describe what was done..."></textarea>
      </div>
      <div id="wo-log-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="wo-log-cancel">Cancel</button>
        <button class="btn btn-primary" id="wo-log-save">Log time</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#wo-log-close').addEventListener('click', close);
  overlay.querySelector('#wo-log-cancel').addEventListener('click', close);

  const inSel = overlay.querySelector('#wo-time-in');
  const outSel = overlay.querySelector('#wo-time-out');
  inSel.value = '07:00';
  outSel.value = '15:30';

  function updateHours() {
    const [ih, im] = inSel.value.split(':').map(Number);
    const [oh, om] = outSel.value.split(':').map(Number);
    const mins = (oh * 60 + om) - (ih * 60 + im);
    const el = overlay.querySelector('#wo-time-hours');
    if (mins <= 0) { el.textContent = 'Invalid time range'; el.style.color = '#e53e3e'; }
    else { el.textContent = (mins / 60).toFixed(2) + ' hours'; el.style.color = 'inherit'; }
  }
  updateHours();
  inSel.addEventListener('change', updateHours);
  outSel.addEventListener('change', updateHours);

  overlay.querySelector('#wo-log-save').addEventListener('click', async () => {
    const date = overlay.querySelector('#wo-time-date').value;
    const timeIn = inSel.value;
    const timeOut = outSel.value;
    const activityDescription = overlay.querySelector('#wo-time-desc').value.trim() || null;
    const errorEl = overlay.querySelector('#wo-log-error');
    const btn = overlay.querySelector('#wo-log-save');

    if (!date) { errorEl.innerHTML = errorHtml('Date is required.'); return; }
    const [ih, im] = timeIn.split(':').map(Number);
    const [oh, om] = timeOut.split(':').map(Number);
    if ((oh*60+om) <= (ih*60+im)) { errorEl.innerHTML = errorHtml('Time out must be after time in.'); return; }

    btn.disabled = true;
    btn.textContent = 'Logging...';
    try {
      await api('/time-entries', { method: 'POST', body: JSON.stringify({
        companyId: state.activeCompanyId,
        employeeId: wo.assignedTo?.id || state.employee.id,
        entryDate: date, timeIn, timeOut, activityDescription,
        jobLocationId: wo.jobLocation?.id || null,
        workOrderId: wo.id,
      })});
      close();
      refreshAndReopenWo(wo.id);
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Log time';
    }
  });
}

// ---- Bill work order dialog — requires invoice number ----
function showBillWorkOrderDialog(wo) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:380px;width:100%;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div style="font-weight:700;font-size:17px;">Mark as billed</div>
        <button id="bill-wo-close" style="background:none;border:none;font-size:24px;cursor:pointer;">&times;</button>
      </div>
      <div class="screen-sub" style="margin-bottom:14px;">WO# ${escapeHtml(wo.woNumber)}${wo.jobLocation ? ' &middot; ' + escapeHtml(wo.jobLocation.name) : ''}</div>
      <div class="field">
        <label for="bill-invoice-number">Invoice number *</label>
        <input id="bill-invoice-number" type="text" placeholder="e.g. INV-2026-0042" style="font-size:16px;" />
        <div class="screen-sub">Required. This work order will be archived once billed and can be searched by invoice number.</div>
      </div>
      <div id="bill-wo-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="bill-wo-cancel">Cancel</button>
        <button class="btn btn-primary" id="bill-wo-save">Mark as billed</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#bill-wo-close').addEventListener('click', close);
  overlay.querySelector('#bill-wo-cancel').addEventListener('click', close);

  // Auto-focus the invoice number field
  setTimeout(() => overlay.querySelector('#bill-invoice-number').focus(), 100);

  overlay.querySelector('#bill-wo-save').addEventListener('click', async () => {
    const invoiceNumber = overlay.querySelector('#bill-invoice-number').value.trim();
    const errorEl = overlay.querySelector('#bill-wo-error');
    const btn = overlay.querySelector('#bill-wo-save');

    if (!invoiceNumber) {
      errorEl.innerHTML = errorHtml('Invoice number is required.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await api('/work-orders', {
        method: 'PATCH',
        body: JSON.stringify({ companyId: state.activeCompanyId, workOrderId: wo.id, action: 'bill', invoiceNumber }),
      });
      close();
      render('approvals', { subView: 'schedule' });
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Mark as billed';
    }
  });
}

// ---- WO conflict checker ----
// Runs when assignee or scheduled date changes in Create/Edit dialogs.
// Warns admin if the assigned employee has schedule or leave conflicts.
async function checkWoConflicts(overlay) {
  const assignedId = overlay.querySelector('#wo-assigned, #edit-wo-assigned')?.value;
  const scheduledDate = overlay.querySelector('#wo-scheduled-date, #edit-wo-scheduled')?.value;
  const warningEl = overlay.querySelector('#wo-conflict-warning');
  if (!warningEl) return;

  if (!assignedId || !scheduledDate) {
    warningEl.style.display = 'none';
    return;
  }

  try {
    const result = await api('/work-orders', {
      method: 'PATCH',
      body: JSON.stringify({
        companyId: state.activeCompanyId,
        workOrderId: 'conflict-check',
        action: 'check_conflicts',
        employeeId: assignedId,
        scheduledDate,
      }),
    });

    const conflicts = result.conflicts || [];
    if (conflicts.length === 0) {
      warningEl.style.display = 'none';
    } else {
      warningEl.style.display = 'block';
      warningEl.innerHTML = `⚠ <strong>Scheduling conflict${conflicts.length > 1 ? 's' : ''}:</strong><ul style="margin:6px 0 0 16px;padding:0;">${conflicts.map(c => `<li>${c.message}</li>`).join('')}</ul><div style="margin-top:6px;font-size:12px;">You can still assign this WO — this is a warning only.</div>`;
    }
  } catch (err) {
    // Silently ignore conflict check errors — don't block the dialog
    warningEl.style.display = 'none';
  }
}

// ---- Stay on WO: re-fetch and reopen after any action ----
async function refreshAndReopenWo(woId) {
  try {
    const [openData, closedData] = await Promise.all([
      api(withCompany('/work-orders?status=open')).catch(() => ({ workOrders: [] })),
      api(withCompany('/work-orders?status=ready_to_bill')).catch(() => ({ workOrders: [] })),
    ]);
    const allWos = [...(openData.workOrders || []), ...(closedData.workOrders || [])];
    const updated = allWos.find(w => w.id === woId);
    if (updated) showWorkOrderDetail(updated.id, allWos);
    else render('approvals', { subView: 'schedule' });
  } catch {
    render('approvals', { subView: 'schedule' });
  }
}

// ---- Add job site photos from a work order ----
// Opens a multi-photo upload dialog pre-filled with the WO's job location.
// Photos go into job_site_photos (appear in Photos tab) not work_order_photos.
function showWoSitePhotosDialog(wo) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;-webkit-overflow-scrolling:touch;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div style="font-weight:700;font-size:17px;">Add job site photos</div>
        <button id="wo-site-photos-close" style="background:none;border:none;font-size:24px;cursor:pointer;">&times;</button>
      </div>
      <div class="screen-sub" style="margin-bottom:14px;">WO# ${escapeHtml(wo.woNumber)}${wo.jobLocation ? ' &middot; ' + escapeHtml(wo.jobLocation.name) : ''}</div>

      <div class="field">
        <label>Photos (select one or more)</label>
        <input id="wo-site-photo-input" type="file" accept="image/*" multiple />
        <div class="screen-sub">Select multiple photos at once from your library.</div>
      </div>
      <div id="wo-site-photo-preview" style="display:none;margin-bottom:14px;"></div>

      <div class="field">
        <label for="wo-site-photo-location">Job location</label>
        <select id="wo-site-photo-location">
          <option value="">No specific location</option>
        </select>
      </div>

      <div class="field">
        <label for="wo-site-photo-description">Description (optional)</label>
        <textarea id="wo-site-photo-description" rows="2" placeholder="Describe the work shown..."></textarea>
      </div>

      <div id="wo-site-photo-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="wo-site-photo-cancel">Cancel</button>
        <button class="btn btn-primary" id="wo-site-photo-save" disabled>Upload</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#wo-site-photos-close').addEventListener('click', close);
  overlay.querySelector('#wo-site-photo-cancel').addEventListener('click', close);

  // Populate location dropdown — pre-select WO's job location
  api(withCompany('/job-locations')).then(d => {
    const sel = overlay.querySelector('#wo-site-photo-location');
    if (!sel) return;
    (d.locations || []).forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name;
      if (l.id === wo.jobLocation?.id) opt.selected = true;
      sel.appendChild(opt);
    });
  }).catch(() => {});

  let compressedImages = [];

  overlay.querySelector('#wo-site-photo-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const saveBtn = overlay.querySelector('#wo-site-photo-save');
    const errorEl = overlay.querySelector('#wo-site-photo-error');
    const previewGrid = overlay.querySelector('#wo-site-photo-preview');
    errorEl.innerHTML = '';
    saveBtn.disabled = true;
    saveBtn.textContent = `Processing ${files.length} photo${files.length > 1 ? 's' : ''}...`;
    compressedImages = [];

    try {
      for (const file of files) {
        const compressed = await compressImage(file);
        compressedImages.push(compressed);
      }
      previewGrid.style.display = 'block';
      previewGrid.innerHTML = `
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:6px;">${compressedImages.length} photo${compressedImages.length > 1 ? 's' : ''} selected</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
          ${compressedImages.map((img, i) => `
            <img src="data:${img.mimeType};base64,${img.base64}" data-preview-idx="${i}" style="width:100%;height:80px;object-fit:cover;border-radius:6px;display:block;" />`).join('')}
        </div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = `Upload ${compressedImages.length} photo${compressedImages.length > 1 ? 's' : ''}`;
    } catch (err) {
      errorEl.innerHTML = errorHtml(`Could not process photos: ${err.message}`);
      saveBtn.textContent = 'Upload';
    }
  });

  overlay.querySelector('#wo-site-photo-save').addEventListener('click', async () => {
    if (!compressedImages.length) return;
    const jobLocationId = overlay.querySelector('#wo-site-photo-location').value || null;
    const description = overlay.querySelector('#wo-site-photo-description').value.trim() || null;
    const errorEl = overlay.querySelector('#wo-site-photo-error');
    const saveBtn = overlay.querySelector('#wo-site-photo-save');
    saveBtn.disabled = true;

    try {
      for (let i = 0; i < compressedImages.length; i++) {
        saveBtn.textContent = `Uploading ${i + 1} of ${compressedImages.length}...`;
        await api('/job-photos', {
          method: 'POST',
          body: JSON.stringify({
            companyId: state.activeCompanyId,
            jobLocationId,
            description,
            imageBase64: compressedImages[i].base64,
            mimeType: compressedImages[i].mimeType,
            isReceipt: false,
            receiptAmount: null,
          }),
        });
      }
      close();
      refreshAndReopenWo(wo.id);
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = `Upload ${compressedImages.length} photo${compressedImages.length > 1 ? 's' : ''}`;
    }
  });
}
