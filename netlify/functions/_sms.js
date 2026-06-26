// Shared Twilio SMS sender. Stubs and logs instead of sending when no
// credentials are configured, so nothing breaks before Twilio is set up
// - same pattern used by the original scheduled-reminders.js feature.
async function sendSms(toPhone, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !fromNumber) {
    console.log(`[SMS STUB - no Twilio credentials configured] Would send to ${toPhone}: "${message}"`);
    return { ok: false, status: 'skipped_no_credentials' };
  }

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toPhone, From: fromNumber, Body: message }).toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Twilio send failed:', resp.status, errText);
      return { ok: false, status: 'failed' };
    }
    return { ok: true, status: 'sent' };
  } catch (err) {
    console.error('Twilio send threw:', err);
    return { ok: false, status: 'failed' };
  }
}

module.exports = { sendSms };
