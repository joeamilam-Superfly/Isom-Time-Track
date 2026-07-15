// Job site photo log - a dedicated feed, browsable by job location,
// visible to every employee regardless of role (per explicit decision).
// Photos are compressed client-side before upload to stay well under
// Netlify's ~4.5MB request body limit and keep uploads fast on
// job-site connections.

const PHOTO_MAX_DIMENSION = 1600; // px, longest side after compression
const PHOTO_JPEG_QUALITY = 0.75;

async function renderPhotoLog(opts) {
  root.innerHTML = `
    ${topbarHtml()}
    <main>
      ${roleTabsHtml('photolog')}
      <div class="screen-title">Job Site Photos</div>
      <div class="field">
        <label for="photolog-filter">Filter by job location</label>
        <select id="photolog-filter">
          <option value="">All locations</option>
        </select>
      </div>
      <div id="photolog-grid">${loadingHtml()}</div>
    </main>
    <div class="bottom-bar">
      <button class="btn btn-amber" id="add-photo-btn">+ Add photo</button>
    </div>
  `;

  attachTopbarHandlers();
  attachRoleTabHandlers();

  document.getElementById('add-photo-btn').addEventListener('click', showAddPhotoDialog);

  try {
    const locationsData = await api(withCompany('/job-locations'));
    state.jobLocations = locationsData.locations || [];
    const filterEl = document.getElementById('photolog-filter');
    filterEl.innerHTML = `
      <option value="">All locations</option>
      <option value="none">⚠ No location assigned</option>
      ${state.jobLocations.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
    `;
    filterEl.addEventListener('change', () => loadPhotoLog(filterEl.value));
  } catch (err) {
    console.error('Could not load job locations for filter:', err);
  }

  // Auto-load all photos on init (receipts filtered out — they appear in Billing Report and Admin)
  loadPhotoLog('');
}

async function loadPhotoLog(jobLocationId) {
  const gridEl = document.getElementById('photolog-grid');
  gridEl.innerHTML = loadingHtml();
  try {
    const base = jobLocationId
      ? withCompany(`/job-photos?jobLocationId=${jobLocationId}&photosOnly=true`)
      : withCompany('/job-photos?photosOnly=true');
    const data = await api(base);
    renderPhotoGrid(data.photos || []);
  } catch (err) {
    gridEl.innerHTML = errorHtml(err.message);
  }
}

function renderPhotoGrid(photos) {
  const gridEl = document.getElementById('photolog-grid');
  if (photos.length === 0) {
    gridEl.innerHTML = `<div class="empty-state"><div class="icon">&#128247;</div>No photos yet.</div>`;
    return;
  }

  // Split photos into assigned and unassigned groups
  const unassigned = photos.filter(p => !p.jobLocationId);
  const assigned = photos.filter(p => p.jobLocationId);

  const canManage = currentCompanyRole() === 'admin' || currentCompanyRole() === 'foreman';

  function photoCardHtml(p) {
    const takenDate = new Date(p.takenAt);
    const dateLabel = takenDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeLabel = takenDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const canDelete = currentCompanyRole() === 'admin' || isOwnPhoto(p);
    return `
      <div class="day-stub" style="padding:0; overflow:hidden;">
        ${p.url ? `<img src="${p.url}" alt="Job site photo" style="width:100%; display:block; max-height:280px; object-fit:cover;" />` : `<div class="empty-state" style="padding:30px;">Image unavailable</div>`}
        <div class="day-stub-body" style="padding:12px 14px;">
          <div class="day-stub-top">
            <div class="day-stub-date" style="${!p.jobLocationId ? 'color:#e53e3e;' : ''}">${p.jobLocationName ? escapeHtml(p.jobLocationName) : '⚠ No location'}</div>
            <div class="day-stub-hours" style="font-size:13px;">${dateLabel}</div>
          </div>
          <div class="day-stub-meta">
            ${p.employeeName ? `<span>${escapeHtml(p.employeeName)}</span>` : ''}
            <span>${timeLabel}</span>
          </div>
          ${p.description ? `<div class="screen-sub" style="margin-top:6px;margin-bottom:0;">${escapeHtml(p.description)}</div>` : ''}
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            ${canManage ? `<button class="btn btn-sm btn-ghost" data-edit-photo="${p.id}" style="font-size:12px;">Edit</button>` : ''}
            ${canDelete ? `<button class="btn btn-sm btn-ghost" data-delete-photo="${p.id}" style="font-size:12px;">Delete</button>` : ''}
          </div>
        </div>
      </div>`;
  }

  let html = '';

  if (unassigned.length > 0) {
    html += `
      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:10px 14px;margin-bottom:12px;">
        <div style="font-weight:700;font-size:13px;color:#92400e;">⚠ ${unassigned.length} photo${unassigned.length > 1 ? 's' : ''} with no job location — tap Edit to assign</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px;margin-bottom:24px;">
        ${unassigned.map(photoCardHtml).join('')}
      </div>`;
  }

  if (assigned.length > 0) {
    html += `<div style="display:flex;flex-direction:column;gap:16px;">${assigned.map(photoCardHtml).join('')}</div>`;
  }

  gridEl.innerHTML = html;

  gridEl.querySelectorAll('[data-edit-photo]').forEach(btn => {
    const photoId = btn.getAttribute('data-edit-photo');
    const photo = photos.find(p => p.id === photoId);
    if (photo) btn.addEventListener('click', () => showEditPhotoDialog(photo));
  });

  gridEl.querySelectorAll('[data-delete-photo]').forEach(btn => {
    btn.addEventListener('click', () => deletePhoto(btn.getAttribute('data-delete-photo')));
  });
}

function isOwnPhoto(p) {
  const fullName = `${state.employee.firstName} ${state.employee.lastName}`;
  return p.employeeName === fullName;
}

async function deletePhoto(photoId) {
  if (!confirm('Delete this photo?')) return;
  try {
    await api(`/job-photos?photoId=${photoId}&companyId=${state.activeCompanyId}`, { method: 'DELETE' });
    const filterEl = document.getElementById('photolog-filter');
    loadPhotoLog(filterEl ? filterEl.value : '');
  } catch (err) {
    alert(err.message);
  }
}

function showEditPhotoDialog(photo) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="font-weight:700;font-size:17px;">Edit photo</div>
        <button id="edit-photo-close" style="background:none;border:none;font-size:24px;cursor:pointer;">&times;</button>
      </div>
      ${photo.url ? `<img src="${photo.url}" style="width:100%;border-radius:8px;margin-bottom:14px;max-height:200px;object-fit:cover;" />` : ''}
      <div class="field">
        <label for="edit-photo-location">Job location</label>
        <select id="edit-photo-location">
          <option value="">No location</option>
        </select>
      </div>
      <div class="field">
        <label for="edit-photo-description">Description</label>
        <input id="edit-photo-description" type="text" value="${photo.description ? escapeHtml(photo.description) : ''}" placeholder="Describe what this photo shows..." />
      </div>
      <div id="edit-photo-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="edit-photo-cancel">Cancel</button>
        <button class="btn btn-primary" id="edit-photo-save">Save changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
  overlay.querySelector('#edit-photo-close').addEventListener('click', close);
  overlay.querySelector('#edit-photo-cancel').addEventListener('click', close);

  // Populate locations dropdown
  const locSel = overlay.querySelector('#edit-photo-location');
  (state.jobLocations || []).forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = l.name;
    if (l.id === photo.jobLocationId) opt.selected = true;
    locSel.appendChild(opt);
  });

  // If locations not loaded yet, fetch them
  if (!state.jobLocations || state.jobLocations.length === 0) {
    api(withCompany('/job-locations')).then(d => {
      state.jobLocations = d.locations || [];
      state.jobLocations.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.name;
        if (l.id === photo.jobLocationId) opt.selected = true;
        locSel.appendChild(opt);
      });
    }).catch(() => {});
  }

  overlay.querySelector('#edit-photo-save').addEventListener('click', async () => {
    const jobLocationId = overlay.querySelector('#edit-photo-location').value || null;
    const description = overlay.querySelector('#edit-photo-description').value.trim() || null;
    const errorEl = overlay.querySelector('#edit-photo-error');
    const btn = overlay.querySelector('#edit-photo-save');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await api('/job-photos', {
        method: 'PATCH',
        body: JSON.stringify({ companyId: state.activeCompanyId, photoId: photo.id, jobLocationId, description }),
      });
      close();
      const filterEl = document.getElementById('photolog-filter');
      loadPhotoLog(filterEl ? filterEl.value : '');
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      btn.disabled = false;
      btn.textContent = 'Save changes';
    }
  });
}

function showAddPhotoDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Add photos</div>

      <div class="field" style="margin-bottom:10px;">
        <label style="font-weight:600; font-size:14px;">Photo type</label>
        <div style="display:flex; gap:24px; margin-top:8px; align-items:center;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:14px; white-space:nowrap;">
            <input type="radio" name="photo-type" id="photo-type-jobsite" value="jobsite" checked style="width:18px; height:18px; flex-shrink:0;" />
            Job site photo
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:14px; white-space:nowrap;">
            <input type="radio" name="photo-type" id="photo-type-receipt" value="receipt" style="width:18px; height:18px; flex-shrink:0;" />
            Receipt
          </label>
        </div>
      </div>

      <div class="field">
        <label for="photo-file-input">Photos (select one or more)</label>
        <input id="photo-file-input" type="file" accept="image/*" multiple />
        <div class="screen-sub">Tap to choose multiple photos at once from your library.</div>
      </div>
      <div id="photo-preview-grid" style="display:none; margin-bottom:14px;"></div>

      <div class="field">
        <label for="photo-location-select">Job location</label>
        <select id="photo-location-select">
          <option value="">No specific location</option>
          ${state.jobLocations.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </div>

      <div class="field" id="photo-description-field">
        <label for="photo-description" id="photo-description-label">What's happening in these photos?</label>
        <textarea id="photo-description" rows="3" placeholder="Describe the work completed"></textarea>
      </div>

      <div class="field" id="receipt-amount-field" style="display:none;">
        <label for="photo-receipt-amount">Receipt total ($)</label>
        <input id="photo-receipt-amount" type="number" min="0" step="0.01" placeholder="0.00" />
      </div>

      <div class="screen-sub" id="photo-timestamp-note"></div>
      <div id="photo-dialog-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="photo-dialog-cancel">Cancel</button>
        <button class="btn btn-primary" id="photo-dialog-save" disabled>Upload</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.querySelectorAll('input[name="photo-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isReceipt = document.getElementById('photo-type-receipt').checked;
      document.getElementById('receipt-amount-field').style.display = isReceipt ? 'block' : 'none';
      document.getElementById('photo-description-label').textContent = isReceipt
        ? 'What is this receipt for?'
        : 'What\'s happening in these photos?';
      document.getElementById('photo-description').placeholder = isReceipt
        ? 'e.g. Lumber, electrical supplies, fuel'
        : 'Describe the work completed';
    });
  });

  document.getElementById('photo-timestamp-note').textContent =
    `Will be tagged with today's date and time (${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}) automatically.`;

  document.getElementById('photo-dialog-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  let compressedImages = []; // array of { base64, mimeType }

  document.getElementById('photo-file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const saveBtn = document.getElementById('photo-dialog-save');
    const errorEl = document.getElementById('photo-dialog-error');
    const previewGrid = document.getElementById('photo-preview-grid');
    errorEl.innerHTML = '';
    saveBtn.disabled = true;
    saveBtn.textContent = `Processing ${files.length} photo${files.length > 1 ? 's' : ''}...`;
    compressedImages = [];

    try {
      for (const file of files) {
        const compressed = await compressImageFile(file);
        compressedImages.push(compressed);
      }

      // Show thumbnail grid of selected photos
      previewGrid.style.display = 'block';
      previewGrid.innerHTML = `
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:6px;">${compressedImages.length} photo${compressedImages.length > 1 ? 's' : ''} selected</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
          ${compressedImages.map((img, i) => `
            <div style="position:relative;">
              <img src="data:${img.mimeType};base64,${img.base64}" style="width:100%;height:80px;object-fit:cover;border-radius:6px;display:block;" />
              <button data-remove-preview="${i}" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.6);border:none;color:#fff;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:1;padding:0;">&times;</button>
            </div>`).join('')}
        </div>`;

      // Allow removing individual photos from the selection
      previewGrid.querySelectorAll('[data-remove-preview]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.getAttribute('data-remove-preview'));
          compressedImages.splice(idx, 1);
          if (compressedImages.length === 0) {
            previewGrid.style.display = 'none';
            saveBtn.disabled = true;
            saveBtn.textContent = 'Upload';
          } else {
            // Re-render preview
            btn.closest('.field, div[style*="grid"]')?.closest('div')?.remove();
            document.getElementById('photo-file-input').dispatchEvent(new Event('rerender'));
          }
        });
      });

      saveBtn.disabled = false;
      saveBtn.textContent = `Upload ${compressedImages.length} photo${compressedImages.length > 1 ? 's' : ''}`;
    } catch (err) {
      errorEl.innerHTML = errorHtml(`Could not process photos: ${err.message}`);
      saveBtn.textContent = 'Upload';
    }
  });

  document.getElementById('photo-dialog-save').addEventListener('click', async () => {
    if (!compressedImages.length) return;

    const jobLocationId = document.getElementById('photo-location-select').value || null;
    const description = document.getElementById('photo-description').value.trim();
    const isReceipt = document.getElementById('photo-type-receipt').checked;
    const receiptAmount = isReceipt
      ? (parseFloat(document.getElementById('photo-receipt-amount').value) || null)
      : null;
    const errorEl = document.getElementById('photo-dialog-error');
    const saveBtn = document.getElementById('photo-dialog-save');
    errorEl.innerHTML = '';

    if (isReceipt && !receiptAmount) {
      errorEl.innerHTML = errorHtml('Please enter the receipt total amount.');
      return;
    }

    saveBtn.disabled = true;

    try {
      // Upload all photos sequentially
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
            isReceipt,
            receiptAmount,
          }),
        });
      }
      document.body.removeChild(overlay);
      loadPhotoLog(document.getElementById('photolog-filter')?.value || '');
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = `Upload ${compressedImages.length} photo${compressedImages.length > 1 ? 's' : ''}`;
    }
  });
}

// Resizes and compresses an image file client-side using a canvas, so
// uploads stay well under Netlify's request size limit and transfer
// quickly even on a weak job-site connection. Returns { base64, mimeType }
// with the data: prefix already stripped from base64.
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not load the image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > PHOTO_MAX_DIMENSION || height > PHOTO_MAX_DIMENSION) {
          if (width > height) {
            height = Math.round((height / width) * PHOTO_MAX_DIMENSION);
            width = PHOTO_MAX_DIMENSION;
          } else {
            width = Math.round((width / height) * PHOTO_MAX_DIMENSION);
            height = PHOTO_MAX_DIMENSION;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
        const base64 = dataUrl.split(',')[1];
        resolve({ base64, mimeType: 'image/jpeg' });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
