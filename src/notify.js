// WhatsApp notifications to the developer. A failed notification is logged, never thrown:
// it must not fail the task it reports on.

async function check(res, provider) {
  if (!res.ok) throw new Error(`${provider} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const SEND = {
  // Twilio WhatsApp API (sandbox or approved sender)
  async twilio(w, body) {
    const auth = Buffer.from(`${w.twilioSid}:${w.twilioToken}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${w.twilioSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: `whatsapp:${w.from}`, To: `whatsapp:${w.to}`, Body: body }),
    });
    await check(res, 'Twilio');
  },
  // Meta WhatsApp Cloud API (free-form text is delivered inside the 24h customer-service window)
  async meta(w, body) {
    const res = await fetch(`https://graph.facebook.com/v21.0/${w.metaPhoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${w.metaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: w.to.replace(/^\+/, ''), type: 'text', text: { body } }),
    });
    await check(res, 'Meta');
  },
  // CallMeBot: free personal WhatsApp API (https://www.callmebot.com/blog/free-api-whatsapp-messages/)
  async callmebot(w, body) {
    const q = new URLSearchParams({ phone: w.to, text: body, apikey: w.callmebotKey });
    const res = await fetch(`https://api.callmebot.com/whatsapp.php?${q}`);
    await check(res, 'CallMeBot');
  },
};

export const PROVIDERS = Object.keys(SEND);

/** Returns notify(event, text); a no-op when WhatsApp is not configured or the event is muted. */
export function createNotifier(whatsapp, log = () => {}) {
  if (!whatsapp?.provider) return async () => {};
  return async (event, text) => {
    if (!whatsapp.events.includes(event)) return;
    try {
      await SEND[whatsapp.provider](whatsapp, text);
    } catch (err) {
      log(`WhatsApp notification failed: ${err.message}`);
    }
  };
}
