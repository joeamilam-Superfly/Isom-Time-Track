// Runs hourly. Finds WOs self-assigned from the queue 24+ hours ago
// with no hours logged against them, and returns them to the queue.

const { supabase } = require('./_company-role');

exports.handler = async (event) => {
  const forceRun = event?.queryStringParameters?.force === 'true';
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Find self-assigned WOs with self_assigned_at > 24h ago, status=open,
  // and no time entries logged against them
  const { data: staleWos, error } = await supabase
    .from('work_orders')
    .select('id, wo_number, company_id, assigned_to_id, self_assigned_at')
    .not('self_assigned_at', 'is', null)
    .lte('self_assigned_at', cutoff)
    .eq('status', 'open');

  if (error) {
    console.error('Queue return error fetching WOs:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  let returned = 0;
  let skipped = 0;

  for (const wo of staleWos || []) {
    // Check if any time has been logged against this WO
    const { count } = await supabase
      .from('time_entries')
      .select('id', { count: 'exact', head: true })
      .eq('work_order_id', wo.id);

    if (count > 0) {
      // Hours logged — keep assigned
      console.log(`WO ${wo.wo_number}: has ${count} time entries, keeping assigned`);
      skipped++;
      continue;
    }

    // No hours — return to queue
    const { error: updateError } = await supabase
      .from('work_orders')
      .update({
        assigned_to_id: null,
        self_assigned_at: null,
        queue_visible: true,
        updated_at: now.toISOString(),
      })
      .eq('id', wo.id);

    if (updateError) {
      console.error(`WO ${wo.wo_number}: return failed:`, updateError);
      skipped++;
    } else {
      console.log(`WO ${wo.wo_number}: returned to queue after 24h with no hours`);
      returned++;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ date: now.toISOString().slice(0, 10), returned, skipped }),
  };
};

exports.config = {
  schedule: '0 * * * *',
};
