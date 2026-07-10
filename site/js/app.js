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
  pendingLeaveRequestCount: 0, // count of leave requests assigned to this user awaiting decision // [{id, name, role}] - every foreman/admin at the active company
  weekEntries: {}, // date -> entry
  pendingLocationConfirm: null,
  view: 'loading',
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function sundayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay());
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

async function api(path, options = {}) {
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
    throw new Error(data.error || `Request failed (${resp.status})`);
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
