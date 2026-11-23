import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager, memoryLocalCache,
  doc, collection, setDoc, updateDoc, getDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp, writeBatch, arrayUnion, getDocFromServer, Timestamp, deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
// Staff pages (board/admin) keep an offline cache owned by this tab so moves survive Wi-Fi drops.
// Guest pages use an in-memory cache: a direct live connection with no cross-tab relay, so updates land in about a second.
const staffView = /^#\/(board|admin)/.test(location.hash);
const db = initializeFirestore(fb, {
  // Long-polling instead of a streaming connection: venue Wi-Fi, proxies and some phone/browser filters
  // buffer streams, which delays live updates by many seconds.
  experimentalForceLongPolling: true,
  localCache: staffView ? persistentLocalCache({ tabManager: persistentSingleTabManager({ forceOwnership: true }) }) : memoryLocalCache()
});

// ---------- catalog ----------
// One shared catalog in /config/catalog: categories → pieces → option groups → choices.
// Each event turns pieces and single choices on or off. Ids never change once made, so
// old orders and photos keep matching when a label is renamed.
const DETAIL = () => ({ id: 'addon', label: 'Embellishment', swatch: false, choices: [{ id: 'none', label: 'None' }, { id: 'stars', label: 'Stars' }, { id: 'heart', label: 'Heart' }, { id: 'flowers', label: 'Flowers' }] });
// Little drawings on the embellishment pills.
const EMB_ICON = {
  stars: '<svg class="embi" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.6 6.6L21 9l-5 4.4L17.6 21 12 17.3 6.4 21 8 13.4 3 9l6.4-.4z" fill="currentColor"/></svg>',
  heart: '<svg class="embi" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21C5 15.5 2 12.3 2 8.5 2 5.4 4.4 3 7.4 3c1.8 0 3.5.9 4.6 2.3C13.1 3.9 14.8 3 16.6 3 19.6 3 22 5.4 22 8.5c0 3.8-3 7-10 12.5z" fill="currentColor"/></svg>',
  flowers: '<svg class="embi" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="12" cy="6" r="3.6"/><circle cx="17.7" cy="10.2" r="3.6"/><circle cx="15.5" cy="17" r="3.6"/><circle cx="8.5" cy="17" r="3.6"/><circle cx="6.3" cy="10.2" r="3.6"/></g><circle cx="12" cy="12" r="2.6" fill="#fff"/></svg>',
  heart_outline: ''
};
const embIcon = (g, c) => g && g.id === 'addon' ? (EMB_ICON[c.id] || '') : '';
const DEFAULT_CATALOG = { categories: [
  { id: 'engraving', label: 'Engraving', items: [
    { id: 'bagtag', label: 'Leather bag tag', material: 'leather', preview: 'bagtag', groups: [
      { id: 'color', label: 'Color', swatch: true, choices: [{ id: 'black', label: 'Black', color: '#1d1b1a' }, { id: 'tan', label: 'Tan', color: '#a86b43' }, { id: 'blush', label: 'Blush', color: '#d9aa98' }] }, DETAIL()] },
    { id: 'tumbler', label: 'Tumbler', material: 'stainless steel', preview: 'tumbler', groups: [
      { id: 'color', label: 'Color', swatch: true, choices: [{ id: 'black', label: 'Black', color: '#1d1b1a' }, { id: 'white', label: 'White', color: '#efece6' }, { id: 'terracotta', label: 'Terracotta', color: '#b9623f' }] }, DETAIL()] }] },
  { id: 'calligraphy', label: 'Calligraphy', items: [] }] };
let CAT = DEFAULT_CATALOG, catLoading = null;
// Saved catalogs keep their old wording; rename the two defaults in place (only when untouched).
function relabel(cat) {
  cat.categories.forEach(c => (c.items || []).forEach(it => (it.groups || []).forEach(g => {
    if (g.id === 'addon' && g.label === 'Detail') g.label = 'Embellishment';
    if (g.id === 'addon') g.choices.forEach(x => { if (x.id === 'none' && x.label === 'Name only') x.label = 'None'; });
    if (g.id === 'color' && g.label === 'Leather') g.label = 'Color';
  })));
}
function loadCatalog(force = false) {
  if (!catLoading || force) catLoading = getDoc(doc(db, 'config', 'catalog'))
    .then(s => { const c = s.exists() && s.data().categories; if (Array.isArray(c)) { CAT = { categories: c }; relabel(CAT); }  }).catch(() => {});
  return catLoading;
}
const FONTS = { script: 'Script', serif: 'Print' };
const SWATCH = { black: '#1d1b1a', tan: '#a86b43', blush: '#d9aa98', white: '#efece6', terracotta: '#b9623f' };
const STATUS_LABEL = { queue: 'Waiting', progress: 'Engraving', done: 'Ready for pickup', picked: 'Picked up' };
const WAVE = w => `<svg class="wave" viewBox="0 0 ${w} 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 15 C ${w * .23} 0 ${w * .44} 28 ${w * .64} 11 S ${w * .92} 5 ${w} 15 L${w} 24 L0 24Z" fill="#fff8f0"/></svg>`;
const LOGO = `<img class="logo" src="logo.png" alt="Ivelisse Designs">`;
// Instagram link, top right of every guest-facing header.
const IG = `<a class="iglink" href="https://www.instagram.com/ivelissedesigns/" target="_blank" rel="noopener" aria-label="Ivelisse Designs on Instagram"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none"/></svg></a>`;

// ---------- helpers ----------
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortId = id => id.slice(-4).toUpperCase();
// US mobile numbers only: returns +1XXXXXXXXXX, '' when empty, or null when it isn't a valid number.
// Accepts 10 to 13 digits. A US number is 10 digits, or 11 with a leading 1 (never more after the 1).
// Other country codes pass through as +digits. Texts only go to US numbers.
const normPhone = v => {
  const d = String(v || '').replace(/\D/g, ''); if (!d) return '';
  if (d.length < 10 || d.length > 13) return null;
  if (d[0] === '1') return d.length === 11 && /^1[2-9]\d{2}[2-9]\d{6}$/.test(d) ? '+' + d : null;
  if (d.length === 10) return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? '+1' + d : null;
  return '+' + d;
};
const fmtPhone = e => { const d = String(e || '').replace(/^\+1/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e; };
const fmtDate = d => { if (!d) return ''; const t = new Date(d + 'T12:00:00'); return isNaN(t) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
const fmtTime = d => d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase() : '';
const tsDate = t => (t && typeof t.toDate === 'function') ? t.toDate() : (typeof t === 'number' ? new Date(t) : null);
let unsubs = [], timers = [];
// Per-event colors for the guest pages: header band and buttons. Defaults are the Ivelisse colors.
const THEME_DEFAULT = { band: '#b85c3a', ink: '#a9532f' };
const THEME_SWATCHES = ['#b85c3a', '#a9532f', '#8a5341', '#be836f', '#d9aa98', '#c0392b', '#8e1b2e', '#6b2737', '#7a4069', '#4b2e5a',
  '#2c3e66', '#1f4e79', '#2f6f8f', '#2f6b5e', '#3f6b4a', '#6b7a3a', '#b08d3c', '#c98a2b', '#5b4636', '#3a3a3a', '#1d1b1a', '#9aa3a8'];
const hexOk = h => /^#[0-9a-f]{6}$/i.test(h || '');
const themeOf = ev => ({ band: hexOk(ev?.theme?.band) ? ev.theme.band : THEME_DEFAULT.band, ink: hexOk(ev?.theme?.ink) ? ev.theme.ink : THEME_DEFAULT.ink });
// Too light for white text on top of it?
const tooLight = h => { const n = parseInt(h.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2] > .4; };
function applyTheme(ev) { const r = document.documentElement.style, m = document.querySelector('meta[name="theme-color"]');
  if (!ev) { r.removeProperty('--band'); r.removeProperty('--ink'); if (m) m.content = THEME_DEFAULT.band; return; }
  const t = themeOf(ev); r.setProperty('--band', t.band); r.setProperty('--ink', t.ink); if (m) m.content = t.band; }
const cleanup = () => { applyTheme(null); document.querySelectorAll('.toast').forEach(t => t.remove()); photoRerender = null; unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; timers.forEach(clearInterval); timers = []; };
function toast(msg, action) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { action.run(); t.remove(); };
  document.body.appendChild(t); setTimeout(() => t.remove(), action ? 10000 : 2800);
}
const baseUrl = () => location.href.split('#')[0];
function driveToDirect(url) {
  const m = String(url).match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
  return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w900` : String(url).trim();
}
const allPieces = () => CAT.categories.flatMap(c => c.items.map(it => ({ cat: c, it })));
const pieceDef = id => allPieces().find(p => p.it.id === id) || null;
// Orders before the catalog change stored color/addon directly instead of opts.
const optsOf = o => o.opts || { color: o.color, addon: o.addon };
// An event lists the pieces it offers (new catalog pieces don't appear in it by surprise) and the choices it hides.
const offered = (ev, id) => !ev?.items || ev.items[id] === true;
const choicesFor = (ev, it, g) => g.choices.filter(c => !(ev?.hidden || {})[`${it.id}/${g.id}/${c.id}`]);
// Questions this event asks (an event can leave a question out without deleting it).
const groupsFor = (ev, it) => it.groups.filter(g => !(ev?.hidden || {})[`${it.id}/${g.id}`]);
const firstOpts = (ev, it) => Object.fromEntries(it.groups.map(g => [g.id, (choicesFor(ev, it, g)[0] || g.choices[0] || {}).id]));
const pieceLabel = o => o.labels?.piece || pieceDef(o.item)?.it.label || o.item || '';
function choiceLabels(o) { // [{ g: group label, c: choice label, id }]
  if (o.labels?.opts) return o.labels.opts;
  const p = pieceDef(o.item), op = optsOf(o);
  if (!p) return Object.entries(op).filter(([, v]) => v).map(([g, v]) => ({ g, c: v, id: v }));
  return p.it.groups.filter(g => op[g.id] != null).map(g => { const ch = g.choices.find(c => c.id === op[g.id]); return { g: g.label, c: ch ? ch.label : op[g.id], id: op[g.id] }; });
}
// Example photos live in /photos/{key}, shared by every event. A piece's photos follow its first two
// option groups: piece_choice1, or piece_choice1_choice2 (a "none" second choice uses the shorter key).
// Each photo is fetched the first time a screen needs it, so a guest's phone only downloads what it shows.
const photoLib = {};       // key -> image data URL, or null once we know there is none
let photoRerender = null;  // the open page's redraw, run when a photo arrives
// How each photo sits in its square frame: z = zoom (1 = full width), x/y = offset in % of the frame.
const photoFits = {};
const fitVars = f => `--z:${+(f && f.z) || 1};--x:${+(f && f.x) || 0};--y:${+(f && f.y) || 0}`;
const photoImg = (src, key) => `<img class="pfit" src="${esc(src)}" alt="" loading="lazy" style="${fitVars(photoFits[key])}">`;
function takePhoto(key, s) { const d = s.exists() ? s.data() : null; photoLib[key] = d ? (d.data || null) : null; photoFits[key] = d ? (d.fit || null) : null; }
let photoTimer = null;
// Photos are per event: events/{id}/public/photo_{key}. An event without its own photo for a key
// falls back to the shared library in /photos/{key}. Copying an event copies its photos.
let photoEvent = null; const photoOwn = {};
const evPhotoRef = (e, k) => doc(db, 'events', e, 'public', 'photo_' + k);
function setPhotoEvent(id) { if (id === photoEvent) return; photoEvent = id || null; [photoLib, photoFits, photoOwn].forEach(m => Object.keys(m).forEach(k => delete m[k])); }
async function fetchPhoto(key) {
  if (photoEvent) { const e = await getDoc(evPhotoRef(photoEvent, key)); if (e.exists()) { photoOwn[key] = true; return e; } }
  photoOwn[key] = false; return getDoc(doc(db, 'photos', key));
}
function requestPhoto(key) {
  if (key in photoLib) return;
  photoLib[key] = undefined;
  fetchPhoto(key).then(s => {
    takePhoto(key, s);
    if (photoLib[key]) { clearTimeout(photoTimer); photoTimer = setTimeout(() => photoRerender && photoRerender(), 60); }
  }).catch(() => { photoLib[key] = null; });
}
function photoKeys(o) {
  const p = pieceDef(o.item), op = optsOf(o);
  const [g1, g2] = p ? p.it.groups : [{ id: 'color' }, { id: 'addon' }];
  const v1 = g1 && op[g1.id], v2 = g2 && op[g2.id];
  return [...new Set([v1 && v2 && v2 !== 'none' ? `${o.item}_${v1}_${v2}` : null, v1 ? `${o.item}_${v1}` : null, o.item].filter(Boolean))];
}
function photoHit(ev, o) {
  const p = (ev && ev.photos) || {}; // older events may still hold pasted photo links
  for (const k of photoKeys(o)) { if (p[k]) return { src: p[k], key: k }; requestPhoto(k); if (photoLib[k]) return { src: photoLib[k], key: k }; }
  return null;
}
const photoFor = (ev, o) => photoHit(ev, o)?.src || null;
function previewHTML(ev, o, withName = true) {
  const hit = photoHit(ev, o);
  if (hit) return photoImg(hit.src, hit.key);
  const p = pieceDef(o.item), op = optsOf(o);
  const sg = p?.it.groups.find(g => g.swatch), ch = sg && sg.choices.find(c => c.id === op[sg.id]);
  const kind = p?.it.preview || (o.item === 'tumbler' || o.item === 'bagtag' ? o.item : 'card');
  const mark = Object.values(op).find(v => v === 'stars' || v === 'heart') || 'none';
  return window.EngravePreview.renderPreview({ item: kind, color: sg ? op[sg.id] : op.color, hex: ch?.color, addon: mark, name: withName ? o.name : '', font: o.font });
}
function describe(ev, o) {
  const parts = choiceLabels(o).filter(x => x.id !== 'none').map(x => String(x.c).toLowerCase());
  const pl = pieceLabel(o).toLowerCase();
  return parts.length ? [`${parts[0]} ${pl}`, ...parts.slice(1)].join(' • ') : pl;
}
const myOrdersKey = id => 'eb-mine-' + id;
function myOrders(eventId) { try { return JSON.parse(localStorage.getItem(myOrdersKey(eventId)) || '[]'); } catch (e) { return []; } }
function rememberOrder(eventId, o) { try { const a = myOrders(eventId).filter(x => x.id !== o.id); a.unshift(o); localStorage.setItem(myOrdersKey(eventId), JSON.stringify(a.slice(0, 8))); } catch (e) {} }

// ---------- auth ----------
let user = null;
const authReady = new Promise(res => { let first = true; onAuthStateChanged(auth, u => { user = u; if (first) { first = false; res(); } }); });
async function ensureGuest() { await authReady; if (!user) { const c = await signInAnonymously(auth); user = c.user; } return user; }
async function isStaff() {
  await authReady;
  if (!user || user.isAnonymous || !user.email) return false;
  try { return (await getDoc(doc(db, 'staff', user.email))).exists(); } catch (e) { return false; }
}
// Event setup, catalog and photos are for the managers (Google accounts listed in /staff).
async function staffGate(render) {
  if (await isStaff()) return render();
  $app.innerHTML = `<div class="page"><header class="band">${LOGO}<div class="ev">event setup</div>${WAVE(390)}</header>
    <main class="content">${crumbs([['Events', '#/'], ['Event setup', '#/admin'], ['Sign in']])}<h1>event <em>setup</em></h1>
    <p class="note">${user && !user.isAnonymous ? `${esc(user.email)} can't open event setup.` : "Sign in with Steph's Google account."}</p>
    <button class="btn" id="g" type="button">Sign in with Google</button>
    ${user && !user.isAnonymous ? '<button class="btn out" id="out" type="button">Sign out</button>' : ''}
    <p class="note" style="font-size:.8125rem">On an iPad home-screen app, if the sign-in window doesn't open, open this page in Safari once and sign in there.</p></main></div>`;

  document.getElementById('g').onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); route(); }
    catch (e) { toast('Sign-in did not finish: ' + (e.code || e.message)); }
  };
  const out = document.getElementById('out'); if (out) out.onclick = () => signOut(auth).then(route);
}

// Event staff: tap the event, enter the staff PIN once on this device, then pick your name.
// Each event has its own PIN (set in its setup). The database rules check it, and only while the event is open.
const staffKey = id => 'eb-staff-' + id;
function staffName(id) { try { return localStorage.getItem(staffKey(id)) || ''; } catch (e) { return ''; } }
function setStaffName(id, n) { try { localStorage.setItem(staffKey(id), n); } catch (e) {} }
const newPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
// Each event has its own staff PIN, set in that event's setup.
const pinRef = id => doc(db, 'events', id, 'private', 'access');
async function loadPin(id) { // managers only
  const s = await getDoc(pinRef(id));
  if (s.exists() && s.data().pin) return s.data().pin;
  // Events from before per-event PINs start with the old shared PIN, if there was one.
  let p = ''; try { const old = await getDoc(doc(db, 'private', 'access')); p = old.exists() ? (old.data().pin || '') : ''; } catch (e) {}
  p = p || newPin(); await setDoc(pinRef(id), { pin: p, updatedAt: serverTimestamp() }); return p;
}
// Events running now: whatever is switched Open in its setup. Date doesn't matter, so nothing appears
// or disappears on its own. Closest date first, then by name. Two can run at once.
function openEvents(evs) {
  const today = todayStr();
  const dist = e => Math.abs(new Date((e.date || today) + 'T12:00:00') - new Date(today + 'T12:00:00'));
  return evs.filter(e => e.id !== DEMO_ID && e.open !== false)
    .sort((a, b) => dist(a) - dist(b) || String(a.name).localeCompare(String(b.name)));
}
async function canWorkBoard(eventId) {
  if (eventId === DEMO_ID || await isStaff()) return true;
  if (!user) return false;
  try { return (await getDocFromServer(doc(db, 'events', eventId, 'staffSessions', user.uid))).exists(); }
  catch (e) { try { return (await getDoc(doc(db, 'events', eventId, 'staffSessions', user.uid))).exists(); } catch (x) { return false; } }
}
async function boardGate(eventId) {
  await authReady;
  if (eventId === DEMO_ID) await ensureGuest();
  if (await canWorkBoard(eventId)) return boardPage(eventId);
  location.replace(`${baseUrl()}#/staff/${encodeURIComponent(eventId)}`);
}

// Managers previewing the guest side, or on the board, always get a way back to the event's setup.
const POV_KEY = 'eb-pov';
const povOn = id => { try { return sessionStorage.getItem(POV_KEY) === id; } catch (e) { return false; } };
const setPov = id => { try { id ? sessionStorage.setItem(POV_KEY, id) : sessionStorage.removeItem(POV_KEY); } catch (e) {} };
// The Ivelisse Designs logo leads back to Events (the staff home), instead of a button on screen.
let logoHref = null;
function setupPill() {
  logoHref = '#/'; document.body.classList.add('logolink');
  unsubs.push(() => { logoHref = null; document.body.classList.remove('logolink'); });
}
document.addEventListener('click', e => { const l = e.target.closest('.logo'); if (l && logoHref) { e.preventDefault(); location.hash = logoHref; } });

// Smart sizing: 1–3 items stack full width and share the screen; 4 or more become a two-across grid.
const smart = n => `smart n${Math.max(1, Math.min(n, 4))}`;

// Breadcrumbs: [[label, href], …, [label]] — the last one is where you are.
const crumbs = list => `<nav class="crumbs" aria-label="Breadcrumb">${list.map(([l, h], i) => i < list.length - 1 && h ? `<a href="${h}">${esc(l)}</a>` : `<span aria-current="page">${esc(l)}</span>`).join('<i aria-hidden="true">›</i>')}</nav>`;

// Events home → tap an event → staff PIN → pick your name (the event's guest QR shows here) → board.
async function staffSignIn(eventId, step) {
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  await authReady;
  const mgr = await isStaff();
  const head = `<header class="band">${LOGO}<div class="ev">events</div>${WAVE(390)}</header>`;
  const setupLink = `<a class="barlink" href="#/admin">Event setup</a>`;

  if (!eventId) {
    let live = [];
    try { live = openEvents(await listEvents()); } catch (e) {}
    $app.innerHTML = `<div class="page">${head}<main class="content">${crumbs([['Events']])}
      ${live.length ? `<div class="evpick tall ${smart(live.length)}">${live.map(e => `<a href="#/staff/${encodeURIComponent(e.id)}"><b>${esc(e.name)}</b><small>${esc(fmtDate(e.date))}</small></a>`).join('')}</div>`
        : `<div class="rule"></div><h1>no event is <em>open</em></h1>`}
      </main><div class="bar stack">${setupLink}</div></div>`;
    return;
  }

  let ev = null;
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) {}
  applyTheme(ev);
  if (!ev) { location.replace(`${baseUrl()}#/`); return; }
  const trail = [['Events', '#/'], [ev.name, `#/staff/${encodeURIComponent(eventId)}`]];
  // Everyone signs in the same way, Steph and DeVaughn included: event, PIN, then name.
  // The PIN is asked every time someone comes in through Events; only the name step right after it skips it.
  const pinKey = 'eb-pinok-' + eventId;
  let signedIn = eventId === DEMO_ID;
  if (!signedIn && step === 'who') { try { signedIn = sessionStorage.getItem(pinKey) === '1'; } catch (e) {} }
  if (!signedIn && step === 'who') { location.replace(`${baseUrl()}#/staff/${encodeURIComponent(eventId)}`); return; }
  try { if (step !== 'who') sessionStorage.removeItem(pinKey); } catch (e) {}
  // A device that already signed in to this event can still see the closed message's way out below.
  let hadSession = false;
  if (ev.open === false && user) { try { hadSession = (await getDoc(doc(db, 'events', eventId, 'staffSessions', user.uid))).exists(); } catch (x) {} }

  if (ev.open === false && hadSession) return boardPage(eventId); // already signed in: finish up on the board
  if (ev.open === false) {
    $app.innerHTML = `<div class="page">${head}<main class="content">${crumbs([trail[0], [ev.name]])}<div class="rule"></div><h1>this event is <em>closed</em></h1></main><div class="bar stack">${setupLink}</div></div>`;
    return;
  }

  // Step 1: the PIN (skipped once this device is in, and for Steph and DeVaughn).
  if (!signedIn) {
    const st = { pin: '', busy: false, err: '' };
    const render = () => {
      $app.innerHTML = `<div class="page">${head}<main class="content">${crumbs([trail[0], [ev.name]])}
        <div class="evnow"><h1>${esc(ev.name)}</h1><p class="note">${esc(fmtDate(ev.date))}</p></div>
        <div class="field"><label class="lbl" for="pin" style="text-align:center">Staff PIN</label>
          <input id="pin" class="pinfield" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" value="${esc(st.pin)}"></div>
        <p class="err" role="alert">${esc(st.err)}</p></main>
        <div class="bar stack"><button class="btn" id="go" type="button" ${st.busy || st.pin.length !== 4 ? 'disabled' : ''}>${st.busy ? 'Checking…' : 'Continue'}</button></div></div>`;
      const p = document.getElementById('pin'); p.focus();
      p.oninput = () => { st.pin = p.value.replace(/\D/g, '').slice(0, 4); p.value = st.pin; st.err = ''; document.getElementById('go').disabled = st.pin.length !== 4; if (st.pin.length === 4) go(); };
      document.getElementById('go').onclick = go;
    };
    const go = async () => {
      if (st.busy) return; st.busy = true; render();
      try {
        await ensureGuest();
        await setDoc(doc(db, 'events', eventId, 'staffSessions', user.uid), { pin: st.pin, at: serverTimestamp() });
        try { sessionStorage.setItem(pinKey, '1'); } catch (x) {}
        location.hash = `#/staff/${encodeURIComponent(eventId)}/who`;
      } catch (e) { st.busy = false; st.pin = ''; st.err = e.code === 'permission-denied' ? "That PIN doesn't match." : 'Could not sign in: ' + (e.code || e.message); render(); }
    };
    render();
    return;
  }

  // Step 2: who are you? The guest QR for this event sits right here to show guests.
  const names = ev.engravers || [];
  const url = guestUrl(eventId);
  $app.innerHTML = `<div class="page">${head}<main class="content">${crumbs([...trail, ['Who are you?']])}
    <fieldset><legend>who are <em>you?</em></legend>
      <div class="namegrid ${smart(names.length)}">${names.map(n => `<button type="button" data-nm="${esc(n)}">${esc(n)}</button>`).join('') || '<p class="note">No staff names on this event yet.</p>'}</div></fieldset>
    <section class="eventqr"><div class="qr" aria-label="QR code guests scan to order">${qrSvg(url)}</div><div><b>Guests scan to order</b><span>${esc(ev.name)}</span><button class="btn out" id="dlqr" type="button">Download QR</button></div></section>
    </main></div>`;
  document.getElementById('dlqr').onclick = () => downloadQr(url, eventId);
  $app.querySelectorAll('[data-nm]').forEach(b => b.onclick = () => { setStaffName(eventId, b.dataset.nm); location.hash = `#/board/${encodeURIComponent(eventId)}`; });
}

// The one guest QR: always opens whichever event is open now.
async function goToCurrent() {
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  let live = [];
  try { live = openEvents(await listEvents()); } catch (e) {}
  // Guests arrive from an event QR or a shared link; this fallback just opens the closest open event.
  if (live.length) { location.replace(`${baseUrl()}#/e/${encodeURIComponent(live[0].id)}`); return; }
  if (live.length > 1) {
    $app.innerHTML = `<div class="page"><header class="band">${IG}${LOGO}${WAVE(390)}</header><main class="content"><div class="rule"></div><h1>which event are <em>you at?</em></h1>
      <div class="evpick tall ${smart(live.length)}">${live.map(e => `<a href="#/e/${encodeURIComponent(e.id)}"><b>${esc(e.name)}</b><small>${esc(fmtDate(e.date))}</small></a>`).join('')}</div></main></div>`;
    return;
  }
  $app.innerHTML = `<div class="page"><header class="band">${IG}${LOGO}${WAVE(390)}</header><main class="content"><div class="rule"></div><h1>see you at the <em>next event</em></h1>
    <p class="note">We're not taking orders right now.</p></main></div>`;
}

// ---------- router ----------
// Setup and form builder pages set leaveGuard while they hold unsaved changes.
let leaveGuard = null, lastHash = location.hash;
async function route() {
  if (leaveGuard && leaveGuard() && location.hash !== lastHash && !confirm('Leave without saving your changes?')) { history.replaceState(null, '', lastHash || '#/'); return; }
  leaveGuard = null; lastHash = location.hash;
  cleanup();
  const [view, a, b] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  await loadCatalog();
  if (view === 'go') return goToCurrent();
  if (view === 'e' && a) return guestForm(a);
  if (view === 'o' && a && b) return statusPage(a, b);
  if (view === 'board' && a) return boardGate(a);
  if (view === 'admin') return staffGate(() => a ? setupPage(a) : adminPage());
  if (view === 'photos') return staffGate(photosPage);
  if (view === 'catalog') { location.replace(`${baseUrl()}#/admin`); return; }
  return staffSignIn(view === 'staff' ? a : undefined, view === 'staff' ? b : undefined);
}
addEventListener('hashchange', route);

// ---------- guest form ----------
async function guestForm(eventId) {
  setPhotoEvent(eventId);
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  if (povOn(eventId)) setupPill(eventId);
  await ensureGuest();
  let ev = null;
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) {}
  applyTheme(ev);
  const head = () => `<header class="band gband">${IG}${brandCorners(brand)}${brandTop(brand)}<div class="ev">${esc(ev?.name || '')}${ev?.date ? ' · ' + esc(fmtDate(ev.date)) : ''}</div>${WAVE(390)}</header>`;
  if (!ev) { $app.innerHTML = `<div class="page"><main class="content"><h1>event not <em>found</em></h1><p class="note">Check the QR code or ask the engraver.</p></main></div>`; return; }
  let brand = {}; try { const b = await getDoc(brandRef(eventId)); brand = b.exists() ? b.data() : {}; } catch (e) {}
  const mine = myOrders(eventId);
  if (ev.open === false) { $app.innerHTML = `<div class="page">${head(false)}<main class="content"><h1>orders are <em>closed</em></h1><p class="note">Thanks for stopping by. Items already ordered are still being finished.</p>${mineHTML()}${brandBottom(brand)}</main></div>`; return; }

  // Categories with at least one piece this event offers (and every option group still has a choice on).
  const cats = CAT.categories.map(c => ({ c, items: c.items.filter(it => offered(ev, it.id) && groupsFor(ev, it).every(g => choicesFor(ev, it, g).length)) })).filter(x => x.items.length);
  const fonts = fontKeys(ev), maxc = maxChars(ev), nameLabel = ev.nameLabel || 'Personalization';
  const st = { step: 1, cat: cats[0]?.c.id, item: null, opts: {}, name: '', font: fonts[0], phone: '', sending: false };
  const curCat = () => cats.find(x => x.c.id === st.cat);
  const curItem = () => curCat()?.items.find(it => it.id === st.item) || null;
  function setItem(id) {
    st.item = id; const it = curItem(); if (!it) return;
    // Keep choices that still apply when switching pieces (black stays black), else take the first offered one.
    st.opts = Object.fromEntries(groupsFor(ev, it).map(g => { const ch = choicesFor(ev, it, g); return [g.id, ch.some(c => c.id === st.opts[g.id]) ? st.opts[g.id] : ch[0].id]; }));
  }
  if (cats[0]) setItem(cats[0].items[0].id);
  const order = () => ({ item: st.item, opts: st.opts, name: st.name, font: st.font });
  const submitKey = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).replace(/-/g, '').slice(0, 20);

  function mineHTML() {
    if (!mine.length) return '';
    return `<div class="mine"><div class="eyebrow" style="text-align:left">your items</div>${mine.map(o => `<a href="#/o/${encodeURIComponent(eventId)}/${esc(o.id)}"><span>${esc(o.name)} • ${shortId(o.id)}</span><b>check status ›</b></a>`).join('')}</div>`;
  }
  const stepsHTML = () => `<ol class="steps">${['item', 'personalize', 'one last look'].map((s, i) => `<li class="${i + 1 < st.step ? 'dn' : ''}" ${i + 1 === st.step ? 'aria-current="step"' : ''}>${s}</li>`).join('')}</ol>`;
  const radios = (name, entries, cur, cls) => `<div class="${cls}" role="radiogroup" aria-label="${esc(name)}">${entries.map(([k, v]) => `<button type="button" role="radio" aria-checked="${k === cur}" data-${name}="${esc(k)}">${esc(v)}</button>`).join('')}</div>`;
  const groupHTML = (it, g) => {
    const ch = choicesFor(ev, it, g);
    return `<fieldset class="sect"><legend>choose your <em>${esc(g.label.toLowerCase())}</em></legend><div class="${g.swatch ? 'sw' : 'seg'}" role="radiogroup" aria-label="${esc(g.label)}">${ch.map(c =>
      `<button type="button" role="radio" aria-checked="${c.id === st.opts[g.id]}" data-g="${esc(g.id)}" data-c="${esc(c.id)}">${g.swatch ? `<span class="dot" style="background:${esc(c.color || SWATCH[c.id] || '#ccc')}"></span>` : ''}${embIcon(g, c)}${esc(c.label.toLowerCase())}</button>`).join('')}</div></fieldset>`;
  };

  function render() {
    const it = curItem();
    let body = '', bar = '';
    if (st.step === 1) {
      const items = curCat()?.items || [];
      body = `<div class="rule"></div><h1>make it <em>yours</em></h1>
        ${mineHTML()}
        ${cats.length > 1 ? `<fieldset><legend>what are we <em>making?</em></legend>${radios('cat', cats.map(x => [x.c.id, x.c.label]), st.cat, 'seg')}</fieldset>` : ''}
        <fieldset><legend>what are we personalizing?</legend>
          <div class="pick ${smart(items.length)}" role="radiogroup" aria-label="Item">${items.map(p => `<button type="button" class="pcard" role="radio" aria-checked="${p.id === st.item}" data-item="${esc(p.id)}">
            ${p.id === st.item ? '<span class="tick" aria-hidden="true">✓</span>' : ''}<span class="ph">${previewHTML(ev, { item: p.id, opts: firstOpts(ev, p), name: '' }, false)}</span><span class="chip">${esc(p.label.toLowerCase())}</span></button>`).join('') || '<p class="note">Nothing is on the menu yet.</p>'}</div></fieldset>`;
      bar = `<button class="btn" id="next" type="button" ${it ? '' : 'disabled'}>Personalize it</button>`;
    } else if (st.step === 2) {
      // A group with a single choice left is decided already; it still shows on the review step.
      const nameBlock = `<fieldset class="sect"><legend>personalize it</legend>
          <label class="lbl" for="nm">${esc(nameLabel)}</label>
          <input id="nm" class="namefield" placeholder="Name or initials" maxlength="${maxc}" autocomplete="off" autocapitalize="words" spellcheck="false" value="${esc(st.name)}">
          <div class="count" id="cnt">${st.name.length} / ${maxc}</div>
          ${fonts.length > 1 ? radios('font', fonts.map(k => [k, FONTS[k]]), st.font, 'seg') : ''}</fieldset>`;
      const blocks = orderBlocks(ev, [{ id: 'name', html: nameBlock }, ...groupsFor(ev, it).filter(g => choicesFor(ev, it, g).length > 1).map(g => ({ id: 'q:' + g.id, html: groupHTML(it, g) }))]);
      body = `${stepsHTML()}
        ${blocks.map(x => x.html).join('')}`;
      bar = `<button class="btn sec" id="back" type="button">Back</button><button class="btn" id="next" type="button" ${st.name.trim() ? '' : 'disabled'}>Next: one last look</button>`;
    } else {
      body = `${stepsHTML()}
        <div class="proof">${ev.preview === false ? '' : `<span class="ph">${previewHTML(ev, order())}</span>`}
          <dl class="rows"><div><dt>Name</dt><dd class="nmrow"><b style="font-size:1.125rem">${esc(st.name.trim())}</b><button class="editbtn" id="edit" type="button" aria-label="Edit the name">✎ Edit</button></dd></div><div><dt>Item</dt><dd>${esc(it.label)}</dd></div>
          ${groupsFor(ev, it).map(g => `<div><dt>${esc(g.label)}</dt><dd>${esc(g.choices.find(c => c.id === st.opts[g.id])?.label || '')}</dd></div>`).join('')}
          <div><dt>Lettering</dt><dd>${esc(FONTS[st.font])}</dd></div>
          </dl></div>
        <div class="optin"><label class="lbl" for="ph">Want a text when it's ready? <span>optional</span></label>
          <input id="ph" class="phonefield" type="tel" inputmode="tel" autocomplete="tel" placeholder="Your phone number here" value="${esc(st.phone)}">
          <p class="fine" style="text-align:center">Up to ${ev.thanksOn === false ? 2 : 3} order texts from Ivelisse Designs. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a> · <a href="sms-terms.html" target="_blank" rel="noopener">Terms &amp; Conditions</a></p></div>
        <p class="err" id="err" role="alert"></p>`;
      bar = `<button class="btn sec" id="back" type="button">Back</button><button class="btn" id="send" type="button" ${st.sending ? 'disabled' : ''}>${st.sending ? 'Sending…' : 'Send for engraving'}</button>`;
    }
    $app.innerHTML = `<div class="page gpage step${st.step}">${head()}<main class="content">${body}</main>${st.step === 3 && brandBottom(brand) ? `<div class="bfoot">${brandBottom(brand)}</div>` : ''}<div class="bar">${bar}</div></div>`;
    bind();
  }
  function bind() {
    $app.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { st.cat = b.dataset.cat; setItem(curCat().items[0].id); render(); });
    $app.querySelectorAll('[data-item]').forEach(b => b.onclick = () => { setItem(b.dataset.item); render(); });
    $app.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { st.opts[b.dataset.g] = b.dataset.c; render(); });
    $app.querySelectorAll('[data-font]').forEach(b => b.onclick = () => { st.font = b.dataset.font; render(); });
    const nm = document.getElementById('nm');
    if (nm) nm.oninput = () => {
      st.name = nm.value.replace(/^\s+/, '');
      document.getElementById('cnt').textContent = `${st.name.length} / ${maxc}`;
      document.getElementById('next').disabled = !st.name.trim();
    };
    const go = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    go('next', () => { st.step++; render(); window.scrollTo(0, 0); });
    go('back', () => { st.step--; render(); window.scrollTo(0, 0); });
    go('edit', () => { st.step = 2; render(); setTimeout(() => document.getElementById('nm')?.focus(), 50); });
    go('send', submit);
    const ph = document.getElementById('ph'); if (ph) ph.oninput = () => { st.phone = ph.value; document.getElementById('err').textContent = ''; };
  }
  async function submit() {
    const name = st.name.trim().slice(0, maxc);
    const phone = normPhone(st.phone);
    if (phone === null) { document.getElementById('err').textContent = "That number doesn't look right. Use 10 digits (11 with the country code), or leave it blank."; document.getElementById('ph')?.focus(); return; }
    const it = curItem();
    // Re-check the event is still taking orders and the piece and choices are still offered.
    try {
      const s = await getDoc(doc(db, 'events', eventId)); const fresh = s.exists() ? s.data() : null;
      if (fresh && fresh.open === false) { document.getElementById('err').textContent = 'Orders just closed for this event.'; return; }
      if (fresh && (!offered(fresh, it.id) || groupsFor(fresh, it).some(g => !choicesFor(fresh, it, g).some(c => c.id === st.opts[g.id])))) {
        document.getElementById('err').textContent = 'That just sold out. Pick another and your name will carry over.';
        ev = fresh; st.step = 1; setTimeout(render, 1600); return;
      }
    } catch (e) { /* offline: the order still queues locally */ }
    st.sending = true; render();
    // The order id is fixed for this form visit, so a retry overwrites the same order instead of creating a second one.
    const ref = doc(db, 'events', eventId, 'orders', submitKey);
    // Labels are copied onto the order so the board and exports still read right if the catalog is renamed later.
    const labels = { piece: it.label, opts: groupsFor(ev, it).map(g => ({ g: g.label, c: g.choices.find(c => c.id === st.opts[g.id])?.label || st.opts[g.id], id: st.opts[g.id] })) };
    const data = { uid: user.uid, service: allPieces().find(p => p.it.id === it.id)?.cat.id || st.cat, item: it.id, opts: { ...st.opts }, labels, font: st.font, name, status: 'queue', engraver: null, createdAt: serverTimestamp(), clientAt: Date.now(), ...(phone ? { phone, textOptIn: true, optInAt: Date.now() } : {}) };
    // One batch: create the order and add it to the bottom of the public line, so the guest's
    // "pieces ahead" count works even when no board is open.
    const batch = writeBatch(db);
    batch.set(ref, data);
    batch.set(doc(db, 'events', eventId, 'public', 'queue'), { ids: arrayUnion(ref.id), updatedAt: serverTimestamp() }, { merge: true });
    batch.commit().catch(() => setDoc(ref, data).catch(e => toast('Could not send: ' + (e.code || e.message))));
    rememberOrder(eventId, { id: ref.id, name });
    location.hash = `#/o/${encodeURIComponent(eventId)}/${ref.id}`;
  }
  // A photo arriving mid-typing only swaps the preview, so the name field keeps focus.
  photoRerender = () => { if (document.activeElement?.id === 'nm') { const pv = document.getElementById('pv'); if (pv) pv.innerHTML = previewHTML(ev, order()); } else render(); };
  render();
}

// ---------- guest status ----------
async function statusPage(eventId, orderId) {
  setPhotoEvent(eventId);
  $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading…</p></div>`;
  if (povOn(eventId)) setupPill(eventId);
  await ensureGuest();
  let ev = null, order = null, queue = null, connected = true, lastSig = '', brand = {};
  // Don't hold the page on the event details; the order itself is what the guest is waiting for.
  getDoc(doc(db, 'events', eventId)).then(s => { ev = s.exists() ? s.data() : null; applyTheme(ev); render(); }).catch(() => {});
  getDoc(brandRef(eventId)).then(s => { brand = s.exists() ? s.data() : {}; render(); }).catch(() => {});
  const link = `${baseUrl()}#/o/${encodeURIComponent(eventId)}/${orderId}`;
  // A shared link opened on someone else's phone can't read this order: send them to the form to order their own.
  let sent = false;
  const notMine = e => { if (sent || e?.code !== 'permission-denied' || myOrders(eventId).some(o => o.id === orderId) || !location.hash.startsWith('#/o/')) return false; sent = true; location.replace(`${baseUrl()}#/e/${encodeURIComponent(eventId)}`); return true; };

  function aheadText(n) { return n === 0 ? "you're next" : `${n} ${n === 1 ? 'item' : 'items'} ahead of yours`; }
  function render() {
    if (!order) { $app.innerHTML = `<div class="page"><header class="band">${IG}${LOGO}<div class="ev">order ${shortId(orderId)}</div>${WAVE(390)}</header><main class="content"><h1>looking for your <em>order</em></h1><p class="note">If this doesn't change in a few seconds, it may have been placed on a different phone. Ask at the engraving table with your name.</p><a class="btn out" href="#/e/${encodeURIComponent(eventId)}">Back to the form</a></main></div>`; return; }
    const s = order.status, pos = queue ? queue.indexOf(orderId) : -1;
    const sig = s + '|' + pos + '|' + (order.engraver || '');
    const steps = ['in line', 'being customized', 'ready'];
    const curIdx = { queue: 0, progress: 1, done: 2, picked: 2 }[s] ?? 0;
    const miles = `<ol class="miles">${steps.map((t, i) => `<li class="${i < curIdx || s === 'picked' ? 'dn' : ''}" ${i === curIdx && s !== 'picked' ? 'aria-current="step"' : ''}><b aria-hidden="true"></b>${t}</li>`).join('')}</ol>`;
    const item = `<div class="mini ${ev?.preview === false ? 'nopic' : ''}">${ev?.preview === false ? '' : `<span class="ph">${previewHTML(ev, order)}</span>`}<div><div class="nm">${esc(order.name)}</div><div class="ds">${esc(describe(ev, order, true))}<br>${esc((FONTS[order.font] || '').toLowerCase())}</div></div></div>`;
    const live = `<div class="live ${connected ? '' : 'off'}"><i aria-hidden="true"></i>${connected ? 'Live • updates on its own' : 'Reconnecting… your order is safe'}</div>`;
    const save = `<div class="save"><span>Copy link to save for later, or share with another person so they can order too!</span><button class="linkbtn" id="copy" type="button">Copy link</button></div>`;
    let html;
    if (s === 'done' || s === 'picked') {
      const pick = ev?.pickupNote || 'at the engraving table';
      html = `<header class="band readyband">${IG}${brandCorners(brand)}${brandTop(brand)}
        ${s === 'done' ? `<h1 style="margin-top:8px">it's <em>ready!</em></h1><div style="font-size:1.0625rem;margin-top:6px">pick it up ${esc(pick)}</div><div class="code">${shortId(orderId)}</div><div style="font-size:.875rem;margin-top:8px">show this code</div>`
        : `<h1 style="margin-top:8px">enjoy it, <em>${esc(order.name)}</em></h1><div style="font-size:1.0625rem;margin-top:6px">thanks for celebrating with us</div>`}${WAVE(390)}</header>
        <main class="content"><div class="proof">${ev?.preview === false ? '' : `<span class="ph">${previewHTML(ev, order)}</span>`}<div style="font:800 1.125rem var(--body)">${esc(order.name)}</div><div style="font-size:.875rem;color:var(--muted)">${order.engraver ? 'made by ' + esc(order.engraver) : ''}${tsDate(order.doneAt) ? ' • ' + fmtTime(tsDate(order.doneAt)) : ''}</div></div>${brandBottom(brand)}</main>
        <div class="bar"><a class="btn out" href="#/e/${encodeURIComponent(eventId)}">Personalize another item</a></div>`;
    } else {
      const state = s === 'progress'
        ? `<div class="eyebrow">it's happening</div><h1 class="cust">${esc(order.engraver || 'we')} ${order.engraver ? 'is' : 'are'} <em>customizing</em> your ${esc(pieceLabel(order).toLowerCase() || 'item')}</h1>`
        : (pos >= 0 ? `${pos === 0 ? `<div class="eyebrow">you're in line</div><h1>you're <em>next</em></h1>` : `<div class="eyebrow">you're number</div><div class="big" aria-hidden="true">${pos + 1}</div><h1 style="font-size:1.5rem;margin-top:4px" aria-hidden="true">in <em>line</em></h1><p class="note" style="margin-top:6px;font-size:.9375rem">${aheadText(pos)}</p>`}`
          : `<div class="eyebrow">you're in line</div><h1>${queue === null ? 'finding your <em>place</em>…' : `we've got <em>yours</em>`}</h1>`);
      html = `<header class="band gband">${IG}${brandCorners(brand)}${brandTop(brand)}<div class="ev">order ${shortId(orderId)}</div>${WAVE(390)}</header>
        <main class="content"><section class="hero"><div class="state">${state}</div>${miles}
          <button type="button" class="morehint" onclick="document.getElementById('details').scrollIntoView({behavior:'smooth',block:'start'})">your details ↓</button></section>
        <p class="vh" role="status" aria-atomic="true" id="announce"></p>
        <div class="proof mydetails" id="details">${ev?.preview === false ? '' : `<span class="ph">${previewHTML(ev, order)}</span>`}
          <dl class="rows"><div><dt>Name</dt><dd><b style="font-size:1.125rem">${esc(order.name)}</b></dd></div>
            <div><dt>Item</dt><dd>${esc(order.labels?.piece || pieceDef(order.item)?.it.label || order.item || '')}</dd></div>
            ${choiceLabels(order).map(x => `<div><dt>${esc(x.g)}</dt><dd>${esc(x.c)}</dd></div>`).join('')}
            <div><dt>Lettering</dt><dd>${esc(FONTS[order.font] || order.font || '')}</dd></div>
            ${order.phone ? `<div><dt>Text updates</dt><dd>${esc(fmtPhone(order.phone))}</dd></div>` : ''}
            <div><dt>Order</dt><dd>${shortId(orderId)}</dd></div></dl></div>
        ${save}${live}<a class="btn out" href="#/e/${encodeURIComponent(eventId)}">Personalize another item</a>${brandBottom(brand)}</main>`;
    }
    $app.innerHTML = `<div class="page">${html}</div>`;
    const ann = document.getElementById('announce');
    if (ann && sig !== lastSig) ann.textContent = s === 'progress' ? `${order.engraver || 'Your engraver'} is customizing your ${pieceLabel(order).toLowerCase() || 'item'}.` : (pos >= 0 ? (pos === 0 ? "You're next." : `You're number ${pos + 1} in line. ${aheadText(pos)}.`) : "You're in line.");
    if (sig !== lastSig && lastSig && s === 'done') { try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {} document.title = '✓ Ready — Ivelisse'; }
    lastSig = sig;
    const c = document.getElementById('copy');
    if (c) c.onclick = () => (navigator.clipboard?.writeText(link) || Promise.reject()).then(() => toast('Link copied')).catch(() => toast(link));
  }
  let stopOrder = null;
  const listen = () => {
    if (stopOrder) stopOrder();
    stopOrder = onSnapshot(doc(db, 'events', eventId, 'orders', orderId), { includeMetadataChanges: true }, s => {
      connected = !s.metadata.fromCache; order = s.exists() ? s.data({ serverTimestamps: 'estimate' }) : null; render();
    }, e => { if (!notMine(e)) render(); });
  };
  listen();
  unsubs.push(() => stopOrder && stopOrder());
  // Only trust the line once it comes from the server. Right after submitting, the phone's own pending
  // write makes the line look like it holds just this order, which would wrongly say "you're next".
  unsubs.push(onSnapshot(doc(db, 'events', eventId, 'public', 'queue'), { includeMetadataChanges: true }, s => {
    if (s.metadata.hasPendingWrites || s.metadata.fromCache) return;
    queue = s.exists() ? (s.data().ids || []) : []; render();
  }, () => {}));
  // Phones pause live connections in the background; re-check straight from the server when the page
  // comes back on screen and every 15s until the piece is ready, so the status can't get stuck.
  async function refresh(full = true) {
    if (order && (order.status === 'done' || order.status === 'picked')) return;
    try {
      const q = await getDocFromServer(doc(db, 'events', eventId, 'public', 'queue')).catch(() => null);
      if (q) queue = q.exists() ? (q.data().ids || []) : [];
      if (full || !order) { const o = await getDocFromServer(doc(db, 'events', eventId, 'orders', orderId)); if (o.exists()) order = o.data({ serverTimestamps: 'estimate' }); }
      connected = true; render();
    } catch (e) { if (notMine(e)) return; connected = false; render(); }
  }
  const vis = () => { if (document.visibilityState === 'visible') { listen(); refresh(); } };
  document.addEventListener('visibilitychange', vis); addEventListener('focus', vis); addEventListener('pageshow', vis);
  unsubs.push(() => { document.removeEventListener('visibilitychange', vis); removeEventListener('focus', vis); removeEventListener('pageshow', vis); });
  // Live listeners usually win, but phones can be slow to open them. Fetch right away, then
  // re-check the line every 5s and the order itself every 10s until the piece is ready.
  refresh();
  let tick = 0;
  timers.push(setInterval(() => { tick++; refresh(tick % 2 === 0); }, 5000));
  photoRerender = render;
  render();
}

// ---------- text preview ----------
// Shows guests what the order texts look like, laid out like the iPhone Messages app.
// Nothing is sent; it's a simulation built from this order.
const TEXT_FROM = '+1 (469) 398-8476';
// Steph's Google Business Profile link.
const REVIEW_URL = 'https://share.google/pYr87ENQgaxoU85Ng';
const IG_URL = 'https://instagram.com/ivelissedesigns';
const FOLLOW_URL = 'https://maps.app.goo.gl/zyrToGerBpppPteV8'; // Google Maps review page
// Picture texted with the thank-you when an event doesn't set its own (public, so Twilio can fetch it).
const FOLLOW_IMG = 'followup.jpg';
const followRef = id => doc(db, 'events', id, 'public', 'followup');
// The finished picture texted with the thank-you (square JPEG, cropped as framed in the adjust window).
const followImgRef = id => doc(db, 'events', id, 'public', 'followupImg');
// The most recently saved thank-you link and picture, used as the starting point for new events.
const lastFollowRef = () => doc(db, 'config', 'followup'), lastFollowImgRef = () => doc(db, 'config', 'followupImg');
// The texted picture also goes to Firebase Storage so Twilio gets a public link (followupImg.url).
async function uploadFollow(eventId, dataUrl) {
  const S = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js');
  const st = S.getStorage(fb), r = S.ref(st, `followup/${eventId}-${Date.now()}.jpg`);
  await S.uploadString(r, dataUrl, 'data_url', { contentType: 'image/jpeg', cacheControl: 'public,max-age=31536000' });
  return S.getDownloadURL(r);
}
async function bakeFit(src, fit, size = 1080) {
  const im = new Image(); im.src = src; await im.decode();
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);
  const w = size * (fit?.z || 1), h = w * im.naturalHeight / im.naturalWidth;
  const cx = size / 2 + size * (fit?.x || 0) / 100, cy = size / 2 + size * (fit?.y || 0) / 100;
  g.imageSmoothingQuality = 'high'; g.drawImage(im, cx - w / 2, cy - h / 2, w, h);
  let out = c.toDataURL('image/jpeg', 0.88); if (out.length > 850000) out = c.toDataURL('image/jpeg', 0.75);
  return out;
}
let textCssDone = false;
function textCss() {
  if (textCssDone) return; textCssDone = true;
  const s = document.createElement('style');
  s.textContent = `
.txtbtn{position:fixed;top:max(10px,env(safe-area-inset-top));right:10px;z-index:40;display:flex;align-items:center;gap:6px;min-height:40px;padding:0 14px;border:0;border-radius:20px;background:rgba(255,255,255,.94);color:#2b2522;font:700 .875rem var(--body);box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:pointer}
.txtbtn svg{width:18px;height:18px}
.ims-wrap{position:fixed;inset:0;z-index:100;background:rgba(20,14,10,.55);display:flex;align-items:center;justify-content:center;animation:imsFade .2s ease}
@keyframes imsFade{from{opacity:0}to{opacity:1}}
.ims{width:100%;height:100%;background:#fff;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif;color:#000;-webkit-font-smoothing:antialiased;overflow:hidden;position:relative}
@media (min-width:520px) and (min-height:760px){.ims{width:390px;height:844px;max-height:94vh;border-radius:54px;border:11px solid #111;box-shadow:0 30px 80px rgba(0,0,0,.45)}.ims .ims-island{display:block}}
.ims-status{height:47px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 30px 0 34px;font-weight:600;font-size:16px;letter-spacing:-.2px;position:relative}
.ims-island{display:none;position:absolute;top:10px;left:50%;transform:translateX(-50%);width:122px;height:35px;border-radius:20px;background:#000}
.ims-icons{display:flex;gap:6px;align-items:center}
.ims-icons svg{height:12px;width:auto;display:block}
.ims-head{flex:none;display:grid;grid-template-columns:70px 1fr 70px;align-items:start;padding:2px 8px 8px;background:rgba(249,249,249,.94);border-bottom:.5px solid rgba(0,0,0,.18)}
.ims-back{border:0;background:none;color:#007aff;font-size:17px;display:flex;align-items:center;gap:2px;padding:10px 0 0;cursor:pointer;font-family:inherit}
.ims-back svg{width:12px;height:20px}
.ims-who{display:flex;flex-direction:column;align-items:center;gap:4px}
.ims-av{width:48px;height:48px;border-radius:50%;background:linear-gradient(#a5abb8,#858a96);display:flex;align-items:flex-end;justify-content:center;overflow:hidden}
.ims-av svg{width:40px;height:40px}
.ims-name{font-size:11px;color:#000;display:flex;align-items:center;gap:2px}
.ims-name svg{width:6px;height:10px;opacity:.4}
.ims-body{flex:1;overflow-y:auto;padding:10px 16px 14px;display:flex;flex-direction:column;-webkit-overflow-scrolling:touch}
.ims-meta{text-align:center;font-size:11px;color:#8a8a8e;margin:14px 0 8px;line-height:1.35}
.ims-meta b{font-weight:600}
.ims-row{display:flex;margin-top:2px;animation:imsPop .28s cubic-bezier(.2,.9,.3,1.2)}
@keyframes imsPop{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}
.ims-b{position:relative;max-width:75%;background:#e9e9eb;color:#000;border-radius:18px;padding:7px 12px 8px;font-size:17px;line-height:1.29;letter-spacing:-.2px;word-wrap:break-word;overflow-wrap:anywhere}
.ims-b a{color:#000;text-decoration:underline}
.ims-row.tail .ims-b:not(.ims-pic)::before{content:'';position:absolute;left:-7px;bottom:0;width:20px;height:18px;background:#e9e9eb;border-bottom-right-radius:16px 14px}
.ims-row.tail .ims-b:not(.ims-pic)::after{content:'';position:absolute;left:-26px;bottom:0;width:26px;height:18px;background:#fff;border-bottom-right-radius:10px}
.ims-pic{padding:0;overflow:hidden;width:220px;max-width:62%;background:#e9e9eb;border-radius:18px}
.ims-pic img,.ims-pic svg{display:block;width:100%;height:auto}
.ims-pic .ph-wrap{aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;background:#f4ece5}
.ims-pic .ph-wrap>*{width:100%;height:100%;object-fit:cover}
.ims-card{max-width:75%;width:260px;border-radius:18px;overflow:hidden;background:#e9e9eb;margin-top:2px}
.ims-card .hero{height:120px;background:linear-gradient(135deg,#b85c3a,#d9aa98);display:flex;align-items:center;justify-content:center;color:#fff8f0;font:400 30px var(--script,cursive)}
.ims-card .meta{padding:8px 12px 10px;font-size:13px;line-height:1.3}
.ims-card .t{font-weight:600;color:#000}
.ims-card .d{color:#8a8a8e}
.ims-typing{display:flex;gap:4px;align-items:center;padding:12px 14px}
.ims-typing i{width:8px;height:8px;border-radius:50%;background:#8e8e93;animation:imsDot 1.2s infinite}
.ims-typing i:nth-child(2){animation-delay:.15s}.ims-typing i:nth-child(3){animation-delay:.3s}
@keyframes imsDot{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-2px)}}
.ims-foot{flex:none;display:flex;align-items:center;gap:10px;padding:6px 12px 10px;background:#fff}
.ims-plus{width:34px;height:34px;border-radius:50%;background:#eeeef0;display:flex;align-items:center;justify-content:center;flex:none}
.ims-plus svg{width:16px;height:16px}
.ims-field{flex:1;height:36px;border:1px solid #c7c7cc;border-radius:18px;display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 14px;color:#b0b0b5;font-size:16px}
.ims-field svg{width:18px;height:18px}
.ims-home{flex:none;height:22px;display:flex;align-items:center;justify-content:center}
.ims-home i{width:134px;height:5px;border-radius:3px;background:#000}
.ims-note{flex:none;display:flex;align-items:center;justify-content:center;gap:8px;padding:6px 12px 2px;font-size:11px;color:#8a8a8e}
.ims-replay{border:0;background:none;color:#007aff;font:600 12px -apple-system,system-ui,sans-serif;padding:4px 6px;cursor:pointer}
@media (prefers-reduced-motion:reduce){.ims-row,.ims-wrap{animation:none}.ims-typing i{animation:none}}`;
  document.head.appendChild(s);
}
const TXT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/></svg>`;
function textButtonHTML() { textCss(); return `<button class="txtbtn" id="txtsim" type="button" aria-label="Preview the texts you'll get">${TXT_ICON}Texts</button>`; }

function showTextSim(ev, order, pos, link) {
  textCss();
  const name = order.name || 'there';
  const piece = pieceLabel(order).toLowerCase() || 'item';
  const line = pos >= 0 ? pos + 1 : 3;
  const pick = ev?.pickupNote || 'at the engraving table';
  const t0 = tsDate(order.createdAt) || tsDate(order.clientAt) || new Date();
  const at = m => new Date(t0.getTime() + m * 60000);
  const clock = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = d => { const n = new Date(); n.setHours(0, 0, 0, 0); const x = new Date(d); x.setHours(0, 0, 0, 0); const diff = Math.round((x - n) / 864e5); return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : x.toLocaleDateString('en-US', { weekday: 'long' }); };
  const stamp = d => `${day(d)} ${clock(d)}`;
  // The thank-you goes out a few hours later, but never overnight: late orders get it the next morning at 10.
  // The thank-you goes out at 9 AM the morning after the event.
  const thanksAt = (() => { const m = ev?.date ? new Date(ev.date + 'T09:00:00') : new Date(at(0)); m.setDate(m.getDate() + 1); m.setHours(9, 0, 0, 0); return m; })();
  const follow = ev?.followLink || FOLLOW_URL;
  const now = new Date();
  const linkA = u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`;
  const card = (title, domain, hero) => `<div class="ims-card"><div class="hero">${hero}</div><div class="meta"><div class="t">${esc(title)}</div><div class="d">${esc(domain)}</div></div></div>`;
  // Each step: a centered timestamp (optional) and the bubbles that arrive together.
  const steps = [
    { meta: `<b>Text Message</b><br>${stamp(at(0))}`, items: [
      `Ivelisse Designs: Thanks, ${esc(name)}! Your ${esc(piece)} order is in and you're #${line} in line. Reply STOP to opt out, HELP for help.`] },
    { meta: `${stamp(at(18))}`, items: [`Ivelisse Designs: ${esc(name)}, your ${esc(piece)} is ready! Pick it up ${esc(pick)}. Reply STOP to opt out.`] },
    ...(ev?.thanksOn === false ? [] : [{ meta: `${stamp(thanksAt)}`, items: [
      `Ivelisse Designs: Hi ${esc(name)}, the @ivelissedesigns team hopes you're enjoying your ${esc(piece)}! We'd be so grateful if you left us a quick review: ${linkA(follow)} It keeps us doing what we love. Thank you! Reply STOP to opt out.`,
      { card: card('Ivelisse Designs', follow.replace(/^https?:\/\//, '').split('/')[0], `<img src="${FOLLOW_IMG}" alt="" style="width:100%;height:100%;object-fit:cover">`) }] }])
  ];

  const wrap = document.createElement('div');
  wrap.className = 'ims-wrap';
  wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Preview of your order texts');
  wrap.innerHTML = `<div class="ims">
    <div class="ims-status"><span>${clock(now).replace(/\s?[AP]M$/i, '')}</span><span class="ims-island"></span>
      <span class="ims-icons"><svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
      <svg viewBox="0 0 16 12"><path d="M8 2.6c2.2 0 4.2.9 5.7 2.3l1.1-1.1A9.6 9.6 0 0 0 8 1 9.6 9.6 0 0 0 1.2 3.8l1.1 1.1A8 8 0 0 1 8 2.6zm0 3.3c1.3 0 2.5.5 3.4 1.4l1.1-1.1A6.4 6.4 0 0 0 8 4.3a6.4 6.4 0 0 0-4.5 1.9l1.1 1.1A4.8 4.8 0 0 1 8 5.9zm0 3.3a1.6 1.6 0 0 0-1.1.5L8 11l1.1-1.3A1.6 1.6 0 0 0 8 9.2z"/></svg>
      <svg viewBox="0 0 27 12"><rect x=".5" y=".5" width="22" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="16" height="8" rx="2"/><path d="M24 4v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" opacity=".4"/></svg></span></div>
    <div class="ims-head"><button class="ims-back" type="button" aria-label="Close preview"><svg viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="ims-who"><div class="ims-av"><svg viewBox="0 0 40 40" fill="#fff"><circle cx="20" cy="15" r="8"/><path d="M4 40c0-9 7-15 16-15s16 6 16 15z"/></svg></div><div class="ims-name">${TEXT_FROM}<svg viewBox="0 0 6 10"><path d="M1 1l4 4-4 4" fill="none" stroke="#000" stroke-width="1.5"/></svg></div></div><span></span></div>
    <div class="ims-body" aria-live="polite"></div>
    <div class="ims-note"><span>Preview only. No texts were sent.</span><button class="ims-replay" type="button">Replay</button></div>
    <div class="ims-foot"><span class="ims-plus"><svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="#8e8e93" stroke-width="2" stroke-linecap="round"/></svg></span>
      <span class="ims-field">Text Message • SMS<svg viewBox="0 0 24 24" fill="none" stroke="#b0b0b5" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span></div>
    <div class="ims-home"><i></i></div></div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector('.ims-body');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer = null, alive = true;
  const wait = ms => new Promise(r => { timer = setTimeout(r, reduce ? 0 : ms); });
  const scroll = () => body.scrollTo({ top: body.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  function bubble(it, tail) {
    const row = document.createElement('div'); row.className = 'ims-row' + (tail ? ' tail' : '');
    if (typeof it === 'string') row.innerHTML = `<div class="ims-b">${it}</div>`;
    else if (it.pic) row.innerHTML = `<div class="ims-b ims-pic"><div class="ph-wrap">${it.pic}</div></div>`;
    else row.innerHTML = it.card;
    body.appendChild(row); scroll();
  }
  async function play() {
    body.innerHTML = '';
    for (const st of steps) {
      if (!alive) return;
      const m = document.createElement('div'); m.className = 'ims-meta'; m.innerHTML = st.meta; body.appendChild(m);
      for (let i = 0; i < st.items.length; i++) {
        const it = st.items[i];
        if (typeof it === 'string' || it.pic) {
          const ty = document.createElement('div'); ty.className = 'ims-row tail'; ty.innerHTML = `<div class="ims-b ims-typing"><i></i><i></i><i></i></div>`;
          body.appendChild(ty); scroll(); await wait(1100); if (!alive) return; ty.remove();
        } else await wait(250);
        if (!alive) return;
        const lastText = st.items.slice(i + 1).every(x => typeof x !== 'string' && !x.pic);
        bubble(it, (typeof it === 'string' || it.pic) && lastText);
      }
      await wait(1300);
    }
  }
  function close() { alive = false; clearTimeout(timer); removeEventListener('keydown', key); wrap.remove(); document.getElementById('txtsim')?.focus(); }
  const key = e => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', key);
  wrap.querySelector('.ims-back').onclick = close;
  wrap.onclick = e => { if (e.target === wrap) close(); };
  wrap.querySelector('.ims-replay').onclick = () => { alive = false; clearTimeout(timer); setTimeout(() => { alive = true; play(); }, 0); };
  wrap.querySelector('.ims-back').focus();
  play();
}

// ---------- demo event ----------
// A practice event with sample orders in every stage. Reset wipes its orders (including any test
// orders placed through the guest form) and puts the samples back. Real events are never touched.
const DEMO_ID = 'demo';
const DEMO_ENGRAVERS = ['Steph', 'Veronica', 'Christina', 'DeVaughn'];
const DEMO_ORDERS = [
  // [id, name, item, color, addon, font, status, engraver, minutes ago submitted, started, ready, picked up]
  ['demo-r3k8', 'Harper', 'bagtag', 'black', 'none', 'script', 'picked', 'Steph', 48, 44, 39, 35],
  ['demo-w5n2', 'Ethan', 'tumbler', 'black', 'stars', 'serif', 'picked', 'Veronica', 45, 41, 34, 30],
  ['demo-h7q4', 'Camila', 'bagtag', 'blush', 'heart', 'script', 'done', 'Christina', 38, 33, 27, null],
  ['demo-t9b6', 'Noah', 'tumbler', 'white', 'none', 'serif', 'done', 'Steph', 34, 28, 21, null],
  ['demo-m2x7', 'Ava', 'bagtag', 'tan', 'stars', 'script', 'done', 'Veronica', 30, 24, 16, null],
  ['demo-c4j9', 'Priya', 'tumbler', 'terracotta', 'heart', 'script', 'progress', 'Steph', 22, 5, null, null],
  ['demo-p6d3', 'Jordan', 'bagtag', 'black', 'stars', 'serif', 'progress', 'Veronica', 19, 3, null, null],
  ['demo-k8f5', 'Maya', 'bagtag', 'tan', 'none', 'script', 'queue', null, 14, null, null, null],
  ['demo-y3g7', 'Liam', 'tumbler', 'black', 'none', 'serif', 'queue', null, 11, null, null, null],
  ['demo-b5v2', 'Sofia', 'bagtag', 'blush', 'heart', 'script', 'queue', null, 7, null, null, null],
  ['demo-z7s4', 'Zoe', 'tumbler', 'white', 'stars', 'script', 'queue', null, 3, null, null, null]
];
async function resetDemo() {
  const evRef = doc(db, 'events', DEMO_ID);
  const old = await getDoc(evRef).catch(() => null);
  const prev = old && old.exists() ? old.data() : null;
  const today = new Date(); const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (await isStaff()) await setDoc(evRef, { name: 'Demo event', date, engravers: DEMO_ENGRAVERS, items: { bagtag: true, tumbler: true }, hidden: prev?.hidden || {},
    photos: prev?.photos || {}, pickupNote: prev?.pickupNote || 'at the engraving table', open: true, demo: true, createdAt: prev?.createdAt || serverTimestamp() });
  // Clear every order in the demo event.
  const snap = await getDocs(collection(db, 'events', DEMO_ID, 'orders'));
  for (let i = 0; i < snap.docs.length; i += 400) { const b = writeBatch(db); snap.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit(); }
  // Orders have to start in the queue (same rule guests follow), then get moved to their stage.
  const ago = m => m == null ? null : Timestamp.fromMillis(Date.now() - m * 60000);
  const make = writeBatch(db), place = writeBatch(db);
  DEMO_ORDERS.forEach(([id, name, item, color, addon, font, status, engraver, sub, started, ready, picked]) => {
    const ref = doc(db, 'events', DEMO_ID, 'orders', id);
    make.set(ref, { uid: user.uid, service: 'engraving', item, opts: { color, addon }, font, name, status: 'queue', engraver: null, createdAt: ago(sub), clientAt: Date.now() - sub * 60000, demo: true });
    if (status !== 'queue') place.update(ref, { status, engraver, startedAt: ago(started), doneAt: ago(ready), pickedAt: ago(picked), updatedAt: serverTimestamp() });
  });
  await make.commit();
  place.set(doc(db, 'events', DEMO_ID, 'public', 'queue'), { ids: DEMO_ORDERS.filter(o => o[6] === 'queue').map(o => o[0]), updatedAt: serverTimestamp() });
  await place.commit();
}
async function confirmResetDemo(exists) {
  if (exists && !confirm('Reset the demo event? This clears every order in it and puts the sample orders back. Real events are not touched.')) return false;
  try { await resetDemo(); toast(exists ? 'Demo reset' : 'Demo event ready'); return true; }
  catch (e) { toast('Demo reset failed: ' + (e.code || e.message)); return false; }
}

// ---------- board ----------
async function boardPage(eventId) {
  setPhotoEvent(eventId);
  let ev = null, orders = [], fromCache = false, lastQueueSig = '', dragging = false, openWho = null, pickupQuery = '';
  const mgr = await isStaff();
  setupPill();
  const me = staffName(eventId);
  const online = () => navigator.onLine && !fromCache;
  unsubs.push(onSnapshot(doc(db, 'events', eventId), s => { ev = s.exists() ? s.data() : null; render(); }));
  unsubs.push(onSnapshot(query(collection(db, 'events', eventId, 'orders'), orderBy('createdAt')), { includeMetadataChanges: true }, s => {
    orders = s.docs.map(d => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) }));
    fromCache = s.metadata.fromCache; render(); syncQueue();
  }, e => { if (e.code === 'permission-denied') location.replace(`${baseUrl()}#/staff/${encodeURIComponent(eventId)}`); }));
  const onl = () => render(); addEventListener('online', onl); addEventListener('offline', onl);
  unsubs.push(() => { removeEventListener('online', onl); removeEventListener('offline', onl); });
  timers.push(setInterval(() => render(), 30000)); // refresh wait ages

  function syncQueue() {
    const ids = orders.filter(o => o.status === 'queue').map(o => o.id), sig = ids.join(',');
    if (sig === lastQueueSig) return; lastQueueSig = sig;
    setDoc(doc(db, 'events', eventId, 'public', 'queue'), { ids, updatedAt: serverTimestamp() }).catch(() => {});
  }
  const staff = () => (ev?.engravers?.length ? ev.engravers : ['Steph']);
  // Anyone can hold any number of pieces; oldest started sits at the top of their column.
  const holding = e => orders.filter(o => o.status === 'progress' && o.engraver === e).sort((a, b) => (tsDate(a.startedAt) || 0) - (tsDate(b.startedAt) || 0));
  const mins = o => { const d = tsDate(o.createdAt) || tsDate(o.clientAt); return d ? Math.max(0, Math.round((Date.now() - d) / 60000)) : 0; };
  const pendChip = o => o.pending ? `<div class="pend">${online() ? 'Saving…' : 'Offline • move pending'}</div>` : '';

  // Up to 3 staff: one button each (1 = full width, 2 = left and right, 3 = thirds). More than 3: tap to open the list.
  function assignRow(o) {
    const names = staff();
    const btn = e => `<button type="button" class="as ${e === me ? 'me' : ''}" data-start="${o.id}" data-who="${esc(e)}" aria-label="Assign to ${esc(e)}">${names.length === 1 ? 'Assign to ' : ''}${esc(e)}</button>`;
    if (names.length <= 3) return `<div class="assign n${names.length}">${names.map(btn).join('')}</div>`;
    return `<div class="assign n1"><button type="button" class="as" data-pick="${o.id}" aria-expanded="${openWho === o.id}">${openWho === o.id ? 'Assign to… ▴' : 'Tap to assign ▾'}</button></div>
      ${openWho === o.id ? `<div class="assign n2">${names.map(btn).join('')}</div>` : ''}`;
  }
  function queueCard(o, i) {
    const m = mins(o);
    return `<div class="qc" data-id="${o.id}"><span class="ph">${previewHTML(ev, o)}</span><div class="nm"><span class="pos" aria-label="Position ${i + 1}">${i + 1}</span>${esc(o.name)}</div><div class="ds">#${shortId(o.id)} • ${esc(describe(ev, o, true))} • ${esc((FONTS[o.font] || '').toLowerCase())}${o.phone ? ' • <b class="txt">gets texts</b>' : ''}</div>
      <div class="ft"><span class="age ${m >= 10 ? 'hot' : ''}">waiting ${m} min</span></div>${assignRow(o)}${pendChip(o)}</div>`;
  }
  function nowCard(o) {
    const st = tsDate(o.startedAt); const m = st ? Math.max(0, Math.round((Date.now() - st) / 60000)) : 0;
    return `<div class="now" data-id="${o.id}"><div class="top"><span class="ph">${previewHTML(ev, o)}</span><div><div class="nm">${esc(o.name)}</div><div class="ds">#${shortId(o.id)} • ${esc(describe(ev, o, true))}<br>${esc((FONTS[o.font] || '').toLowerCase())} • ${m} min in</div></div></div>
      <div class="acts2"><button class="ret" type="button" data-return="${o.id}">Return to queue</button><button class="rd" type="button" data-ready="${o.id}">Mark ready!</button></div>${pendChip(o)}</div>`;
  }
  function readyCard(o) {
    return `<div class="rc" data-id="${o.id}"><span class="ph">${previewHTML(ev, o)}</span><div><div class="nm">${esc(o.name)} <span class="cd">${shortId(o.id)}</span></div><div class="ds">${esc(describe(ev, o))}${o.engraver ? ' • ' + esc(o.engraver) : ''}</div></div>
      <button class="pk2" type="button" data-picked="${o.id}">Picked up</button>${pendChip(o)}</div>`;
  }
  function render() {
    if (dragging) return;
    if (!ev) { $app.innerHTML = `<div class="page"><p class="note" style="padding:40px">Loading board…</p></div>`; return; }
    const dlgOpen = document.getElementById('pk')?.open; const qv = document.getElementById('find')?.value ?? pickupQuery;
    const q = orders.filter(o => o.status === 'queue'), ready = orders.filter(o => o.status === 'done');
    const n = { q: q.length, p: orders.filter(o => o.status === 'progress').length, r: ready.length, x: orders.filter(o => o.status === 'picked').length };
    // Pieces held by someone no longer on the event still need a home on screen.
    const names = [...staff(), ...new Set(orders.filter(o => o.status === 'progress' && o.engraver && !staff().includes(o.engraver)).map(o => o.engraver))];
    $app.innerHTML = `<div class="boardpage">
      <header class="bh">${LOGO}<div><div class="t">${esc(ev.name)}</div><div class="sub">${esc(fmtDate(ev.date))}</div></div>
        <div class="k"><span><b>${n.q}</b>waiting</span><span><b>${n.p}</b>in progress</span><span><b>${n.x}</b>picked up</span>
          <button class="pu" id="openpk" type="button">Find by code ›</button>
          <span class="lv ${online() ? '' : 'off'}"><i aria-hidden="true"></i>${online() ? 'Live' : 'Offline • moves save on this iPad'}</span></div>${WAVE(1180)}</header>
      <main class="lanes">
        <section class="lane q" aria-label="Queue"><h2>queue <small>${n.q}</small></h2>
          <div class="drop" data-status="queue" data-engraver="">${q.map(queueCard).join('') || '<p class="note">No one waiting.</p>'}</div></section>
        ${names.map(e => { const h = holding(e); 
          return `<section class="lane staff ${e === me ? 'mine' : ''}" aria-label="${esc(e)}"><h2><span>${esc(e.toLowerCase())}${e === me ? ' <small class="you">you</small>' : ''}</span> <small>${h.length || ''}</small></h2>
            <div class="drop zone" data-status="progress" data-engraver="${esc(e)}">${h.map(nowCard).join('')}<div class="free"><div><b>free</b></div></div></div>
            </section>`; }).join('')}
        <section class="lane ready" aria-label="Ready for pickup"><h2>ready <small>${n.r}</small></h2>
          <div class="drop" data-status="done" data-engraver="">${ready.map(readyCard).join('') || '<p class="note">Nothing waiting for pickup.</p>'}</div></section>
      </main>
      <dialog class="pickup" id="pk" aria-labelledby="pkt"><div class="pk-in">
        <h2 id="pkt"><span>ready for <em>pickup</em></span><button class="close" id="pkx" type="button" aria-label="Close">×</button></h2>
        <label class="lbl" for="find">Find by code</label>
        <input class="find" id="find" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="4" value="${esc(qv)}">
        <div class="pk-list" id="pkl"></div>
        <p class="note" style="font-size:.8125rem;text-align:left">Picked up by mistake? Tap Undo on the message that appears.</p></div></dialog>
    </div>`;
    bindBoard();
    if (dlgOpen) { document.getElementById('pk').showModal(); renderPickup(); const f = document.getElementById('find'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  }
  const pickedUp = id => { move(id, 'picked'); toast(`${shortId(id)} picked up`, { label: 'Undo', run: () => move(id, 'done', null, true) }); };
  function renderPickup() {
    const v = (document.getElementById('find')?.value || '').trim().toUpperCase(); pickupQuery = v;
    const list = orders.filter(o => o.status === 'done' && (!v || shortId(o.id).startsWith(v) || o.name.toUpperCase().startsWith(v)));
    document.getElementById('pkl').innerHTML = list.map(o => `<div class="pr ${v.length === 4 && shortId(o.id) === v ? 'match' : ''}"><span class="c">${shortId(o.id)}</span><span class="ph">${previewHTML(ev, o)}</span>
      <div><div style="font:800 1.0625rem var(--body)">${esc(o.name)}</div><div style="font-size:.8125rem;color:var(--muted)">${esc(describe(ev, o))}${o.engraver ? ' • by ' + esc(o.engraver) : ''}</div></div>
      <button class="pk" type="button" data-pickedx="${o.id}">Picked up</button></div>`).join('') || `<p class="note">${v ? 'No ready piece matches that code.' : 'Nothing waiting for pickup.'}</p>`;
    document.querySelectorAll('[data-pickedx]').forEach(b => b.onclick = () => pickedUp(b.dataset.pickedx));
  }
  function bindBoard() {
    document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { openWho = openWho === b.dataset.pick ? null : b.dataset.pick; render(); });
    document.querySelectorAll('[data-start]').forEach(b => b.onclick = () => { openWho = null; move(b.dataset.start, 'progress', b.dataset.who); });
    document.querySelectorAll('[data-return]').forEach(b => b.onclick = () => move(b.dataset.return, 'queue'));
    document.querySelectorAll('[data-ready]').forEach(b => b.onclick = () => move(b.dataset.ready, 'done'));
    document.querySelectorAll('[data-picked]').forEach(b => b.onclick = () => pickedUp(b.dataset.picked));
    const d = document.getElementById('pk');
    document.getElementById('openpk').onclick = () => { d.showModal(); renderPickup(); document.getElementById('find').focus(); };
    document.getElementById('pkx').onclick = () => { d.close(); document.getElementById('openpk').focus(); };
    document.getElementById('find').oninput = renderPickup;
    document.getElementById('find').onkeydown = e => { if (e.key === 'Enter') e.preventDefault(); };
    // On a phone the cards fill the screen, so a touch has to scroll the page first; dragging needs a longer hold.
    const phone = matchMedia('(max-width:820px)').matches;
    document.querySelectorAll('.drop').forEach(el => new Sortable(el, {
      group: 'orders', animation: 150, delay: phone ? 350 : 120, delayOnTouchOnly: true, touchStartThreshold: phone ? 8 : 1, ...(phone ? { supportPointer: false } : {}), draggable: '.qc,.now,.rc', filter: 'button,.assign', preventOnFilter: false,
      onStart: () => { dragging = true; },
      onEnd: evt => {
        dragging = false;
        const id = evt.item.dataset.id, from = evt.from, to = evt.to;
        if (from !== to) move(id, to.dataset.status, to.dataset.engraver || null); else render();
      }
    }));
  }
  function move(id, status, engraver = null, undo = false) {
    const o = orders.find(x => x.id === id); if (!o) return;
    const patch = { status, updatedAt: serverTimestamp(), movedBy: me || user?.email || null };
    if (status === 'queue') { patch.engraver = null; patch.startedAt = null; patch.doneAt = null; patch.pickedAt = null; }
    if (status === 'progress') { patch.engraver = engraver; if (o.status !== 'progress') patch.startedAt = serverTimestamp(); patch.doneAt = null; patch.pickedAt = null; }
    if (status === 'done') { if (!undo) patch.doneAt = serverTimestamp(); patch.pickedAt = null; }
    if (status === 'picked') patch.pickedAt = serverTimestamp();
    updateDoc(doc(db, 'events', eventId, 'orders', id), patch).catch(e => { toast('That move did not save: ' + (e.code || e.message)); });
  }
  photoRerender = render;
  render();
}

// ---------- export ----------
const fmtStamp = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
const minsBetween = (a, b) => (a && b && b >= a) ? Math.round((b - a) / 6000) / 10 : '';
async function exportOrders(eventId, ev) {
  const snap = await getDocs(query(collection(db, 'events', eventId, 'orders'), orderBy('createdAt')));
  const head = ['Order #', 'Name', 'Category', 'Piece', 'Choices', 'Lettering', 'Texts', 'Submitted', 'Handled by', 'Started', 'Ready', 'Picked up', 'Wait in queue (min)', 'Time to make (min)', 'Submit to ready (min)', 'Status'];
  const rows = snap.docs.map(d => {
    const o = d.data();
    const sub = tsDate(o.createdAt), st = tsDate(o.startedAt), dn = (o.status === 'done' || o.status === 'picked') ? tsDate(o.doneAt) : null, pk = o.status === 'picked' ? tsDate(o.pickedAt) : null;
    return [shortId(d.id), o.name, CAT.categories.find(c => c.id === o.service)?.label || o.service || '', pieceLabel(o), choiceLabels(o).map(x => `${x.g}: ${x.c}`).join('; '),
      FONTS[o.font] || o.font || '', o.phone ? 'yes' : '', fmtStamp(sub), o.engraver || '', fmtStamp(st), fmtStamp(dn), fmtStamp(pk), minsBetween(sub, st), minsBetween(st, dn), minsBetween(sub, dn), STATUS_LABEL[o.status] || o.status];
  });
  const cell = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = '\ufeff' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `${eventId}-orders.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`${rows.length} orders exported. In Google Sheets: File → Import → Upload.`);
}

// ---------- staff: event setup, catalog, photos ----------
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const guestUrl = id => `${baseUrl()}#/e/${encodeURIComponent(id)}`;
const qrSvg = url => { const q = qrcode(0, 'M'); q.addData(url); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
function downloadQr(url, name) { const q = qrcode(0, 'M'); q.addData(url); q.make(); const l = document.createElement('a'); l.href = q.createDataURL(12, 4); l.download = `qr-${name}.gif`; l.click(); }
const staffHead = (title, tab, here) => `<header class="band"><a href="#/" aria-label="Events">${LOGO}</a><div class="ev">event setup</div>${WAVE(1180)}</header>
  <div class="shead2">${crumbs([['Events', '#/'], ['Event setup', '#/admin'], ...(tab === 'photos' ? [['Photos']] : here ? [[here]] : [])].slice(0, tab === 'photos' || here ? 3 : 2))}
  <nav class="snav" aria-label="Event setup"><span>${esc(user.email)}</span><a href="#" id="out">Sign out</a></nav></div>`;
function bindStaffHead() { const o = document.getElementById('out'); if (o) o.onclick = e => { e.preventDefault(); signOut(auth).then(() => { location.hash = '#/'; }); }; }
const staffLoading = msg => `<div class="page"><p class="note" style="padding:40px">${esc(msg)}</p></div>`;
const dropHidden = h => Object.fromEntries(Object.entries(h || {}).filter(([, v]) => v === true));
async function listEvents() { return (await getDocs(collection(db, 'events'))).docs.map(d => ({ id: d.id, ...d.data() })); }
const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

// The parts of an event's setup that carry over to the next one.
const setupFrom = src => ({ engravers: [...(src.engravers || [])], pickupNote: src.pickupNote || 'at the engraving table',
  items: Object.fromEntries(allPieces().map(({ it }) => [it.id, offered(src, it.id)])), hidden: dropHidden(src.hidden),
  ...(src.maxChars ? { maxChars: src.maxChars } : {}), ...(src.followLink ? { followLink: src.followLink } : {}), ...(src.thanksOn === false ? { thanksOn: false } : {}), ...(src.theme ? { theme: { ...src.theme } } : {}), ...(src.nameLabel ? { nameLabel: src.nameLabel } : {}), ...(Array.isArray(src.fonts) ? { fonts: [...src.fonts] } : {}),
  ...(Array.isArray(src.blockOrder) ? { blockOrder: [...src.blockOrder] } : {}), ...(src.preview === false ? { preview: false } : {}) });

// ---------- branding images ----------
// Logos shrink to a small PNG (keeps transparency) stored in the event's public branding doc.
async function fileToLogo(file, max = 360) {
  const img = await loadPicture(file), w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  let size = max, out = '';
  for (let i = 0; i < 4; i++) {
    const s = Math.min(1, size / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    out = c.toDataURL('image/png');
    if (out.length < 250000) return out;
    size = Math.round(size * 0.7);
  }
  return out;
}
const BRAND_SLOTS = [['tc', 'Top center'], ['tl', 'Top left'], ['tr', 'Top right'], ['bc', 'Bottom center']];
// Each branding image sits in a fixed box, evenly spaced: corners are 24×14 (in % of the header width), 4% in from the edges.
const BRAND_ASPECT = { tl: 24 / 14, tr: 24 / 14, bc: 3, tc: 3 / 2 };
const brandRef = id => doc(db, 'events', id, 'public', 'branding');
const brandImg = (b, k) => { const f = b?.fit?.[k]; return f ? `<img class="pfit" src="${esc(b[k])}" alt="" style="${fitVars(f)}">` : `<img class="bcontain" src="${esc(b[k])}" alt="">`; };
const brandCorners = b => ['tl', 'tr'].map(k => b?.[k] ? `<span class="bbox ${k}">${brandImg(b, k)}</span>` : '').join('');
const brandBottom = b => b?.bc ? `<div class="bbottom"><span class="bbox bc">${brandImg(b, 'bc')}</span></div>` : '';
const STEPH_LOGO = 'logo-steph.png';
const brandTop = b => `<span class="bbox tc">${b?.tc ? brandImg(b, 'tc') : `<img class="bcontain" src="${STEPH_LOGO}" alt="Ivelisse Designs">`}</span>`;
// Starting fit that shows the whole image inside a box of the given width/height ratio.
async function containFit(src, aspect) {
  const im = new Image(); im.src = src; try { await im.decode(); } catch (e) { return { z: 1, x: 0, y: 0 }; }
  const a = (im.naturalWidth || 1) / (im.naturalHeight || 1);
  return { z: +Math.min(1, a / aspect).toFixed(3), x: 0, y: 0 };
}
// What surrounds each box on the guest's screen, drawn around the frame in the adjust window
// (positions are in % of the frame, so it reads like a zoomed-in view of that part of the page).
const ADJ_CTX = {
  tl: { bg: 'var(--band)', html: '<img class="adjghost" src="logo.png" alt="" style="left:142%;top:-7%;width:98%"><i class="adjoff" style="right:116.7%"></i>' },
  tr: { bg: 'var(--band)', html: '<img class="adjghost" src="logo.png" alt="" style="right:142%;top:-7%;width:98%"><i class="adjoff" style="left:116.7%"></i>' },
  bc: { bg: 'var(--cream)', html: '<i class="adjfield" style="left:-14%;right:-14%;bottom:150%;height:62%"></i><i class="adjline" style="left:-8%;right:-8%;bottom:118%"></i><i class="adjline" style="left:4%;right:4%;bottom:106%"></i><i class="adjbtn" style="left:-14%;right:-14%;top:132%;height:62%"></i>' },
  tc: { bg: 'var(--band)', html: '<i class="adjoff" style="right:150%"></i><i class="adjoff" style="left:150%"></i>' },
  photo: { bg: '#2a2a2a', html: '' }
};
// Canva-style framing: drag to move, pinch / scroll / slider to zoom, 3×3 grid, undo and redo.
// The dimmed part outside the frame is kept with the image but never shown to guests.
function openAdjust({ src, fit, aspect = 1, title = 'Adjust', ctx = ADJ_CTX.photo, base = null, onSave }) {
  let f = { z: 1, x: 0, y: 0, ...(fit || {}) };
  const hist = [{ ...f }]; let hi = 0;
  const d = document.createElement('dialog'); d.className = 'adj';
  const fw = aspect >= 2.5 ? 80 : aspect > 1.2 ? 46 : 56, light = /cream/.test(ctx.bg);
  d.innerHTML = `<div class="adjtop"><button type="button" class="btn out" data-undo>↶ Undo</button><b>${esc(title)}</b><button type="button" class="btn out" data-redo>Redo ↷</button></div>
    <div class="adjstage ${light ? 'light' : ''}" style="background:${ctx.bg}"><div class="adjframe" style="width:${fw}%;aspect-ratio:${aspect}">${ctx.html}<img class="pfit adjdim" src="${esc(src)}" alt=""><div class="adjclip"><img class="pfit" src="${esc(src)}" alt=""></div><div class="adjgrid" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div></div>
    <label class="adjzoom"><span>Zoom <b data-zv>(100%)</b></span><input type="range" min="20" max="400" step="5" list="adjticks" data-zoom></label>
    <datalist id="adjticks">${Array.from({ length: 77 }, (_, i) => `<option value="${20 + i * 5}"></option>`).join('')}</datalist>
    <div class="adjpos"><label>Zoom %<input type="number" step="5" data-nz></label><label>Left / right %<input type="number" step="1" data-nx></label><label>Up / down %<input type="number" step="1" data-ny></label></div>
    <p class="hint">Drag to move. Pinch, scroll or use the slider to zoom. Only what's inside the box shows to guests.</p>
    <div class="adjbar"><button type="button" class="linkbtn" data-reset>Reset</button><button type="button" class="btn out" data-cancel>Back</button><button type="button" class="btn" data-save>Save</button></div>`;
  document.body.appendChild(d);
  const frame = d.querySelector('.adjframe'), stage = d.querySelector('.adjstage'), imgs = d.querySelectorAll('.pfit'), zoom = d.querySelector('[data-zoom]');
  const undoB = d.querySelector('[data-undo]'), redoB = d.querySelector('[data-redo]');
  const zv = d.querySelector('[data-zv]'), nz = d.querySelector('[data-nz]'), nx = d.querySelector('[data-nx]'), ny = d.querySelector('[data-ny]');
  const paint = () => { imgs.forEach(i => { i.style.cssText = fitVars(f); }); zoom.value = Math.round(f.z * 100); zv.textContent = `(${Math.round(f.z * 100)}%)`;
    [[nz, Math.round(f.z * 100)], [nx, Math.round(f.x)], [ny, Math.round(f.y)]].forEach(([el, v]) => { if (document.activeElement !== el) el.value = v; });
    undoB.disabled = hi === 0; redoB.disabled = hi === hist.length - 1; };
  [[nz, v => { f.z = v / 100; }], [nx, v => { f.x = v; }], [ny, v => { f.y = v; }]].forEach(([el, set]) => { el.oninput = () => { const v = +el.value; if (el.value !== '' && isFinite(v)) { set(v); clampF(); paint(); } }; el.onchange = () => { commit(); paint(); }; });
  const commit = () => { const l = hist[hi]; if (l.z === f.z && l.x === f.x && l.y === f.y) return; hist.splice(hi + 1); hist.push({ ...f }); hi = hist.length - 1; paint(); };
  const clampF = () => { f.z = Math.min(4, Math.max(0.2, f.z)); const lim = 50 + 100 * f.z; f.x = Math.max(-lim, Math.min(lim, f.x)); f.y = Math.max(-lim, Math.min(lim, f.y)); };
  const pts = new Map(); let start = null;
  const snap = () => { start = { f: { ...f }, pts: [...pts.values()].map(v => ({ ...v })) }; };
  stage.addEventListener('pointerdown', e => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); snap(); stage.classList.add('moving'); });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const a = [...pts.values()], b = start.pts, r = frame.getBoundingClientRect();
    if (a.length >= 2 && b.length >= 2) { const dist = p => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); f.z = start.f.z * dist(a) / Math.max(1, dist(b)); }
    else if (b.length) { f.x = start.f.x + (a[0].x - b[0].x) / r.width * 100; f.y = start.f.y + (a[0].y - b[0].y) / r.height * 100; }
    clampF(); paint();
  });
  const up = e => { pts.delete(e.pointerId); snap(); if (!pts.size) { stage.classList.remove('moving'); commit(); } };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  let wt = null;
  stage.addEventListener('wheel', e => { e.preventDefault(); f.z *= Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)); clampF(); paint(); clearTimeout(wt); wt = setTimeout(commit, 300); }, { passive: false });
  zoom.oninput = () => { f.z = Math.round(zoom.value / 5) * 5 / 100; clampF(); paint(); }; zoom.onchange = commit;
  undoB.onclick = () => { if (hi > 0) { hi--; f = { ...hist[hi] }; paint(); } };
  redoB.onclick = () => { if (hi < hist.length - 1) { hi++; f = { ...hist[hi] }; paint(); } };
  d.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? redoB : undoB).click(); } });
  d.querySelector('[data-reset]').onclick = async () => { f = base ? { ...base } : await containFit(src, aspect); commit(); paint(); };
  let closed = false; const close = () => { if (closed) return; closed = true; try { d.close(); } catch (e) {} d.remove(); };
  d.querySelector('[data-cancel]').onclick = close; d.addEventListener('cancel', e => { e.preventDefault(); close(); });
  const sb = d.querySelector('[data-save]');
  sb.onclick = async () => { sb.disabled = true; sb.textContent = 'Saving…';
    try { await onSave({ z: +f.z.toFixed(3), x: +f.x.toFixed(2), y: +f.y.toFixed(2) }); close(); }
    catch (err) { toast('Could not save: ' + (err.code || err.message)); sb.disabled = false; sb.textContent = 'Save'; } };
  d.showModal(); paint();
}
// "Are you sure?" with Confirm and Back.
function confirmBox(msg, ok = 'Confirm') {
  return new Promise(res => {
    const d = document.createElement('dialog'); d.className = 'confirm';
    d.innerHTML = `<p>${esc(msg)}</p><div class="crow"><button type="button" class="btn out" data-back>Back</button><button type="button" class="btn danger" data-ok>${esc(ok)}</button></div>`;
    document.body.appendChild(d);
    let done = false; const fin = v => { if (done) return; done = true; try { d.close(); } catch (e) {} d.remove(); res(v); };
    d.querySelector('[data-back]').onclick = () => fin(false); d.querySelector('[data-ok]').onclick = () => fin(true);
    d.addEventListener('cancel', e => { e.preventDefault(); fin(false); });
    d.showModal(); d.querySelector('[data-back]').focus();
  });
}
// Page order on the guest form after the item: the name box and each question, as the event sets it.
const orderBlocks = (ev, blocks) => { const o = (ev && ev.blockOrder) || []; return blocks.map((b, i) => ({ b, k: o.includes(b.id) ? o.indexOf(b.id) : 1000 + i })).sort((a, c) => a.k - c.k).map(x => x.b); };
const fontKeys = ev => { const f = Array.isArray(ev?.fonts) ? ev.fonts.filter(k => FONTS[k]) : []; return f.length ? f : Object.keys(FONTS); };
const maxChars = ev => Math.min(30, Math.max(1, +(ev && ev.maxChars) || 14));

const goUrl = () => `${baseUrl()}#/go`;

// New event, optionally reusing another event's staff, pickup spot, menu and branding.
async function createEvent(name, date, src) {
  // Never overwrite an existing event that happens to share the name and date.
  const base = (name || date ? slug(`${name}-${date}`) : '') || 'new-event'; let id = base;
  for (let n = 2; (await getDoc(doc(db, 'events', id))).exists(); n++) id = `${base}-${n}`;
  const setup = src ? setupFrom(src) : { engravers: ['Steph'], pickupNote: 'at the engraving table', items: Object.fromEntries(allPieces().map(({ it }) => [it.id, true])), hidden: {} };
  await setDoc(doc(db, 'events', id), { name, date, ...setup, photos: {}, open: false, createdAt: serverTimestamp(), ...(src ? { copiedFrom: src.id } : {}) });
  let pin = ''; if (src) { try { pin = await loadPin(src.id); } catch (x) {} }
  await setDoc(pinRef(id), { pin: pin || newPin(), updatedAt: serverTimestamp() });
  if (src) { try { const b = await getDoc(brandRef(src.id)); if (b.exists()) await setDoc(brandRef(id), b.data()); } catch (x) {} }
  if (src) { try { const ps = (await getDocs(collection(db, 'events', src.id, 'public'))).docs.filter(d => d.id.startsWith('photo_'));
    await Promise.all(ps.map(d => setDoc(doc(db, 'events', id, 'public', d.id), d.data()))); } catch (x) {} }
  try {
    const pairs = src ? [[followRef(src.id), followRef(id)], [followImgRef(src.id), followImgRef(id)]] : [[lastFollowRef(), followRef(id)], [lastFollowImgRef(), followImgRef(id)]];
    for (const [a, b] of pairs) { const f = await getDoc(a); if (f.exists()) { const { link, ...rest } = f.data(); await setDoc(b, rest); if (!src && link) await updateDoc(doc(db, 'events', id), { followLink: link }); } }
  } catch (x) {}
  return id;
}

// One-time cleanup (Nov 2026): delete the old test and demo events, keeping only TikTok Popcorn.
// Runs when a manager opens Event setup; safe to run again since missing events are skipped.
const OLD_EVENTS = ['demo', 'event-2-2026-11-21', 'test-1-2026-11-20', 'test-2026-11-09'];
async function purgeOldEvents() {
  for (const id of OLD_EVENTS) {
    if (!(await getDoc(doc(db, 'events', id))).exists()) continue;
    const refs = [];
    for (const sub of ['orders', 'public', 'private', 'staffSessions']) (await getDocs(collection(db, 'events', id, sub))).docs.forEach(d => refs.push(d.ref));
    refs.push(doc(db, 'events', id));
    for (let i = 0; i < refs.length; i += 400) { const b = writeBatch(db); refs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit(); }
  }
}

async function adminPage() {
  $app.innerHTML = staffLoading('Loading events…');
  let evs;
  try { if (await isStaff()) await purgeOldEvents(); } catch (e) { toast('Cleanup of old events failed: ' + (e.code || e.message)); }
  try { evs = await listEvents(); }
  catch (e) { $app.innerHTML = `<div class="wrap"><p class="err">Could not load events: ${esc(e.code || e.message)}</p></div>`; return; }
  const today = todayStr();
  const real = evs.filter(e => e.id !== DEMO_ID);
  const live = openEvents(evs), isLive = ev => live.some(e => e.id === ev.id);
  const upcoming = real.filter(e => isLive(e) || (e.date || '') >= addDays(today, -1)).sort((a, b) => -byDateDesc(a, b));
  const past = real.filter(e => !isLive(e) && (e.date || '') < addDays(today, -1)).sort(byDateDesc);
  // Each event's PIN, for the tiles (managers can read them).
  const pins = {};
  await Promise.all(upcoming.map(e => loadPin(e.id).then(p => { pins[e.id] = p; }).catch(() => {})));
  const making = ev => allPieces().filter(({ it }) => offered(ev, it.id)).map(({ it }) => it.label);
  const tile = ev => { const to = `#/admin/${encodeURIComponent(ev.id)}`, on = isLive(ev), staff = (ev.engravers || []).length, m = making(ev);
    return `<article class="etile ${on ? 'live' : ''} ${ev.open === false ? 'closed' : ''}">
      <a class="etop" href="${to}" aria-label="Set up ${esc(ev.name)}">
        <span class="chip ${on ? 'live' : ''}">${on ? 'Live now' : 'Closed'}</span>
        <h2>${esc(ev.name)}</h2><p class="edate">${esc(fmtDate(ev.date))}</p>
        <dl class="estats"><div><dt>Staff</dt><dd>${staff}</dd></div><div><dt>PIN</dt><dd class="epin">${esc(pins[ev.id] || '····')}</dd></div><div><dt>Pieces</dt><dd>${m.length}</dd></div></dl>
        <p class="emaking">${m.length ? m.map(esc).join(' · ') : 'Nothing on the menu yet'}</p>
        <span class="eedit">Edit setup ›</span></a>
      <a class="btn pov" data-pov="${esc(ev.id)}" href="#/e/${encodeURIComponent(ev.id)}">Client's POV</a></article>`; };
  const row = ev => `<a class="evcard" href="#/admin/${encodeURIComponent(ev.id)}"><div><b>${esc(ev.name)}</b><span>${esc(fmtDate(ev.date))} · ${(ev.engravers || []).length} staff</span></div><span class="chip">${ev.open === false ? 'Closed' : 'Open'}</span><span class="chev" aria-hidden="true">›</span></a>`;
  setPov(null);
  $app.innerHTML = `${staffHead('event setup', 'setup')}<main class="wrap">
    <div class="etiles ${smart(upcoming.length)}">${upcoming.slice().sort((a, b) => isLive(b) - isLive(a)).map(tile).join('') || '<p class="note">Nothing scheduled. Create an event below.</p>'}</div>
    <details class="newev card" ${upcoming.length ? '' : 'open'}><summary>+ New event</summary>
      <form id="new" class="newform">
        <div class="field"><label class="lbl" for="n-name">Event name</label><input id="n-name" required placeholder="Coach · NorthPark"></div>
        <div class="field"><label class="lbl" for="n-date">Date</label><input id="n-date" type="date" required value="${today}"></div>
        <div class="field wide"><label class="lbl" for="n-from">Start from</label><select id="n-from"><option value="">Blank: every piece on</option>
          ${real.slice().sort(byDateDesc).map(e => `<option value="${esc(e.id)}">Copy ${esc(e.name)} · ${esc(fmtDate(e.date))}</option>`).join('')}</select></div>
        <button class="btn">Create event</button></form></details>
    ${past.length ? `<details class="pastev"><summary>Past events (${past.length})</summary><div class="evlist">${past.map(row).join('')}</div></details>` : ''}
  </main>`;
  bindStaffHead();
  document.querySelectorAll('[data-pov]').forEach(a => a.onclick = () => setPov(a.dataset.pov));
  document.getElementById('new').onsubmit = async e => {
    e.preventDefault();
    const name = document.getElementById('n-name').value.trim(), date = document.getElementById('n-date').value;
    if (!name || !date) return;
    const src = evs.find(x => x.id === document.getElementById('n-from').value);
    const btn = e.target.querySelector('.btn'); btn.disabled = true;
    try {
      const id = await createEvent(name, date, src);
      location.hash = `#/admin/${encodeURIComponent(id)}`;
    } catch (err) { btn.disabled = false; toast('Could not create: ' + (err.code || err.message)); }
  };
}

// ---------- menu tree ----------
// The event's menu, top-down: category → piece → question → choice. Tap a row to open its branch and edit
// names right on it. Switches turn a piece or a choice on or off for this event only; names, photos and
// anything added or deleted are shared by every event. Photos come straight from the camera roll.
function menuTree(cat, { changed, rerender, st }) {
  // Step 3 is the guest form itself. Tap a word to rename it, tap a piece or choice for its options,
  // tap × to delete (with Undo), tap a dashed + to add. "Off" applies to this event only; everything
  // else is shared by every event. A question shows color dots when its choices have colors.
  const uniq = (label, taken, fallback) => { const b = slug(label) || fallback; let id = b; for (let n = 2; taken.has(id); n++) id = `${b}-${n}`; taken.add(id); return id; };
  cat.categories.forEach(c => c.items.forEach(it => it.groups.forEach(g => { if (g.swatch) g.choices.forEach(x => { x.color = x.color || SWATCH[x.id] || '#cccccc'; }); })));
  let sc = Math.max(0, cat.categories.findIndex(c => c.items.some(it => it._on))), sp = 0, focus = null; // focus: {t:'piece'} | {t:'ch', q, x}
  const C = () => cat.categories[sc] || null, P = () => C()?.items[sp] || null;
  sp = Math.max(0, (C()?.items || []).findIndex(it => it._on));
  const colored = g => g.choices.some(x => x.color);
  const img = key => key && typeof photoLib[key] === 'string' ? photoImg(photoLib[key], key) : '';
  const drawFor = it => { const g = it.groups.find(colored), c0 = g?.choices.find(x => !x._off);
    return window.EngravePreview.renderPreview({ item: it.preview || 'card', color: c0?.id, hex: c0?.color, addon: 'none', name: '', font: 'script' }); };
  const keyIf = (it, x) => it._new || (x && x._new) ? null : x ? `${it.id}_${x.id}` : it.id;
  const pieceIds = () => new Set(cat.categories.flatMap(c => c.items).filter(i => !i._new).map(i => i.id));
  const ensureId = (o, taken, fb) => { if (o._new) { if (!o.label.trim()) return null; o.id = uniq(o.label, taken, fb); delete o._new; } return o.id; };
  const fresh = o => { const c = JSON.parse(JSON.stringify(o)); const mark = v => { delete v.id; v._new = true; }; mark(c); (c.groups || []).forEach(g => { mark(g); g.choices.forEach(mark); }); return c; };
  const ed = (attr, val, text, ph) => `<span class="ged" contenteditable="true" spellcheck="false" ${attr}="${val}" data-ph="${esc(ph)}">${esc(text)}</span>`;
  const x_ = (attr, val, what) => `<button type="button" class="gx" ${attr}="${val}" aria-label="Delete ${esc(what)}">×</button>`;
  let undoSnap = null;
  function remove(fn, what) {
    undoSnap = JSON.stringify({ categories: cat.categories, sc, sp });
    fn(); focus = null; changed(true); rerender();
    toast(`${what} deleted`, { label: 'Undo', run: () => { const s = JSON.parse(undoSnap); cat.categories = s.categories; sc = s.sc; sp = s.sp; changed(true); rerender(); } });
  }

  const grip = '<span class="ggrip" title="Drag to reorder" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>';
  const blockId = (g, qi) => g._new || !g.id ? `q:new${qi}` : `q:${g.id}`;
  function guest() {
    const c = C(), it = P(), cats = cat.categories;
    // Categories only matter when more than one has items; otherwise the guest just sees items.
    const multi = cats.filter(x => x.items.length).length > 1;
    const nameBlk = `<div class="gblk gq" data-blk="name">${grip}<div class="glegend">personalize it</div>
        <div class="gnamefld">${ed('data-nlabel', 0, st.nameLabel || 'Personalization', 'Personalization')}
          <div class="gnamebox">Name or initials</div>
          <label class="gmax">Max characters <input type="number" min="1" max="30" inputmode="numeric" data-maxc value="${esc(st.maxChars)}"></label></div>
        <div class="gfonts"><span>Lettering guests can pick</span>${Object.entries(FONTS).map(([k, l]) => `<label class="gfont"><input type="checkbox" data-fontk="${k}" ${st.fonts.includes(k) ? 'checked' : ''}><b data-font="${k}">${esc(l)}</b></label>`).join('')}</div>
        <small class="hint">${st.fonts.length === 1 ? `Guests won't see a choice: everything is ${esc(FONTS[st.fonts[0]].toLowerCase())}.` : 'Guests pick one. Required: at least 1 character.'}</small></div>`;
    const qBlks = it ? it.groups.map((g, qi) => ({ id: blockId(g, qi), html: `<div class="gblk gq ${g._hid ? 'ghid' : ''}" data-blk="${blockId(g, qi)}">${grip}
          <div class="glegend">choose your <em>${ed('data-qtitle', qi, g.label, 'question')}</em>${g._hid ? `<button type="button" class="gx gaddback" data-delq="${qi}" aria-label="Add this question back">+</button>` : x_('data-delq', qi, g.label || 'question')}</div>${g._hid ? '<small class="goff">not asked at this event</small>' : ''}
          <div class="${colored(g) ? 'gsw' : 'gseg'}">${g.choices.map((x, xi) => `<span class="gch ${x._off ? 'off' : ''} ${focus?.t === 'ch' && focus.q === qi && focus.x === xi ? 'focus' : ''}" data-ch="${qi}.${xi}">
              ${colored(g) ? `<b style="background:${esc(x.color || '#fff')}"></b>` : ''}${embIcon(g, x)}${ed('data-cname', `${qi}.${xi}`, x.label, 'choice')}${x._off ? `<button type="button" class="gx gaddback" data-delch="${qi}.${xi}" aria-label="Add ${esc(x.label)} back">+</button>` : x_('data-delch', `${qi}.${xi}`, x.label || 'choice')}</span>`).join('')}
<button type="button" class="gbub" data-addch="${qi}" aria-label="Add another ${esc((g.label || 'option').toLowerCase())}" title="Add another ${esc((g.label || 'option').toLowerCase())}">+</button></div></div>` })) : [];
    const blocks = orderBlocks({ blockOrder: st.blockOrder }, [{ id: 'name', html: nameBlk }, ...qBlks]);
    return `<div class="gphone"><div class="pb-band"><img class="logo" src="logo.png" alt=""></div><div class="gbody">
      ${multi ? `<div class="glegend">what are we <em>making?</em></div>
      <div class="gcats">${cats.map((x, i) => `<span class="gcat ${i === sc ? 'sel' : ''}" data-cat="${i}">${ed('data-catname', i, x.label, 'Category')}${x_('data-delcat', i, x.label || 'category')}</span>`).join('')}</div>` : ''}
      ${c ? `<div class="glegend"><span class="gstep">1</span>what are we personalizing?</div>
      <div class="gpick ${smart(c.items.filter(p => p._on || p._new).length + 1)}">${c.items.map((p, i) => !(p._on || p._new) ? '' : `<div class="gpc ${i === sp ? 'sel' : ''} ${p._on ? '' : 'off'} ${focus?.t === 'piece' && i === sp ? 'focus' : ''}" data-piece="${i}">
          ${p._on ? x_('data-delpiece', i, p.label || 'item') : `<button type="button" class="gx gaddback" data-delpiece="${i}" aria-label="Add ${esc(p.label)} back to this event">+</button>`}<div class="gph">${img(keyIf(p)) || drawFor(p)}</div>${ed('data-pname', i, p.label, 'Name this item')}${p._on ? '' : '<small class="goff">off at this event</small>'}</div>`).join('')}
        <button type="button" class="gpc gplus" data-addpiece>+ Add an item</button></div>
      ${c.items.some(p => !p._on && !p._new) ? `<div class="gback"><span>Not at this event:</span>${c.items.map((p, i) => p._on || p._new ? '' : `<button type="button" class="gbackbtn" data-addback="${i}">+ ${esc(p.label)}</button>`).join('')}</div>` : ''}` : ''}
      ${it ? `<p class="hint gorder">Drag <b>⠿</b> to change the order guests see these in. The item always comes first.</p>
        <div class="gblocks">${blocks.map(x => x.html).join('')}</div>
        <div class="gq"><button type="button" class="gaddq" data-addq><b>+ Ask guests something else</b><small>like size or font color</small></button></div>
` : ''}
    </div></div>`;
  }
  function panel() {
    const it = P();
    if (!focus || !it) return `<div class="gpanel"><h4>options</h4><p class="hint" style="margin:0">Tap an item or a choice to see its options here.</p></div>`;
    const [ci, pi] = [sc, sp];
    const shut = '<button type="button" class="gshut" data-act="shut" aria-label="Close options">×</button>';
    const adj = k => k && typeof photoLib[k] === 'string' ? `<button type="button" class="btn out" data-adjust="${esc(k)}">Adjust photo</button><button type="button" class="linkbtn" data-droppic="${esc(k)}">Remove photo</button>` : '';
    if (focus.t === 'piece') return `<div class="gpanel"><h4>${ed('data-ptitle', sp, it.label, 'Name this item')}${shut}</h4>
      <label class="gdrop" data-drop="p:${ci}.${pi}"><span class="gdthumb">${img(keyIf(it)) || drawFor(it)}</span><span><b>${img(keyIf(it)) ? 'Change photo' : 'Add photo'}</b><small>Click to choose, drag one here, or paste with ⌘V</small></span><input type="file" accept="image/*,.heic,.heif" data-pfile="p:${ci}.${pi}"></label>
      ${adj(keyIf(it))}
      <button type="button" class="btn out" data-act="toggle">${it._on ? 'Remove from this event' : 'Add back to this event'}</button>
      <button type="button" class="btn out" data-act="dup">Duplicate</button>
      <div class="gmove"><button type="button" class="btn out" data-act="up" ${sp === 0 ? 'disabled' : ''}>‹ Earlier</button><button type="button" class="btn out" data-act="down" ${sp === C().items.length - 1 ? 'disabled' : ''}>Later ›</button></div>
</div>`;
    const g = it.groups[focus.q], x = g.choices[focus.x];
    return `<div class="gpanel"><h4>${esc(x.label || 'New choice')}${shut}</h4>
      ${focus.q === 0 ? `<label class="gdrop" data-drop="x:${ci}.${pi}.${focus.q}.${focus.x}"><span class="gdthumb">${img(keyIf(it, x)) || (x.color ? `<i style="background:${esc(x.color)}"></i>` : '')}</span><span><b>${img(keyIf(it, x)) ? 'Change photo' : 'Add photo'}</b><small>Click to choose, drag one here, or paste with ⌘V</small></span><input type="file" accept="image/*,.heic,.heif" data-pfile="x:${ci}.${pi}.${focus.q}.${focus.x}"></label>${adj(keyIf(it, x))}` : ''}
      <label class="btn out gcolor">Color <input type="color" data-color value="${esc(x.color || '#cccccc')}"></label>
      ${x.color ? '<button type="button" class="btn out" data-act="nocolor">No color</button>' : ''}
      <button type="button" class="btn out" data-act="toggle">${x._off ? 'Add back to this event' : 'Remove from this event'}</button>
      <div class="gmove"><button type="button" class="btn out" data-act="up" ${focus.x === 0 ? 'disabled' : ''}>‹ Earlier</button><button type="button" class="btn out" data-act="down" ${focus.x === g.choices.length - 1 ? 'disabled' : ''}>Later ›</button></div>
</div>`;
  }
  const html = () => `<div class="gb">${guest()}<div class="gside">${panel()}</div></div>`;

  function keyFor(ref) {
    const [kind, path] = ref.split(':'), [ci, pi, gi, xi] = path.split('.').map(Number);
    const it = cat.categories[ci].items[pi];
    const pid = ensureId(it, pieceIds(), 'piece'); if (!pid) return null;
    if (kind === 'p') return pid;
    const g = it.groups[gi], x = g.choices[xi];
    const xid = ensureId(x, new Set(g.choices.filter(c => !c._new).map(c => c.id)), 'choice'); if (!xid) return null;
    return `${pid}_${xid}`;
  }
  function act(a) {
    if (a === 'shut') { focus = null; return rerender(); }
    const it = P();
    if (focus.t === 'piece') {
      const arr = C().items;
      if (a === 'toggle') { it._on = !it._on; if (!it._on) { const j = arr.findIndex(q => q._on || q._new); sp = Math.max(0, j); focus = null; } changed(false); return rerender(); }
      if (a === 'dup') { const cp = fresh(it); cp.label = it.label + ' copy'; arr.splice(sp + 1, 0, cp); sp++; changed(true); rerender(); return editNow(`[data-pname="${sp}"]`); }
      if (a === 'up' || a === 'down') { const j = sp + (a === 'up' ? -1 : 1); [arr[sp], arr[j]] = [arr[j], arr[sp]]; sp = j; changed(true); return rerender(); }
      if (a === 'del') return confirmBox(`Delete ${it.label ? `"${it.label}"` : 'this item'} from every event? Past orders keep their details. This can't be undone after you leave the page.`, 'Delete everywhere').then(ok => ok && remove(() => { arr.splice(sp, 1); sp = Math.max(0, sp - 1); }, it.label || 'Item'));
    } else {
      const g = it.groups[focus.q], arr = g.choices, x = arr[focus.x];
      if (a === 'toggle') { if (!x._off && arr.filter(c => !c._off).length === 1) return toast('Leave at least one choice on.'); x._off = !x._off; changed(false); return rerender(); }
      if (a === 'nocolor') { delete x.color; changed(true); return rerender(); }
      if (a === 'up' || a === 'down') { const j = focus.x + (a === 'up' ? -1 : 1); [arr[focus.x], arr[j]] = [arr[j], arr[focus.x]]; focus.x = j; changed(true); return rerender(); }
      if (a === 'del') return remove(() => arr.splice(focus.x, 1), x.label || 'Choice');
    }
  }
  // Bring the thing being worked on to the middle of the screen.
  let centerNext = false;
  // On a phone the options panel covers the bottom half, so center in the space above it.
  const center = () => {
    const go = smooth => { const el = document.querySelector('.gb .focus'); if (!el) return;
      const panel = innerWidth <= 760 ? document.querySelector('.gb .gpanel') : null;
      const bottom = panel ? panel.getBoundingClientRect().top : innerHeight, r = el.getBoundingClientRect();
      const d = r.top + r.height / 2 - bottom / 2; if (Math.abs(d) > 8) scrollBy({ top: d, behavior: smooth ? 'smooth' : 'auto' }); };
    requestAnimationFrame(() => go(true)); setTimeout(() => go(false), 450);
  };
  function editNow(sel) {
    const e = document.querySelector('.gb ' + sel); if (!e) return;
    e.focus(); const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function bind() {
    const root = document.querySelector('.gb'); if (!root) return;
    root.addEventListener('pointerdown', () => document.querySelectorAll('.bslot2.armed').forEach(x => x.classList.remove('armed')));
    const sideOnly = () => { const s = root.querySelector('.gside'); s.innerHTML = panel(); bindPanel(); root.querySelectorAll('.focus').forEach(e => e.classList.remove('focus')); };
    if (centerNext) { centerNext = false; center(); }
    root.querySelectorAll('[contenteditable]').forEach(e => {
      e.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); e.blur(); } };
      e.onclick = ev => ev.stopPropagation();
    });
    root.querySelectorAll('[data-catname]').forEach(e => e.oninput = () => { cat.categories[+e.dataset.catname].label = e.textContent.trim(); changed(true); });
    root.querySelectorAll('[data-pname]').forEach(e => { e.oninput = () => { C().items[+e.dataset.pname].label = e.textContent.trim(); changed(true); const m = document.querySelector('.gb .gside [data-ptitle]'); if (m && +e.dataset.pname === sp) m.textContent = e.textContent.trim(); }; e.onfocus = () => { const i = +e.dataset.pname; if (sp !== i || focus?.t !== 'piece') { sp = i; focus = { t: 'piece' }; sideOnly(); e.closest('.gpc').classList.add('focus'); center(); } }; });
    root.querySelectorAll('[data-qtitle]').forEach(e => e.oninput = () => { P().groups[+e.dataset.qtitle].label = e.textContent.trim(); changed(true); });
    root.querySelectorAll('[data-cname]').forEach(e => { e.oninput = () => { const [q, x] = e.dataset.cname.split('.').map(Number); P().groups[q].choices[x].label = e.textContent.trim(); changed(true); }; e.onfocus = () => { const [q, x] = e.dataset.cname.split('.').map(Number); focus = { t: 'ch', q, x }; sideOnly(); e.closest('.gch').classList.add('focus'); center(); }; });
    root.querySelectorAll('[data-cat]').forEach(e => e.onclick = ev => { if (ev.target.closest('.gx')) return; const i = +e.dataset.cat; if (i !== sc) { sc = i; sp = 0; focus = null; rerender(); } });
    root.querySelectorAll('[data-piece]').forEach(e => e.onclick = ev => { if (ev.target.closest('.gx')) return; const i = +e.dataset.piece; const same = sp === i; sp = i; focus = { t: 'piece' }; if (same) { sideOnly(); e.classList.add('focus'); center(); } else { centerNext = true; rerender(); } });
    root.querySelectorAll('[data-ch]').forEach(e => e.onclick = ev => { if (ev.target.closest('.gx')) return; const [q, x] = e.dataset.ch.split('.').map(Number); focus = { t: 'ch', q, x }; sideOnly(); e.classList.add('focus'); center(); });
    root.querySelectorAll('[data-delcat]').forEach(b => b.onclick = () => { const c = cat.categories[+b.dataset.delcat];
      if (c._new) return remove(() => { cat.categories.splice(+b.dataset.delcat, 1); sc = 0; sp = 0; }, 'Category');
      const was = c.items.map(it => it._on); c.items.forEach(it => { it._on = false; }); changed(false); rerender();
      toast(`${c.label} removed from this event`, { label: 'Undo', run: () => { c.items.forEach((it, i) => { it._on = was[i]; }); changed(false); rerender(); } }); });
    root.querySelectorAll('[data-addback]').forEach(b => b.onclick = () => { const p = C().items[+b.dataset.addback]; p._on = true; changed(false); rerender(); });
    root.querySelectorAll('[data-delpiece]').forEach(b => b.onclick = async () => { const i = +b.dataset.delpiece, p = C().items[i];
      if (p._new) return remove(() => { C().items.splice(i, 1); sp = Math.max(0, Math.min(sp, C().items.length - 1)); }, 'Item');
      if (!p._on) { p._on = true; changed(false); return rerender(); }
      if (!(await confirmBox(`Remove ${p.label ? `"${p.label}"` : 'this item'} from this event? It stays available to add back, and other events keep it.`, 'Remove'))) return;
      p._on = false; if (sp === i) { const j = C().items.findIndex(q => q._on || q._new); sp = Math.max(0, j); focus = null; } changed(false); rerender(); toast(`${p.label || 'Item'} removed from this event`, { label: 'Undo', run: () => { p._on = true; changed(false); rerender(); } }); });
    root.querySelectorAll('[data-delq]').forEach(b => b.onclick = () => { const i = +b.dataset.delq, g = P().groups[i];
      if (g._new) return remove(() => P().groups.splice(i, 1), g.label || 'Question');
      g._hid = !g._hid; changed(false); rerender();
      if (g._hid) toast(`${g.label || 'Question'} removed from this event`, { label: 'Undo', run: () => { g._hid = false; changed(false); rerender(); } }); });
    root.querySelectorAll('[data-delch]').forEach(b => b.onclick = () => { const [q, x] = b.dataset.delch.split('.').map(Number), g = P().groups[q], ch = g.choices[x];
      if (ch._new) return remove(() => g.choices.splice(x, 1), ch.label || 'Choice');
      if (!ch._off && g.choices.filter(c => !c._off).length === 1) { toast('Leave at least one choice on. Remove the whole question instead.'); return; }
      ch._off = !ch._off; changed(false); rerender(); });
    const acat = root.querySelector('[data-addcat]'); if (acat) acat.onclick = () => { cat.categories.push({ label: '', items: [], _new: true }); sc = cat.categories.length - 1; sp = 0; focus = null; changed(true); rerender(); editNow(`[data-catname="${sc}"]`); };
    const ap = root.querySelector('[data-addpiece]'); if (ap) ap.onclick = () => { C().items.push({ label: '', material: '', preview: 'card', groups: [], _new: true, _on: true }); sp = C().items.length - 1; focus = { t: 'piece' }; changed(true); rerender(); editNow(`[data-pname="${sp}"]`); };
    root.querySelectorAll('[data-addch]').forEach(b => b.onclick = () => { const q = +b.dataset.addch, g = P().groups[q]; g.choices.push({ label: '', _new: true, ...(colored(g) ? { color: '#cccccc' } : {}) }); focus = { t: 'ch', q, x: g.choices.length - 1 }; changed(true); rerender(); editNow(`[data-cname="${q}.${g.choices.length - 1}"]`); });
    // Event-level settings for the name box.
    const nl = root.querySelector('[data-nlabel]'); if (nl) nl.oninput = () => { const v = nl.textContent.trim(); st.nameLabel = v === 'Personalization' ? '' : v; changed(false); };
    const mc = root.querySelector('[data-maxc]'); if (mc) mc.oninput = () => { const v = Math.round(+mc.value); if (v >= 1 && v <= 30) { st.maxChars = v; changed(false); } };
    root.querySelectorAll('[data-fontk]').forEach(cb => cb.onchange = () => {
      const on = Object.keys(FONTS).filter(k => root.querySelector(`[data-fontk="${k}"]`).checked);
      if (!on.length) { cb.checked = true; toast('Keep at least one lettering style.'); return; }
      st.fonts = on; changed(false); rerender();
    });
    // Drag the grip to reorder the name box and the questions.
    const bl = root.querySelector('.gblocks');
    if (bl && window.Sortable) new Sortable(bl, { handle: '.ggrip', animation: 150, onEnd: () => {
      st.blockOrder = [...bl.querySelectorAll(':scope > [data-blk]')].map(e => e.dataset.blk).filter(id => !id.startsWith('q:new')); changed(false); } });
    const aq = root.querySelector('[data-addq]'); if (aq) aq.onclick = () => { P().groups.push({ label: '', swatch: false, choices: [{ label: '', _new: true }], _new: true }); const q = P().groups.length - 1; changed(true); rerender(); editNow(`[data-qtitle="${q}"]`); };
    bindPanel();
  }
  function bindPanel() {
    const s = document.querySelector('.gb .gside'); if (!s) return;
    s.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
    const col = s.querySelector('[data-color]'); if (col) col.oninput = () => { const x = P().groups[focus.q].choices[focus.x]; x.color = col.value; changed(true); const sw = document.querySelector(`.gb [data-ch="${focus.q}.${focus.x}"] b`); if (sw) sw.style.background = col.value; else rerender(); };
    const pt = s.querySelector('[data-ptitle]'); if (pt) { pt.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); pt.blur(); } };
      pt.oninput = () => { P().label = pt.textContent.trim(); changed(true); const m = document.querySelector(`.gb [data-pname="${sp}"]`); if (m) m.textContent = pt.textContent.trim(); }; }
    s.querySelectorAll('[data-adjust]').forEach(b => b.onclick = () => adjust(b.dataset.adjust));
    s.querySelectorAll('[data-droppic]').forEach(b => b.onclick = () => dropPhoto(b.dataset.droppic));
    s.querySelectorAll('[data-pfile]').forEach(inp => inp.onchange = () => { const f = inp.files && inp.files[0]; if (f) savePhoto(inp.dataset.pfile, f); inp.value = ''; });
    const drop = s.querySelector('[data-drop]');
    if (drop) {
      ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
      drop.addEventListener('drop', e => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])].find(isPic); if (f) savePhoto(drop.dataset.drop, f); else toast('Drop a photo file (JPG, PNG or HEIC).'); });
    }
  }

  // Photos: from the picker, dragged in from Finder or Photos, or pasted (Cmd+V) onto the selected piece or choice.
  const isPic = f => f && (/^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(f.name || ''));
  async function savePhoto(ref, f) {
    const key = keyFor(ref);
    if (!key) { toast('Give it a name first, then add the photo.'); return; }
    toast('Saving photo…');
    let data;
    try { data = await fileToJpeg(f); } catch (err) { toast(`That photo couldn't be read (${f.type || f.name || 'unknown type'}). Try a JPG or PNG.`); return; }
    const fit = { z: 1, x: 0, y: 0 }; // full width; a tall phone photo crops top and bottom only
    try { await setDoc(evPhotoRef(photoEvent, key), { data, fit, updatedAt: serverTimestamp(), by: user.email }); photoLib[key] = data; photoFits[key] = fit; photoOwn[key] = true; toast('Photo saved for this event'); rerender(); adjust(key); }
    catch (err) { toast('Could not save the photo: ' + (err.code || err.message)); }
  }
  function adjust(key) {
    if (typeof photoLib[key] !== 'string') return;
    openAdjust({ src: photoLib[key], fit: photoFits[key], aspect: 1, title: 'Frame the photo', base: { z: 1, x: 0, y: 0 }, onSave: async fit => {
      await setDoc(evPhotoRef(photoEvent, key), { data: photoLib[key], fit, updatedAt: serverTimestamp(), by: user.email }); photoFits[key] = fit; photoOwn[key] = true; rerender(); toast('Photo framed'); } });
  }
  async function dropPhoto(key) {
    const old = { data: photoLib[key], fit: photoFits[key] };
    try { await setDoc(evPhotoRef(photoEvent, key), { data: null, removed: true, updatedAt: serverTimestamp(), by: user.email }); photoLib[key] = null; photoFits[key] = null; photoOwn[key] = true; rerender();
      toast('Photo removed from this event', { label: 'Undo', run: () => setDoc(evPhotoRef(photoEvent, key), { ...old, updatedAt: serverTimestamp(), by: user.email }).then(() => { photoLib[key] = old.data; photoFits[key] = old.fit; rerender(); }) }); }
    catch (err) { toast('Could not remove: ' + (err.code || err.message)); }
  }
  const focusRef = () => { if (!focus || !P()) return null; if (focus.t === 'piece') return `p:${sc}.${sp}`; return focus.q === 0 ? `x:${sc}.${sp}.${focus.q}.${focus.x}` : null; };
  const onPaste = e => {
    if (!document.querySelector('.gb')) return;
    const armed = document.querySelector('.bslot2.armed');
    if (armed) { const f = [...(e.clipboardData?.files || [])].find(isPic); if (f) { e.preventDefault(); armed.dispatchEvent(new CustomEvent('brandpaste', { detail: f })); } return; }
    const f = [...(e.clipboardData?.files || [])].find(isPic); if (!f) return;
    const ref = focusRef(); if (!ref) { toast('Tap a piece (or a choice in the first question) first, then paste.'); return; }
    e.preventDefault(); savePhoto(ref, f);
  };
  addEventListener('paste', onPaste); unsubs.push(() => removeEventListener('paste', onPaste));
  // First thing wrong with the menu, or ''.
  function problem() {
    for (const c of cat.categories) {
      if (!c.label.trim()) return 'A category needs a name.';
      for (const it of c.items) {
        const nm = it.label.trim(); if (!nm) return 'An item needs a name.';
        for (const g of it.groups.filter(g => !g._hid)) {
          if (!g.label.trim()) return `${nm}: a question needs a name.`;
          if (!g.choices.length) return `${nm}: ${g.label} needs at least one choice.`;
          if (g.choices.some(x => !x.label.trim())) return `${nm}: a choice under ${g.label} has no name.`;
          if (it._on && g.choices.every(x => x._off)) return `${nm}: leave at least one ${g.label} choice on.`;
        }
      }
    }
    if (!cat.categories.some(c => c.items.some(it => it._on))) return 'Turn on at least one item.';
    return '';
  }
  // Gives new things their ids, then returns the shared catalog plus this event's on/off maps.
  function finalize() {
    const catIds = new Set(cat.categories.filter(c => !c._new).map(c => c.id)), pIds = pieceIds();
    const items = {}, hidden = {};
    const clean = cat.categories.map(c => {
      if (c._new) { c.id = uniq(c.label, catIds, 'category'); delete c._new; }
      return { id: c.id, label: c.label.trim(), items: c.items.map(it => {
        if (it._new) { it.id = uniq(it.label, pIds, 'piece'); delete it._new; }
        items[it.id] = !!it._on;
        const gIds = new Set(it.groups.filter(g => !g._new).map(g => g.id));
        return { id: it.id, label: it.label.trim(), material: (it.material || '').trim(), preview: it.preview || 'card', groups: it.groups.map(g => {
          if (g._new) { g.id = uniq(g.label, gIds, 'option'); delete g._new; }
          if (g._hid) hidden[`${it.id}/${g.id}`] = true;
          const xIds = new Set(g.choices.filter(x => !x._new).map(x => x.id)), sw = colored(g);
          return { id: g.id, label: g.label.trim(), swatch: sw, choices: g.choices.map(x => {
            if (x._new) { x.id = uniq(x.label, xIds, 'choice'); delete x._new; }
            if (x._off) hidden[`${it.id}/${g.id}/${x.id}`] = true;
            return { id: x.id, label: x.label.trim(), ...(sw ? { color: x.color || '#cccccc' } : {}) }; }) }; }) }; }) };
    });
    return { clean, items, hidden };
  }
  return { html, bind, problem, finalize };
}

async function setupPage(eventId) {
  setPhotoEvent(eventId);
  $app.innerHTML = staffLoading('Loading event…');
  await loadCatalog(true);
  let ev = null, brand = {};
  try { const s = await getDoc(doc(db, 'events', eventId)); ev = s.exists() ? s.data() : null; } catch (e) {}
  if (!ev) { $app.innerHTML = `${staffHead('event setup', 'setup', 'Not found')}<main class="wrap"><h1>event not <em>found</em></h1></main>`; bindStaffHead(); return; }
  try { const b = await getDoc(brandRef(eventId)); brand = b.exists() ? b.data() : {}; } catch (e) {}
  let savedPin = ''; try { savedPin = await loadPin(eventId); } catch (e) {}
  let followImg = null, followOrig = null, followFit = null, lastLink = '';
  const readFollow = async (a, b) => { const f = await getDoc(a); if (!f.exists()) return false; followOrig = f.data().orig || f.data().img || null; followFit = f.data().fit || null; const g = await getDoc(b); followImg = g.exists() ? (g.data().img || null) : followOrig; return true; };
  try { const l = await getDoc(lastFollowRef()); lastLink = l.exists() ? (l.data().link || '') : ''; } catch (e) {}
  try { if (!(await readFollow(followRef(eventId), followImgRef(eventId)))) await readFollow(lastFollowRef(), lastFollowImgRef()); } catch (e) {}
  const st = { theme: themeOf(ev), thanksOn: ev.thanksOn !== false, followLink: ev.followLink || lastLink || FOLLOW_URL, preview: ev.preview !== false, name: ev.name || '', date: ev.date || '', open: ev.open !== false, engravers: [...(ev.engravers || [])], pickupNote: ev.pickupNote || 'at the engraving table', pin: savedPin,
    maxChars: maxChars(ev), nameLabel: ev.nameLabel || '', fonts: fontKeys(ev), blockOrder: [...(ev.blockOrder || [])] };
  // Working copy of the menu, carrying this event's on/off switches.
  const cat = JSON.parse(JSON.stringify(CAT));
  let embAdded = false;
  cat.categories.forEach(c => c.items.forEach(it => {
    let g = it.groups.find(x => x.id === 'addon');
    if (!g) { g = DETAIL(); it.groups.push(g); embAdded = true; }
    DETAIL().choices.forEach(d => { if (!g.choices.some(x => x.id === d.id)) { g.choices.push({ ...d }); embAdded = true; } });
    g.choices.forEach(x => { if (x.id === 'none' && x.label === 'Name only') { x.label = 'None'; embAdded = true; } });
  }));
  cat.categories.forEach(c => { c._open = true; c.items.forEach(it => { it._on = offered(ev, it.id); it.groups.forEach(g => { g._hid = (ev.hidden || {})[`${it.id}/${g.id}`] === true; }); it.groups.forEach(g => g.choices.forEach(x => { x._off = (ev.hidden || {})[`${it.id}/${g.id}/${x.id}`] === true; })); }); });
  const keys = cat.categories.flatMap(c => c.items.flatMap(it => [it.id, ...(it.groups[0]?.choices || []).map(x => `${it.id}_${x.id}`)]));
  await Promise.all(keys.filter(k => photoLib[k] === undefined).map(k => fetchPhoto(k).then(s => takePhoto(k, s)).catch(() => { photoLib[k] = null; })));
  photoRerender = null; setPov(null);
  let savedEngravers = [...st.engravers], dirty = false, catDirty = embAdded, saving = false, savedName = st.name, savedOpen = st.open, reuseOpen = false;
  const legacy = Object.keys(ev.photos || {}).length;
  // Leaving with changes that can be saved saves them on the way out; only changes that can't be saved ask first.
  leaveGuard = () => { if (!dirty) return false; if (!blocker()) { save(true); return false; } return true; };
  // Changes save on their own about a second after you stop typing; the Save button still works too.
  let editSeq = 0, autoTimer = null;
  const status = t => { const d = document.getElementById('dirty'); if (d) d.textContent = t; };
  const markDirty = () => { dirty = true; editSeq++; status('Saving soon…'); const s = document.getElementById('save'); if (s) s.disabled = false;
    clearTimeout(autoTimer); autoTimer = setTimeout(() => save(true), 1200); };
  unsubs.push(() => clearTimeout(autoTimer));
  const tree = menuTree(cat, { changed: shared => { if (shared) catDirty = true; markDirty(); }, rerender: id => render(id), st });

  const chipsHTML = () => st.engravers.map((e, i) => `<span>${esc(e)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(e)}">×</button></span>`).join('') || '<em class="note">No staff yet.</em>';
  const brandPreview = () => `<div class="phonebox" aria-label="Preview of a guest page" style="--band:${st.theme.band};--ink:${st.theme.ink}"><div class="pb-band">${['tl', 'tr'].map(k => brand[k] ? `<button type="button" class="bbox ${k}" data-pbk="${k}" aria-label="Adjust ${k === 'tl' ? 'top left' : 'top right'} image">${brandImg(brand, k)}</button>` : `<span class="bbox ${k} bempty" aria-hidden="true"></span>`).join('')}<button type="button" class="bbox tc" data-pbk="tc" aria-label="Top center logo">${brand.tc ? brandImg(brand, 'tc') : `<img class="bcontain" src="${STEPH_LOGO}" alt="">`}</button><div class="ev">${esc(savedName)}</div></div>
    <div class="pb-body"><div class="pb-line"></div><div class="pb-line short"></div><div class="pb-field"></div><div class="pb-line short"></div>
      ${brand.bc ? `<div class="bbottom"><button type="button" class="bbox bc" data-pbk="bc" aria-label="Adjust bottom center image">${brandImg(brand, 'bc')}</button></div>` : '<div class="bbottom"><span class="bbox bc bempty" aria-hidden="true"></span></div>'}<div class="pb-btn"></div></div></div>
    <p class="hint" style="text-align:center;margin:6px 0 0">Tap an image to move or resize it.</p>`;
  // Each slot takes a click (file picker), a file dragged from Finder or Photos, or ⌘V after tapping it.
  const brandSlots = () => BRAND_SLOTS.map(([k, l]) => `<div class="bslot2" data-bdrop="${k}" tabindex="0" aria-label="${l} image">
    <div class="bthumb">${brand[k] ? `<span class="bbox ${k} bprev">${brandImg(brand, k)}</span>` : k === 'tc' ? `<span class="bbox tc bprev"><img class="bcontain" src="${STEPH_LOGO}" alt=""></span>` : '<span>none</span>'}</div>
    <div class="btext"><b>${l}</b><small>${k === 'bc' ? 'Shows under the text-me box on the last step and on the order status page.' : k === 'tc' ? 'The main logo in the header. Ivelisse Designs unless you upload one.' : 'Shows in the header on every guest page.'} Click to choose, drag an image here, or click then paste with ⌘V.</small></div>
    <label class="btn out bup">${brand[k] ? 'Replace' : 'Choose'}<input type="file" accept="image/*,.heic,.heif" data-up="${k}" class="vhfile"></label>
    ${brand[k] ? `<button type="button" class="btn out" data-badj="${k}">Adjust</button>${(k === 'tl' || k === 'tr') && brand[k === 'tl' ? 'tr' : 'tl'] ? `<button type="button" class="btn out" data-match="${k}">Match ${k === 'tl' ? 'top right' : 'top left'}</button>` : ''}<button type="button" class="linkbtn" data-rmb="${k}">${k === 'tc' ? 'Use Ivelisse logo' : 'Remove'}</button>` : ''}
    ${brand[k] ? `<small class="bpos">${posText(brand.fit?.[k])}</small>` : ''}</div>`).join('');
  const posText = f => f ? `Zoom ${Math.round(f.z * 100)}% · left/right ${Math.round(f.x)}% · up/down ${Math.round(f.y)}%` : 'Fit to box';
  const themeRow = (k, label, help) => `<div class="throw"><div class="thhead"><b>${label}</b><small>${help}</small></div>
    <div class="thgrid" role="radiogroup" aria-label="${label}">${THEME_SWATCHES.map(h => `<button type="button" class="thsw ${st.theme[k].toLowerCase() === h ? 'on' : ''}" data-th="${k}" data-hex="${h}" style="background:${h}" aria-label="${h}" aria-checked="${st.theme[k].toLowerCase() === h}" role="radio"></button>`).join('')}</div>
    <div class="thhex"><span class="thnow" style="background:${st.theme[k]}"></span><input data-thhex="${k}" value="${esc(st.theme[k])}" maxlength="7" spellcheck="false" aria-label="${label} hex code">
      <label class="thpick">Custom<input type="color" data-thcol="${k}" value="${esc(st.theme[k])}"></label>
      ${st.theme[k].toLowerCase() !== THEME_DEFAULT[k] ? `<button type="button" class="linkbtn" data-threset="${k}">Default</button>` : ''}</div>
    ${tooLight(st.theme[k]) ? '<small class="thwarn">This color is light. White text on it may be hard to read.</small>' : ''}</div>`;
  const themePicker = () => `<div class="thbox"><h3>colors</h3>${themeRow('band', 'Header color', 'The band at the top of every guest page.')}${themeRow('ink', 'Button color', 'Buttons, selected choices and highlights.')}</div>`;
  const brandAdjust = k => { if (!brand[k]) return; const l = BRAND_SLOTS.find(x => x[0] === k)[1];
    openAdjust({ src: brand[k], fit: brand.fit?.[k], aspect: BRAND_ASPECT[k], ctx: ADJ_CTX[k], title: `${l} · zoomed in`, onSave: fit => setBrand(k, brand[k], fit) }); };
  const brandFile = async (k, f) => { if (!f) return; toast('Saving image…'); let data; try { data = await fileToLogo(f, k === 'tc' ? 1400 : 900); } catch (err) { toast(`That image couldn't be read (${f.type || f.name || 'unknown type'}). Try a PNG or JPG.`); return; }
    if (await setBrand(k, data, await containFit(data, BRAND_ASPECT[k]))) brandAdjust(k); };

  function render(focusId) {
    const y = scrollY;
    $app.innerHTML = `${staffHead('event setup', 'setup', savedName)}<main class="wrap setup">
      <div class="evhead"><h1>${esc(savedName) || 'new event'}</h1><span class="chip ${savedOpen ? 'live' : ''}">${savedOpen ? 'Live now' : 'Closed'}</span></div>
      <div class="btnrow three"><button class="btn" id="povtop" type="button">Open Client's POV</button><button class="btn out" id="reuse" type="button" >Reuse this event setup</button></div>
      <p class="hint" style="margin:6px 0 0">Reuse makes a copy of this setup (staff, PIN, menu, photos, branding, pickup spot, texts) with a blank name and date to fill in.</p>

      <section class="card step"><h2><span class="n">1</span>details</h2>
        <div class="two"><div class="field"><label class="lbl" for="s-name">Event name</label><input id="s-name" value="${esc(st.name)}"></div>
          <div class="field"><label class="lbl" for="s-date">Date</label><input id="s-date" type="date" value="${esc(st.date)}"></div></div>
        <div class="field"><label class="lbl" for="s-pick">Pickup spot</label><input id="s-pick" value="${esc(st.pickupNote)}" placeholder="at the engraving table"></div></section>

      <section class="card step"><h2><span class="n">2</span>staff &amp; PIN</h2>
        <div class="chips" id="chips">${chipsHTML()}</div>
        <div class="addrow"><label class="vh" for="s-eng">Add a staff name</label><input id="s-eng" placeholder="First name" autocapitalize="words"><button class="btn out" id="addeng" type="button">Add</button></div>
        <div class="pinrow"><label class="lbl" for="s-pin">Staff PIN for this event</label><input id="s-pin" class="pinfield" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${esc(st.pin)}"></div></section>

      <section class="card step"><h2><span class="n">3</span>menu</h2>
        <p class="hint">This is the guest form. Tap a word to rename it, tap an item or choice for options, tap × to delete. "Off" is for this event only.</p>
        <label class="pvtog"><span class="sw2"><input type="checkbox" id="s-preview" ${st.preview ? 'checked' : ''}><i></i></span><span><b>Preview picture</b><small>${st.preview ? 'On: the picture changes as guests pick options.' : 'Off: guests only see the item photos on the first screen.'}</small></span></label>
        ${tree.html()}</section>

      <section class="card step"><h2><span class="n">4</span>branding</h2>
        <div class="brandgrid"><div class="bslots">${brandSlots()}${themePicker()}</div>${brandPreview()}</div></section>

      <section class="card step"><h2><span class="n">5</span>guest QR</h2>
        <div class="share"><div class="qr" aria-label="QR code guests scan to order at this event">${qrSvg(guestUrl(eventId))}</div>
          <div class="shareinfo"><button class="btn out" id="dlqr" type="button">Download QR</button><button class="btn out" id="copy" type="button">Copy link</button></div></div></section>

      <section class="card step"><h2><span class="n">6</span>open or close</h2>
        <div class="openseg" role="radiogroup" aria-label="Event status">
          <button type="button" role="radio" aria-checked="${st.open}" data-open="1"><b>Open (live)</b><small>Shows on Events and the client link. Guests order. PIN works.</small></button>
          <button type="button" role="radio" aria-checked="${!st.open}" data-open="0"><b>Closed</b><small>Hidden everywhere. PIN stops working. New events start here.</small></button></div></section>

      <section class="card step"><h2><span class="n">7</span>thank-you text</h2>
        <label class="pvtog"><span class="sw2"><input type="checkbox" id="s-thanks" ${st.thanksOn ? 'checked' : ''}><i></i></span><span><b>Send a thank-you text</b><small>${st.thanksOn ? 'On: goes out at 9 AM the morning after the event to guests who asked for texts.' : 'Off: guests only get the order and ready texts.'}</small></span></label>
        <div class="fwrap ${st.thanksOn ? '' : 'off'}">
        <div class="field"><label class="lbl" for="s-follow">Link in the text</label><input id="s-follow" type="url" value="${esc(st.followLink)}" placeholder="${FOLLOW_URL}"></div>
        <div class="bslot2 fslot"><div class="bthumb fthumb"><img src="${esc(followImg || FOLLOW_IMG)}" alt=""></div>
          <div class="btext"><b>Picture sent with it</b><small>${followImg ? 'This event\'s picture.' : 'Using the default Ivelisse Designs picture.'} Click Choose, or drag one here, to use a different one for this event.</small></div>
          <label class="btn out bup">${followImg ? 'Replace' : 'Choose'}<input type="file" accept="image/*,.heic,.heif" id="s-fimg" class="vhfile"></label>
          ${followOrig ? '<button type="button" class="btn out" id="s-fadj">Adjust</button>' : ''}${followImg ? '<button type="button" class="linkbtn" id="s-frm">Use default picture</button>' : ''}</div>
        <div class="smsprev" aria-label="Preview of the thank-you text">
          <div class="smshead"><span class="smsav">ID</span>Ivelisse Designs</div>
          <div class="smsbody"><small>Morning after the event · 9:00 AM</small>
            <img class="smsimg" src="${esc(followImg || FOLLOW_IMG)}" alt="">
            <p class="smsbub">Ivelisse Designs: Hi Ava, the @ivelissedesigns team hopes you're enjoying your leather bag tag! We'd be so grateful if you left us a quick review: <u id="s-flinkprev">${esc((st.followLink || FOLLOW_URL).replace(/^https?:\/\//, ''))}</u> It keeps us doing what we love. Thank you! Reply STOP to opt out.</p></div></div></div></section>

      <section class="card step"><h2><span class="n">8</span>after the event</h2>
        <button class="btn out" id="export" type="button">Export orders</button>
        ${legacy ? `<button class="linkbtn" id="clearlegacy" type="button" style="margin-left:12px">Remove ${legacy} old photo link${legacy === 1 ? '' : 's'}</button>` : ''}</section>
    </main>
    <div class="savebar"><span id="dirty">${dirty ? 'Unsaved changes' : 'All changes saved'}</span><button class="btn out" id="pov" type="button">Preview from Client's POV</button><button class="btn" id="save" type="button" ${dirty ? '' : 'disabled'}>Save</button></div>`;
    bind(); scrollTo(0, y);
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); } }
  }
  async function setBrand(k, val, fit) {
    const next = { ...brand, fit: { ...(brand.fit || {}) } };
    if (val) { next[k] = val; if (fit) next.fit[k] = fit; } else { delete next[k]; delete next.fit[k]; }
    delete next.updatedAt;
    try { await setDoc(brandRef(eventId), { ...next, updatedAt: serverTimestamp() }); brand = next; render(); toast(val ? (fit ? 'Image placed' : 'Image saved') : 'Image removed'); return true; }
    catch (err) { toast('Could not save the image: ' + (err.code || err.message)); return false; }
  }
  function bind() {
    bindStaffHead(); tree.bind();
    const bindChips = () => document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { st.engravers.splice(+b.dataset.rm, 1); document.getElementById('chips').innerHTML = chipsHTML(); bindChips(); markDirty(); });
    bindChips();
    const engIn = document.getElementById('s-eng');
    const addEng = () => {
      const n = engIn.value.trim(); if (!n) return;
      if (st.engravers.some(e => e.toLowerCase() === n.toLowerCase())) { toast(`${n} is already on the list`); return; }
      st.engravers.push(n); engIn.value = ''; document.getElementById('chips').innerHTML = chipsHTML(); bindChips(); markDirty(); engIn.focus();
    };
    document.getElementById('addeng').onclick = addEng;
    engIn.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addEng(); } };
    const saveFollow = async (orig, fit) => {
      const img = orig ? await bakeFit(orig, fit) : null;
      await setDoc(followRef(eventId), { orig: orig || null, fit: fit || null, updatedAt: serverTimestamp() });
      let url = null;
      if (img) { try { url = await uploadFollow(eventId, img); } catch (e) { console.warn('Storage upload failed', e); toast('Saved, but the picture could not be uploaded for texting yet (Firebase Storage).'); } }
      await setDoc(followImgRef(eventId), { img, url, updatedAt: serverTimestamp() });
      await setDoc(lastFollowRef(), { orig: orig || null, fit: fit || null, link: st.followLink.trim() || FOLLOW_URL, updatedAt: serverTimestamp() }, { merge: true });
      await setDoc(lastFollowImgRef(), { img, url, updatedAt: serverTimestamp() });
      followOrig = orig || null; followFit = fit || null; followImg = img; render();
    };
    const adjustFollow = () => followOrig && openAdjust({ src: followOrig, fit: followFit, aspect: 1, title: 'Frame the text picture', base: { z: 1, x: 0, y: 0 },
      onSave: async fit => { await saveFollow(followOrig, fit); toast('Picture framed'); } });
    const setFollowImg = async v => { try { await saveFollow(v, v ? { z: 1, x: 0, y: 0 } : null); toast(v ? 'Picture saved' : 'Picture removed'); if (v) adjustFollow(); } catch (err) { toast('Could not save: ' + (err.code || err.message)); } };
    const th = document.getElementById('s-thanks'); if (th) th.onchange = () => { st.thanksOn = th.checked; markDirty(); render(); };
    const fadj = document.getElementById('s-fadj'); if (fadj) fadj.onclick = adjustFollow;
    const fi = document.getElementById('s-fimg'); if (fi) fi.onchange = async () => { const f = fi.files[0]; fi.value = ''; if (!f) return; toast('Saving picture…'); try { setFollowImg(await fileToJpeg(f)); } catch (e) { toast("That picture couldn't be read. Try a JPG or PNG."); } };
    const fz = document.querySelector('.fslot'); if (fz) { ['dragenter', 'dragover'].forEach(t => fz.addEventListener(t, e => { e.preventDefault(); fz.classList.add('over'); })); ['dragleave', 'drop'].forEach(t => fz.addEventListener(t, () => fz.classList.remove('over')));
      fz.addEventListener('drop', async e => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])][0]; if (f) { try { setFollowImg(await fileToJpeg(f)); } catch (x) { toast("That picture couldn't be read."); } } }); }
    const frm = document.getElementById('s-frm'); if (frm) frm.onclick = () => setFollowImg(null);
    [['s-name', 'name'], ['s-date', 'date'], ['s-pick', 'pickupNote'], ['s-follow', 'followLink']].forEach(([id, k]) => document.getElementById(id).oninput = e => { st[k] = e.target.value; markDirty();
      if (k === 'followLink') { const pv = document.getElementById('s-flinkprev'); if (pv) pv.textContent = (e.target.value || FOLLOW_URL).replace(/^https?:\/\//, ''); } });
    const pvt = document.getElementById('s-preview'); pvt.onchange = () => { st.preview = pvt.checked; pvt.closest('.pvtog').querySelector('small').textContent = st.preview ? 'On: the picture changes as guests pick options.' : 'Off: guests only see the item photos on the first screen.'; markDirty(); };
    const pinIn = document.getElementById('s-pin'); pinIn.oninput = () => { pinIn.value = pinIn.value.replace(/\D/g, '').slice(0, 4); st.pin = pinIn.value; markDirty(); };
    document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { st.open = b.dataset.open === '1'; document.querySelectorAll('[data-open]').forEach(x => x.setAttribute('aria-checked', String((x.dataset.open === '1') === st.open))); markDirty(); });
    document.querySelectorAll('[data-up][type=file]').forEach(inp => inp.onchange = () => { brandFile(inp.dataset.up, inp.files[0]); inp.value = ''; });
    document.querySelectorAll('[data-bdrop]').forEach(z => {
      ['dragenter', 'dragover'].forEach(t => z.addEventListener(t, e => { e.preventDefault(); z.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(t => z.addEventListener(t, () => z.classList.remove('over')));
      z.addEventListener('drop', e => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])].find(x => /^image\//.test(x.type) || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(x.name)); f ? brandFile(z.dataset.bdrop, f) : toast('Drop an image file (PNG, JPG or HEIC).'); });
      z.addEventListener('brandpaste', e => brandFile(z.dataset.bdrop, e.detail));
      z.addEventListener('click', e => { if (e.target.closest('label,button')) return; document.querySelectorAll('.bslot2.armed').forEach(x => x.classList.remove('armed')); z.classList.add('armed'); z.focus(); });
    });
    document.querySelectorAll('[data-rmb]').forEach(b => b.onclick = () => setBrand(b.dataset.rmb, null));
    const setTheme = (k, v) => { if (!hexOk(v)) return false; st.theme[k] = v.toLowerCase(); markDirty(); render(); return true; };
    document.querySelectorAll('[data-th]').forEach(b => b.onclick = () => setTheme(b.dataset.th, b.dataset.hex));
    document.querySelectorAll('[data-thcol]').forEach(i => i.onchange = () => setTheme(i.dataset.thcol, i.value));
    document.querySelectorAll('[data-thhex]').forEach(i => { i.onchange = () => { let v = i.value.trim(); if (!v.startsWith('#')) v = '#' + v; if (!setTheme(i.dataset.thhex, v)) { toast('Use a 6-digit hex code like #b85c3a.'); i.value = st.theme[i.dataset.thhex]; } }; i.onkeydown = e => { if (e.key === 'Enter') i.blur(); }; });
    document.querySelectorAll('[data-threset]').forEach(b => b.onclick = () => setTheme(b.dataset.threset, THEME_DEFAULT[b.dataset.threset]));
    document.querySelectorAll('[data-badj]').forEach(b => b.onclick = () => brandAdjust(b.dataset.badj));
    // Same zoom and height as the other corner, mirrored left/right, so both line up.
    document.querySelectorAll('[data-match]').forEach(b => b.onclick = () => { const k = b.dataset.match, o = k === 'tl' ? 'tr' : 'tl', of = brand.fit?.[o] || { z: 1, x: 0, y: 0 };
      setBrand(k, brand[k], { z: of.z, x: -of.x, y: of.y }); });
    document.querySelectorAll('.phonebox [data-pbk]').forEach(b => b.onclick = () => brand[b.dataset.pbk] ? brandAdjust(b.dataset.pbk) : document.querySelector(`[data-up="${b.dataset.pbk}"]`)?.click());
    document.getElementById('dlqr').onclick = () => downloadQr(guestUrl(eventId), eventId);
    document.getElementById('copy').onclick = () => (navigator.clipboard?.writeText(guestUrl(eventId)) || Promise.reject()).then(() => toast('Guest link copied')).catch(() => toast(guestUrl(eventId)));
    document.getElementById('reuse').onclick = async e => { const b = e.currentTarget;
      if (dirty) { await save(false); if (dirty) return; }
      b.disabled = true; b.textContent = 'Copying…';
      try { const s = await getDoc(doc(db, 'events', eventId)); const id = await createEvent('', '', { id: eventId, ...s.data() }); dirty = false; sessionStorage.setItem('eb-fresh', id); location.hash = `#/admin/${encodeURIComponent(id)}`; }
      catch (err) { b.disabled = false; b.textContent = 'Reuse this event setup'; toast('Could not copy: ' + (err.code || err.message)); } };
    document.getElementById('export').onclick = async () => { try { await exportOrders(eventId, ev); } catch (err) { toast('Export failed: ' + (err.code || err.message)); } };
    const cl = document.getElementById('clearlegacy');
    if (cl) cl.onclick = async () => { try { await updateDoc(doc(db, 'events', eventId), { photos: {} }); ev.photos = {}; toast('Old photo links removed'); render(); } catch (err) { toast('Could not remove: ' + (err.code || err.message)); } };
    document.getElementById('save').onclick = () => save(false);
    // Previewing counts as a save.
    document.getElementById('povtop').onclick = () => document.getElementById('pov').click();
    document.getElementById('pov').onclick = async () => { if (dirty) { await save(false); if (dirty) return; } setPov(eventId); location.hash = `#/e/${encodeURIComponent(eventId)}`; };
  }
  const blocker = () => {
    if (!st.name.trim() || !st.date) return 'The event needs a name and a date.';
    if (!st.engravers.length) return 'Add at least one staff name.';
    if (!/^\d{4}$/.test(st.pin)) return 'The staff PIN needs 4 digits.';
    return tree.problem();
  };
  async function save(quiet) {
    if (quiet === true) {} else quiet = false;
    if (!dirty) return;
    if (saving) { if (quiet) { clearTimeout(autoTimer); autoTimer = setTimeout(() => save(true), 800); } return; }
    clearTimeout(autoTimer);
    const stop = m => { if (quiet) status('Not saved yet: ' + m); else toast(m); };
    const prob = blocker(); if (prob) return stop(prob);
    const seq = editSeq;
    saving = true; const b = document.getElementById('save'); if (b) { b.disabled = true; b.textContent = 'Saving…'; } status('Saving…');
    try {
      // Removing a staff name hides their column, so don't allow it while they hold a piece.
      const removed = savedEngravers.filter(e => !st.engravers.includes(e));
      if (removed.length) {
        const busy = (await getDocs(collection(db, 'events', eventId, 'orders'))).docs.map(d => d.data()).find(o => o.status === 'progress' && removed.includes(o.engraver));
        if (busy) { stop(`${busy.engraver} has ${busy.name}'s piece. Move it before removing them.`); return; }
      }
      if (st.pin !== savedPin) { await setDoc(pinRef(eventId), { pin: st.pin, updatedAt: serverTimestamp() }); savedPin = st.pin; }
      const { clean, items, hidden } = tree.finalize();
      if (catDirty) { await setDoc(doc(db, 'config', 'catalog'), { categories: clean, updatedAt: serverTimestamp(), by: user.email }); CAT = { categories: clean }; catLoading = Promise.resolve(); catDirty = false; }
      await updateDoc(doc(db, 'events', eventId), { name: st.name.trim(), date: st.date, pickupNote: st.pickupNote.trim() || 'at the engraving table', open: st.open, preview: st.preview,
        engravers: st.engravers, items, hidden, maxChars: st.maxChars, nameLabel: st.nameLabel.trim(), thanksOn: st.thanksOn, theme: { ...st.theme }, followLink: st.followLink.trim() || FOLLOW_URL, fonts: st.fonts, blockOrder: st.blockOrder, updatedAt: serverTimestamp() });
      if ((st.followLink.trim() || FOLLOW_URL) !== lastLink) { try { await setDoc(lastFollowRef(), { link: st.followLink.trim() || FOLLOW_URL, updatedAt: serverTimestamp() }, { merge: true }); lastLink = st.followLink.trim() || FOLLOW_URL; } catch (e) {} }
      const headChanged = savedName !== st.name.trim() || savedOpen !== st.open;
      savedEngravers = [...st.engravers]; savedName = st.name.trim(); savedOpen = st.open;
      dirty = editSeq !== seq;
      if (quiet) { // don't redraw while someone may be typing
        const h = document.querySelector('.evhead h1'); if (h && headChanged) h.textContent = savedName;
        const c = document.querySelector('.evhead .chip'); if (c && headChanged) { c.textContent = savedOpen ? 'Live now' : 'Closed'; c.classList.toggle('live', savedOpen); }
      } else { render(); toast('Saved'); }
      status(dirty ? 'Saving soon…' : 'All changes saved');
    } catch (err) { stop('Could not save: ' + (err.code || err.message)); }
    finally { saving = false; const s = document.getElementById('save'); if (s) { s.textContent = 'Save'; s.disabled = !dirty; } }
  }
  const leave = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', leave); unsubs.push(() => removeEventListener('beforeunload', leave));
  const fresh = sessionStorage.getItem('eb-fresh') === eventId; if (fresh) sessionStorage.removeItem('eb-fresh');
  render(fresh ? 's-name' : undefined); if (fresh) toast('Copied. Give this event a name and a date, then Save.');
}

addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
addEventListener('drop', e => { if (e.dataTransfer?.types?.includes('Files') && !e.defaultPrevented) { e.preventDefault(); toast('Drop the image right on a photo box.'); } });

// ---------- photo library ----------
// Phone photos shrink to a small JPEG stored in Firestore (the free plan has no file storage).
// iPhone photos on a Mac are often HEIC, which Chrome (and the Claude app's browser) can't open.
// Those get converted to JPEG first, with a converter loaded only when needed.
let heicLib = null;
async function heicToJpeg(file) {
  if (!heicLib) heicLib = import('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/+esm').then(m => m.default || m);
  const conv = await heicLib;
  const out = await conv({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(out) ? out[0] : out;
}
async function decode(blob) {
  if (window.createImageBitmap) { try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) {} }
  const src = URL.createObjectURL(blob);
  try { return await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('unreadable image')); img.src = src; }); }
  finally { setTimeout(() => URL.revokeObjectURL(src), 60000); }
}
async function loadPicture(file) {
  const heic = /\.(heic|heif)$/i.test(file.name || '') || /hei[cf]/i.test(file.type || '');
  try { return await decode(file); }
  catch (e) {
    if (!heic && file.type && !/octet-stream/.test(file.type)) throw e;
    toast('Converting iPhone photo…');
    return decode(await heicToJpeg(file));
  }
}
async function fileToJpeg(file, max = 1400) {
  const img = await loadPicture(file), w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  let size = max, out = '';
  for (let i = 0; i < 6; i++) {
    const s = Math.min(1, size / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    out = c.toDataURL('image/jpeg', 0.84);
    if (out.length < 850000) return out;
    size = Math.round(size * 0.82);
  }
  return out;
}
function photoSlots(it) {
  const [g1, g2] = it.groups;
  if (!g1) return [{ key: it.id, opts: {}, label: 'Any' }];
  return g1.choices.flatMap(c1 => {
    if (!g2) return [{ key: `${it.id}_${c1.id}`, opts: { [g1.id]: c1.id }, label: c1.label }];
    const none = g2.choices.find(c => c.id === 'none');
    return [{ key: `${it.id}_${c1.id}`, opts: { [g1.id]: c1.id, [g2.id]: 'none' }, label: `${c1.label} · ${none ? none.label.toLowerCase() : 'any ' + g2.label.toLowerCase()}` },
      ...g2.choices.filter(c => c.id !== 'none').map(c2 => ({ key: `${it.id}_${c1.id}_${c2.id}`, opts: { [g1.id]: c1.id, [g2.id]: c2.id }, label: `${c1.label} · ${c2.label.toLowerCase()}` }))];
  });
}
async function photosPage() {
  setPhotoEvent(null);
  $app.innerHTML = staffLoading('Loading photos…');
  await loadCatalog(true);
  const pieces = allPieces().map(p => ({ ...p, slots: photoSlots(p.it).map(s => ({ ...s, item: p.it.id })) }));
  const slots = pieces.flatMap(p => p.slots);
  await Promise.all(slots.map(s => getDoc(doc(db, 'photos', s.key)).then(d => takePhoto(s.key, d)).catch(() => {})));
  const busy = new Set();
  const drawn = s => { const p = pieceDef(s.item), sg = p.it.groups.find(g => g.swatch), ch = sg && sg.choices.find(c => c.id === s.opts[sg.id]);
    return window.EngravePreview.renderPreview({ item: p.it.preview || 'card', color: sg ? s.opts[sg.id] : undefined, hex: ch?.color, addon: Object.values(s.opts).find(v => v === 'stars' || v === 'heart') || 'none', name: '', font: 'script' }); };
  const tile = s => {
    const has = typeof photoLib[s.key] === 'string', up = busy.has(s.key);
    return `<figure class="ptile" data-key="${esc(s.key)}"><div class="pimg ${has ? '' : 'none'}">${has ? `<img src="${esc(photoLib[s.key])}" alt="">` : drawn(s)}${has ? '' : '<span class="tag">no photo yet</span>'}</div>
      <figcaption>${esc(s.label)}</figcaption><div class="acts"><label class="up ${up ? 'busy' : ''}">${up ? 'Uploading…' : has ? 'Replace' : 'Add photo'}<input type="file" accept="image/*,.heic,.heif" data-upload="${esc(s.key)}" ${up ? 'disabled' : ''}></label>
      ${has && !up ? `<button class="rm" type="button" data-remove="${esc(s.key)}" aria-label="Remove photo">×</button>` : ''}</div></figure>`;
  };
  function render() {
    const y = scrollY, n = slots.filter(s => typeof photoLib[s.key] === 'string').length;
    $app.innerHTML = `${staffHead('photos', 'photos')}<main class="wrap"><h1>example <em>photos</em></h1>
      <p class="hint">${n} of ${slots.length} added. Guests see these as they choose; without one they see a drawn preview. These are the default photos, used by any event that hasn't set its own in event setup. Changing one here doesn't change events that have their own. Shoot in portrait with the piece centered.</p>
      ${pieces.map(p => `<h2 class="sec">${esc(p.it.label.toLowerCase())} <small>${esc(p.cat.label)}</small></h2><div class="pgrid">${p.slots.map(tile).join('')}</div>`).join('') || '<p class="note">The catalog has no pieces yet.</p>'}</main>`;
    bindStaffHead(); scrollTo(0, y);
    document.querySelectorAll('[data-upload]').forEach(inp => inp.onchange = async () => {
      const f = inp.files && inp.files[0]; if (!f) return; const key = inp.dataset.upload;
      busy.add(key); render();
      try {
        const data = await fileToJpeg(f);
        await setDoc(doc(db, 'photos', key), { data, updatedAt: serverTimestamp(), by: user.email });
        photoLib[key] = data; photoFits[key] = null; toast('Photo saved');
      } catch (err) { toast('Could not save that photo: ' + (err.code || err.message || 'unreadable image')); }
      finally { busy.delete(key); render(); }
    });
    document.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
      const key = b.dataset.remove, old = photoLib[key];
      try {
        await deleteDoc(doc(db, 'photos', key)); photoLib[key] = null; render();
        toast('Photo removed', { label: 'Undo', run: () => setDoc(doc(db, 'photos', key), { data: old, updatedAt: serverTimestamp(), by: user.email }).then(() => { photoLib[key] = old; render(); }) });
      } catch (err) { toast('Could not remove: ' + (err.code || err.message)); }
    });
  }
  render();
}


route();
