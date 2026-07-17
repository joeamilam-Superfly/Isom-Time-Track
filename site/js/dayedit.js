async function renderDayEdit(opts) {
  const date = opts.date;
  const autoAdd = !!opts.autoAdd;

  root.innerHTML = `
    ${topbarHtml()}
    <main>
      <div class="screen-title">${formatDateLabel(date)}</div>
      <div class="screen-sub">${date === todayStr() ? "Today's hours" : 'Edit hours for this day'}</div>
      <div id="day-schedule-section"></div>
      <div id="day-wo-section"></div>
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
    state.todayScheduleEntries = scheduleData.entries || [];
    state.todayTimeEntries = entriesData.entries || [];
    state.currentDayDate = date;
    renderDaySchedule(scheduleData.entries || []);
    renderDaySegments(date, entriesData.entries || [], autoAdd);

    // Show work orders assigned to this employee for this date
    renderDayWorkOrders(date);
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

  // Separate OFF entries from real assignments - OFF entries are shown
  // as a non-tappable red banner, not a clickable "log time here" card.
  const offEntries = scheduleEntries.filter(e => e.job_locations?.name?.toUpperCase() === 'OFF');
  const workEntries = scheduleEntries.filter(e => e.job_locations?.name?.toUpperCase() !== 'OFF');

  const offBannerHtml = offEntries.length > 0 ? `
    <div style="background:#e53e3e; color:#fff; border-radius:8px; padding:10px 14px; margin-bottom:8px; font-weight:600;">
      OFF today
    </div>
  ` : '';

  const workCardsHtml = workEntries.map(e => {
    const loc = e.job_locations ? escapeHtml(e.job_locations.name) : 'No location set';
    const note = e.note ? ` &mdash; ${escapeHtml(e.note)}` : '';
    const deviationNote = e.deviation_reason ? `<div style="font-size:12px; color:var(--amber-dark); margin-top:4px;">Reason not attended: ${escapeHtml(e.deviation_reason)}</div>` : '';
    return `
      <div class="day-stub" data-schedule-entry="${e.id}" data-loc-id="${e.job_location_id || ''}" data-loc-name="${e.job_locations ? escapeHtml(e.job_locations.name) : ''}" style="cursor:pointer; margin-bottom:8px;">
        <div class="day-stub-perf" style="background:var(--amber);"></div>
        <div class="day-stub-body">
          <div class="day-stub-top">
            <div class="day-stub-date">${loc}${note}</div>
            <div style="font-size:12px; color:var(--ink-soft);">Tap to log time</div>
          </div>
          ${deviationNote}
        </div>
      </div>
    `;
  }).join('');

  if (!offBannerHtml && !workCardsHtml) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div style="margin-bottom:14px;">
      ${offBannerHtml ? offBannerHtml : `<div style="font-size:12px; text-transform:uppercase; letter-spacing:0.05em; color:var(--ink-soft); margin-bottom:6px;">Scheduled today &mdash; tap to log time</div>`}
      ${workCardsHtml}
    </div>
  `;

  // Only attach click handlers to work entries, not OFF entries
  el.querySelectorAll('[data-schedule-entry]').forEach(card => {
    card.addEventListener('click', () => {
      const locId = card.getAttribute('data-loc-id');
      const locName = card.getAttribute('data-loc-name');
      const date = root.querySelector('.screen-title') ? getCurrentDateFromScreen() : todayStr();
      showSegmentFormDialogWithLocation(date, locId, locName);
    });
  });
}

// Gets the current date being viewed from the day-edit screen's title
// element - needed since renderDaySchedule doesn't have direct access to
// the date variable from renderDayEdit's scope.
function getCurrentDateFromScreen() {
  // date is stored on state when the day-edit screen loads
  return state.currentDayDate || todayStr();
}

// Opens the segment form with a specific job location pre-selected,
// used when an employee taps a scheduled location card to log time
// against it directly, rather than having to find the location themselves.
function showSegmentFormDialogWithLocation(date, locId, locName) {
  selectedJobLocationId = locId || null;
  const latestSeg = findLatestSegment((state.todayTimeEntries || []).filter(e => e.hours_type !== 'pto'));
  const dialog = showSegmentFormDialog(date, null, latestSeg);
  // After the dialog opens, set both the input text AND fire the selection
  // so the form knows this is a valid existing location, not a new one
  setTimeout(() => {
    const input = document.getElementById('seg-job-location-input');
    if (input && locName) {
      _settingLocationProgrammatically = true;
      input.value = locName;
      input.dispatchEvent(new Event('input')); // update suggestions UI
      _settingLocationProgrammatically = false;
      // Re-assert the ID since the input event may have cleared it
      selectedJobLocationId = locId || null;
    }
  }, 50);
  return dialog;
}

let selectedJobLocationId = null;
let _settingLocationProgrammatically = false;

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

      <div class="field" id="seg-wo-field" style="display:none;">
        <label for="seg-wo-select">Associate with work order (optional)</label>
        <select id="seg-wo-select">
          <option value="">No work order</option>
        </select>
        <div class="screen-sub">Link this time segment to a specific work order for billing purposes.</div>
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

  // Load work orders assigned to this employee for the WO association dropdown
  api(withCompany('/work-orders?status=open')).then(data => {
    const myWos = (data.workOrders || []).filter(wo =>
      wo.assignedTo?.id === state.employee.id || currentCompanyRole() !== 'employee'
    );
    const woField = document.getElementById('seg-wo-field');
    const woSel = document.getElementById('seg-wo-select');
    if (myWos.length > 0 && woField && woSel) {
      woField.style.display = 'block';
      myWos.forEach(wo => {
        const opt = document.createElement('option');
        opt.value = wo.id;
        opt.textContent = `WO# ${wo.woNumber}${wo.jobLocation ? ' — ' + wo.jobLocation.name : ''}`;
        if (existing?.work_order_id === wo.id) opt.selected = true;
        woSel.appendChild(opt);
      });
    }
  }).catch(() => {});

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
    if (_settingLocationProgrammatically) return;
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
    const workOrderId = document.getElementById('seg-wo-select')?.value || null;
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
          workOrderId,
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
          workOrderId,
        }),
      });
    }

    document.body.removeChild(overlay);

    // After a successful save, check whether a deviation reason is needed:
    // if the employee has scheduled locations today, and NONE of those
    // locations have any time logged against them (including what was just
    // saved), and the segment just saved was at a DIFFERENT location than
    // any scheduled one. If all three conditions are true, prompt for a
    // reason before proceeding - this is a blocking prompt per explicit
    // design decision.
    const scheduleEntries = state.todayScheduleEntries || [];
    // Only check deviation against real work assignments, not OFF entries
    const workScheduleEntries = scheduleEntries.filter(e => e.job_locations?.name?.toUpperCase() !== 'OFF');
    if (workScheduleEntries.length > 0 && jobLocationId) {
      const scheduledLocationIds = new Set(
        workScheduleEntries.map(e => e.job_location_id).filter(Boolean)
      );
      const savedAtScheduledLocation = scheduledLocationIds.has(jobLocationId);

      if (!savedAtScheduledLocation) {
        // Fetch fresh time entries to check if any scheduled location
        // now has time logged against it (including this just-saved one)
        try {
          const freshEntries = await api(withCompany(
            `/time-entries?employeeId=${state.employee.id}&startDate=${state.currentDayDate}&endDate=${state.currentDayDate}`
          ));
          const loggedLocationIds = new Set(
            (freshEntries.entries || []).map(e => e.job_location_id).filter(Boolean)
          );
          const anyScheduledLocationLogged = [...scheduledLocationIds].some(id => loggedLocationIds.has(id));

          if (!anyScheduledLocationLogged) {
            // Need a reason - find the work schedule entries that weren't attended
            const unattendedEntries = workScheduleEntries.filter(
              e => e.job_location_id && !loggedLocationIds.has(e.job_location_id) && !e.deviation_reason
            );
            if (unattendedEntries.length > 0) {
              const reason = await showDeviationReasonPrompt(unattendedEntries);
              if (reason) {
                // Store the reason on each unattended schedule entry
                await Promise.all(unattendedEntries.map(e =>
                  api('/schedule', {
                    method: 'PATCH',
                    body: JSON.stringify({
                      companyId: state.activeCompanyId,
                      scheduleEntryId: e.id,
                      deviationReason: reason,
                    }),
                  })
                ));
              }
            }
          }
        } catch (err) {
          // Non-fatal - don't block the save if the deviation check itself fails
          console.error('Deviation check failed:', err);
        }
      }
    }

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

// Blocking prompt that asks the employee why they didn't go to their
// scheduled location. Returns a Promise that resolves to the reason
// string once they submit, or null if they somehow dismiss it.
// Per explicit design decision this is blocking - the reason must be
// entered before the save flow completes and the screen refreshes.
function showDeviationReasonPrompt(unattendedEntries) {
  return new Promise((resolve) => {
    const locationNames = unattendedEntries
      .map(e => e.job_locations ? escapeHtml(e.job_locations.name) : 'scheduled location')
      .join(', ');

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.7);display:flex;align-items:center;justify-content:center;z-index:200;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;">
        <div style="font-weight:700;font-size:17px;margin-bottom:6px;">You weren't at your scheduled location</div>
        <div class="screen-sub" style="margin-bottom:14px;">
          You were scheduled at <strong>${locationNames}</strong> but logged time elsewhere.
          Please explain why before continuing.
        </div>
        <div class="field">
          <label for="deviation-reason-input">Reason</label>
          <textarea id="deviation-reason-input" rows="3" placeholder="e.g. Job was cancelled, sent to a different site by supervisor..."></textarea>
        </div>
        <div id="deviation-reason-error"></div>
        <button class="btn btn-primary" id="deviation-reason-submit" style="margin-top:8px; width:100%;">Submit reason</button>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('deviation-reason-submit').addEventListener('click', () => {
      const reason = document.getElementById('deviation-reason-input').value.trim();
      const errorEl = document.getElementById('deviation-reason-error');
      if (!reason) {
        errorEl.innerHTML = errorHtml('Please enter a reason before continuing.');
        return;
      }
      document.body.removeChild(overlay);
      resolve(reason);
    });
  });
}

// Shows work orders assigned to this employee that are scheduled for
// this date, so a tech can see the WO details and mark it complete
// directly from their day view without navigating to the Schedule tab.
async function renderDayWorkOrders(date) {
  const el = document.getElementById('day-wo-section');
  if (!el) return;

  try {
    // Fetch open WOs assigned to this employee for today
    const [openData, closedData] = await Promise.all([
      api(withCompany('/work-orders?status=open')),
      api(withCompany('/work-orders?includeCompleted=true')),
    ]);

    const myOpenWos = (openData.workOrders || []).filter(wo =>
      wo.scheduledDate === date &&
      (wo.assignedTo?.id === state.employee.id ||
       (wo.crew || []).some(c => c.id === state.employee.id))
    );

    // Closed WOs where this employee is primary or crew — shown for additional time logging
    const myClosedWos = (closedData.workOrders || []).filter(wo =>
      wo.status !== 'open' &&
      (wo.assignedTo?.id === state.employee.id ||
       (wo.crew || []).some(c => c.id === state.employee.id))
    );

    if (myOpenWos.length === 0 && myClosedWos.length === 0) { el.innerHTML = ''; return; }

    let html = '';

    if (myOpenWos.length > 0) {
      html += `
        <div style="margin-bottom:14px;">
          <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.05em; color:var(--ink-soft); margin-bottom:6px;">Work orders for today</div>
          ${myOpenWos.map(wo => `
            <div class="day-stub" style="margin-bottom:8px; cursor:pointer;" data-wo-day-view="${wo.id}">
              <div class="day-stub-perf" style="background:#16a34a;"></div>
              <div class="day-stub-body">
                <div class="day-stub-top">
                  <div class="day-stub-date">WO# ${escapeHtml(wo.woNumber)}</div>
                  <div style="font-size:12px; color:#16a34a; font-weight:600;">Open</div>
                </div>
                ${wo.jobLocation ? `<div class="day-stub-meta"><span>${escapeHtml(wo.jobLocation.name)}</span></div>` : ''}
                ${wo.details ? `<div style="font-size:11px; color:var(--ink); margin-top:4px; white-space:pre-line; background:var(--paper-dim); border-radius:4px; padding:6px 8px;">${escapeHtml(wo.details)}</div>` : ''}
                <div style="font-size:12px; color:var(--ink-soft); margin-top:4px;">Tap to view work order &rarr;</div>
              </div>
            </div>`).join('')}
        </div>`;
    }

    if (myClosedWos.length > 0) {
      html += `
        <div style="margin-bottom:14px;">
          <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.05em; color:var(--ink-soft); margin-bottom:6px;">Closed work orders — tap to log time</div>
          ${myClosedWos.map(wo => `
            <div class="day-stub" style="margin-bottom:8px; cursor:pointer; opacity:0.8;" data-wo-day-view="${wo.id}">
              <div class="day-stub-perf" style="background:var(--ink-soft);"></div>
              <div class="day-stub-body">
                <div class="day-stub-top">
                  <div class="day-stub-date">WO# ${escapeHtml(wo.woNumber)}</div>
                  <div style="font-size:12px; color:var(--ink-soft); font-weight:600;">${wo.status === 'ready_to_bill' ? 'Ready to bill' : 'Billed'}</div>
                </div>
                ${wo.jobLocation ? `<div class="day-stub-meta"><span>${escapeHtml(wo.jobLocation.name)}</span></div>` : ''}
                <div style="font-size:12px; color:var(--ink-soft); margin-top:4px;">Tap to log additional time &rarr;</div>
              </div>
            </div>`).join('')}
        </div>`;
    }

    el.innerHTML = html;

    const allWos = [...myOpenWos, ...myClosedWos];
    el.querySelectorAll('[data-wo-day-view]').forEach(card => {
      card.addEventListener('click', () => {
        const woId = card.getAttribute('data-wo-day-view');
        showWorkOrderDetail(woId, allWos);
      });
    });
  } catch (err) {
    console.error('Could not load day work orders:', err);
    el.innerHTML = '';
  }
}
