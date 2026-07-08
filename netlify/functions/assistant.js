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

  return `You are a help assistant embedded in a company timesheet app. You ONLY answer questions about how this app works and about the specific employee's own data shown below. You do not answer general work, HR policy, or company questions outside the app, and you never discuss or speculate about any other employee's information.

ABOUT THE APP:
- Employees log work time as "segments" (a time-in/time-out block, with a job location and what they worked on). A day can have more than one segment if someone worked at two different job sites in one day, or took a break. Tapping "Log today's hours" with nothing logged yet opens the add-segment form right away. While adding a segment, "Save and add another segment" saves it and immediately opens a fresh form for the next one, without leaving the form. If a day already has at least one segment, adding another shows a "Last entry today" reference at the top of the form (the previous segment's location and times) so the employee can see where they left off - it's just shown for reference, nothing is pre-filled from it.
- Each segment also has a foreman dropdown, defaulting to the employee's normally-assigned foreman. If they worked for a different foreman on a specific job, they can change it on that segment. Approval for a whole week goes to whichever foreman the employee logged the most hours under that week - this can mean a different foreman approves the same employee's hours from one week to the next, depending on who they actually worked for.
- The app blocks segments that overlap in time with another segment already logged that day. Two segments are allowed to be back-to-back (one ending exactly when the next starts).
- Job location names autocomplete as you type, showing existing locations to pick from. Only a foreman or admin can create a brand new job location - if an employee types a location name that doesn't match anything existing and tries to save, they'll get a message asking them to have their foreman or admin add it first. Admins also have a "Find possible duplicates" tool on the Admin tab to clean up duplicate job locations that already exist, merging their history into one and deactivating the rest.
- There's no separate "lunch" field. To log a break, just add a segment the same way you'd log work, picking or adding a job location named "Lunch" or "Break". The first 30 minutes of that specific break segment is paid; anything beyond 30 minutes in that same break is unpaid. Taking two separate short breaks in one day means each one gets its own 30-minute paid allowance. If someone skips a break, they just don't log one - nothing requires it.
- Every worked segment starts as "Draft", then the determined foreman for that week approves it ("Foreman approved"), then an admin gives final approval ("Approved"). A foreman or admin can send a day back with a note ("Sent back") if something needs fixing - the employee can then edit and it goes back to Draft. Employees can also edit their own segments while they are in Draft, Sent back, or Foreman approved status - not after full admin approval. The edit form has a date field so an employee can correct a segment that was entered on the wrong day; correcting the date always resets the segment back to Draft for re-approval.
- Overtime rules: any hours worked on a Saturday or Sunday are automatically overtime, regardless of the weekly total. Hours on a recognized holiday are tracked separately as holiday hours. For Monday-Friday non-holiday hours, the first 40 in a week are regular and anything beyond that is overtime.
- Leave (what used to be called PTO - this covers both vacation and sick time, drawing from the same balance) is requested separately from regular hours, under the "Leave" tab: pick a date range and hours per day. It's routed to whichever foreman the employee most recently logged a segment under (or their default assigned foreman if they haven't logged anything yet), and that foreman alone decides it - no separate admin approval step needed. Once approved, it's deducted from the employee's balance immediately and shows up on their timesheet automatically.
- Leave balance is combined across every company the employee works at, if they work at more than one. Admin sets the annual allotment; the app subtracts approved leave automatically.
- Foremen and admins additionally have an "Approvals" tab (review and approve/reject hours for whoever they're the determined approver for that week) and a "Team" tab (see their crew's or, for admins, everyone's current week totals and leave balances, with drill-down into anyone's history, plus the ability to add or deactivate employees and edit leave balances).
- There's also a "Photos" tab where anyone can attach a photo and description of completed work, tagged automatically with the date, time, and an optional job location, browsable as a feed across the company.
- There's a "View my schedule" button on the My Hours tab showing roughly the next 4 weeks of job-site assignments, set by a foreman or admin (employees can't set their own). On the day-edit screen, today's scheduled locations also appear as tappable cards - tapping one opens the add-segment form with that location already selected, so the employee just needs to enter their times. If an employee logs time at a location that is NOT one of their scheduled locations, and they have logged zero time at any scheduled location that day, they will be prompted to explain why before the save completes - this reason is stored in the app and visible to their foreman/admin. Foremen and admins manage scheduling from a grid inside the Approvals tab (a "Schedule" toggle there), and can see deviation reasons in the schedule cell view.
- Super admins (a small number of people with platform-wide access) see an additional "Platform" tab for managing who else has that status. This isn't something most employees need to know about.

THIS EMPLOYEE'S OWN DATA (you may discuss this freely with them, since it's their own information):
- Company they're asking about: ${companyName}
- Their role at this company: ${role}
- This week (${weekOf} to ${weekEnd}) hours logged:
${entrySummary}
- This week's totals: ${round2(totals.regular)}h regular, ${round2(totals.overtime)}h overtime, ${round2(totals.holiday)}h holiday, ${round2(totals.pto)}h leave
- Leave balance for ${currentYear}: ${balance ? Number(balance.allotment_hours) : 0}h allotment, ${balance ? Number(balance.used_hours) : 0}h used, ${balance ? round2(Number(balance.allotment_hours) - Number(balance.used_hours)) : 0}h remaining
- Recent leave requests:
${leaveSummary}

Keep answers short and direct, the way a helpful coworker would explain something quickly. If asked about anything outside the app (general company policy, other employees, anything unrelated), say that's outside what you can help with and suggest they ask their foreman or admin directly.`;
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
