// ISOM Electric / Multi-Company Timesheet — frontend app logic.
// Plain JS, no framework, single-page app with manual view rendering.
// This keeps the deploy simple (static files + Netlify Functions, no build step).

const API_BASE = '/api';

const state = {
  token: localStorage.getItem('isom_token') || null,
  employee: JSON.parse(localStorage.getItem('isom_employee') || 'null'),
  companies: JSON.parse(localStorage.getItem('isom_companies') || '[]'), // [{id, name, role}]
  activeCompanyId: localStorage.getItem('isom_active_company') || null,
  currentWeekOf: null, // YYYY-MM-DD of the Sunday for the week being viewed
  jobLocations: [],
  foremen: [],
  lastPeopleList: [],
  pendingLeaveRequestCount: 0, // count of leave requests assigned to this user awaiting decision // [{id, name, role}] - every foreman/admin at the active company
  weekEntries: {}, // date -> entry
  pendingLocationConfirm: null,
  view: 'loading',
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function sundayOf(dateStr) {
  // Kept as sundayOf for compatibility but now respects the active
  // company's week start day (0=Sunday, 1=Monday).
  const d = new Date(dateStr + 'T00:00:00');
  const startDay = activeWeekStartDay();
  const day = d.getDay();
  // Roll back to the configured start day
  const diff = (day - startDay + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatWeekRange(sunday) {
  const sat = addDaysStr(sunday, 6);
  const s = new Date(sunday + 'T00:00:00');
  const e = new Date(sat + 'T00:00:00');
  const sameMonth = s.getMonth() === e.getMonth();
  const startLabel = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endLabel = sameMonth
    ? e.toLocaleDateString('en-US', { day: 'numeric' })
    : e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${startLabel} - ${endLabel}`;
}

// Returns the {id, name, role} object for whichever company is currently
// active, or null if none is set yet (shouldn't happen post-login, since
// boot() always picks one, but defensive nonetheless).
function activeCompany() {
  return state.companies.find(c => c.id === state.activeCompanyId) || null;
}

// Returns the configured week start day for the active company.
// 0 = Sunday (default, Isom Electric), 1 = Monday (South Pointe).
function activeWeekStartDay() {
  const c = activeCompany();
  return c ? (c.weekStartDay || 0) : 0;
}

// Convenience: the caller's role at the currently active company.
// Returns 'employee' as a safe default if something's inconsistent,
// since that's the most restrictive role.
function currentCompanyRole() {
  const c = activeCompany();
  return c ? c.role : 'employee';
}

// The employee's permanently-assigned default foreman at the active
// company, used to pre-select the foreman dropdown on a new segment.
// Returns null if they have none set.
function currentDefaultForemanId() {
  const c = activeCompany();
  return c ? (c.defaultForemanId || null) : null;
}

async function api(path, options = {}, _retryCount = 0) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let data;
  try {
    data = await resp.json();
  } catch {
    data = {};
  }

  if (!resp.ok) {
    // 502/503/504 are transient server errors - retry once after a short
    // delay before surfacing the error to the user, since these are almost
    // always momentary Netlify or Supabase hiccups that succeed on retry.
    if ((resp.status === 502 || resp.status === 503 || resp.status === 504) && _retryCount < 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      return api(path, options, _retryCount + 1);
    }
    const friendlyMessage = resp.status === 502 || resp.status === 503 || resp.status === 504
      ? 'The server took too long to respond. Please try again.'
      : data.error || `Request failed (${resp.status})`;
    throw new Error(friendlyMessage);
  }
  return data;
}

// Appends companyId as a query param. Use this for every GET call so we
// never forget to scope a request to the active company.
function withCompany(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}companyId=${state.activeCompanyId}`;
}

function saveSession(token, employee, companies) {
  state.token = token;
  state.employee = employee;
  state.companies = companies;
  state.activeCompanyId = companies.length > 0 ? companies[0].id : null;
  localStorage.setItem('isom_token', token);
  localStorage.setItem('isom_employee', JSON.stringify(employee));
  localStorage.setItem('isom_companies', JSON.stringify(companies));
  if (state.activeCompanyId) localStorage.setItem('isom_active_company', state.activeCompanyId);
}

function setActiveCompany(companyId) {
  state.activeCompanyId = companyId;
  localStorage.setItem('isom_active_company', companyId);
}

function clearSession() {
  state.token = null;
  state.employee = null;
  state.companies = [];
  state.activeCompanyId = null;
  localStorage.removeItem('isom_token');
  localStorage.removeItem('isom_employee');
  localStorage.removeItem('isom_companies');
  localStorage.removeItem('isom_active_company');
}

function logout() {
  clearSession();
  render('login');
}

// ---------- Root render dispatch ----------

const root = document.getElementById('app');

function render(view, opts) {
  state.view = view;
  if (view === 'login') return renderLogin();
  if (view === 'week') return renderWeek(opts || {});
  if (view === 'dayEdit') return renderDayEdit(opts || {});
  if (view === 'approvals') return renderApprovals(opts || {});
  if (view === 'approvalDetail') return renderApprovalDetail(opts || {});
  if (view === 'admin') return renderAdmin(opts || {});
  if (view === 'timeoff') return renderTimeOff(opts || {});
  if (view === 'team') return renderTeam(opts || {});
  if (view === 'reports') return renderReports(opts || {});
  if (view === 'platform') return renderPlatform(opts || {});
  if (view === 'photolog') return renderPhotoLog(opts || {});
}

// ---------- Boot ----------
// Deferred until DOMContentLoaded so every script tag (login.js, week.js,
// etc.) has finished loading and defining its render functions before boot()
// tries to call them. Without this, boot() running immediately at the end
// of this file's own execution would fire before later <script> tags have
// even started loading, causing a ReferenceError on renderLogin/etc.
function boot() {
  if (state.token && state.employee && state.companies.length > 0) {
    if (!state.activeCompanyId || !activeCompany()) {
      state.activeCompanyId = state.companies[0].id;
    }
    state.currentWeekOf = sundayOf(todayStr());
    render('week');
  } else {
    render('login');
  }
}

window.addEventListener('DOMContentLoaded', boot);

// ---- Broadcast message modal ----
// Called after each render. Shows unread messages as a modal the employee
// must acknowledge before using the app.
async function checkBroadcastMessages() {
  if (!state.token || !state.employee || !state.activeCompanyId) return;
  if (state.view === 'login') return;

  try {
    const data = await api(withCompany('/broadcast-messages?unread=true'));
    const messages = data.messages || [];
    if (messages.length === 0) return;

    // Show first unread message — once dismissed check for the next
    const msg = messages[0];
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.7);display:flex;align-items:center;justify-content:center;z-index:200;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;width:100%;max-width:420px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <span style="font-size:24px;">📢</span>
          <div style="font-weight:700;font-size:17px;">${msg.title ? escapeHtml(msg.title) : 'Message from management'}</div>
        </div>
        <div style="font-size:14px;line-height:1.6;white-space:pre-line;background:var(--paper-dim);border-radius:8px;padding:12px 14px;margin-bottom:16px;">${escapeHtml(msg.message)}</div>
        <button class="btn btn-primary" id="msg-acknowledge" style="width:100%;">Got it</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#msg-acknowledge').addEventListener('click', async () => {
      document.body.removeChild(overlay);
      // Mark as read
      await api(`/broadcast-messages?action=mark_read`, {
        method: 'POST',
        body: JSON.stringify({ companyId: state.activeCompanyId, messageId: msg.id }),
      }).catch(() => {});
      // Check if there are more unread messages
      if (messages.length > 1) checkBroadcastMessages();
    });
  } catch (err) {
    // Silently fail — don't block the app if messages can't load
  }
}
// When user returns to the tab after 5+ minutes away, silently refresh
// the current view — but only if no dialog/overlay is open.
let lastActiveTime = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    lastActiveTime = Date.now();
  } else {
    const awayMs = Date.now() - lastActiveTime;
    const fiveMinutes = 5 * 60 * 1000;
    if (awayMs >= fiveMinutes && state.token && state.view && state.view !== 'login') {
      // Only refresh if no overlay/dialog is open
      const overlays = document.querySelectorAll('[style*="position:fixed"]');
      if (overlays.length <= 1) { // 1 = the topbar itself may be fixed
        render(state.view);
      }
    }
  }
});

// ---- Pull to refresh (mobile) ----
// Swipe down from top of page triggers a refresh.
// Guarded against dialogs and mid-scroll pulls.
(function initPullToRefresh() {
  let startY = 0;
  let isPulling = false;
  let indicator = null;

  function isDialogOpen() {
    return document.querySelectorAll('[style*="position:fixed"]').length > 1;
  }

  document.addEventListener('touchstart', (e) => {
    if (isDialogOpen()) return;
    if (window.scrollY === 0) {
      startY = e.touches[0].clientY;
      isPulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!isPulling || isDialogOpen()) return;
    const pullDistance = e.touches[0].clientY - startY;
    if (pullDistance > 10 && pullDistance < 80) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;text-align:center;padding:8px;font-size:13px;color:#C47C1E;background:rgba(255,255,255,0.95);transition:opacity 0.2s;';
        indicator.textContent = '↓ Pull to refresh';
        document.body.appendChild(indicator);
      }
      indicator.textContent = pullDistance > 55 ? '↑ Release to refresh' : '↓ Pull to refresh';
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!isPulling || isDialogOpen()) { isPulling = false; return; }
    const pullDistance = e.changedTouches[0].clientY - startY;
    if (indicator) { document.body.removeChild(indicator); indicator = null; }
    isPulling = false;
    if (pullDistance > 55 && state.token && state.view && state.view !== 'login') {
      render(state.view);
    }
  });
})();
