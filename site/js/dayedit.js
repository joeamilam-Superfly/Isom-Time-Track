async function renderDayEdit(opts) {
  const date = opts.date;
  const autoAdd = !!opts.autoAdd;

  root.innerHTML = `
    ${topbarHtml()}
    <main>
      <div class="screen-title">${formatDateLabel(date)}</div>
      <div class="screen-sub">${date === todayStr() ? "Today's hours" : 'Edit hours for this day'}</div>
      <div id="day-schedule-section"></div>
      <div id="day-edit-banner"></div>
      <div id="segments-list">${loadingHtml()}</div>
      <div id="add-segment-section"></div>
    </main>
    <div class="bottom-bar">
      <button class="btn btn-ghost" id="back-to-week-btn">&larr; Back to week</button>
    </div>
  `;
  attachTopbarHandlers();
  document.getElementById('back-to-week-btn').addEventListener('click', () => render('week'));

  try {
    const [entriesData, locationsData, foremenData, scheduleData] = await Promise.all([
      api(withCompany(`/time-entries?employeeId=${state.employee.id}&startDate=${date}&endDate=${date}`)),
      api(withCompany('/job-locations')),
      api(withCompany('/foremen-list')),
      api(withCompany(`/schedule?employeeId=${state.employee.id}&startDate=${date}&endDate=${date}`)),
    ]);
    state.jobLocations = locationsData.locations || [];
    state.foremen = foremenData.foremen || [];
    renderDaySchedule(scheduleData.entries || []);
    renderDaySegments(date, entriesData.entries || [], autoAdd);
  } catch (err) {
    document.getElementById('segments-list').innerHTML = errorHtml(err.message);
  }
}

function renderDaySchedule(scheduleEntries) {
  const el = document.getElementById('day-schedule-section');
  if (!scheduleEntries || scheduleEntries.length === 0) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div class="banner banner-info" style="margin-bottom:14px;">
      <strong>Scheduled today:</strong>
      ${scheduleEntries.map(e => {
        const loc = e.job_locations ? escapeHtml(e.job_locations.name) : 'No location set';
        const note = e.note ? ` &mdash; ${escapeHtml(e.note)}` : '';
        return `${loc}${note}`;
      }).join('; ')}
    </div>
  `;
}

let selectedJobLocationId = null;

// Finds the chronologically last-ending segment among a day's worked
// segments, so the add-segment dialog can show "where they left off" -
// by end time, not entry order, since someone logging after the fact
// might enter an afternoon segment before a morning one.
function findLatestSegment(segments) {
  if (!segments || segments.length === 0) return null;
  const withTimes = segments.filter(s => s.time_out);
  if (withTimes.length === 0) return null;
  return withTimes.reduce((latest, s) => (s.time_out > latest.time_out ? s : latest));
}

function renderDaySegments(date, segments, autoAdd) {
  // PTO entries can't be edited/deleted here at all - they're managed
  // through the Time Off flow. Worked segments can be edited or removed
  // unless they're already approved (employees only; admin can still act).
  const ptoEntry = segments.find(s => s.hours_type === 'pto');
  const workedSegments = segments.filter(s => s.hours_type !== 'pto');
  const latestSegment = findLatestSegment(workedSegments);

  document.getElementById('day-edit-banner').innerHTML = ptoEntry
    ? `<div class="banner banner-info">This day is marked as leave. Manage it from the Leave tab.</div>`
    : '';

  const listEl = document.getElementById('segments-list');

  if (workedSegments.length === 0) {
    listEl.innerHTML = ptoEntry ? '' : `<div class="empty-state"><div class="icon">&#128203;</div>No hours logged for this day yet.</div>`;
  } else {
    listEl.innerHTML = workedSegments
      .slice()
      .sort((a, b) => (a.time_in || '').localeCompare(b.time_in || ''))
      .map(s => segmentRowHtml(s))
      .join('');

    listEl.querySelectorAll('[data-edit-segment]').forEach(btn => {
      btn.addEventListener('click', () => {
        const segId = btn.getAttribute('data-edit-segment');
        const seg = workedSegments.find(s => s.id === segId);
        showSegmentFormDialog(date, seg, null); // editing - no "last segment" reference needed
      });
    });
    listEl.querySelectorAll('[data-delete-segment]').forEach(btn => {
      btn.addEventListener('click', () => deleteSegment(date, btn.getAttribute('data-delete-segment')));
    });
  }

  const addSection = document.getElementById('add-segment-section');
  if (ptoEntry) {
    addSection.innerHTML = '';
  } else {
    addSection.innerHTML = `<button class="btn btn-amber" id="add-segment-btn" style="margin-top:14px;">+ Add a time segment</button>`;
    document.getElementById('add-segment-btn').addEventListener('click', () => showSegmentFormDialog(date, null, latestSegment));
  }

  // Only auto-open the add-segment form when the caller explicitly asked
  // for it (the week view's "+ Log today's hours" button) AND the day is
  // genuinely empty. Without the autoAdd flag, tapping into an already-
  // empty day just to look at it (e.g. a past day with nothing logged)
  // correctly shows the empty state without forcing a dialog open.
  if (autoAdd && workedSegments.length === 0 && !ptoEntry) {
    showSegmentFormDialog(date, null, null);
  }
}

function segmentRowHtml(seg) {
  const locked = seg.status === 'admin_approved' && currentCompanyRole() === 'employee';
  const statusLabel = {
    draft: 'Draft',
    foreman_approved: 'Foreman approved',
    admin_approved: 'Approved',
    rejected: 'Sent back',
  }[seg.status] || seg.status;

  return `
    <div class="day-stub">
      <div class="day-stub-perf"></div>
      <div class="day-stub-body">
        <div class="day-stub-top">
          <div class="day-stub-date">${seg.time_in ? seg.time_in.slice(0,5) : '?'} - ${seg.time_out ? seg.time_out.slice(0,5) : '?'}</div>
          <div class="day-stub-hours">${Number(seg.hours_worked).toFixed(2)}h</div>
        </div>
        <div class="day-stub-meta">
          ${seg.job_locations ? `<span>${escapeHtml(seg.job_locations.name)}</span>` : '<span>No location set</span>'}
          ${seg.employees ? `<span>Foreman: ${escapeHtml(seg.employees.first_name)} ${escapeHtml(seg.employees.last_name)}</span>` : ''}
          ${seg.activity_description ? `<span>${escapeHtml(seg.activity_description)}</span>` : ''}
        </div>
        <span class="status-pill status-${seg.status}">${statusLabel}</span>
        ${seg.status === 'rejected' && seg.rejection_note ? `<div class="screen-sub" style="margin-top:6px; margin-bottom:0;">Sent back: ${escapeHtml(seg.rejection_note)}</div>` : ''}
        ${!locked ? `
          <div class="btn-row" style="margin-top:10px;">
            <button class="btn btn-sm btn-ghost" data-delete-segment="${seg.id}">Remove</button>
            <button class="btn btn-sm btn-primary" data-edit-segment="${seg.id}">Edit</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

async function deleteSegment(date, segmentId) {
  if (!confirm('Remove this time segment?')) return;
  try {
    await api(`/time-entries?entryId=${segmentId}&companyId=${state.activeCompanyId}`, { method: 'DELETE' });
    renderDayEdit({ date });
  } catch (err) {
    alert(err.message);
  }
}

function showSegmentFormDialog(date, existing, latestSegment) {
  selectedJobLocationId = existing && existing.job_location_id ? existing.job_location_id : null;

  const lastEntryHtml = (!existing && latestSegment) ? `
    <div class="banner banner-info" style="margin-bottom:14px;">
      Last entry today: ${latestSegment.job_locations ? escapeHtml(latestSegment.job_locations.name) : 'No location set'},
      ${latestSegment.time_in ? latestSegment.time_in.slice(0,5) : '?'} - ${latestSegment.time_out ? latestSegment.time_out.slice(0,5) : '?'}
    </div>
  ` : '';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;overflow-y:auto;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;">
      <div style="font-weight:700;font-size:17px;margin-bottom:2px;">${existing ? 'Edit time segment' : 'Add a time segment'}</div>
      <div style="font-size:14px;color:var(--amber-dark);font-weight:600;margin-bottom:14px;">${formatDateLabel(date)}</div>
      ${lastEntryHtml}

      ${existing ? `
        <div class="field">
          <label for="seg-entry-date">Date</label>
          <input id="seg-entry-date" type="date" value="${existing.entry_date}" />
          <div class="screen-sub">Change this if the segment was entered on the wrong day. It will go back to Draft for re-approval.</div>
        </div>
      ` : ''}

      <div class="field">
        <label for="seg-job-location-input">Job location</label>
        <input id="seg-job-location-input" type="text" placeholder="Start typing a job site..." value="${existing && existing.job_locations ? escapeHtml(existing.job_locations.name) : ''}" autocomplete="off" />
        <div id="seg-job-location-suggestions"></div>
      </div>

      <div class="field">
        <label for="seg-activity">Activity / job description</label>
        <textarea id="seg-activity" rows="2" placeholder="What did you work on?">${existing ? escapeHtml(existing.activity_description || '') : ''}</textarea>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="seg-time-in">Time in</label>
          <input id="seg-time-in" type="time" value="${existing && existing.time_in ? existing.time_in.slice(0,5) : ''}" />
        </div>
        <div class="field">
          <label for="seg-time-out">Time out</label>
          <input id="seg-time-out" type="time" value="${existing && existing.time_out ? existing.time_out.slice(0,5) : ''}" />
        </div>
      </div>

      <div class="field">
        <label for="seg-foreman-select">Foreman for this job</label>
        <select id="seg-foreman-select">
          <option value="">No foreman selected</option>
          ${(state.foremen || []).map(f => {
            const selectedForemanId = existing ? existing.foreman_id : currentDefaultForemanId();
            return `<option value="${f.id}" ${f.id === selectedForemanId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`;
          }).join('')}
        </select>
        <div class="screen-sub">Defaults to your assigned foreman. If you worked for someone else on this job, change it here.</div>
      </div>

      <div class="screen-sub">Taking a lunch or break? Log it as its own segment, the same way you'd log time at a job site - just pick (or add) a job location named "Lunch" or "Break".</div>

      <div id="seg-computed-hours" class="banner banner-ok" style="display:none;"></div>
      <div id="seg-dialog-error"></div>

      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="seg-dialog-cancel">Cancel</button>
        <button class="btn btn-primary" id="seg-dialog-save">${existing ? 'Save changes' : 'Add segment'}</button>
      </div>
      ${!existing ? `
        <button class="btn btn-ghost btn-sm" id="seg-dialog-save-another" style="margin-top:8px;">Save and add another segment</button>
      ` : ''}
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('seg-dialog-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  setupSegmentLocationAutocomplete();
  setupSegmentHoursPreview();

  document.getElementById('seg-dialog-save').addEventListener('click', () => saveSegment(date, existing, overlay, false));

  const saveAnotherBtn = document.getElementById('seg-dialog-save-another');
  if (saveAnotherBtn) {
    saveAnotherBtn.addEventListener('click', () => saveSegment(date, existing, overlay, true));
  }
}

function setupSegmentLocationAutocomplete() {
  const input = document.getElementById('seg-job-location-input');
  const suggestionsEl = document.getElementById('seg-job-location-suggestions');

  input.addEventListener('input', () => {
    selectedJobLocationId = null;
    const query = input.value.trim();
    if (!query) {
      suggestionsEl.innerHTML = '';
      return;
    }

    const matches = findLiveMatches(query, state.jobLocations, 5);
    if (matches.length === 0) {
      suggestionsEl.innerHTML = '';
      return;
    }

    suggestionsEl.innerHTML = `
      <div style="margin-top:6px; border:1px solid var(--line); border-radius:8px; overflow:hidden;">
        ${matches.map(m => `
          <div class="employee-row" style="padding:10px 12px; cursor:pointer;" data-loc-id="${m.id}" data-loc-name="${escapeHtml(m.name)}">
            <span>${escapeHtml(m.name)}</span>
            ${m.score < 1 ? `<span style="font-size:11px; color:var(--ink-soft);">possible match</span>` : ''}
          </div>
        `).join('')}
      </div>
    `;
    suggestionsEl.querySelectorAll('[data-loc-id]').forEach(el => {
      el.addEventListener('click', () => {
        input.value = el.getAttribute('data-loc-name');
        selectedJobLocationId = el.getAttribute('data-loc-id');
        suggestionsEl.innerHTML = '';
      });
    });
  });
}

function setupSegmentHoursPreview() {
  const update = () => {
    const timeIn = document.getElementById('seg-time-in').value;
    const timeOut = document.getElementById('seg-time-out').value;
    const el = document.getElementById('seg-computed-hours');
    if (!timeIn || !timeOut) {
      el.style.display = 'none';
      return;
    }
    const hours = computeHoursClientSide(timeIn, timeOut);
    el.style.display = 'block';
    el.textContent = `${hours.toFixed(2)} hours`;
  };
  document.getElementById('seg-time-in').addEventListener('input', update);
  document.getElementById('seg-time-out').addEventListener('input', update);
  update();
}

function computeHoursClientSide(timeIn, timeOut) {
  const [inH, inM] = timeIn.split(':').map(Number);
  const [outH, outM] = timeOut.split(':').map(Number);
  let diff = (outH * 60 + outM) - (inH * 60 + inM);
  if (diff < 0) diff += 24 * 60;
  return Math.max(0, diff / 60);
}

async function saveSegment(date, existing, overlay, keepOpen) {
  const saveBtn = document.getElementById('seg-dialog-save');
  const saveAnotherBtn = document.getElementById('seg-dialog-save-another');
  const clickedBtn = keepOpen ? saveAnotherBtn : saveBtn;
  const errorEl = document.getElementById('seg-dialog-error');
  errorEl.innerHTML = '';

  // Disable both buttons during the save, not just the one clicked, so a
  // double-tap on the other button can't fire a second concurrent save.
  saveBtn.disabled = true;
  if (saveAnotherBtn) saveAnotherBtn.disabled = true;
  clickedBtn.textContent = 'Saving...';

  function resetButtons() {
    saveBtn.disabled = false;
    saveBtn.textContent = existing ? 'Save changes' : 'Add segment';
    if (saveAnotherBtn) {
      saveAnotherBtn.disabled = false;
      saveAnotherBtn.textContent = 'Save and add another segment';
    }
  }

  try {
    const locationName = document.getElementById('seg-job-location-input').value.trim();
    const activityDescription = document.getElementById('seg-activity').value.trim();
    const timeIn = document.getElementById('seg-time-in').value;
    const timeOut = document.getElementById('seg-time-out').value;
    const foremanId = document.getElementById('seg-foreman-select').value || null;
    const entryDateField = document.getElementById('seg-entry-date');
    const entryDate = entryDateField ? entryDateField.value || undefined : undefined;

    if (!timeIn || !timeOut) {
      errorEl.innerHTML = errorHtml('Please enter both a time in and time out.');
      resetButtons();
      return;
    }

    let jobLocationId = selectedJobLocationId;

    if (locationName && !jobLocationId) {
      const locResult = await api('/job-locations', {
        method: 'POST',
        body: JSON.stringify({ companyId: state.activeCompanyId, name: locationName }),
      });

      if (locResult.needsConfirmation) {
        const confirmed = await showLocationConfirmDialog(locationName, locResult.suggestions);
        if (confirmed.cancelled) {
          // Abort the save entirely - re-enable the form so the employee
          // can change the job location text and try again, rather than
          // being forced into either "use this existing one" or "create
          // a new one" with no way out.
          resetButtons();
          return;
        } else if (confirmed.useExisting) {
          jobLocationId = confirmed.locationId;
        } else {
          const created = await api('/job-locations', {
            method: 'POST',
            body: JSON.stringify({ companyId: state.activeCompanyId, name: locationName, confirmNew: true }),
          });
          jobLocationId = created.location.id;
        }
      } else {
        jobLocationId = locResult.location.id;
      }
    }

    if (existing) {
      await api('/time-entries', {
        method: 'PUT',
        body: JSON.stringify({
          entryId: existing.id,
          companyId: state.activeCompanyId,
          jobLocationId,
          foremanId,
          activityDescription,
          timeIn,
          timeOut,
          entryDate,
        }),
      });
    } else {
      await api('/time-entries', {
        method: 'POST',
        body: JSON.stringify({
          companyId: state.activeCompanyId,
          employeeId: state.employee.id,
          entryDate: date,
          jobLocationId,
          foremanId,
          activityDescription,
          timeIn,
          timeOut,
          hoursType: 'regular',
        }),
      });
    }

    document.body.removeChild(overlay);

    if (keepOpen) {
      // Don't navigate back to the day-edit screen at all - go straight
      // into a fresh empty form for the next segment, since the whole
      // point is avoiding a round trip for someone logging several
      // segments in one sitting. Refresh state.jobLocations in case the
      // segment just saved created a brand new location, so it shows up
      // in the next segment's autocomplete immediately.
      let refreshedLocations = state.jobLocations;
      try {
        const locationsData = await api(withCompany('/job-locations'));
        refreshedLocations = locationsData.locations || [];
        state.jobLocations = refreshedLocations;
      } catch {
        // non-fatal - keep whatever locations were already loaded
      }

      // Build the "last entry" reference from what was just typed/saved,
      // rather than the API response (which doesn't include the joined
      // job location name) - this is simpler and avoids an extra lookup.
      const savedLocationName = refreshedLocations.find(l => l.id === jobLocationId)?.name || locationName || null;
      const justSavedSegment = {
        time_in: timeIn,
        time_out: timeOut,
        job_locations: savedLocationName ? { name: savedLocationName } : null,
      };

      showSegmentFormDialog(date, null, justSavedSegment);
    } else {
      renderDayEdit({ date });
    }
  } catch (err) {
    errorEl.innerHTML = errorHtml(err.message);
    resetButtons();
  }
}

function showLocationConfirmDialog(typedName, suggestions) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:101;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;">
        <div style="font-weight:700;margin-bottom:6px;">Is this the same job site?</div>
        <div style="font-size:13px;color:var(--ink-soft);margin-bottom:14px;">You typed "${escapeHtml(typedName)}". This looks similar to an existing location:</div>
        ${suggestions.map(s => `
          <div class="suggestion-option" data-use="${s.id}" style="cursor:pointer;">
            <span>${escapeHtml(s.name)}</span>
            <span style="font-size:11px;color:var(--ink-soft);">${s.score}% match</span>
          </div>
        `).join('')}
        <button class="btn btn-ghost" id="confirm-new-loc" style="margin-top:10px;">No, this is a new location</button>
        <button class="btn btn-ghost" id="cancel-loc-dialog" style="margin-top:8px;">Cancel - let me re-type it</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('[data-use]').forEach(el => {
      el.addEventListener('click', () => {
        document.body.removeChild(overlay);
        resolve({ useExisting: true, locationId: el.getAttribute('data-use') });
      });
    });
    overlay.querySelector('#confirm-new-loc').addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve({ useExisting: false });
    });
    overlay.querySelector('#cancel-loc-dialog').addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve({ cancelled: true });
    });
  });
}
