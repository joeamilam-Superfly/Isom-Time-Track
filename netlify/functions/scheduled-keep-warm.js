// Pings the most frequently called functions every 5 minutes
// to prevent cold starts on Netlify Pro.
// Uses a lightweight OPTIONS/HEAD check rather than a full authenticated call.

const FUNCTIONS = [
  'dashboard',
  'weekly-summary',
  'work-orders',
  'time-entries',
  'job-locations',
  'broadcast-messages',
];

const BASE_URL = 'https://isomtime.netlify.app/.netlify/functions';

exports.handler = async () => {
  const results = await Promise.allSettled(
    FUNCTIONS.map(fn =>
      fetch(`${BASE_URL}/${fn}`, { method: 'GET' })
        .then(r => ({ fn, status: r.status }))
        .catch(err => ({ fn, error: err.message }))
    )
  );

  const summary = results.map(r => r.value || r.reason);
  console.log('Keep-warm ping results:', JSON.stringify(summary));

  return {
    statusCode: 200,
    body: JSON.stringify({ pinged: FUNCTIONS.length, results: summary }),
  };
};

exports.config = {
  schedule: '*/5 * * * *', // every 5 minutes
};
