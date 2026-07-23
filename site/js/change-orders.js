// ---- Change Orders UI ----
// Loaded as part of the app. Functions called from work-orders.js worksheet view.

async function showCreateChangeOrderDialog(homeBuildId, workOrderId, woNumber) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.6);display:flex;align-items:flex-end;justify-content:center;z-index:160;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px 16px 0 0;width:100%;max-width:600px;max-height:92vh;display:flex;flex-direction:column;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid var(--line);flex-shrink:0;">
        <div style="font-weight:700;font-size:17px;">New Change Order — WO# ${escapeHtml(woNumber)}</div>
        <button id="co-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--ink-soft);">&times;</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:16px 18px;">
        <div class="field">
          <label>Description of change</label>
          <textarea id="co-description" rows="3" placeholder="Describe what changed from the original scope..."></textarea>
        </div>

        <div style="font-weight:700;font-size:14px;margin-bottom:8px;">Materials</div>
        <div id="co-materials-list"></div>
        <button class="btn btn-ghost btn-sm" id="co-add-material" style="margin-bottom:16px;">+ Add material</button>

        <div style="font-weight:700;font-size:14px;margin-bottom:6px;">Crew on this change order</div>
        <div class="screen-sub" style="margin-bottom:8px;">Select who is working on this CO. Each person logs their own hours from the worksheet.</div>
        <div id="co-crew-list" style="border:1px solid var(--line);border-radius:8px;overflow:hidden;max-height:180px;overflow-y:auto;margin-bottom:16px;">${loadingHtml()}</div>

        <div id="co-error" style="color:#dc2626;font-size:13px;margin-bottom:8px;"></div>
        <div class="btn-row">
          <button class="btn btn-ghost" id="co-save-draft">Save draft</button>
          <button class="btn btn-primary" id="co-save-sign">Save &amp; Get Signature</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#co-close').addEventListener('click', close);

  // Load crew checklist
  let selectedCrewIds = new Set();
  api(withCompany('/dashboard')).then(data => {
    const people = (data.people || []).filter(p => p.id !== state.employee.id);
    const crewList = overlay.querySelector('#co-crew-list');
    if (people.length === 0) {
      crewList.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:var(--ink-soft);">No other employees found.</div>';
      return;
    }
    const myTeam = people.filter(p => p.isMyTeam !== false);
    const others = people.filter(p => p.isMyTeam === false);
    function crewRowHtml(p) {
      return `<label data-crew-id="${p.id}" style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;font-size:13px;">
        <input type="checkbox" value="${p.id}" style="width:16px;height:16px;" />
        ${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)} <span style="color:var(--ink-soft);font-size:11px;">(${p.role})</span>
      </label>`;
    }
    let html = '';
    if (myTeam.length > 0 && others.length > 0) {
      html += `<div style="padding:4px 12px;font-size:11px;font-weight:700;color:var(--ink-soft);background:var(--paper-dim);">MY TEAM</div>`;
    }
    html += myTeam.map(crewRowHtml).join('');
    if (others.length > 0) {
      html += `<div style="padding:4px 12px;font-size:11px;font-weight:700;color:var(--ink-soft);background:var(--paper-dim);">OTHER EMPLOYEES</div>`;
      html += others.map(crewRowHtml).join('');
    }
    crewList.innerHTML = html;
    crewList.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selectedCrewIds.add(cb.value);
        else selectedCrewIds.delete(cb.value);
      });
    });
  }).catch(() => {
    overlay.querySelector('#co-crew-list').innerHTML = '<div style="padding:10px 12px;font-size:12px;color:var(--ink-soft);">Could not load employees.</div>';
  });

  // Materials rows
  let materialRows = [{ id: Date.now(), catalogItemId: null, partNumber: '', name: '', category: '', unit: 'each', quantity: 1, unitCost: '' }];

  function renderMaterials() {
    const container = overlay.querySelector('#co-materials-list');
    container.innerHTML = materialRows.map((row, idx) => `
      <div data-mat-idx="${idx}" style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px;position:relative;">
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <div style="flex:2;position:relative;">
            <input type="text" class="mat-name-input" data-idx="${idx}" placeholder="Search parts..." value="${escapeHtml(row.name)}"
              style="width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--line);font-size:13px;box-sizing:border-box;" />
            <div class="mat-suggestions" data-idx="${idx}" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid var(--line);border-radius:6px;z-index:10;max-height:160px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.1);"></div>
          </div>
          <input type="text" class="mat-part" data-idx="${idx}" placeholder="Part #" value="${escapeHtml(row.partNumber)}"
            style="flex:1;padding:7px 8px;border-radius:6px;border:1px solid var(--line);font-size:12px;box-sizing:border-box;" />
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="number" class="mat-qty" data-idx="${idx}" value="${row.quantity}" min="0.001" step="any"
            style="width:70px;padding:7px 8px;border-radius:6px;border:1px solid var(--line);font-size:13px;" />
          <select class="mat-unit" data-idx="${idx}" style="padding:7px 8px;border-radius:6px;border:1px solid var(--line);font-size:13px;">
            ${['each','box','roll','ft','bag','pack','pair','lb'].map(u => `<option ${row.unit===u?'selected':''}>${u}</option>`).join('')}
          </select>
          <input type="number" class="mat-cost" data-idx="${idx}" value="${row.unitCost}" min="0" step="0.01" placeholder="Unit cost"
            style="flex:1;padding:7px 8px;border-radius:6px;border:1px solid var(--line);font-size:13px;" />
          <span style="font-size:12px;color:var(--ink-soft);min-width:60px;text-align:right;" id="mat-total-${idx}">
            ${row.unitCost && row.quantity ? '$' + (parseFloat(row.unitCost) * parseFloat(row.quantity)).toFixed(2) : '—'}
          </span>
          <button class="mat-remove" data-idx="${idx}" style="background:none;border:none;color:#dc2626;font-size:18px;cursor:pointer;padding:2px 4px;">×</button>
        </div>
      </div>
    `).join('');

    // Wire events
    container.querySelectorAll('.mat-name-input').forEach(input => {
      const idx = parseInt(input.getAttribute('data-idx'));
      input.addEventListener('input', async () => {
        materialRows[idx].name = input.value;
        materialRows[idx].catalogItemId = null;
        const q = input.value.trim();
        const suggEl = container.querySelector(`.mat-suggestions[data-idx="${idx}"]`);
        if (q.length < 2) { suggEl.style.display = 'none'; return; }
        try {
          const data = await api(withCompany(`/materials-catalog?q=${encodeURIComponent(q)}&limit=8`));
          const items = data.items || [];
          if (items.length === 0) { suggEl.style.display = 'none'; return; }
          suggEl.innerHTML = items.map(item => `
            <div data-item-id="${item.id}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line);font-size:13px;" class="mat-sugg-item">
              <div style="font-weight:600;">${escapeHtml(item.name)}</div>
              <div style="font-size:11px;color:var(--ink-soft);">${item.part_number || ''} ${item.category ? '· ' + item.category : ''} · ${item.unit}${item.unit_cost ? ' · $' + Number(item.unit_cost).toFixed(2) : ''}</div>
            </div>`).join('');
          suggEl.style.display = '';
          suggEl.querySelectorAll('.mat-sugg-item').forEach(s => {
            s.addEventListener('click', () => {
              const item = items.find(i => i.id === s.getAttribute('data-item-id'));
              if (!item) return;
              materialRows[idx] = { ...materialRows[idx], catalogItemId: item.id, name: item.name, partNumber: item.part_number || '', category: item.category || '', unit: item.unit || 'each', unitCost: item.unit_cost || '' };
              suggEl.style.display = 'none';
              renderMaterials();
            });
          });
        } catch {}
      });
      input.addEventListener('blur', () => {
        setTimeout(() => { const s = container.querySelector(`.mat-suggestions[data-idx="${idx}"]`); if (s) s.style.display = 'none'; }, 200);
      });
    });

    container.querySelectorAll('.mat-qty').forEach(input => {
      input.addEventListener('change', () => {
        const idx = parseInt(input.getAttribute('data-idx'));
        materialRows[idx].quantity = parseFloat(input.value) || 1;
        const cost = parseFloat(materialRows[idx].unitCost);
        const totalEl = document.getElementById(`mat-total-${idx}`);
        if (totalEl) totalEl.textContent = (cost && materialRows[idx].quantity) ? '$' + (cost * materialRows[idx].quantity).toFixed(2) : '—';
      });
    });
    container.querySelectorAll('.mat-unit').forEach(sel => {
      sel.addEventListener('change', () => { materialRows[parseInt(sel.getAttribute('data-idx'))].unit = sel.value; });
    });
    container.querySelectorAll('.mat-cost').forEach(input => {
      input.addEventListener('change', () => {
        const idx = parseInt(input.getAttribute('data-idx'));
        materialRows[idx].unitCost = input.value;
        const totalEl = document.getElementById(`mat-total-${idx}`);
        if (totalEl) totalEl.textContent = (input.value && materialRows[idx].quantity) ? '$' + (parseFloat(input.value) * materialRows[idx].quantity).toFixed(2) : '—';
      });
    });
    container.querySelectorAll('.mat-part').forEach(input => {
      input.addEventListener('change', () => { materialRows[parseInt(input.getAttribute('data-idx'))].partNumber = input.value; });
    });
    container.querySelectorAll('.mat-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'));
        materialRows.splice(idx, 1);
        if (materialRows.length === 0) materialRows.push({ id: Date.now(), catalogItemId: null, partNumber: '', name: '', category: '', unit: 'each', quantity: 1, unitCost: '' });
        renderMaterials();
      });
    });
  }
  renderMaterials();

  overlay.querySelector('#co-add-material').addEventListener('click', () => {
    materialRows.push({ id: Date.now(), catalogItemId: null, partNumber: '', name: '', category: '', unit: 'each', quantity: 1, unitCost: '' });
    renderMaterials();
  });

  async function saveCo(thenSign) {
    const description = overlay.querySelector('#co-description').value.trim();
    const errorEl = overlay.querySelector('#co-error');
    const validMats = materialRows.filter(m => m.name.trim());

    const btn = thenSign ? overlay.querySelector('#co-save-sign') : overlay.querySelector('#co-save-draft');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      const result = await api('/change-orders', {
        method: 'POST',
        body: JSON.stringify({
          companyId: state.activeCompanyId,
          homeBuildId,
          workOrderId,
          description,
          crewIds: [...selectedCrewIds],
          materials: validMats.map(m => ({
            catalogItemId: m.catalogItemId,
            partNumber: m.partNumber,
            name: m.name,
            category: m.category,
            unit: m.unit,
            quantity: m.quantity,
            unitCost: m.unitCost || null,
          })),
        }),
      });

      close();
      if (thenSign) {
        showSignatureDialog(result.changeOrder, homeBuildId);
      } else {
        showHomeBuildWorksheet(homeBuildId);
      }
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = thenSign ? 'Save & Get Signature' : 'Save draft';
    }
  }

  overlay.querySelector('#co-save-draft').addEventListener('click', () => saveCo(false));
  overlay.querySelector('#co-save-sign').addEventListener('click', () => saveCo(true));
}

// ---- In-Person Signature Dialog ----
function showSignatureDialog(co, homeBuildId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.7);display:flex;align-items:center;justify-content:center;z-index:170;padding:16px;';
  const now = new Date();
  const timestamp = now.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;padding:20px;">
      <div style="font-weight:700;font-size:17px;margin-bottom:4px;">${escapeHtml(co.co_number)} — Get Signature</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:16px;">${timestamp}</div>

      ${co.description ? `<div style="font-size:13px;background:var(--paper-dim);border-radius:6px;padding:10px 12px;margin-bottom:14px;">${escapeHtml(co.description)}</div>` : ''}

      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:13px;line-height:1.5;">
        <strong>By signing below, I acknowledge and agree to pay for all labor and materials associated with this change order.</strong>
      </div>

      <div class="field">
        <label>Signer's full name *</label>
        <input id="sig-name" type="text" placeholder="Print full name" style="font-size:15px;" />
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-weight:600;font-size:13px;display:block;margin-bottom:6px;">Signature *</label>
        <canvas id="sig-canvas" width="440" height="180"
          style="border:2px solid var(--line);border-radius:8px;background:#fafafa;touch-action:none;cursor:crosshair;width:100%;display:block;"></canvas>
        <button id="sig-clear" class="btn btn-ghost btn-sm" style="margin-top:6px;">Clear signature</button>
      </div>

      <div style="display:flex;gap:8px;margin-top:4px;">
        <button class="btn btn-ghost" id="sig-cancel">Cancel</button>
        <button class="btn btn-ghost" id="sig-email">Send via email instead</button>
        <button class="btn btn-primary" id="sig-confirm" disabled>Confirm Approval</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#sig-cancel').addEventListener('click', () => { close(); showHomeBuildWorksheet(homeBuildId); });

  // Canvas signature
  const canvas = overlay.querySelector('#sig-canvas');
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#1a1208';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  let drawing = false;
  let hasSig = false;

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const touch = e.touches ? e.touches[0] : e;
    return { x: (touch.clientX - rect.left) * scaleX, y: (touch.clientY - rect.top) * scaleY };
  }

  canvas.addEventListener('mousedown', e => { drawing = true; ctx.beginPath(); const p = getPos(e); ctx.moveTo(p.x, p.y); });
  canvas.addEventListener('mousemove', e => { if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); hasSig = true; updateConfirmBtn(); });
  canvas.addEventListener('mouseup', () => { drawing = false; });
  canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; ctx.beginPath(); const p = getPos(e); ctx.moveTo(p.x, p.y); }, { passive: false });
  canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); hasSig = true; updateConfirmBtn(); }, { passive: false });
  canvas.addEventListener('touchend', () => { drawing = false; });

  overlay.querySelector('#sig-clear').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasSig = false;
    updateConfirmBtn();
  });

  function updateConfirmBtn() {
    const name = overlay.querySelector('#sig-name').value.trim();
    overlay.querySelector('#sig-confirm').disabled = !(hasSig && name.length >= 2);
  }
  overlay.querySelector('#sig-name').addEventListener('input', updateConfirmBtn);

  overlay.querySelector('#sig-confirm').addEventListener('click', async () => {
    const approverName = overlay.querySelector('#sig-name').value.trim();
    const signatureData = canvas.toDataURL('image/png');
    const btn = overlay.querySelector('#sig-confirm');
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      await api('/change-orders', {
        method: 'PATCH',
        body: JSON.stringify({
          companyId: state.activeCompanyId,
          id: co.id,
          action: 'sign_in_person',
          approverName,
          signatureData,
        }),
      });
      close();
      showHomeBuildWorksheet(homeBuildId);
    } catch (err) {
      alert('Could not save signature: ' + err.message);
      btn.disabled = false; btn.textContent = 'Confirm Approval';
    }
  });

  overlay.querySelector('#sig-email').addEventListener('click', () => {
    close();
    showRemoteApprovalDialog(co, homeBuildId);
  });
}

// ---- Remote Email Approval Dialog ----
function showRemoteApprovalDialog(co, homeBuildId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.7);display:flex;align-items:center;justify-content:center;z-index:170;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:100%;max-width:420px;padding:20px;">
      <div style="font-weight:700;font-size:17px;margin-bottom:8px;">Send for Remote Approval</div>
      <div class="screen-sub" style="margin-bottom:16px;">The recipient will receive a link to review and approve ${escapeHtml(co.co_number)}. The link expires in 7 days.</div>
      <div class="field">
        <label>Recipient email *</label>
        <input id="remote-email" type="email" placeholder="approver@example.com" style="font-size:15px;" />
      </div>
      <div id="remote-error" style="color:#dc2626;font-size:13px;margin-bottom:8px;"></div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="remote-cancel">Cancel</button>
        <button class="btn btn-primary" id="remote-send">Send approval request</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#remote-cancel').addEventListener('click', () => { close(); showHomeBuildWorksheet(homeBuildId); });
  overlay.querySelector('#remote-send').addEventListener('click', async () => {
    const email = overlay.querySelector('#remote-email').value.trim();
    const errorEl = overlay.querySelector('#remote-error');
    if (!email || !email.includes('@')) { errorEl.textContent = 'Enter a valid email address.'; return; }
    const btn = overlay.querySelector('#remote-send');
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      await api('/change-orders', {
        method: 'PATCH',
        body: JSON.stringify({ companyId: state.activeCompanyId, id: co.id, action: 'send_remote_approval', approvalEmail: email }),
      });
      close();
      alert(`Approval request sent to ${email}. ${escapeHtml(co.co_number)} is now pending approval.`);
      showHomeBuildWorksheet(homeBuildId);
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Send approval request';
    }
  });
}

// ---- Log Labor on Change Order ----
async function showLogCoLaborDialog(co, homeBuildId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.6);display:flex;align-items:center;justify-content:center;z-index:170;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;width:100%;max-width:420px;padding:20px;">
      <div style="font-weight:700;font-size:17px;margin-bottom:4px;">Log My Time — ${escapeHtml(co.co_number)}</div>
      <div class="screen-sub" style="margin-bottom:14px;">Time will appear in your My Hours and link to the work order.</div>

      <div class="field">
        <label>Date *</label>
        <input id="labor-date" type="date" value="${todayStr()}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;box-sizing:border-box;" />
      </div>
      <div class="field">
        <label>Hours worked *</label>
        <input id="labor-hours" type="number" min="0.25" step="0.25" placeholder="e.g. 2.5" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;box-sizing:border-box;" />
      </div>
      <div class="field">
        <label>Description (optional)</label>
        <input id="labor-desc" type="text" placeholder="What was done..." style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);font-size:13px;box-sizing:border-box;" />
      </div>
      <div id="labor-error" style="color:#dc2626;font-size:13px;margin-bottom:8px;"></div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="labor-cancel">Cancel</button>
        <button class="btn btn-primary" id="labor-save">Log my hours</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#labor-cancel').addEventListener('click', close);

  overlay.querySelector('#labor-save').addEventListener('click', async () => {
    const entryDate = overlay.querySelector('#labor-date').value;
    const hoursWorked = parseFloat(overlay.querySelector('#labor-hours').value);
    const activityDescription = overlay.querySelector('#labor-desc').value.trim();
    const errorEl = overlay.querySelector('#labor-error');

    if (!entryDate) { errorEl.textContent = 'Enter a date.'; return; }
    if (!hoursWorked || hoursWorked <= 0) { errorEl.textContent = 'Enter valid hours.'; return; }

    const btn = overlay.querySelector('#labor-save');
    btn.disabled = true; btn.textContent = 'Saving...';

    try {
      await api('/change-orders', {
        method: 'PATCH',
        body: JSON.stringify({
          companyId: state.activeCompanyId,
          id: co.id,
          action: 'log_labor',
          employeeId: state.employee.id,
          entryDate,
          hoursWorked,
          activityDescription: activityDescription || null,
          foremanId: state.employee.id,
        }),
      });
      close();
      showHomeBuildWorksheet(homeBuildId);
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Log my hours';
    }
  });
}
