// Runs daily at midnight ET. Clears read records for recurring messages
// so they show again to employees on the next app load.
const { supabase } = require('./_company-role');

exports.handler = async (event) => {
  const now = new Date();
  const etHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false
  }).format(now));

  const forceRun = event?.queryStringParameters?.force === 'true';
  if (etHour !== 0 && !forceRun) {
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: `ET hour is ${etHour}, not 0` }) };
  }

  // Get all active recurring message IDs
  const { data: recurring } = await supabase
    .from('broadcast_messages')
    .select('id')
    .eq('is_recurring', true)
    .eq('active', true);

  if (!recurring || recurring.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ cleared: 0 }) };
  }

  const ids = recurring.map(m => m.id);

  // Delete read records so messages show again today
  const { error } = await supabase
    .from('broadcast_message_reads')
    .delete()
    .in('message_id', ids);

  if (error) {
    console.error('Error clearing recurring reads:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ cleared: ids.length }) };
};

exports.config = { schedule: '0 * * * *' };
