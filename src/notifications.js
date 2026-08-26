function encodeBasic(username, password) {
  return btoa(`${username}:${password}`);
}

async function enqueueNotification(db, { dedupeKey, kind, subject, message }) {
  const id = crypto.randomUUID();
  const result = await db.prepare("INSERT OR IGNORE INTO notification_events(id,dedupe_key,kind,subject,message,created_at) VALUES(?,?,?,?,?,?)")
    .bind(id, dedupeKey, kind, subject.slice(0, 160), message.slice(0, 1500), Date.now()).run();
  return { queued: Number(result.meta?.changes || 0) === 1, dedupe_key: dedupeKey };
}

async function sendSms(env, body, fetcher = fetch) {
  if (!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER && env.NOTIFY_SMS_TO)) return { status: "unconfigured" };
  const form = new URLSearchParams({ To: env.NOTIFY_SMS_TO, From: env.TWILIO_FROM_NUMBER, Body: body.slice(0, 1500) });
  const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${encodeBasic(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!response.ok) throw new Error(`Twilio returned ${response.status}`);
  return { status: "sent" };
}

async function sendEmail(env, subject, body, fetcher = fetch) {
  if (!(env.RESEND_API_KEY && env.NOTIFY_EMAIL_TO && env.NOTIFY_EMAIL_FROM)) return { status: "unconfigured" };
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.NOTIFY_EMAIL_FROM, to: [env.NOTIFY_EMAIL_TO], subject: subject.slice(0, 160), text: body }),
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
  return { status: "sent" };
}

async function dispatchNotifications(env, fetcher = fetch) {
  if (!env.DB) return { configured: false, processed: 0 };
  const result = await env.DB.prepare("SELECT id,subject,message,sms_status,email_status,attempts FROM notification_events WHERE (sms_status='pending' OR email_status='pending') AND attempts<12 ORDER BY created_at LIMIT 10").all();
  let processed = 0;
  for (const event of result.results || []) {
    let sms = event.sms_status;
    let email = event.email_status;
    let lastError = null;
    if (sms === "pending") {
      try { const outcome = await sendSms(env, event.message, fetcher); if (outcome.status === "sent") sms = "sent"; }
      catch (error) { lastError = String(error.message || error).slice(0, 500); }
    }
    if (email === "pending") {
      try { const outcome = await sendEmail(env, event.subject, event.message, fetcher); if (outcome.status === "sent") email = "sent"; }
      catch (error) { lastError = String(error.message || error).slice(0, 500); }
    }
    const complete = sms === "sent" && email === "sent";
    await env.DB.prepare("UPDATE notification_events SET sms_status=?,email_status=?,attempts=attempts+1,last_error=?,sent_at=? WHERE id=?")
      .bind(sms, email, lastError, complete ? Date.now() : null, event.id).run();
    processed += 1;
  }
  return { configured: true, processed, sms_configured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER), email_configured: Boolean(env.RESEND_API_KEY && env.NOTIFY_EMAIL_FROM) };
}

export { dispatchNotifications, enqueueNotification, sendEmail, sendSms };
