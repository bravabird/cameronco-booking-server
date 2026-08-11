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
const APPOINTMENT_MINUTES = parseInt(process.env.APPOINTMENT_MINUTES || '45', 10);
const SITE_BASE_URL = process.env.SITE_BASE_URL || `http://localhost:${PORT}`;

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
    address: '73-75 Canterbury Road, Canterbury VIC 3126'
  },
  sydney: {
    label: 'Sydney Office',
    salesEmail: 'nswsales@cameronco.com.au',
    calendarId: process.env.GOOGLE_CALENDAR_SYDNEY_ID,
    zoomUserId: process.env.ZOOM_SYDNEY_USER_ID || process.env.ZOOM_SYDNEY_ROOM_ID,
    address: 'Suite 2, Level 7, 37 York Street, Sydney NSW 2000'
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

function bookingText(booking, action) {
  const office = OFFICES[booking.office];
  const lines = [
    `${action}: ${booking.service}`,
    `Name: ${booking.name}`,
    `When: ${new Date(booking.start).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`,
    `Office: ${office.label}`,
    `Address: ${office.address}`,
    `Zoom: ${booking.zoomJoinUrl || 'To be supplied by the Cameron & Co team'}`,
    `Manage appointment: ${manageUrl(booking)}`,
    booking.notes ? `Notes: ${booking.notes}` : ''
  ];
  return lines.filter(Boolean).join('\n');
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

async function sendEmail(to, subject, text) {
  const transporter = await getSmtpTransporter();
  if (!transporter) {
    console.log('[dry-run email]', { to, subject, text });
    return { dryRun: true };
  }
  const stored = await getEmailSettings();
  const fromName = stored.fromName || process.env.SMTP_FROM_NAME || 'Cameron & Co';
  const fromEmail = stored.fromEmail || process.env.SMTP_FROM_EMAIL || stored.user || process.env.SMTP_USER;
  return transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text,
    html: text.replace(/\n/g, '<br>')
  });
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
    timeZone: 'Australia/Sydney',
    items: [{ id: office.calendarId }]
  });
  return response?.calendars?.[office.calendarId]?.busy || [];
}

async function createCalendarEvent(booking) {
  const office = OFFICES[booking.office];
  if (!office.calendarId) return { dryRun: true };
  const event = {
    summary: `Cameron & Co: ${booking.service} with ${booking.name}`,
    description: bookingText(booking, 'Appointment confirmed'),
    location: office.address,
    start: { dateTime: booking.start, timeZone: 'Australia/Sydney' },
    end: { dateTime: booking.end, timeZone: 'Australia/Sydney' }
  };
  const created = await googleCalendarRequest('POST', `/calendars/${encodeURIComponent(office.calendarId)}/events?sendUpdates=all`, event);
  return { eventId: created.id };
}

async function updateCalendarEvent(booking) {
  const office = OFFICES[booking.office];
  if (!office.calendarId || !booking.googleEventId) return { dryRun: true };
  return googleCalendarRequest('PATCH', `/calendars/${encodeURIComponent(office.calendarId)}/events/${encodeURIComponent(booking.googleEventId)}?sendUpdates=all`, {
    start: { dateTime: booking.start, timeZone: 'Australia/Sydney' },
    end: { dateTime: booking.end, timeZone: 'Australia/Sydney' },
    description: bookingText(booking, 'Appointment updated')
  });
}

async function deleteCalendarEvent(booking) {
  const office = OFFICES[booking.office];
  if (!office.calendarId || !booking.googleEventId) return { dryRun: true };
  return googleCalendarRequest('DELETE', `/calendars/${encodeURIComponent(office.calendarId)}/events/${encodeURIComponent(booking.googleEventId)}?sendUpdates=all`);
}

let zoomToken = null;
let zoomTokenExpiry = 0;

async function getZoomToken() {
  if (zoomToken && Date.now() < zoomTokenExpiry) return zoomToken;
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  if (!accountId || !clientId || !clientSecret) return null;

  const response = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
    }
  });
  if (!response.ok) throw new Error(`Zoom auth returned ${response.status}`);
  const json = await response.json();
  zoomToken = json.access_token;
  zoomTokenExpiry = Date.now() + (json.expires_in - 120) * 1000;
  return zoomToken;
}

async function createZoomMeeting(booking) {
  const office = OFFICES[booking.office];
  const token = await getZoomToken();
  if (!token || !office.zoomUserId) return { dryRun: true };
  const response = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(office.zoomUserId)}/meetings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      topic: `Cameron & Co: ${booking.service}`,
      type: 2,
      start_time: booking.start,
      duration: APPOINTMENT_MINUTES,
      timezone: 'Australia/Sydney',
      settings: { waiting_room: true }
    })
  });
  if (!response.ok) throw new Error(`Zoom meeting returned ${response.status}`);
  const json = await response.json();
  return { meetingId: json.id, joinUrl: json.join_url };
}

async function updateZoomMeeting(booking) {
  const token = await getZoomToken();
  if (!token || !booking.zoomMeetingId) return { dryRun: true };
  const response = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(booking.zoomMeetingId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      start_time: booking.start,
      duration: APPOINTMENT_MINUTES,
      timezone: 'Australia/Sydney'
    })
  });
  if (!response.ok && response.status !== 204) throw new Error(`Zoom update returned ${response.status}`);
  return { success: true };
}

async function deleteZoomMeeting(booking) {
  const token = await getZoomToken();
  if (!token || !booking.zoomMeetingId) return { dryRun: true };
  const response = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(booking.zoomMeetingId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok && response.status !== 204) throw new Error(`Zoom delete returned ${response.status}`);
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

async function notifyBooking(booking, action) {
  const office = OFFICES[booking.office];
  const subject = `Cameron & Co appointment ${action}: ${booking.service}`;
  const text = bookingText(booking, `Appointment ${action}`);
  await Promise.all([
    sendEmail(booking.email, subject, text),
    sendEmail(office.salesEmail, subject, text)
  ]);
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
      if (now < fireAt) continue;

      const message = `Reminder: your Cameron & Co ${booking.service} appointment is in ${window.label}. Manage: ${manageUrl(booking)}`;
      try {
        await Promise.all([
          sendEmail(booking.email, `Cameron & Co appointment reminder: ${window.label}`, message),
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
  res.json({
    success: true,
    integrations: {
      nivoda: Boolean(NIVODA_USERNAME && NIVODA_PASSWORD),
      googleCalendar: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY),
      shopifyCustomerSync: Boolean(process.env.SHOPIFY_SHOP && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET),
      zoom: Boolean(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET),
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

app.get('/api/booking/availability', async (req, res) => {
  try {
    const officeKey = officeFor(req.query.office);
    const now = new Date();
    const horizon = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
    const busy = await busyTimes(officeKey, now, horizon);
    const slots = [];

    // Business hours are always Sydney-local (9am-5pm, Mon-Fri) regardless
    // of the server's own timezone -- plain Date.setHours() etc. operate in
    // the server's local zone, which broke this outright once the server
    // moved from a local/AU machine to Firebase Functions running in
    // us-central1: "9am" became 9am US Central, landing in the middle of
    // the Sydney night. Luxon with an explicit zone avoids that regardless
    // of where this ends up hosted next, DST included.
    let cursor = DateTime.fromJSDate(now, { zone: 'Australia/Sydney' })
      .plus({ days: 1 })
      .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const horizonDt = DateTime.fromJSDate(horizon, { zone: 'Australia/Sydney' });

    while (cursor < horizonDt && slots.length < 24) {
      const weekday = cursor.weekday; // Luxon: 1 = Monday ... 7 = Sunday
      const hour = cursor.hour;
      if (weekday !== 6 && weekday !== 7 && hour >= 9 && hour < 17) {
        const start = cursor.toJSDate();
        const end = addMinutes(start, APPOINTMENT_MINUTES);
        const overlaps = busy.some((item) => start < new Date(item.end) && end > new Date(item.start));
        if (!overlaps) slots.push({ start: start.toISOString(), end: end.toISOString() });
      }
      cursor = cursor.plus({ minutes: 60 });
      if (cursor.hour >= 17) {
        cursor = cursor.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
      }
    }

    res.json({ success: true, office: officeKey, slots });
  } catch (error) {
    console.error('Availability error:', error.message);
    res.status(500).json({ error: 'Unable to load appointment availability', details: error.message });
  }
});

app.post('/api/booking', async (req, res) => {
  try {
    const required = ['name', 'email', 'service', 'slot'];
    const missing = required.filter((field) => !req.body[field]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    const officeKey = officeFor(req.body.office);
    const start = new Date(req.body.slot);
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Invalid appointment slot' });

    const booking = {
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
      end: addMinutes(start, APPOINTMENT_MINUTES).toISOString(),
      status: 'confirmed',
      createdAt: new Date().toISOString()
    };

    const zoom = await createZoomMeeting(booking);
    booking.zoomMeetingId = zoom.meetingId;
    booking.zoomJoinUrl = zoom.joinUrl;

    const calendar = await createCalendarEvent(booking);
    booking.googleEventId = calendar.eventId;

    const shopifyCustomer = await syncShopifyCustomer(booking).catch((error) => {
      console.error('Shopify customer sync error:', error.message);
      return { skipped: true };
    });
    booking.shopifyCustomerId = shopifyCustomer.customerId;

    await saveBooking(booking.manageToken, booking);
    await notifyBooking(booking, 'confirmed');

    res.status(201).json({ success: true, booking: publicBooking(booking), manageToken: booking.manageToken });
  } catch (error) {
    console.error('Booking create error:', error.message);
    res.status(500).json({ error: 'Unable to create appointment', details: error.message });
  }
});

app.get('/api/booking/:token', async (req, res) => {
  const booking = await getBooking(req.params.token);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  res.json({ success: true, booking: publicBooking(booking) });
});

app.post('/api/booking/:token/cancel', async (req, res) => {
  try {
    const booking = await getBooking(req.params.token);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    booking.status = 'cancelled';
    booking.cancelledAt = new Date().toISOString();
    await Promise.all([deleteCalendarEvent(booking), deleteZoomMeeting(booking)]);
    await saveBooking(booking.manageToken, booking);
    await notifyBooking(booking, 'cancelled');
    res.json({ success: true, booking: publicBooking(booking) });
  } catch (error) {
    console.error('Booking cancel error:', error.message);
    res.status(500).json({ error: 'Unable to cancel appointment', details: error.message });
  }
});

app.post('/api/booking/:token/reschedule', async (req, res) => {
  try {
    const booking = await getBooking(req.params.token);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!req.body.slot) return res.status(400).json({ error: 'Missing slot' });
    const start = new Date(req.body.slot);
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Invalid appointment slot' });

    booking.start = start.toISOString();
    booking.end = addMinutes(start, APPOINTMENT_MINUTES).toISOString();
    booking.status = 'confirmed';
    booking.updatedAt = new Date().toISOString();
    // Reset so reminders fire again relative to the new time -- otherwise a
    // reminder already sent for the old slot would silently suppress the
    // equivalent reminder for the rescheduled one.
    booking.remindersSent = {};
    await Promise.all([updateCalendarEvent(booking), updateZoomMeeting(booking)]);
    await saveBooking(booking.manageToken, booking);
    await notifyBooking(booking, 'rescheduled');
    res.json({ success: true, booking: publicBooking(booking) });
  } catch (error) {
    console.error('Booking reschedule error:', error.message);
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
