// Lunch auto-add is now handled in real time by time-entries.js
// (autoAddLunchIfNeeded) whenever an employee saves a time entry
// that crosses the 8-hour threshold. This scheduled function is
// intentionally disabled to prevent any possibility of duplicate
// lunch entries being created.

exports.handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({ skipped: true, reason: 'Lunch auto-add handled in real time by time-entries.js' }),
  };
};

exports.config = {
  schedule: '0 5 * * *',
};
