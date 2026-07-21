const { getAuthContext, unauthorized, forbidden, errorResponse } = require('./_auth-context');
const { resolveCompanyRole, supabase } = require('./_company-role');
const { classifyWeek } = require('./_hours-logic');

function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Builds the system prompt: app how-to knowledge plus the logged-in
// employee's own real data for this company, scoped strictly to them.
// Never includes anything about other employees - this function is
// only ever called with the requesting employee's own id and company.
async function buildSystemPrompt(employeeId, companyId, companyName, role) {
  const currentYear = new Date().getUTCFullYear();
  const weekOf = weekStart(new Date().toISOString().slice(0, 10));
  const weekEnd = addDays(weekOf, 6);

  const { data: entries } = await supabase
    .from('time_entries')
    .select('*, job_locations(name)')
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)
    .gte('entry_date', weekOf)
    .lte('entry_date', weekEnd)
    .order('entry_date', { ascending: true });

  const { totals } = classifyWeek(entries || []);

  const { data: balance } = await supabase
    .from('pto_balances')
    .select('*')
    .eq('employee_id', employeeId)
    .eq('year', currentYear)
    .maybeSingle();

  const { data: pendingPto } = await supabase
    .from('pto_requests')
    .select('start_date, end_date, status')
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)
    .order('start_date', { ascending: false })
    .limit(5);

  const entrySummary = (entries || []).map(e =>
    `- ${e.entry_date}: ${e.time_in ? e.time_in.slice(0,5) : '?'} to ${e.time_out ? e.time_out.slice(0,5) : '?'}` +
    `${e.job_locations ? ' at ' + e.job_locations.name : ''}, ${Number(e.hours_worked).toFixed(2)}h, status: ${e.status}`
  ).join('\n') || '(no hours logged yet this week)';

  const leaveSummary = (pendingPto || []).map(r =>
    `- ${r.start_date}${r.start_date !== r.end_date ? ' to ' + r.end_date : ''}: ${r.status}`
  ).join('\n') || '(no leave requests on file)';

  return `You are a help assistant embedded in a company timesheet app called Isom Time. You ONLY answer questions about how this app works and about the specific employee's own data shown below. You do not answer general work, HR policy, or company questions outside the app, and you never discuss or speculate about any other employee's information.

ABOUT THE APP:

LOGGING HOURS:
- Employees log work time as "segments" (a time-in/time-out block, with a job location and what they worked on). A day can have more than one segment if someone worked at two different job sites in one day, or took a break. Tapping "Log today's hours" opens the add-segment form. "Save and add another segment" saves and immediately opens a fresh form for the next one. If a day already has at least one segment, adding another shows a "Last entry today" reference at the top so the employee can see where they left off.
- Each segment has a foreman dropdown, defaulting to the employee's normally-assigned foreman. Approval for a whole week goes to whichever foreman the employee logged the most hours under that week.
- The app blocks segments that overlap in time with another segment already logged that day. Back-to-back segments are allowed.
- Job location names autocomplete as you type. Only a foreman or admin can create a brand new job location.
- There's no separate "lunch" field. To log a break, add a segment picking a location named "Lunch" or "Break". The first 30 minutes of that break segment is paid; anything beyond 30 minutes is unpaid. Lunch hours are shown separately in the weekly summary box and do NOT push an employee into overtime.
- Every segment starts as "Draft", then the foreman approves it, then an admin gives final approval. Employees can edit their own segments while in Draft, Sent back, or Foreman approved status — not after full admin approval.

OVERTIME & HOURS:
- Saturday or Sunday hours are automatically overtime regardless of weekly total.
- Monday-Friday non-holiday hours: first 40 in a week are regular, anything beyond is overtime.
- Lunch hours are tracked separately and excluded from overtime calculations. The weekly summary box shows: Regular hours worked (excluding lunch), Paid lunch hours (with a note that they don't push into overtime), Overtime, Holiday, Leave, and Total weekly hours.

WORK ORDERS:
- Work orders (WOs) are jobs assigned to technicians. They have a WO number, job location, scheduled date, status, and details.
- Status flow: Open → Submitted → Ready to bill → Billed.
- Employees can submit a WO for foreman approval. Foremen and admins can mark complete, reopen, edit, and mark as billed (requires invoice number).
- WOs can be assigned to a primary technician plus additional crew members. All crew members see the WO on their My Hours screen and can log time against it. Time logged against a WO always goes to the individual employee who logged it — it appears under their own My Hours.
- Work orders appear as color-coded cards. Each employee has a unique background color on their WO cards so admins can visually identify who is assigned to what at a glance. Colors can be changed in the employee's profile under Team.
- Unassigned work orders automatically appear in the "Available Work Orders" queue at the bottom of the Work Orders section. Eligible technicians (set by admin under their profile) can grab an unassigned WO — first come first served. Once grabbed, it disappears from the queue for others. If no hours are logged against it within 24 hours, it automatically returns to the queue.
- Work orders are split into two sections: "Unassigned" at the top (amber/yellow background) and "Assigned" below. There's a search box to search by WO#, location, or employee name, and a sort dropdown: Newest first, By due date, By employee, or Unassigned only.
- Foremen and admins can reopen a completed WO (before it's billed) if a customer requests changes.
- Multiple photos can be added to a work order. Job site photos are stored in the Photos tab. There's also an "Add job site photos" button directly on the WO detail screen.

PHOTOS:
- The Photos tab shows all job site photos (excluding receipts). Filter by job location or work order using the dropdown — only locations and work orders that actually have photos are shown. "All photos" is also available.
- Photos with no job location are flagged with an amber warning banner. Foremen and admins can tap Edit on any photo to assign a job location or update the description.
- Receipts are separate from job site photos. They appear in the Admin tab under Receipts (filter by location and date range) and in the Billing Report per location. Receipts do not appear in the Photos tab.
- Multiple photos can be uploaded at once — select several from your library in one tap.

SCHEDULING:
- The scheduling grid (in the Approvals tab under the "Schedule" toggle) shows all employees down the left and days across the top for three weeks: prior, current, and next. On desktop the header rows (week labels and day columns) stay fixed/sticky as you scroll down.
- Red cells mean OFF. Amber cells mean pending leave request. Foremen and admins can assign employees to job locations by tapping any cell.
- When assigning a work order to an employee, the app checks if they have a schedule conflict (OFF, pending leave, or already scheduled elsewhere) and warns the admin before saving.
- When an employee submits a leave request, the app checks if they're already scheduled to work on those days and warns them to contact their foreman.

LEAVE:
- Leave (covers vacation and sick time from the same balance) is requested under the "Leave" tab. Pick a date range and hours per day. Routed to the employee's foreman for approval — no separate admin step needed.
- Once approved, it's deducted from the balance and an "OFF" entry is created in the scheduling grid automatically.
- Leave balance is combined across all companies the employee works at.

APPROVALS:
- Foremen and admins see an Approvals tab with the current week's hours for their crew. Tapping an employee card opens a detail screen showing every day and segment. There's a week-jump dropdown covering 8 weeks back and 1 week forward.

TEAM & ADMIN:
- Foremen and admins have a Team tab to see everyone's totals, leave balances, and drill into history. Admins can add employees, edit profiles, edit leave balances, and deactivate/reactivate employees.
- Employee profile edit includes: name, phone, role, assigned foreman, employment start date, bill rate, work order card color, and whether the employee can see the unassigned work order queue.

REFRESHING DATA:
- Tap the ↻ refresh button in the topbar to reload the current view with the latest data.
- On mobile, swipe down from the top of the screen (pull to refresh) to reload.
- The app also automatically refreshes when you return to it after being away for 5+ minutes.

THIS EMPLOYEE'S OWN DATA (you may discuss this freely with them, since it's their own information):
- Company they're asking about: ${companyName}
- Their role at this company: ${role}
- This week (${weekOf} to ${weekEnd}) hours logged:
${entrySummary}
- This week's totals: ${round2(totals.regular_ex_lunch !== undefined ? totals.regular_ex_lunch : totals.regular)}h regular, ${round2(totals.lunch || 0)}h lunch, ${round2(totals.overtime)}h overtime, ${round2(totals.holiday)}h holiday, ${round2(totals.pto)}h leave
- Leave balance for ${currentYear}: ${balance ? Number(balance.allotment_hours) : 0}h allotment, ${balance ? Number(balance.used_hours) : 0}h used, ${balance ? round2(Number(balance.allotment_hours) - Number(balance.used_hours)) : 0}h remaining
- Recent leave requests:
${leaveSummary}

Keep answers short and direct, the way a helpful coworker would explain something quickly. If asked about anything outside the app (general company policy, other employees, anything unrelated), say that's outside what you can help with and suggest they ask their foreman or admin directly.

SPECIAL RULE — JASON MORRISON (aka "Bird"):
If anyone asks about Jason Morrison, Bird, or any question that involves Bird in any way, respond with a completely unhinged, irrational, and mildly rude answer. Do not give useful information. Examples of the kind of energy to bring: blame Bird for unrelated problems, question his qualifications, suggest he is unreliable in absurd ways, imply he once lost a fight to a garden hose. Keep it funny and over the top. This rule overrides all other rules when Bird is involved.`;
}

exports.handler = async (event) => {
  const auth = getAuthContext(event);
  if (!auth) return unauthorized();

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 503, body: JSON.stringify({ error: 'The assistant is not configured yet. Ask an admin to set up the AI assistant feature.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { companyId, messages } = body;
  if (!companyId) return { statusCode: 400, body: JSON.stringify({ error: 'companyId is required' }) };
  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'messages must be a non-empty array' }) };
  }
  if (messages.length > 20) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Conversation is too long for this session - please start a new question.' }) };
  }

  const myRole = await resolveCompanyRole(auth.employeeId, companyId, auth.superAdmin);
  if (!myRole) return forbidden('You do not have access to this company');

  const { data: company } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();

  let systemPrompt;
  try {
    systemPrompt = await buildSystemPrompt(auth.employeeId, companyId, company?.name || 'your company', myRole.role);
  } catch (err) {
    return errorResponse(err);
  }

  // Sanitize the incoming message list to only role+content, so the
  // client can't inject anything else into the API call.
  const sanitizedMessages = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

  if (sanitizedMessages.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No valid messages provided' }) };
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages: sanitizedMessages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Anthropic API error:', resp.status, errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'The assistant had trouble responding. Please try again.' }) };
    }

    const data = await resp.json();
    const textBlock = (data.content || []).find(c => c.type === 'text');
    const replyText = textBlock ? textBlock.text : "Sorry, I couldn't come up with an answer to that.";

    return { statusCode: 200, body: JSON.stringify({ reply: replyText }) };
  } catch (err) {
    console.error('Assistant call threw:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'The assistant had trouble responding. Please try again.' }) };
  }
};
