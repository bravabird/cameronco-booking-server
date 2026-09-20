require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const { DateTime } = require('luxon');
const admin = require('firebase-admin');
const { getFirestore: getFirestoreInstance } = require('firebase-admin/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5002;
const BOOKING_STORE_PATH = process.env.BOOKING_STORE_PATH || path.join(__dirname, 'bookings-store.json');
// Legacy fallback only -- per-service durations below are what's actually used.
const APPOINTMENT_MINUTES = parseInt(process.env.APPOINTMENT_MINUTES || '45', 10);
// "buffer" is minutes held after the appointment before the next one can
// start (travel/reset time) -- it's not shown to the customer and isn't part
// of the Zoom meeting length, only of how long the slot blocks the calendar.
const DEFAULT_SERVICE_TIMINGS = {
  virtual: { label: 'Virtual Enquiry', duration: 30, buffer: 0 },
  engagement: { label: 'Engagement Ring Enquiry', duration: 60, buffer: 15 },
  wedding: { label: 'Wedding Ring Enquiry', duration: 60, buffer: 15 },
  repair: { label: 'Jewellery Repairs', duration: 30, buffer: 15 },
  collection: { label: 'Collection', duration: 30, buffer: 0 },
  remake: { label: 'Remake or Custom Item', duration: 60, buffer: 15 }
};
const SLOT_STEP_MINUTES = 15;

function serviceTimingKey(service) {
  const value = String(service || '').toLowerCase();
  if (value.includes('virtual')) return 'virtual';
  if (value.includes('engagement')) return 'engagement';
  if (value.includes('wedding')) return 'wedding';
  if (value.includes('repair')) return 'repair';
  if (value.includes('collection')) return 'collection';
  if (value.includes('remake') || value.includes('custom')) return 'remake';
  return null;
}

// Durations/buffers are editable at /admin/appointment-settings (stored in
// Firestore, same pattern as email/Zoom settings) so they can change without
// a redeploy. Falls back to the defaults above for any type not overridden.
async function getServiceSettings() {
  const db = getFirestore();
  if (db) {
    const doc = await db.collection('settings').doc('appointmentTypes').get();
    return doc.exists ? doc.data() : {};
  }
  console.log('[dry-run settings] Firestore not configured, using local file');
  return loadSettingsFile().appointmentTypes || {};
}

async function saveServiceSettings(update) {
  const db = getFirestore();
  if (db) {
    await db.collection('settings').doc('appointmentTypes').set(update, { merge: true });
    return;
  }
  console.log('[dry-run settings] Firestore not configured, using local file');
  const all = loadSettingsFile();
  all.appointmentTypes = { ...(all.appointmentTypes || {}), ...update };
  saveSettingsFile(all);
}

// { duration, buffer } in minutes for a given service string (e.g. the free
// text stored on a booking, not just the canonical key).
async function getServiceTiming(service) {
  const key = serviceTimingKey(service);
  const fallback = (key && DEFAULT_SERVICE_TIMINGS[key]) || { duration: APPOINTMENT_MINUTES, buffer: 0 };
  if (!key) return { duration: fallback.duration, buffer: fallback.buffer };
  const stored = await getServiceSettings();
  const override = stored[key] || {};
  return {
    duration: Number.isFinite(Number(override.duration)) ? Number(override.duration) : fallback.duration,
    buffer: Number.isFinite(Number(override.buffer)) ? Number(override.buffer) : fallback.buffer
  };
}
const SITE_BASE_URL = process.env.SITE_BASE_URL || `http://localhost:${PORT}`;
const BOOKING_ERROR_ALERT_EMAIL = process.env.BOOKING_ERROR_ALERT_EMAIL;

app.set('trust proxy', true);
app.use((req, res, next) => {
  console.log('Incoming request:', req.method, req.url);
  next();
});
app.use(express.json());
app.use(cors());

// Explicit CORS headers for any origin (including null)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.static(path.join(__dirname, '..')));

// Configuration from environment variables
const NIVODA_API_URL = process.env.NIVODA_API_URL || 'https://intg-customer-staging.nivodaapi.net/api/diamonds';
const NIVODA_USERNAME = process.env.NIVODA_USERNAME || 'testaccount@sample.com';
const NIVODA_PASSWORD = process.env.NIVODA_PASSWORD || 'staging-nivoda-22';
const PRICE_MARKUP_FACTOR = parseFloat(process.env.PRICE_MARKUP_FACTOR) || 1.35; // Example 35% markup

const OFFICES = {
  melbourne: {
    label: 'Melbourne Office',
    salesEmail: 'vicsales@cameronco.com.au',
    calendarId: process.env.GOOGLE_CALENDAR_MELBOURNE_ID,
    zoomUserId: process.env.ZOOM_MELBOURNE_USER_ID || process.env.ZOOM_MELBOURNE_ROOM_ID,
    address: '73-75 Canterbury Road, Canterbury VIC 3126',
    timeZone: 'Australia/Melbourne',
    timeLabel: 'Melbourne time'
  },
  sydney: {
    label: 'Sydney Office',
    salesEmail: 'nswsales@cameronco.com.au',
    calendarId: process.env.GOOGLE_CALENDAR_SYDNEY_ID,
    zoomUserId: process.env.ZOOM_SYDNEY_USER_ID || process.env.ZOOM_SYDNEY_ROOM_ID,
    address: 'Suite 2, Level 7, 37 York Street, Sydney NSW 2000',
    timeZone: 'Australia/Sydney',
    timeLabel: 'Sydney time'
  }
};

// Booking storage: Firestore when configured, falling back to the local
// JSON file for local development without live Firebase creds. When
// actually running inside Firebase Functions (Cloud Run under the hood,
// which always sets K_SERVICE), Firebase's own ambient credentials are used
// automatically -- no key needed there at all. GCP_* vars are only for
// local dev, and deliberately avoid the FIREBASE_ prefix, which Firebase
// Functions reserves and refuses to load from a deploy-time .env file.
const BOOKINGS_COLLECTION = 'bookings';
let firestoreDb = null;
function getFirestore() {
  if (firestoreDb) return firestoreDb;
  try {
    if (process.env.GCP_PROJECT_ID && process.env.GCP_CLIENT_EMAIL && process.env.GCP_PRIVATE_KEY) {
      admin.initializeApp({
        credential: admin.cert({
          projectId: process.env.GCP_PROJECT_ID,
          clientEmail: process.env.GCP_CLIENT_EMAIL,
          privateKey: process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
      });
    } else if (process.env.K_SERVICE) {
      admin.initializeApp();
    } else {
      return null;
    }
  } catch (error) {
    console.error('Firestore init error:', error.message);
    return null;
  }
  firestoreDb = getFirestoreInstance();
  // Zoom/Calendar dry-run stubs leave fields like zoomMeetingId undefined
  // when those integrations aren't configured; Firestore rejects undefined
  // values outright (the old JSON.stringify-based store silently dropped
  // them), so match that original behaviour here.
  firestoreDb.settings({ ignoreUndefinedProperties: true });
  return firestoreDb;
}

function loadBookingsFile() {
  try {
    if (!fs.existsSync(BOOKING_STORE_PATH)) return {};
    return JSON.parse(fs.readFileSync(BOOKING_STORE_PATH, 'utf8'));
  } catch (error) {
    console.error('Booking store read error:', error.message);
    return {};
  }
}

function saveBookingsFile(allBookings) {
  fs.writeFileSync(BOOKING_STORE_PATH, JSON.stringify(allBookings, null, 2));
}

async function getBooking(token) {
  const db = getFirestore();
  if (db) {
    const doc = await db.collection(BOOKINGS_COLLECTION).doc(token).get();
    return doc.exists ? doc.data() : null;
  }
  console.log('[dry-run bookings] Firestore not configured, using local file');
  return loadBookingsFile()[token] || null;
}

async function saveBooking(token, booking) {
  const db = getFirestore();
  if (db) {
    await db.collection(BOOKINGS_COLLECTION).doc(token).set(booking);
    return;
  }
  console.log('[dry-run bookings] Firestore not configured, using local file');
  const all = loadBookingsFile();
  all[token] = booking;
  saveBookingsFile(all);
}

async function getAllBookings() {
  const db = getFirestore();
  if (db) {
    const snapshot = await db.collection(BOOKINGS_COLLECTION).get();
    return snapshot.docs.map((doc) => doc.data());
  }
  return Object.values(loadBookingsFile());
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function publicBooking(booking) {
  return {
    id: booking.id,
    office: booking.office,
    officeLabel: OFFICES[booking.office]?.label,
    service: booking.service,
    name: booking.name,
    email: booking.email,
    phone: booking.phone,
    start: booking.start,
    end: booking.end,
    zoomJoinUrl: booking.zoomJoinUrl,
    status: booking.status
  };
}

function officeFor(value) {
  return OFFICES[value] ? value : 'melbourne';
}

function manageUrl(booking) {
  // Always the storefront's own booking page -- never booking.baseUrl (the
  // Cloud Function's own host, which is where the POST request landed, not
  // where the customer's browser is) and never /booking.html (a leftover
  // path from the pre-Shopify static site). The live Shopify booking-page
  // section reads ?booking=<token> from the URL itself and wires up working
  // Cancel/Reschedule buttons, so this link is all that's needed.
  return `${SITE_BASE_URL.replace(/\/$/, '')}/pages/booking?booking=${encodeURIComponent(booking.manageToken)}`;
}

function isVirtualBooking(booking) {
  return /\bvirtual\b/i.test(String(booking && booking.service || ''));
}

function officeEventColorId(service) {
  const value = String(service || '').toLowerCase();
  if (value.includes('virtual')) return '3'; // purple
  if (value.includes('engagement')) return '9'; // blue
  if (value.includes('wedding')) return '4'; // pink
  if (value.includes('repair')) return '6'; // orange
  if (value.includes('collection')) return '10'; // green
  if (value.includes('remake') || value.includes('custom')) return '7'; // teal
  return undefined;
}

// "action" here is the full label ("Appointment confirmed"/"Appointment
// rescheduled"/"Appointment cancelled") passed down from notifyBooking, not
// the raw action key -- this pulls the customer-facing verb back out of it
// for the staff-facing "a customer has ___ an appointment" line.
function verbForAction(action) {
  if (/cancelled/i.test(action)) return 'cancelled';
  if (/rescheduled/i.test(action)) return 'rescheduled';
  return 'booked';
}

// A manual "Add to Google Calendar" link, alongside the .ics attachment --
// whether a mail client shows any UI for an .ics attachment at all is
// inconsistent (some show an invite banner, many show nothing), so this
// link is the one reliably clickable option in every client.
function googleCalendarAddUrl(booking) {
  const office = OFFICES[booking.office];
  const virtual = isVirtualBooking(booking);
  const fmt = (value) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const details = virtual
    ? `Join online: ${booking.zoomJoinUrl || 'The Cameron & Co team will send your meeting link.'}`
    : `Office: ${office.label}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Cameron & Co ${booking.service}`,
    dates: `${fmt(booking.start)}/${fmt(booking.end)}`,
    details,
    location: virtual ? '' : office.address
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function outlookCalendarAddUrl(booking) {
  const office = OFFICES[booking.office];
  const virtual = isVirtualBooking(booking);
  const details = virtual
    ? `Join online: ${booking.zoomJoinUrl || 'The Cameron & Co team will send your meeting link.'}`
    : `Office: ${office.label}`;
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: `Cameron & Co ${booking.service}`,
    startdt: new Date(booking.start).toISOString(),
    enddt: new Date(booking.end).toISOString(),
    body: details,
    location: virtual ? '' : office.address
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

function bookingText(booking, action, audience = 'customer') {
  const office = OFFICES[booking.office];
  const virtual = isVirtualBooking(booking);
  const when = `${new Date(booking.start).toLocaleString('en-AU', { timeZone: office.timeZone })} (${office.timeLabel})`;

  if (audience === 'office') {
    const lines = [
      `A customer has ${verbForAction(action)} an appointment.`,
      '',
      `Name: ${booking.name}`,
      `Email: ${booking.email}`,
      booking.phone ? `Phone: ${booking.phone}` : '',
      `Service: ${booking.service}`,
      `When: ${when}`,
      virtual
        ? (/cancelled/i.test(action) ? '' : `Join online: ${booking.zoomJoinUrl || 'Meeting link pending.'}`)
        : `Office: ${office.label}`,
      booking.notes ? `Notes: ${booking.notes}` : ''
    ];
    return lines.filter(Boolean).join('\n');
  }

  const lines = [
    `${action}: ${booking.service}`,
    `Name: ${booking.name}`,
    `When: ${when}`,
    virtual
      ? (/cancelled/i.test(action) ? '' : `Join online: ${booking.zoomJoinUrl || 'The Cameron & Co team will send your meeting link.'}`)
      : `Office: ${office.label}`,
    virtual ? '' : `Address: ${office.address}`,
    `Manage appointment: ${manageUrl(booking)}`,
    /cancelled/i.test(action) ? '' : `Add to Google Calendar: ${googleCalendarAddUrl(booking)}`,
    /cancelled/i.test(action) ? '' : `Add to Outlook Calendar: ${outlookCalendarAddUrl(booking)}`,
    booking.notes ? `Notes: ${booking.notes}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

// Hosted on the live theme (not the proxy-server's own filesystem) so it
// resolves as a normal https image URL email clients can fetch -- inline
// attachments render inconsistently across Gmail/Outlook/Apple Mail.
const EMAIL_LOGO_URL = 'https://1bgeet-da.myshopify.com/cdn/shop/t/2/assets/cameron-co-logo-email.png';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function bookingHtml(booking, action, audience = 'customer') {
  const office = OFFICES[booking.office];
  const virtual = isVirtualBooking(booking);
  const cancelled = /cancelled/i.test(action);
  const when = new Date(booking.start).toLocaleString('en-AU', {
    timeZone: office.timeZone,
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });

  if (audience === 'office') {
    const officeRows = [
      ['Name', escapeHtml(booking.name)],
      ['Email', escapeHtml(booking.email)],
      ...(booking.phone ? [['Phone', escapeHtml(booking.phone)]] : []),
      ['Service', escapeHtml(booking.service)],
      ['When', `${when} (${office.timeLabel})`],
      ...(virtual
        ? (cancelled ? [] : [['Join online', booking.zoomJoinUrl
          ? `<a href="${escapeHtml(booking.zoomJoinUrl)}" style="color:#171d29;">${escapeHtml(booking.zoomJoinUrl)}</a>`
          : 'Meeting link pending.']])
        : [['Office', escapeHtml(office.label)]])
    ];
    if (booking.notes) officeRows.push(['Notes', escapeHtml(booking.notes).replace(/\n/g, '<br>')]);
    const officeRowsHtml = officeRows.map(([label, value]) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e5e2db;font-size:13px;color:#7a8291;width:110px;vertical-align:top;">${label}</td>
        <td style="padding:10px 0;border-bottom:1px solid #e5e2db;font-size:14px;color:#171d29;vertical-align:top;">${value}</td>
      </tr>
    `).join('');
    return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f3f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3f0;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid rgba(23,29,41,.1);border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 24px;text-align:center;border-bottom:1px solid #e5e2db;">
              <img src="${EMAIL_LOGO_URL}" width="180" alt="Cameron & Co" style="display:inline-block;height:auto;max-width:180px;">
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 32px;">
              <h1 style="margin:0 0 8px;font-size:20px;color:#171d29;font-weight:600;">${escapeHtml(action)}</h1>
              <p style="margin:0 0 20px;font-size:14px;color:#5a6270;">A customer has ${verbForAction(action)} an appointment.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${officeRowsHtml}</table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px;border-top:1px solid #e5e2db;">
              <p style="margin:0;font-size:12px;color:#9aa1ac;">Cameron &amp; Co &mdash; ${virtual ? 'Virtual appointment' : `${escapeHtml(office.label)}, ${escapeHtml(office.address)}`}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  const actionUrl = cancelled ? `${SITE_BASE_URL.replace(/\/$/, '')}/pages/booking` : manageUrl(booking);
  const actionText = cancelled ? 'Book an appointment' : 'Manage appointment';
  const actionStyle = cancelled
    ? 'background:#d5b226;color:#ffffff;'
    : 'background:#171d29;color:#ffffff;';
  const rows = [
    ['Service', booking.service],
    ['When', `${when} (${office.timeLabel})`],
    ...(virtual
      ? (cancelled ? [] : [['Join online', booking.zoomJoinUrl
        ? `<a href="${escapeHtml(booking.zoomJoinUrl)}" style="color:#171d29;">${escapeHtml(booking.zoomJoinUrl)}</a>`
        : 'The Cameron &amp; Co team will send your meeting link.']])
      : [['Office', office.label], ['Address', office.address]])
  ];
  if (booking.notes) rows.push(['Notes', escapeHtml(booking.notes).replace(/\n/g, '<br>')]);

  const rowsHtml = rows.map(([label, value]) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e5e2db;font-size:13px;color:#7a8291;width:110px;vertical-align:top;">${label}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e5e2db;font-size:14px;color:#171d29;vertical-align:top;">${value}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f3f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3f0;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid rgba(23,29,41,.1);border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 24px;text-align:center;border-bottom:1px solid #e5e2db;">
              <img src="${EMAIL_LOGO_URL}" width="180" alt="Cameron & Co" style="display:inline-block;height:auto;max-width:180px;">
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px;">
              <h1 style="margin:0 0 8px;font-size:20px;color:#171d29;font-weight:600;">${escapeHtml(action)}</h1>
              <p style="margin:0 0 20px;font-size:14px;color:#5a6270;">Hi ${escapeHtml(booking.name)}, ${cancelled ? 'your appointment has been cancelled.' : 'here are your appointment details.'}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 32px;">
              <a href="${escapeHtml(actionUrl)}" style="display:inline-block;${actionStyle}text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:4px;">${actionText}</a>
              ${cancelled ? '' : `<div style="margin-top:12px;"><a href="${escapeHtml(googleCalendarAddUrl(booking))}" style="font-size:13px;color:#5a6270;text-decoration:underline;">Add to Google Calendar</a> &nbsp;&middot;&nbsp; <a href="${escapeHtml(outlookCalendarAddUrl(booking))}" style="font-size:13px;color:#5a6270;text-decoration:underline;">Add to Outlook Calendar</a></div>`}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px;border-top:1px solid #e5e2db;">
              <p style="margin:0;font-size:12px;color:#9aa1ac;">Cameron &amp; Co &mdash; ${virtual ? 'Virtual appointment' : `${escapeHtml(office.label)}, ${escapeHtml(office.address)}`}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsTimestamp(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function customerCalendarAttachment(booking, action) {
  const office = OFFICES[booking.office];
  const virtual = isVirtualBooking(booking);
  const cancelled = action === 'cancelled';
  const title = `Cameron & Co ${booking.service}`;
  const details = (virtual
    ? `Join online: ${booking.zoomJoinUrl || 'The Cameron & Co team will send your meeting link.'}`
    : `Office: ${office.label}\nAddress: ${office.address}`) +
    `\n${cancelled ? `Book an appointment: ${SITE_BASE_URL.replace(/\/$/, '')}/pages/booking` : `Manage appointment: ${manageUrl(booking)}`}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'PRODID:-//Cameron & Co//Appointments//EN',
    `METHOD:${cancelled ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${booking.id}@cameronco.com.au`,
    `DTSTAMP:${icsTimestamp(new Date())}`,
    `SEQUENCE:${Number(booking.calendarSequence || 0)}`,
    `DTSTART:${icsTimestamp(booking.start)}`,
    `DTEND:${icsTimestamp(booking.end)}`,
    `SUMMARY:${escapeIcsText(title)}`,
    `DESCRIPTION:${escapeIcsText(details)}`,
    'ORGANIZER;CN=Cameron & Co:mailto:bookings@cameronco.com.au',
    `ATTENDEE;CN=${escapeIcsText(booking.name)};RSVP=TRUE:mailto:${booking.email}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ];
  return {
    filename: 'cameron-co-appointment.ics',
    content: lines.join('\r\n'),
    method: cancelled ? 'CANCEL' : 'REQUEST',
    contentType: `text/calendar; charset=utf-8; method=${cancelled ? 'CANCEL' : 'REQUEST'}`
  };
}

// Email settings: Firestore when configured (so a password rotated via the
// /admin/email-settings page takes effect immediately, no redeploy), falling
// back to a local JSON file for dev without live Firebase creds, same
// pattern as booking storage above. SMTP_* env vars remain the last-resort
// fallback if nothing has been set through the admin page yet.
const SETTINGS_STORE_PATH = process.env.SETTINGS_STORE_PATH || path.join(__dirname, 'settings-store.json');

function loadSettingsFile() {
  try {
    if (!fs.existsSync(SETTINGS_STORE_PATH)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_STORE_PATH, 'utf8'));
  } catch (error) {
    console.error('Settings store read error:', error.message);
    return {};
  }
}

function saveSettingsFile(all) {
  fs.writeFileSync(SETTINGS_STORE_PATH, JSON.stringify(all, null, 2));
}

async function getEmailSettings() {
  const db = getFirestore();
  if (db) {
    const doc = await db.collection('settings').doc('email').get();
    return doc.exists ? doc.data() : {};
  }
  console.log('[dry-run settings] Firestore not configured, using local file');
  return loadSettingsFile().email || {};
}

async function saveEmailSettings(update) {
  const db = getFirestore();
  if (db) {
    await db.collection('settings').doc('email').set(update, { merge: true });
    return;
  }
  console.log('[dry-run settings] Firestore not configured, using local file');
  const all = loadSettingsFile();
  all.email = { ...(all.email || {}), ...update };
  saveSettingsFile(all);
}

async function getSmtpTransporter() {
  const stored = await getEmailSettings();
  const host = stored.host || process.env.SMTP_HOST;
  const port = stored.port || process.env.SMTP_PORT || '587';
  const user = stored.user || process.env.SMTP_USER;
  const pass = stored.password || process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(port, 10),
    // Port 465 is implicit TLS; 587 (and most others) negotiate TLS via STARTTLS instead.
    secure: parseInt(port, 10) === 465,
    auth: { user, pass }
  });
}

async function sendEmail(to, subject, text, html, attachments, icalEvent) {
  const transporter = await getSmtpTransporter();
  if (!transporter) {
    console.log('[dry-run email]', { to, subject, text });
    return { dryRun: true };
  }
  const stored = await getEmailSettings();
  const fromName = stored.fromName || process.env.SMTP_FROM_NAME || 'Cameron & Co';
  const fromEmail = stored.fromEmail || process.env.SMTP_FROM_EMAIL || stored.user || process.env.SMTP_USER;
  const message = {
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text,
    html: html || text.replace(/\n/g, '<br>')
  };
  if (attachments && attachments.length) message.attachments = attachments;
  if (icalEvent) message.icalEvent = icalEvent;
  return transporter.sendMail(message);
}

async function sendSms(to, message) {
  if (!to) return { skipped: true };
  if (!process.env.COMPLETE_SMS_API_URL) {
    console.log('[dry-run sms]', { to, message });
    return { dryRun: true };
  }
  const headers = {
    'Content-Type': 'application/json',
    ...(process.env.COMPLETE_SMS_API_TOKEN ? { Authorization: `Bearer ${process.env.COMPLETE_SMS_API_TOKEN}` } : {})
  };
  const response = await fetch(process.env.COMPLETE_SMS_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      to,
      message,
      from: process.env.COMPLETE_SMS_SENDER || 'CameronCo'
    })
  });
  if (!response.ok) throw new Error(`Complete SMS API returned ${response.status}`);
  return response.json().catch(() => ({ success: true }));
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let googleToken = null;
let googleTokenExpiry = 0;

async function getGoogleToken() {
  if (googleToken && Date.now() < googleTokenExpiry) return googleToken;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !privateKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const assertion = `${header}.${payload}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString()
  });
  if (!response.ok) throw new Error(`Google auth returned ${response.status}`);
  const json = await response.json();
  googleToken = json.access_token;
  googleTokenExpiry = Date.now() + (json.expires_in - 120) * 1000;
  return googleToken;
}

async function googleCalendarRequest(method, url, body) {
  const token = await getGoogleToken();
  if (!token) return { dryRun: true };
  const response = await fetch(`https://www.googleapis.com/calendar/v3${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Calendar returned ${response.status}: ${errorText}`);
  }
  return response.status === 204 ? { success: true } : response.json();
}

async function busyTimes(officeKey, timeMin, timeMax) {
  const office = OFFICES[officeKey];
  if (!office.calendarId) return [];
  const response = await googleCalendarRequest('POST', '/freeBusy', {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    timeZone: office.timeZone,
    items: [{ id: office.calendarId }]
  });
  return response?.calendars?.[office.calendarId]?.busy || [];
}

async function createCalendarEvent(booking) {
  const office = OFFICES[booking.office];
  if (!office.calendarId) return { dryRun: true };
  const event = {
    summary: `${booking.service} with ${booking.name}`,
    colorId: officeEventColorId(booking.service),
    description: bookingText(booking, 'Appointment confirmed'),
    location: isVirtualBooking(booking) ? '' : office.address,
    start: { dateTime: booking.start, timeZone: office.timeZone },
    end: { dateTime: booking.calendarEnd || booking.end, timeZone: office.timeZone }
  };
  const created = await googleCalendarRequest('POST', `/calendars/${encodeURIComponent(office.calendarId)}/events?sendUpdates=all`, event);
  return { eventId: created.id, calendarId: office.calendarId };
}

async function updateCalendarEvent(booking) {
  const office = OFFICES[booking.office];
  const calendarId = booking.googleCalendarId || office.calendarId;
  if (!calendarId || !booking.googleEventId) return { dryRun: true };
  return googleCalendarRequest('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(booking.googleEventId)}?sendUpdates=all`, {
    colorId: officeEventColorId(booking.service),
    start: { dateTime: booking.start, timeZone: office.timeZone },
    end: { dateTime: booking.calendarEnd || booking.end, timeZone: office.timeZone },
    location: isVirtualBooking(booking) ? '' : office.address,
    description: bookingText(booking, 'Appointment updated')
  });
}

async function deleteCalendarEvent(booking) {
  const office = OFFICES[booking.office];
  const calendarId = booking.googleCalendarId || office.calendarId;
  if (!calendarId || !booking.googleEventId) return { dryRun: true };
  try {
    return await googleCalendarRequest('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(booking.googleEventId)}?sendUpdates=all`);
  } catch (error) {
    if (/Google Calendar returned (404|410):/.test(error.message)) return { alreadyDeleted: true };
    throw error;
  }
}

async function cleanupBookingIntegrations(booking) {
  const results = await Promise.allSettled([
    deleteCalendarEvent(booking),
    deleteZoomMeeting(booking)
  ]);
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) {
    const details = failures.map((error) => error.message || String(error)).join('; ');
    console.error('Booking integration cleanup error:', details);
    await notifyBookingError('Cancellation cleanup', new Error(details), booking);
  }
  return failures;
}

// Zoom settings: Firestore when configured (so credentials rotated via the
// /admin/zoom-settings page take effect immediately, no redeploy), falling
// back to a local JSON file for dev without live Firebase creds, same
// pattern as email settings above. ZOOM_* env vars remain the last-resort
// fallback if nothing has been set through the admin page yet.
async function getZoomSettings() {
  const db = getFirestore();
  if (db) {
    const doc = await db.collection('settings').doc('zoom').get();
    return doc.exists ? doc.data() : {};
  }
  console.log('[dry-run settings] Firestore not configured, using local file');
  return loadSettingsFile().zoom || {};
}

async function saveZoomSettings(update) {
  const db = getFirestore();
  if (db) {
    await db.collection('settings').doc('zoom').set(update, { merge: true });
    return;
  }
  console.log('[dry-run settings] Firestore not configured, using local file');
  const all = loadSettingsFile();
  all.zoom = { ...(all.zoom || {}), ...update };
  saveSettingsFile(all);
}

// Melbourne and Sydney each have their own independent Zoom account (their
// own Server-to-Server OAuth app), not just separate users on a shared
// account -- so credentials, and the OAuth token they produce, are looked
// up and cached per office.
function zoomOfficeKey(officeValue) {
  return officeValue === 'sydney' ? 'sydney' : 'melbourne';
}

async function getZoomCredentials(officeKey) {
  const stored = await getZoomSettings();
  const office = stored[officeKey] || {};
  const prefix = officeKey === 'sydney' ? 'ZOOM_SYDNEY_' : 'ZOOM_MELBOURNE_';
  return {
    accountId: office.accountId || process.env[`${prefix}ACCOUNT_ID`],
    clientId: office.clientId || process.env[`${prefix}CLIENT_ID`],
    clientSecret: office.clientSecret || process.env[`${prefix}CLIENT_SECRET`],
    userId: office.userId || process.env[`${prefix}USER_ID`] || process.env[`${prefix}ROOM_ID`]
  };
}

const zoomTokens = {}; // officeKey -> { token, expiry }

function zoomLocalStartTime(booking) {
  const office = OFFICES[booking.office];
  return DateTime.fromJSDate(new Date(booking.start), { zone: office.timeZone })
    .toFormat("yyyy-LL-dd'T'HH:mm:ss");
}

async function getZoomToken(officeKey) {
  const cached = zoomTokens[officeKey];
  if (cached && Date.now() < cached.expiry) return cached.token;
  const { accountId, clientId, clientSecret } = await getZoomCredentials(officeKey);
  if (!accountId || !clientId || !clientSecret) return null;

  const response = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`Zoom auth failed for ${officeKey}:`, response.status, body);
    throw new Error(`Zoom auth returned ${response.status}`);
  }
  const json = await response.json();
  zoomTokens[officeKey] = {
    token: json.access_token,
    expiry: Date.now() + (json.expires_in - 120) * 1000
  };
  return zoomTokens[officeKey].token;
}

async function createZoomMeeting(booking) {
  const officeKey = zoomOfficeKey(booking.office);
  const token = await getZoomToken(officeKey);
  const credentials = await getZoomCredentials(officeKey);
  if (!token || !credentials.userId) return { dryRun: true };
  const response = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(credentials.userId)}/meetings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      topic: `Cameron & Co: ${booking.service}`,
      type: 2,
      start_time: zoomLocalStartTime(booking),
      duration: booking.durationMinutes || APPOINTMENT_MINUTES,
      timezone: OFFICES[booking.office].timeZone,
      settings: { waiting_room: true }
    })
  });
  if (!response.ok) throw new Error(`Zoom meeting returned ${response.status}`);
  const json = await response.json();
  return { meetingId: json.id, joinUrl: json.join_url };
}

async function updateZoomMeeting(booking) {
  // Existing appointments without a Zoom meeting must still be able to be
  // rescheduled. Do not attempt Zoom authentication for those bookings: an
  // unrelated missing/expired Zoom credential would otherwise abort the
  // Google Calendar update and the reschedule notification.
  if (!booking.zoomMeetingId) return { skipped: true };
  const token = await getZoomToken(zoomOfficeKey(booking.office));
  if (!token) return { dryRun: true };
  const response = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(booking.zoomMeetingId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      start_time: zoomLocalStartTime(booking),
      duration: booking.durationMinutes || APPOINTMENT_MINUTES,
      timezone: OFFICES[booking.office].timeZone
    })
  });
  if (!response.ok && response.status !== 204) throw new Error(`Zoom update returned ${response.status}`);
  return { success: true };
}

async function deleteZoomMeeting(booking) {
  if (!booking.zoomMeetingId) return { skipped: true };
  const token = await getZoomToken(zoomOfficeKey(booking.office));
  if (!token) return { dryRun: true };
  const response = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(booking.zoomMeetingId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok && response.status !== 204 && response.status !== 404) throw new Error(`Zoom delete returned ${response.status}`);
  return { success: true };
}

const SHOPIFY_API_VERSION = '2026-07';

let shopifyToken = null;
let shopifyTokenExpiry = 0;

// Custom app using the client credentials grant (Dev Dashboard apps created
// after Jan 1 2026 don't issue a permanent token -- see admin-email-settings
// history). Same cache-and-refresh shape as getZoomToken above.
async function getShopifyAdminToken() {
  if (shopifyToken && Date.now() < shopifyTokenExpiry) return shopifyToken;
  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!shop || !clientId || !clientSecret) return null;

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  if (!response.ok) throw new Error(`Shopify auth returned ${response.status}`);
  const json = await response.json();
  shopifyToken = json.access_token;
  shopifyTokenExpiry = Date.now() + (json.expires_in - 120) * 1000;
  return shopifyToken;
}

// Creates (or, if the app is later granted read_customers, updates) a
// Shopify Customer for whoever just booked, so appointments show up
// alongside orders in Shopify's own Customers list instead of only living
// in Firestore. Never allowed to fail the booking itself -- callers treat
// this as a best-effort side sync, matching how Zoom/email failures here
// already don't block a booking from being confirmed.
async function syncShopifyCustomer(booking) {
  const shop = process.env.SHOPIFY_SHOP;
  const token = await getShopifyAdminToken();
  if (!token || !shop) return { skipped: true };

  const office = OFFICES[booking.office];
  const [firstName, ...rest] = booking.name.trim().split(/\s+/);
  const customerPayload = {
    first_name: firstName || booking.name,
    last_name: rest.join(' '),
    email: booking.email,
    tags: 'booking-appointment',
    note: `Booked "${booking.service}" at ${office?.label || booking.office} via the website booking widget.`
  };
  if (booking.phone) customerPayload.phone = booking.phone;

  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/customers.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ customer: customerPayload })
  });

  if (response.ok) {
    const json = await response.json();
    return { customerId: json.customer.id, created: true };
  }

  // 422 almost always means a customer with this email already exists.
  // Updating them requires read_customers (to look up their ID first),
  // which this app isn't currently granted -- log and move on rather than
  // failing the booking over a CRM side-effect.
  const errorBody = await response.text().catch(() => '');
  console.warn('Shopify customer sync skipped:', response.status, errorBody);
  return { skipped: true, status: response.status };
}

const OFFICE_NOTIFICATION_SUBJECT = {
  confirmed: 'New appointment booked',
  rescheduled: 'Appointment rescheduled',
  cancelled: 'Appointment cancelled'
};

async function notifyBooking(booking, action) {
  const office = OFFICES[booking.office];
  const officeNotificationEmail = process.env.BOOKING_OFFICE_NOTIFICATION_EMAIL || office.salesEmail;
  const label = `Appointment ${action}`;
  const customerSubject = `Cameron & Co appointment ${action}: ${booking.service}`;
  const customerText = bookingText(booking, label);
  const customerHtml = bookingHtml(booking, label);
  const calendarEvent = customerCalendarAttachment(booking, action);

  const officeSubject = `${OFFICE_NOTIFICATION_SUBJECT[action] || 'Appointment update'}: ${booking.service}`;
  const officeText = bookingText(booking, label, 'office');
  const officeHtml = bookingHtml(booking, label, 'office');

  await Promise.all([
    // Send the calendar data as a native text/calendar MIME part, rather than
    // only a file attachment, so Gmail/Outlook process REQUEST and CANCEL as
    // updates to the same calendar event.
    sendEmail(booking.email, customerSubject, customerText, customerHtml, undefined, calendarEvent),
    sendEmail(officeNotificationEmail, officeSubject, officeText, officeHtml)
  ]);
}

async function notifyBookingError(operation, error, booking = {}) {
  if (!BOOKING_ERROR_ALERT_EMAIL) return;
  const office = OFFICES[officeFor(booking.office)];
  const subject = `Cameron & Co booking error: ${operation}`;
  const details = [
    `Operation: ${operation}`,
    `Office: ${office.label}`,
    booking.name ? `Customer: ${booking.name}` : '',
    booking.email ? `Email: ${booking.email}` : '',
    booking.phone ? `Phone: ${booking.phone}` : '',
    booking.service ? `Service: ${booking.service}` : '',
    booking.start ? `Appointment: ${booking.start}` : '',
    `Error: ${error.message || String(error)}`
  ].filter(Boolean).join('\n');
  try {
    await sendEmail(BOOKING_ERROR_ALERT_EMAIL, subject, details);
  } catch (alertError) {
    console.error('Booking error alert failed:', alertError.message);
  }
}

// Reminders: a scheduled function (see bottom of file) calls this every 15
// minutes rather than the old approach of an in-memory setTimeout per
// booking. A timer waiting in a process's memory doesn't survive that
// process spinning down between requests -- which happens constantly on
// serverless/free-tier hosting -- so reminders are now computed fresh each
// run by scanning confirmed bookings in Firestore. remindersSent on each
// booking document stops a window firing more than once across runs.
const REMINDER_WINDOWS = [
  { key: 'oneDay', ms: 24 * 60 * 60 * 1000, label: '1 day' },
  { key: 'oneHour', ms: 60 * 60 * 1000, label: '1 hour' }
];
const REMINDER_DELIVERY_WINDOW_MS = 20 * 60 * 1000;

async function checkAndSendReminders() {
  const db = getFirestore();
  if (!db) {
    console.log('[reminders] Firestore not configured, skipping reminder check');
    return;
  }
  const snapshot = await db.collection(BOOKINGS_COLLECTION).where('status', '==', 'confirmed').get();
  const now = Date.now();

  for (const doc of snapshot.docs) {
    const booking = doc.data();
    const start = new Date(booking.start).getTime();
    if (Number.isNaN(start) || start <= now) continue;
    const sent = booking.remindersSent || {};

    for (const window of REMINDER_WINDOWS) {
      if (sent[window.key]) continue;
      const fireAt = start - window.ms;
      // The scheduled worker runs every 15 minutes. Only send within a small
      // grace period after the intended moment so a "1 day to go" reminder
      // never arrives hours late merely because an earlier run was missed.
      if (now < fireAt || now > fireAt + REMINDER_DELIVERY_WINDOW_MS) continue;

      const message = `Reminder: your Cameron & Co ${booking.service} appointment is in ${window.label}. Manage: ${manageUrl(booking)}`;
      const reminderLabel = `Appointment reminder (${window.label} to go)`;
      try {
        await Promise.all([
          sendEmail(
            booking.email,
            `Cameron & Co appointment reminder: ${window.label}`,
            bookingText(booking, reminderLabel),
            bookingHtml(booking, reminderLabel)
          ),
          sendSms(booking.phone, message)
        ]);
        await doc.ref.update({ [`remindersSent.${window.key}`]: true });
      } catch (error) {
        console.error('Reminder send error:', error.message);
      }
    }
  }
}

// Token Caching Variables
let cachedToken = null;
let tokenExpiryTime = null;

/**
 * Authenticates with Nivoda and retrieves a Bearer Token.
 */
async function getNivodaToken() {
  const currentTime = Date.now();
  
  // Return cached token if valid (expires in 6 hours, we refresh after 5.5 hours to be safe)
  if (cachedToken && tokenExpiryTime && currentTime < tokenExpiryTime) {
    return cachedToken;
  }

  console.log('Fetching new Nivoda authentication token...');
  const query = `
    query Authenticate($username: String!, $password: String!) {
      authenticate {
        username_and_password(username: $username, password: $password) {
          token
        }
      }
    }
  `;

  try {
    const response = await fetch(NIVODA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { username: NIVODA_USERNAME, password: NIVODA_PASSWORD }
      })
    });

    const result = await response.json();
    if (result.errors) {
      throw new Error(result.errors[0].message);
    }

    const token = result.data?.authenticate?.username_and_password?.token;
    if (!token) {
      throw new Error('Failed to retrieve token from authentication response.');
    }

    // Cache the token
    cachedToken = token;
    tokenExpiryTime = Date.now() + (5.5 * 60 * 60 * 1000); // 5.5 hours from now
    console.log('Token successfully cached.');
    return cachedToken;
  } catch (error) {
    console.error('Nivoda Authentication Error:', error.message);
    throw error;
  }
}

/**
 * API Route: Search Diamonds
 * Receives search parameters from static frontend, constructs the GraphQL query,
 * applies markups to wholesale pricing, and returns response.
 */
app.post('/api/diamonds', async (req, res) => {
  console.log('Diamond API hit with body:', req.body);
  try {
    const token = await getNivodaToken();
    const { shapes, sizes, color, clarity, limit = 12, offset = 0 } = req.body;

    // Build the query inputs. 
    // In production, map colors and clarities to standard array formats expected by Nivoda
    const filterInput = {
      labgrown: req.body.labgrown || false,
      treated: false, // Default to only untreated natural stones
    };

    if (shapes && shapes.length) filterInput.shapes = shapes;
    if (sizes && sizes.length) filterInput.sizes = sizes;
    if (color && color.length) filterInput.color = color;
    if (clarity && clarity.length) filterInput.clarity = clarity;

    const query = `
      query SearchDiamonds($token: String!, $query: DiamondQuery!, $limit: Int, $offset: Int) {
        as(token: $token) {
          diamonds_by_query(query: $query, limit: $limit, offset: $offset) {
            items {
              id
              price
              diamond {
                id
                image
                video
                certificate {
                  shape
                  carats
                  color
                  clarity
                  cut
                  polish
                  symmetry
                  lab
                  certNumber
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(NIVODA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { token, query: filterInput, limit, offset }
      })
    });

    const result = await response.json();
    if (result.errors) {
      return res.status(400).json({ error: result.errors[0].message });
    }

    const rawItems = result.data?.as?.diamonds_by_query?.items || [];
    
    // Process items: Apply markup factor, convert cents to standard currency
    const processedItems = rawItems.map(item => {
      const stone = item.diamond;
      const cert = stone.certificate || {};
      // Nivoda price is returned in cents (USD/preferred currency).
      const wholesalePriceDollars = (item.price || 0) / 100;
      const retailPriceDollars = Math.round(wholesalePriceDollars * PRICE_MARKUP_FACTOR);

      return {
        id: item.id, // Offer ID needed for orders/holds
        stoneId: stone.id,
        shape: cert.shape || 'ROUND',
        carat: cert.carats || 0.0,
        color: cert.color || 'N/A',
        clarity: cert.clarity || 'N/A',
        cut: cert.cut || 'N/A',
        polish: cert.polish || 'N/A',
        symmetry: cert.symmetry || 'N/A',
        lab: cert.lab || 'N/A',
        certNumber: cert.certNumber || 'N/A',
        price: retailPriceDollars, // Marked up retail price
        image: stone.image,
        video: stone.video
      };
    });

    res.json({ success: true, count: processedItems.length, diamonds: processedItems });
  } catch (error) {
    console.error('Search Route Error:', error.message);
    // Fallback: return empty result set instead of error
    res.json({ success: true, count: 0, diamonds: [] });
  }
});

app.get('/api/health', async (req, res) => {
  const stored = await getEmailSettings();
  const melbourneZoom = await getZoomCredentials('melbourne');
  const sydneyZoom = await getZoomCredentials('sydney');
  res.json({
    success: true,
    integrations: {
      nivoda: Boolean(NIVODA_USERNAME && NIVODA_PASSWORD),
      googleCalendar: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY),
      shopifyCustomerSync: Boolean(process.env.SHOPIFY_SHOP && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET),
      zoomMelbourne: Boolean(melbourneZoom.accountId && melbourneZoom.clientId && melbourneZoom.clientSecret),
      zoomSydney: Boolean(sydneyZoom.accountId && sydneyZoom.clientId && sydneyZoom.clientSecret),
      email: Boolean((stored.host || process.env.SMTP_HOST) && (stored.user || process.env.SMTP_USER) && (stored.password || process.env.SMTP_PASSWORD)),
      completeSms: Boolean(process.env.COMPLETE_SMS_API_URL),
      firestore: Boolean((process.env.GCP_PROJECT_ID && process.env.GCP_CLIENT_EMAIL && process.env.GCP_PRIVATE_KEY) || process.env.K_SERVICE)
    }
  });
});

// Admin settings: lets bookings@cameronco.com.au's SMTP password be rotated
// from a browser instead of editing the deploy-time .env and redeploying.
// Guarded by a shared key (ADMIN_API_KEY) rather than the password itself
// ever being readable back out through the API.
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

function requireAdminKey(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(503).json({ error: 'Admin interface not configured (ADMIN_API_KEY is not set).' });
  }
  if (req.get('X-Admin-Key') !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/email-settings', requireAdminKey, async (req, res) => {
  try {
    const stored = await getEmailSettings();
    res.json({
      success: true,
      settings: {
        host: stored.host || process.env.SMTP_HOST || '',
        port: stored.port || process.env.SMTP_PORT || '587',
        user: stored.user || process.env.SMTP_USER || '',
        fromName: stored.fromName || process.env.SMTP_FROM_NAME || 'Cameron & Co',
        fromEmail: stored.fromEmail || process.env.SMTP_FROM_EMAIL || '',
        passwordSet: Boolean(stored.password || process.env.SMTP_PASSWORD)
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load settings', details: error.message });
  }
});

app.post('/api/admin/email-settings', requireAdminKey, async (req, res) => {
  try {
    const { host, port, user, password, fromName, fromEmail } = req.body || {};
    if (!host || !user) {
      return res.status(400).json({ error: 'Host and user (bookings@cameronco.com.au) are required.' });
    }
    const update = {
      host,
      port: port || '587',
      user,
      fromName: fromName || 'Cameron & Co',
      fromEmail: fromEmail || user
    };
    // Only overwrite the stored password if a new one was actually typed in --
    // leaves it untouched when the admin is just updating the from-name, etc.
    if (password) update.password = password;
    await saveEmailSettings(update);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save settings', details: error.message });
  }
});

app.get('/api/admin/zoom-settings', requireAdminKey, async (req, res) => {
  try {
    const stored = await getZoomSettings();
    const forOffice = (officeKey) => {
      const office = stored[officeKey] || {};
      const prefix = officeKey === 'sydney' ? 'ZOOM_SYDNEY_' : 'ZOOM_MELBOURNE_';
      return {
        accountId: office.accountId || process.env[`${prefix}ACCOUNT_ID`] || '',
        clientId: office.clientId || process.env[`${prefix}CLIENT_ID`] || '',
        userId: office.userId || process.env[`${prefix}USER_ID`] || '',
        clientSecretSet: Boolean(office.clientSecret || process.env[`${prefix}CLIENT_SECRET`])
      };
    };
    res.json({
      success: true,
      settings: {
        melbourne: forOffice('melbourne'),
        sydney: forOffice('sydney')
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load settings', details: error.message });
  }
});

app.post('/api/admin/zoom-settings', requireAdminKey, async (req, res) => {
  try {
    const { office, accountId, clientId, clientSecret, userId } = req.body || {};
    if (office !== 'melbourne' && office !== 'sydney') {
      return res.status(400).json({ error: 'office must be "melbourne" or "sydney".' });
    }
    if (!accountId || !clientId) {
      return res.status(400).json({ error: 'Account ID and Client ID are required.' });
    }
    const stored = await getZoomSettings();
    const officeUpdate = {
      ...(stored[office] || {}),
      accountId,
      clientId,
      userId: userId || ''
    };
    // Only overwrite the stored client secret if a new one was actually typed in --
    // leaves it untouched when the admin is just updating a user ID, etc.
    if (clientSecret) officeUpdate.clientSecret = clientSecret;
    await saveZoomSettings({ [office]: officeUpdate });
    delete zoomTokens[office];
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save settings', details: error.message });
  }
});

app.get('/api/admin/appointment-settings', requireAdminKey, async (req, res) => {
  try {
    const stored = await getServiceSettings();
    const types = Object.keys(DEFAULT_SERVICE_TIMINGS).map((key) => {
      const fallback = DEFAULT_SERVICE_TIMINGS[key];
      const override = stored[key] || {};
      return {
        key,
        label: fallback.label,
        duration: Number.isFinite(Number(override.duration)) ? Number(override.duration) : fallback.duration,
        buffer: Number.isFinite(Number(override.buffer)) ? Number(override.buffer) : fallback.buffer
      };
    });
    res.json({ success: true, types });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load settings', details: error.message });
  }
});

app.post('/api/admin/appointment-settings', requireAdminKey, async (req, res) => {
  try {
    const { key, duration, buffer } = req.body || {};
    if (!DEFAULT_SERVICE_TIMINGS[key]) {
      return res.status(400).json({ error: `Unknown appointment type "${key}".` });
    }
    const durationNum = Number(duration);
    const bufferNum = Number(buffer);
    if (!Number.isFinite(durationNum) || durationNum <= 0) {
      return res.status(400).json({ error: 'Duration must be a positive number of minutes.' });
    }
    if (!Number.isFinite(bufferNum) || bufferNum < 0) {
      return res.status(400).json({ error: 'Buffer must be zero or a positive number of minutes.' });
    }
    await saveServiceSettings({ [key]: { duration: durationNum, buffer: bufferNum } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save settings', details: error.message });
  }
});

app.get('/api/booking/availability', async (req, res) => {
  try {
    const officeKey = officeFor(req.query.office);
    const timing = await getServiceTiming(req.query.service);
    const blockMinutes = timing.duration + timing.buffer;
    const now = new Date();
    const horizon = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
    const busy = await busyTimes(officeKey, now, horizon);
    const slots = [];

    // Slot hours are expressed in each office's own local time. Calendar
    // free/busy determines whether a slot can be booked; include all future
    // slots in the 21-day window, including the rest of today. Checked every
    // SLOT_STEP_MINUTES rather than only on the hour, since appointment
    // types now have different durations -- a 30-minute service can start at
    // :15 or :45, not just on the hour. "buffer" is added to the candidate's
    // own block so the offered slot always leaves that gap before whatever
    // comes next; it isn't part of the customer-facing end time.
    const office = OFFICES[officeKey];
    const nowDt = DateTime.fromJSDate(now, { zone: office.timeZone });
    let cursor = nowDt.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const horizonDt = DateTime.fromJSDate(horizon, { zone: office.timeZone });
    const closeMinutesFromOpen = (17 - 9) * 60;

    while (cursor < horizonDt) {
      const weekday = cursor.weekday; // Luxon: 1 = Monday ... 7 = Sunday
      const minutesFromOpen = (cursor.hour - 9) * 60 + cursor.minute;
      const fitsBeforeClose = minutesFromOpen >= 0 && minutesFromOpen + blockMinutes <= closeMinutesFromOpen;
      if (weekday !== 6 && weekday !== 7 && cursor.hour >= 9 && cursor.hour < 17 && fitsBeforeClose) {
        const start = cursor.toJSDate();
        const blockEnd = addMinutes(start, blockMinutes);
        const overlaps = busy.some((item) => start < new Date(item.end) && blockEnd > new Date(item.start));
        if (start > now && !overlaps) {
          slots.push({ start: start.toISOString(), end: addMinutes(start, timing.duration).toISOString() });
        }
      }
      cursor = cursor.plus({ minutes: SLOT_STEP_MINUTES });
      if (cursor.hour >= 17) {
        cursor = cursor.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
      }
    }

    res.json({ success: true, office: officeKey, service: req.query.service || null, duration: timing.duration, buffer: timing.buffer, slots });
  } catch (error) {
    console.error('Availability error:', error.message);
    await notifyBookingError('Availability lookup', error, { office: req.query.office, service: req.query.service });
    res.status(500).json({ error: 'Unable to load appointment availability', details: error.message });
  }
});

app.post('/api/booking', async (req, res) => {
  let booking;
  try {
    const required = ['name', 'email', 'service', 'slot'];
    const missing = required.filter((field) => !req.body[field]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    const officeKey = officeFor(req.body.office);
    const start = new Date(req.body.slot);
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Invalid appointment slot' });
    const timing = await getServiceTiming(req.body.service);
    const end = addMinutes(start, timing.duration);
    // The calendar event is deliberately blocked longer than the visible
    // appointment (duration + buffer) so free/busy naturally enforces the
    // gap before the next booking, without needing to know other bookings'
    // service types. Customer-facing "end" above stays the true duration.
    const calendarEnd = addMinutes(start, timing.duration + timing.buffer);
    // A slot can become unavailable after the browser first loaded its list
    // (or a request can bypass the page altogether). Re-check Google Calendar
    // immediately before any Zoom meeting or calendar event is created.
    const currentBusy = await busyTimes(officeKey, start, calendarEnd);
    const alreadyBooked = currentBusy.some((item) => start < new Date(item.end) && calendarEnd > new Date(item.start));
    if (alreadyBooked) {
      return res.status(409).json({ error: 'That appointment time is no longer available. Please choose another time.' });
    }

    booking = {
      id: createId('booking'),
      manageToken: createId('manage'),
      office: officeKey,
      service: String(req.body.service),
      name: String(req.body.name),
      email: String(req.body.email),
      phone: req.body.phone ? String(req.body.phone) : '',
      notes: req.body.notes ? String(req.body.notes) : '',
      diamondId: req.body.diamondId ? String(req.body.diamondId) : '',
      start: start.toISOString(),
      end: end.toISOString(),
      calendarEnd: calendarEnd.toISOString(),
      durationMinutes: timing.duration,
      bufferMinutes: timing.buffer,
      calendarSequence: 0,
      status: 'confirmed',
      createdAt: new Date().toISOString()
    };

    const zoom = isVirtualBooking(booking)
      ? await createZoomMeeting(booking)
      : { dryRun: true };
    booking.zoomMeetingId = zoom.meetingId;
    booking.zoomJoinUrl = zoom.joinUrl;

    const calendar = await createCalendarEvent(booking);
    booking.googleEventId = calendar.eventId;
    booking.googleCalendarId = calendar.calendarId;

    const shopifyCustomer = await syncShopifyCustomer(booking).catch((error) => {
      console.error('Shopify customer sync error:', error.message);
      return { skipped: true };
    });
    booking.shopifyCustomerId = shopifyCustomer.customerId;

    await saveBooking(booking.manageToken, booking);
    // The booking itself (Zoom + Calendar + Firestore) already succeeded by
    // this point -- a notification failure (e.g. a broken SMTP cert) shouldn't
    // make the customer-facing response say the whole booking failed.
    await notifyBooking(booking, 'confirmed').catch((error) => {
      console.error('Booking notification error:', error.message);
    });

    res.status(201).json({ success: true, booking: publicBooking(booking), manageToken: booking.manageToken });
  } catch (error) {
    console.error('Booking create error:', error.message);
    // If Zoom succeeded but the subsequent calendar write failed, do not
    // leave an orphaned Zoom meeting behind. (A saved booking has its own
    // normal cancellation path, so only clean up before it has an event ID.)
    if (booking && booking.zoomMeetingId && !booking.googleEventId) {
      await deleteZoomMeeting(booking).catch((cleanupError) => {
        console.error('Booking rollback Zoom cleanup error:', cleanupError.message);
      });
    }
    await notifyBookingError('Booking creation', error, booking || { office: req.body && req.body.office, name: req.body && req.body.name, email: req.body && req.body.email, phone: req.body && req.body.phone, service: req.body && req.body.service });
    const message = isVirtualBooking(req.body || {}) && /Zoom auth returned/.test(error.message)
      ? 'Online booking for virtual appointments is temporarily unavailable'
      : 'Unable to create appointment';
    res.status(500).json({ error: message, details: error.message });
  }
});

app.get('/api/booking/:token', async (req, res) => {
  const booking = await getBooking(req.params.token);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  res.json({ success: true, booking: publicBooking(booking) });
});

app.post('/api/booking/:token/cancel', async (req, res) => {
  let booking;
  try {
    booking = await getBooking(req.params.token);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled') {
      booking.calendarSequence = Number(booking.calendarSequence || 0) + 1;
      await cleanupBookingIntegrations(booking);
      await saveBooking(booking.manageToken, booking);
      await notifyBooking(booking, 'cancelled').catch((error) => {
        console.error('Booking notification error:', error.message);
      });
      return res.json({ success: true, alreadyCancelled: true, cancellationReissued: true, booking: publicBooking(booking) });
    }
    booking.calendarSequence = Number(booking.calendarSequence || 0) + 1;
    booking.status = 'cancelled';
    booking.cancelledAt = new Date().toISOString();
    await cleanupBookingIntegrations(booking);
    await saveBooking(booking.manageToken, booking);
    await notifyBooking(booking, 'cancelled').catch((error) => {
      console.error('Booking notification error:', error.message);
    });
    res.json({ success: true, booking: publicBooking(booking) });
  } catch (error) {
    console.error('Booking cancel error:', error.message);
    await notifyBookingError('Cancellation', error, booking);
    res.status(500).json({ error: 'Unable to cancel appointment', details: error.message });
  }
});

app.post('/api/booking/:token/reschedule', async (req, res) => {
  let booking;
  try {
    booking = await getBooking(req.params.token);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!req.body.slot) return res.status(400).json({ error: 'Missing slot' });
    const start = new Date(req.body.slot);
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Invalid appointment slot' });

    // Legacy bookings made before per-service durations existed won't have
    // durationMinutes/bufferMinutes stored -- fall back to a fresh lookup.
    const timing = (booking.durationMinutes != null && booking.bufferMinutes != null)
      ? { duration: booking.durationMinutes, buffer: booking.bufferMinutes }
      : await getServiceTiming(booking.service);
    booking.start = start.toISOString();
    booking.end = addMinutes(start, timing.duration).toISOString();
    booking.calendarEnd = addMinutes(start, timing.duration + timing.buffer).toISOString();
    booking.durationMinutes = timing.duration;
    booking.bufferMinutes = timing.buffer;
    booking.calendarSequence = Number(booking.calendarSequence || 0) + 1;
    booking.status = 'confirmed';
    booking.updatedAt = new Date().toISOString();
    // Reset so reminders fire again relative to the new time -- otherwise a
    // reminder already sent for the old slot would silently suppress the
    // equivalent reminder for the rescheduled one.
    booking.remindersSent = {};
    await Promise.all([updateCalendarEvent(booking), updateZoomMeeting(booking)]);
    await saveBooking(booking.manageToken, booking);
    await notifyBooking(booking, 'rescheduled').catch((error) => {
      console.error('Booking notification error:', error.message);
    });
    res.json({ success: true, booking: publicBooking(booking) });
  } catch (error) {
    console.error('Booking reschedule error:', error.message);
    await notifyBookingError('Reschedule', error, booking);
    res.status(500).json({ error: 'Unable to reschedule appointment', details: error.message });
  }
});

app.get(['/booking', '/diamonds'], (req, res) => {
  const page = req.path === '/booking' ? 'booking.html' : 'diamonds.html';
  res.sendFile(path.join(__dirname, '..', page));
});

app.get('/admin/email-settings', (req, res) => {
  // Served from __dirname (not '..' like /booking and /diamonds below) so
  // it's actually included in the Cloud Functions deploy bundle, which only
  // packages this proxy-server directory -- the parent HTML Website folder
  // those older routes point at isn't uploaded, so they 404 in production.
  res.sendFile(path.join(__dirname, 'admin-email-settings.html'));
});

app.get('/admin/zoom-settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-zoom-settings.html'));
});

app.get('/admin/appointment-settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-appointment-settings.html'));
});

// Running directly (`node server.js`, e.g. local dev) starts a normal
// always-listening server. Loaded by the Firebase Functions runtime instead
// (require.main !== module in that case), only the exports below matter --
// Functions supplies its own HTTP listener and scheduler.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Cameron & Co. integrations server listening on port ${PORT}`);
  });
}

exports.api = onRequest(app);
exports.sendReminders = onSchedule('every 15 minutes', checkAndSendReminders);
