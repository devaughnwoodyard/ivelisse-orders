// Order texts for Ivelisse Orders, sent through Twilio.
//   1. Order placed  - when a guest submits an order with a phone number
//   2. Ready         - when staff mark the order ready on the board
//   3. Thank-you     - 9 AM (Central) the morning after the event, if the event has it switched on
// Twilio credentials live in Firebase secrets: TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM (+1XXXXXXXXXX).
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const TWILIO_SID = defineSecret('TWILIO_SID');
const TWILIO_TOKEN = defineSecret('TWILIO_TOKEN');
const TWILIO_FROM = defineSecret('TWILIO_FROM');
const SECRETS = [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM];
const TZ = 'America/Chicago';
const DEFAULT_LINK = 'https://maps.app.goo.gl/zyrToGerBpppPteV8';
const DEFAULT_PIC = 'https://orders.ivelissedesigns.com/followup.jpg';

const itemName = o => String(o.labels?.piece || o.item || 'item').toLowerCase();
const usPhone = p => /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(p || ''); // Twilio number only sends to US

const sec = p => String(p.value() || '').trim(); // pasted secrets can carry stray spaces or line breaks
async function sendText(to, body, mediaUrl) {
  const form = new URLSearchParams({ To: to, From: sec(TWILIO_FROM), Body: body });
  if (mediaUrl) form.append('MediaUrl', mediaUrl);
  const auth = Buffer.from(`${sec(TWILIO_SID)}:${sec(TWILIO_TOKEN)}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sec(TWILIO_SID)}/Messages.json`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${out.message || 'send failed'}`);
  return out.sid;
}

// 1. Order placed
exports.textOrderPlaced = onDocumentCreated({ document: 'events/{eventId}/orders/{orderId}', secrets: SECRETS }, async e => {
  const o = e.data?.data(); if (!o || !o.phone || !o.textOptIn || !usPhone(o.phone) || o.demo) return;
  const { eventId, orderId } = e.params;
  const q = await db.doc(`events/${eventId}/public/queue`).get();
  const ids = q.exists ? (q.data().ids || []) : []; const n = ids.indexOf(orderId) >= 0 ? ids.indexOf(orderId) + 1 : ids.length || 1;
  const body = `Ivelisse Designs: Thanks, ${o.name}! Your ${itemName(o)} order is in and you're #${n} in line. Reply STOP to opt out, HELP for help.`;
  try { const sid = await sendText(o.phone, body); await e.data.ref.update({ textPlacedSid: sid }); }
  catch (err) { logger.error('order text failed', eventId, orderId, err.message); }
});

// 2. Ready for pickup
exports.textOrderReady = onDocumentUpdated({ document: 'events/{eventId}/orders/{orderId}', secrets: SECRETS }, async e => {
  const before = e.data.before.data(), o = e.data.after.data();
  if (!o || before.status === 'done' || o.status !== 'done' || o.textReadySid) return;
  if (!o.phone || !o.textOptIn || !usPhone(o.phone) || o.demo) return;
  const ev = (await db.doc(`events/${e.params.eventId}`).get()).data() || {};
  const body = `Ivelisse Designs: ${o.name}, your ${itemName(o)} is ready! Pick it up ${ev.pickupNote || 'at the engraving table'}. Reply STOP to opt out.`;
  try { const sid = await sendText(o.phone, body); await e.data.after.ref.update({ textReadySid: sid }); }
  catch (err) { logger.error('ready text failed', e.params.eventId, e.params.orderId, err.message); }
});

// 3. Thank-you: every morning at 9 AM Central, for events dated yesterday.
exports.textThanks = onSchedule({ schedule: '0 9 * * *', timeZone: TZ, secrets: SECRETS }, async () => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const yesterday = fmt.format(new Date(Date.now() - 864e5));
  const evs = await db.collection('events').where('date', '==', yesterday).get();
  for (const evDoc of evs.docs) {
    const ev = evDoc.data();
    if (ev.thanksOn === false || ev.thanksSentAt || ev.demo) continue;
    const pic = await db.doc(`events/${evDoc.id}/public/followupImg`).get();
    const media = (pic.exists && pic.data().url) || DEFAULT_PIC, link = ev.followLink || DEFAULT_LINK;
    const orders = await evDoc.ref.collection('orders').get(), done = new Set();
    for (const d of orders.docs) {
      const o = d.data();
      if (!o.phone || !o.textOptIn || !usPhone(o.phone) || o.demo || o.textThanksSid || done.has(o.phone)) continue;
      done.add(o.phone);
      const body = `Ivelisse Designs: Hi ${o.name}, the @ivelissedesigns team hopes you're enjoying your ${itemName(o)}! We'd be so grateful if you left us a quick review: ${link} It keeps us doing what we love. Thank you! Reply STOP to opt out.`;
      try { const sid = await sendText(o.phone, body, media); await d.ref.update({ textThanksSid: sid }); }
      catch (err) { logger.error('thank-you text failed', evDoc.id, d.id, err.message); }
    }
    await evDoc.ref.update({ thanksSentAt: admin.firestore.FieldValue.serverTimestamp() });
  }
});
