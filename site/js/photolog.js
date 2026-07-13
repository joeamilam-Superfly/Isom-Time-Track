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
      <div class="screen-sub">Photos from every job site at this company.</div>
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
      ${state.jobLocations.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
    `;
    filterEl.addEventListener('change', () => loadPhotoLog(filterEl.value));
  } catch (err) {
    console.error('Could not load job locations for filter:', err);
  }

  loadPhotoLog('');
}

async function loadPhotoLog(jobLocationId) {
  const gridEl = document.getElementById('photolog-grid');
  gridEl.innerHTML = loadingHtml();
  try {
    const path = jobLocationId
      ? withCompany(`/job-photos?jobLocationId=${jobLocationId}`)
      : withCompany('/job-photos');
    const data = await api(path);
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

  gridEl.innerHTML = photos.map(p => {
    const takenDate = new Date(p.takenAt);
    const dateLabel = takenDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeLabel = takenDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const canDelete = p.employeeName && (currentCompanyRole() === 'admin' || isOwnPhoto(p));

    return `
      <div class="day-stub" style="padding:0; overflow:hidden;">
        ${p.isReceipt ? `<div style="background:var(--amber); color:#fff; font-size:11px; font-weight:700; padding:4px 10px; letter-spacing:0.05em;">RECEIPT${p.receiptAmount ? ' &mdash; $' + Number(p.receiptAmount).toFixed(2) : ''}</div>` : ''}
        ${p.url ? `<img src="${p.url}" alt="${p.isReceipt ? 'Receipt' : 'Job site photo'}" style="width:100%; display:block; max-height:280px; object-fit:cover;" />` : `<div class="empty-state" style="padding:30px;">Image unavailable</div>`}
        <div class="day-stub-body" style="padding:12px 14px;">
          <div class="day-stub-top">
            <div class="day-stub-date">${p.jobLocationName ? escapeHtml(p.jobLocationName) : 'No location'}</div>
            <div class="day-stub-hours" style="font-size:13px;">${dateLabel}</div>
          </div>
          <div class="day-stub-meta">
            ${p.employeeName ? `<span>${escapeHtml(p.employeeName)}</span>` : ''}
            <span>${timeLabel}</span>
          </div>
          ${p.description ? `<div class="screen-sub" style="margin-top:6px; margin-bottom:0;">${escapeHtml(p.description)}</div>` : ''}
          ${canDelete ? `<button class="btn btn-sm btn-ghost" data-delete-photo="${p.id}" style="margin-top:10px;">Delete</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

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

function showAddPhotoDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Add a photo</div>

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
        <label for="photo-file-input">Photo</label>
        <input id="photo-file-input" type="file" accept="image/*" />
      </div>
      <div id="photo-preview" style="display:none; margin-bottom:14px;">
        <img id="photo-preview-img" style="width:100%; border-radius:8px; max-height:240px; object-fit:cover;" />
      </div>

      <div class="field">
        <label for="photo-location-select">Job location</label>
        <select id="photo-location-select">
          <option value="">No specific location</option>
          ${state.jobLocations.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </div>

      <div class="field" id="photo-description-field">
        <label for="photo-description" id="photo-description-label">What's happening in this photo?</label>
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

  // Toggle receipt-specific fields when radio changes
  document.querySelectorAll('input[name="photo-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isReceipt = document.getElementById('photo-type-receipt').checked;
      document.getElementById('receipt-amount-field').style.display = isReceipt ? 'block' : 'none';
      document.getElementById('photo-description-label').textContent = isReceipt
        ? 'What is this receipt for?'
        : 'What\'s happening in this photo?';
      document.getElementById('photo-description').placeholder = isReceipt
        ? 'e.g. Lumber, electrical supplies, fuel'
        : 'Describe the work completed';
    });
  });

  document.getElementById('photo-timestamp-note').textContent =
    `Will be tagged with today's date and time (${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}) automatically.`;

  document.getElementById('photo-dialog-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  let compressedImage = null; // { base64, mimeType }

  document.getElementById('photo-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const saveBtn = document.getElementById('photo-dialog-save');
    const errorEl = document.getElementById('photo-dialog-error');
    errorEl.innerHTML = '';
    saveBtn.disabled = true;
    saveBtn.textContent = 'Processing photo...';

    try {
      compressedImage = await compressImageFile(file);
      document.getElementById('photo-preview').style.display = 'block';
      document.getElementById('photo-preview-img').src = `data:${compressedImage.mimeType};base64,${compressedImage.base64}`;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Upload';
    } catch (err) {
      errorEl.innerHTML = errorHtml(`Could not process that photo: ${err.message}`);
      saveBtn.textContent = 'Upload';
    }
  });

  document.getElementById('photo-dialog-save').addEventListener('click', async () => {
    if (!compressedImage) return;

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
    saveBtn.textContent = 'Uploading...';

    try {
      await api('/job-photos', {
        method: 'POST',
        body: JSON.stringify({
          companyId: state.activeCompanyId,
          jobLocationId,
          description,
          imageBase64: compressedImage.base64,
          mimeType: compressedImage.mimeType,
          isReceipt,
          receiptAmount,
        }),
      });
      document.body.removeChild(overlay);
      loadPhotoLog('');
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Upload';
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
