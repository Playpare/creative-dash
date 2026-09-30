/* ============================================================================
 * CONFIG
 * ========================================================================== */


const FORMATS = ['Video','Playable','Image'];
// Resolves beside index.html locally and inside a GitHub Pages repository path.
const PLAYABLE_THUMB_IMG = new URL(
  './Thumbnail.png?v=' + encodeURIComponent(CONFIG.ASSET_VERSION || '1'),
  document.baseURI
).href;
const COLOR = { Video:'#9b72f5', Playable:'#00e5c3', Image:'#4d9fff', accent:'#4d9fff', ink3:'#c7ccdd', hairline:'rgba(255,255,255,.08)' };

let CREATIVES = [];     // processed, deduped, attributed per-asset daily records
let META = { game:'', appLovinRefreshedAt:'', googleRefreshedAt:'', currencyCode:'USD', accountTimeZone:'' };
let activeFormat = 'all';
// The preset value IS the span in days. Matches the selected <option> in the
// markup; bindFilters() re-reads it from the DOM on boot regardless.
let appliedDatePreset = String(CONFIG.DEFAULT_VIEW_DAYS);
let appliedSingleDate = '';
let _isFetching = false;
let _reqSeq = 0;

// The extended dataset: the last CONFIG.EXTENDED_DAYS of both sheets. This is
// the ONLY window a page load fetches, and it is persisted to IndexedDB.
// While a requested range fits inside it, date changes never touch the server.
//   { cachedAt, startDate, endDate, raw:{applovin,google}, payload? }
let EXT = null;

// What CREATIVES currently holds: 'ext' (the extended dataset) or 'range'
// (a one-off server fetch for a range outside the extended window).
let _creativesSource = '';
let chartFormat = null, chartTop10 = null;
let _loadProgress = 0;
let _loadProgressTimer = null;
let _loadProgressHideTimer = null;

function paintLoadingProgress(value,label){
  const box = document.getElementById('loadProgress');
  const fill = document.getElementById('loadProgressFill');
  const number = document.getElementById('loadProgressValue');
  const text = document.getElementById('loadProgressLabel');
  if (!box || !fill || !number || !text) return;
  _loadProgress = Math.max(0,Math.min(100,Number(value)||0));
  box.classList.add('show');
  box.classList.remove('error');
  fill.style.width = _loadProgress.toFixed(1) + '%';
  number.textContent = Math.round(_loadProgress) + '%';
  if (label) text.textContent = label;
  box.setAttribute('aria-valuenow',String(Math.round(_loadProgress)));
}

function startLoadingProgress(label){
  clearInterval(_loadProgressTimer);
  clearTimeout(_loadProgressHideTimer);
  paintLoadingProgress(6,label || 'Loading dashboard');
  _loadProgressTimer = setInterval(() => {
    const step = _loadProgress < 55 ? 1.4 : (_loadProgress < 78 ? .55 : .16);
    paintLoadingProgress(Math.min(92,_loadProgress + step));
  },220);
}

function completeLoadingProgress(){
  clearInterval(_loadProgressTimer);
  paintLoadingProgress(100,'Dashboard ready');
  _loadProgressHideTimer = setTimeout(() => {
    const box = document.getElementById('loadProgress');
    if (box) box.classList.remove('show');
  },700);
}

function failLoadingProgress(){
  clearInterval(_loadProgressTimer);
  const box = document.getElementById('loadProgress');
  paintLoadingProgress(_loadProgress,'Load failed');
  if (box) box.classList.add('error');
}
/* ============================================================================
 * AUTH STATE
 *
 * Google Sign-In gives the browser an ID token (a signed JWT). That token is
 * NOT the session — it is posted once to Apps Script, which verifies it with
 * Google, checks the allowlist, and returns the same opaque session token the
 * dashboard already used. Only that session token is stored and replayed.
 * ========================================================================== */
let SESSION_TOKEN = '';
let SESSION_ROLE  = '';
let SESSION_EMAIL = '';
let SESSION_NAME  = '';
let SESSION_EXPIRES_AT = 0;   // ms epoch; 0 = unknown

try {
  SESSION_TOKEN = sessionStorage.getItem('dashSessionToken') || '';
  SESSION_ROLE  = sessionStorage.getItem('dashSessionRole')  || '';
  SESSION_EMAIL = sessionStorage.getItem('dashSessionEmail') || '';
  SESSION_NAME  = sessionStorage.getItem('dashSessionName')  || '';
  SESSION_EXPIRES_AT = Number(sessionStorage.getItem('dashSessionExpiresAt') || 0) || 0;
} catch(e) {}

// A token we already know is past its expiry is worth nothing: replaying it
// costs a round trip and ends in a rejection that reads like a failure. Drop it
// here so the tab opens on a clean sign-in card instead.
//
// This is a convenience check, never the control — the server re-validates
// every token on every request regardless of what this thinks.
if (SESSION_TOKEN && SESSION_EXPIRES_AT && Date.now() >= SESSION_EXPIRES_AT){
  clearSession();
}

function storeSession(data){
  SESSION_TOKEN = data.token || '';
  SESSION_ROLE  = data.role  || '';
  SESSION_EMAIL = data.email || '';
  SESSION_NAME  = data.name  || data.email || '';

  // expiresIn is seconds (SESSION_TTL_SECONDS on the server). Store the
  // absolute moment so a reload can tell a live token from a dead one without
  // asking. A server that sends no expiresIn leaves this 0 = "just try it".
  const ttlMs = Number(data.expiresIn || 0) * 1000;
  SESSION_EXPIRES_AT = ttlMs > 0 ? Date.now() + ttlMs : 0;

  try {
    sessionStorage.setItem('dashSessionToken', SESSION_TOKEN);
    sessionStorage.setItem('dashSessionRole',  SESSION_ROLE);
    sessionStorage.setItem('dashSessionEmail', SESSION_EMAIL);
    sessionStorage.setItem('dashSessionName',  SESSION_NAME);
    sessionStorage.setItem('dashSessionExpiresAt', String(SESSION_EXPIRES_AT));
  } catch(e) {}
}

function clearSession(){
  SESSION_TOKEN = ''; SESSION_ROLE = ''; SESSION_EMAIL = ''; SESSION_NAME = '';
  SESSION_EXPIRES_AT = 0;
  try {
    ['dashSessionToken','dashSessionRole','dashSessionEmail','dashSessionName',
     'dashSessionExpiresAt']
      .forEach(k => sessionStorage.removeItem(k));
  } catch(e) {}
}

// Reads an Apps Script response defensively.
//
// Apps Script answers with HTTP 200 + an HTML page whenever the request does
// not reach doPost cleanly — the execution timed out, the deployment was
// replaced, or the endpoint is serving a Google interstitial. Calling
// res.json() on that produced the opaque browser error:
//     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
// so read the body as text first and say what actually came back.
//
// The wording below deliberately avoids the words refresh()'s error handler
// treats as sign-in failures, so a transport problem never bounces a
// legitimately signed-in user back to the login card.
async function readApiJson(res, label){
  const text = await res.text();

  if (!res.ok) throw new Error(label + ' API returned HTTP ' + res.status);

  const head = text.slice(0, 200).trim().toLowerCase();
  if (head.indexOf('<!doctype') === 0 || head.indexOf('<html') === 0){
    throw new Error(
      label + ': the Apps Script endpoint returned an HTML page instead of JSON. ' +
      'The execution probably timed out or the deployment is no longer serving ' +
      'this URL — check the Apps Script Executions log, then redeploy if needed.'
    );
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      label + ': the API response was not valid JSON — ' + text.slice(0, 120)
    );
  }
}

// Shared POST helper. text/plain keeps it a "simple" request so the browser
// skips the CORS preflight, which Apps Script web apps cannot answer.
//
// TRANSPORT RESILIENCE — added because this helper had NONE.
//
// fetchBothSheets already survives the two ways an Apps Script call fails in
// transit. apiPost did not, so every call that goes through it — sync.start,
// sync.status, login, the admin panel — surfaced a transport hiccup to the
// user as if the server had refused them. That is where
//   "Could not start the sync: This endpoint only accepts POST requests"
// came from: the sync was never refused, the request simply never arrived.
//
// THE TWO FAILURES, AND WHY THEY ARE TREATED DIFFERENTLY:
//
// 1. code === 'get_not_supported'
//    The echo URL redirected back to /exec, and a browser following a 302
//    after a POST re-issues it as a GET, so doGet answered. This response is
//    PROOF that doPost never ran, so retrying cannot duplicate anything. Safe
//    for every action, including admin writes.
//
// 2. HTTP 404 / 429 / 5xx from the echo hop
//    Here we genuinely do NOT know whether doPost executed — the work may have
//    completed and only the response been lost. Retrying is therefore only
//    safe for actions that are harmless to repeat. Anything that WRITES is
//    left to fail loudly rather than risk being applied twice.
// google_login IS on this list, and that is a correction.
//
// I originally left it off because login WRITES — it mints a session token —
// and on a 404 we cannot tell whether the server executed. But the risk was
// weighed wrongly: a duplicate session token is stored in CacheService, expires
// on its own, and orphaning one costs nothing at all. Being stranded on the
// sign-in screen with "API API returned HTTP 404" costs the user everything.
//
// Login is also the request MOST likely to hit this, because it is the first
// of the session — fired while the browser is still resolving ListAccounts and
// authuser against Google, the busiest moment for that origin.
const IDEMPOTENT_ACTIONS = ['sync.status', 'sync.start', 'admin.list', 'logout', 'google_login'];
const API_POST_BACKOFF_MS = [4000, 9000];

// A STALLED REQUEST MUST NOT BE ABLE TO OUTLIVE THE USER'S PATIENCE.
//
// requestSheets has always aborted on FETCH_TIMEOUT_MS. apiPost had no ceiling
// at all — no AbortController, no signal — so when the echo hop swallowed a
// reply instead of returning 404, the fetch simply never settled. It then sat
// on Chrome's own network timeout, around FIVE MINUTES, and the retry below
// could not help because a retry only runs once an attempt finishes. That is
// the "Checking access…" hang: not a slow server, a request with no deadline.
//
// WHY 20s IS SAFE FOR EVERY ACTION HERE. Nothing routed through apiPost is
// long-running. Login measured ~2s server-side; sync.start only schedules a
// one-shot trigger and returns in milliseconds (the sync itself runs in its
// own execution and is polled for); admin.list and logout are single sheet
// operations. 20s is generous for all of them on a slow connection while
// still being far below the point where waiting has stopped being useful.
//
// This is deliberately NOT FETCH_TIMEOUT_MS. That budget is long because a
// data payload is megabytes and genuinely takes time to arrive; these
// responses are a few hundred bytes, so a slow one is a broken one.
const API_POST_TIMEOUT_MS = 20000;

async function apiPost(payload, attempt){
  const tryNumber = attempt || 0;
  const action = String((payload && payload.action) || '');
  const canRepeat = IDEMPOTENT_ACTIONS.indexOf(action) >= 0;

  const wait = (ms) => new Promise(done =>
    setTimeout(done, Math.round(ms * (0.75 + Math.random() * 0.5))));

  const canRetry = () => canRepeat && tryNumber < API_POST_BACKOFF_MS.length;
  const again = async () => {
    await wait(API_POST_BACKOFF_MS[tryNumber]);
    return apiPost(payload, tryNumber + 1);
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_POST_TIMEOUT_MS);

  let data;

  try {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify(payload)
    });

    // Lost in transit, outcome unknown -> only repeat what is safe to repeat.
    if (
      (res.status === 404 || res.status === 429 || res.status >= 500) &&
      canRetry()
    ){
      clearTimeout(timer);
      return again();
    }

    // The timer stays armed across this read on purpose: the body is part of
    // the response, and a reply that never finishes arriving is just as stuck
    // as one that never starts.
    data = await readApiJson(res, 'API');
  } catch (err){
    clearTimeout(timer);

    // An abort leaves the outcome UNKNOWN in exactly the way a 404 from the
    // echo hop does — the server may well have run and only the reply been
    // lost — so the same rule applies: repeat only what is safe to repeat.
    // readApiJson throws for transport shapes too (bad status, an HTML error
    // page, unparseable body); business failures come back as data.error
    // below and are never retried here.
    if (canRetry()) return again();

    throw (err && err.name === 'AbortError')
      ? new Error('The server did not respond within ' +
                  Math.round(API_POST_TIMEOUT_MS / 1000) + 's. Please try again.')
      : err;
  }

  clearTimeout(timer);

  // Provably never executed -> always safe to repeat, idempotent or not.
  if (
    data && data.code === 'get_not_supported' &&
    tryNumber < API_POST_BACKOFF_MS.length
  ){
    return again();
  }

  if (data && data.error === 'unauthorized'){
    clearSession();
    throw new Error('unauthorized');
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

// Exchange a Google ID token for a dashboard session token.
async function apiGoogleLogin(credential){
  const data = await apiPost({ action: 'google_login', credential: credential });
  if (!data.token) throw new Error('Login failed.');
  storeSession(data);
  return data;
}

async function apiLogout(){
  const token = SESSION_TOKEN;
  clearSession();
  try { if (token) await apiPost({ action: 'logout', token: token }); } catch(e) {}
}

function apiAdmin(action, extra){
  return apiPost(Object.assign({ action: action, token: SESSION_TOKEN }, extra || {}));
}

/* --- LEGACY PASSWORD LOGIN (disabled) --------------------------------------
   Kept for rollback only. Nothing calls apiLogin() any more.

let DASHBOARD_AUTH = { email: '', password: '' };

// Secure session token (issued by Apps Script doPost 'login'). Held in memory
// + sessionStorage so it survives reloads within the tab session. The token —
// not a password or API key — is what every data request carries.
let SESSION_TOKEN = '';
try { SESSION_TOKEN = sessionStorage.getItem('dashSessionToken') || ''; } catch(e) {}

// POST login → receive + store a session token.
// text/plain content-type keeps it a "simple" request (no CORS preflight,
// which Apps Script web apps cannot answer).
async function apiLogin(email, password){
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'login', email: email, password: password })
  });
  const data = await res.json();
  if (data.error || !data.token) throw new Error(data.error || 'Login failed');
  SESSION_TOKEN = data.token;
  try { sessionStorage.setItem('dashSessionToken', data.token); } catch(e) {}
  return data; // { token, role, email }
}

--------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */
function num(v){
  if (typeof v === 'string') v = v.replace(/[$,%\s]/g,'');
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function str(v){ return String(v == null ? '' : v).trim(); }
function ymd(d){
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return d.getFullYear()+'-'+m+'-'+day;
}
function accountToday(){
  if (!META.accountTimeZone) { const d=new Date(); d.setHours(0,0,0,0); return d; }
  try {
    const parts = new Intl.DateTimeFormat('en-US',{timeZone:META.accountTimeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const get = type => Number(parts.find(p=>p.type===type).value);
    return new Date(get('year'),get('month')-1,get('day'));
  } catch(e) { const d=new Date(); d.setHours(0,0,0,0); return d; }
}
function addDaysToYmd(value, days){
  if (!value) return '';
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return value;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() + days);
  return ymd(d);
}
function ymdCell(v){
  if (v instanceof Date) return ymd(v);
  const s = str(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ]/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const month = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    return m[3]+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
  }
  return s;
}
function apiRangeForFetch(range){
  return {
    startDate: range.startDate ? addDaysToYmd(range.startDate, -1) : '',
    endDate: range.endDate ? addDaysToYmd(range.endDate, 1) : '',
  };
}
function escapeHtml(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function shortNum(n){
  n = Math.round(n||0);
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M';
  if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'')+'K';
  return n.toLocaleString();
}
function truncate(s,n){ s=str(s); return s.length>n ? s.slice(0,n-1)+'…' : s; }
function readField(row, name){
  if (!row) return '';
  if (row[name] !== undefined) return row[name];
  const target = name.toLowerCase();
  const key = Object.keys(row).find(k => String(k).toLowerCase() === target);
  return key ? row[key] : '';
}

/* ---------------------------------------------------------------------------
 * DATA PIPELINE
 * Both Asset_Wise_Data (all-time-retained totals) and Asset_Wise_Daily
 * (date-filtered, via startDate/endDate query params) are already
 * pre-aggregated server-side in Code.gs — one row per unique asset, with
 * installs/revenue/sales/ROAS correctly attributed from AppLovin's set-level
 * data. The client just needs to parse that one shared row shape; no
 * client-side attribution or de-dup math needed anymore.
 * ------------------------------------------------------------------------- */
/* Two different quantities used to share one parser, and the shared rule was
 * wrong for one of them.
 *
 *   rate(v) did:  raw.indexOf('%') !== -1 || n > 1 ? n / 100 : n
 *
 * The "n > 1 means it must be a percentage" guess is fine for CTR and install
 * rate, which are never above 1.0 as a fraction. It is WRONG for ROAS, where
 * 2.5 legitimately means 2.5x — that got silently turned into 0.025, a 100x
 * under-report with no error anywhere.
 *
 * It has been dormant because DATA_SCHEMA in creative.gs carries no revenue or
 * ROAS columns, so these fields are all zero today. It would have gone live,
 * quietly and wrongly, the day someone added them.
 */

// CTR, install rate — a fraction in 0..1. A bare value above 1 is a percentage
// that lost its sign somewhere.
function pctRate(v){
  const raw = str(v);
  const n = num(v);
  if (!n) return 0;
  return raw.indexOf('%') !== -1 || n > 1 ? n / 100 : n;
}

// ROAS — a multiplier. 2.5 means 2.5x and must stay 2.5. Only an explicit '%'
// makes it a percentage.
function ratio(v){
  const raw = str(v);
  const n = num(v);
  if (!n) return 0;
  return raw.indexOf('%') !== -1 ? n / 100 : n;
}

function cleanUrl(value){
  const url = str(value);
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  return url;
}

function isVideoUrl(url){
  const u = str(url).toLowerCase();
  return /\.(mp4|webm|mov|m4v|m3u8)(?:$|[?#])/i.test(u);
}

function isImageUrl(url){
  const u = str(url).toLowerCase();
  let decoded = u;
  try { decoded = decodeURIComponent(u); } catch (e) {}
  return /\.(jpg|jpeg|png|webp|gif|avif|svg)(?:$|[?#])/i.test(u) ||
    /\.(jpg|jpeg|png|webp|gif|avif|svg)(?:$|[?#])/i.test(decoded) ||
    /[?&](?:format|fm|type|mime)=image%2F(?:png|jpe?g|webp|gif|avif|svg)/i.test(u) ||
    /[?&](?:format|fm|type)=(?:png|jpe?g|webp|gif|avif|svg)(?:$|[&#])/i.test(u) ||
    /image\/(?:png|jpe?g|webp|gif|avif|svg\+xml)/i.test(decoded);
}

function isPlayableUrl(url){
  const u = str(url).toLowerCase();
  return /\.(html|htm|zip|mraid)(?:$|[?#])/i.test(u) || u.indexOf('playable') !== -1 || u.indexOf('mraid') !== -1;
}

function isHtmlCard(r){
  let value = str(r && r.name) + ' ' + cleanUrl((r && r.previewUrl) || '');
  try { value += ' ' + decodeURIComponent(value); } catch (e) {}
  return /\.html(?:$|[?#\s])/i.test(value) || /(?:^|[\s/\\])html_/i.test(value);
}

function inferFormat(name, url, currentFormat, subformat){
  const n = str(name).toLowerCase();
  const u = str(url).toLowerCase();
  const f = str(currentFormat).toLowerCase();
  const s = str(subformat).toLowerCase();

  // Explicit asset name and URL signals must override the parent set format.
  const explicitPlayable =
    /\.(html|htm|zip|mraid)(?:$|[?#]|\s)/i.test(n) ||
    isPlayableUrl(u) ||
    n.indexOf('playable') !== -1 ||
    n.indexOf('_applovin.html') !== -1 ||
    n.indexOf('svg') !== -1;

  const explicitVideo =
    /\.(mp4|webm|mov|m4v|m3u8)(?:$|[?#]|\s)/i.test(n) ||
    isVideoUrl(u);

  const explicitImage =
    /\.(jpg|jpeg|png|webp|gif|avif|svg)(?:$|[?#]|\s)/i.test(n) ||
    isImageUrl(u);

  if (explicitPlayable) return 'Playable';
  if (explicitVideo) return 'Video';
  if (explicitImage) return 'Image';

  // Use parent metadata only when the asset itself gives no clear signal.
  if (
    f.indexOf('playable') !== -1 ||
    s.indexOf('playable') !== -1 ||
    f.indexOf('html') !== -1 ||
    s.indexOf('html') !== -1
  ) {
    return 'Playable';
  }

  if (
    f.indexOf('video') !== -1 ||
    s.indexOf('video') !== -1
  ) {
    return 'Video';
  }

  if (
    f.indexOf('image') !== -1 ||
    f.indexOf('graphic') !== -1 ||
    s.indexOf('image') !== -1 ||
    s.indexOf('graphic') !== -1
  ) {
    return 'Image';
  }

  return 'Image';
}

function parseAppLovinDataRows(rows){
  const byCreative = {};

  rows.forEach(r => {
    const date = ymdCell(readField(r, 'Date') || readField(r, 'date'));
    const network = str(readField(r, 'Network') || readField(r, 'source')) || 'AppLovin';
    const campaignId = str(readField(r, 'campaign_id') || readField(r, 'Campaign ID'));
    const creativeId = str(
      readField(r, 'Creative ID') ||
      readField(r, 'asset_id') ||
      readField(r, 'creative_id') ||
      readField(r, 'Creative Set ID') ||
      readField(r, 'Creative Set IDs') ||
      readField(r, 'creative_set_id') ||
      readField(r, 'creative_set_ids')
    );
    const assetName = str(
      readField(r, 'Creative Name') ||
      readField(r, 'asset_name') ||
      readField(r, 'creative_name') ||
      readField(r, 'Creative Set Name') ||
      readField(r, 'creative_set_name')
    ) || creativeId;
    const previewUrl = cleanUrl(readField(r, 'Preview URL') || readField(r, 'preview_url') || readField(r, 'Asset URL') || readField(r, 'asset_url'));
    const inferredFormat = inferFormat(assetName, previewUrl, readField(r, 'Format') || readField(r, 'format'), readField(r, 'Sub-format') || readField(r, 'sub_format'));
    // Google Ads normally uses the asset ID as its card label, but playable
    // assets are more useful when identified by their creative/asset name.
    const name = network === 'Google Ads' && inferredFormat !== 'Playable' ? creativeId : assetName;

    if (!creativeId || !name) return;

    const key = (network === 'Google Ads'
      ? network + '|' + campaignId + '|' + creativeId
      : network + '|' + creativeId).toLowerCase();

    if (!byCreative[key]) {
      byCreative[key] = {
        network,
        id: creativeId,
        name,
        assetName,
        format: inferredFormat,
        subformat: str(readField(r, 'Sub-format') || readField(r, 'sub_format')),
        previewUrl: previewUrl,
        parent: str(
          readField(r, 'Creative Set IDs') ||
          readField(r, 'creative_set_ids') ||
          readField(r, 'Creative Set ID') ||
          readField(r, 'creative_set_id')
        ),
        campaigns: str(readField(r, 'Campaigns') || readField(r, 'campaigns')),
        campaignId: campaignId,
        campaignName: str(readField(r, 'campaign_name') || readField(r, 'Campaign Name')),
        campaignSubtype: str(readField(r, 'campaign_subtype')),
        campaignGoal: str(readField(r, 'campaign_goal')),
        appId: str(readField(r, 'app_id')),
        platform: str(readField(r, 'Platforms') || readField(r, 'platform')),
        days: [],
      };
    }

    const c = byCreative[key];

    if (c.format === 'Image' && inferredFormat !== 'Image') c.format = inferredFormat;
    if (!c.previewUrl && previewUrl) c.previewUrl = previewUrl;
    if (!c.parent) {
      c.parent = str(
        readField(r, 'Creative Set IDs') ||
        readField(r, 'creative_set_ids') ||
        readField(r, 'Creative Set ID') ||
        readField(r, 'creative_set_id')
      );
    }

    c.days.push({
      date,
      spend: num(readField(r, 'Spend') || readField(r, 'spend')),
      impressions: num(readField(r, 'Impressions') || readField(r, 'impressions')),
      clicks: num(readField(r, 'Clicks') || readField(r, 'clicks')),
      interactions: num(readField(r, 'interactions') || readField(r, 'Interactions') || readField(r, 'Clicks') || readField(r, 'clicks')),
      installs: num(readField(r, 'Installs') || readField(r, 'installs')),
      rowInstallRate: pctRate(readField(r, 'install_rate') || readField(r, 'Install Rate')),
      revenue: num(readField(r, 'Revenue')) || num(readField(r, 'Revenue D7')) || num(readField(r, 'D7 Revenue')),
      sales: num(readField(r, 'Sales')),
      roas7: ratio(readField(r, 'D7 ROAS')) || ratio(readField(r, 'ROAS D7')) || ratio(readField(r, 'ROAS')),
      roas30: ratio(readField(r, 'D30 ROAS')) || ratio(readField(r, 'ROAS D30')),
      iapRoas7: ratio(readField(r, 'IAP D7')) || ratio(readField(r, 'IAP ROAS D7')) || ratio(readField(r, 'D7 IAP ROAS')),
      adRoas7: ratio(readField(r, 'Ad D7')) || ratio(readField(r, 'Ad ROAS D7')) || ratio(readField(r, 'D7 Ad ROAS')),
      rowCtr: pctRate(readField(r, 'CTR') || readField(r, 'ctr')),
      rowCpm: num(readField(r, 'CPM') || readField(r, 'cpm')),
      rowCpi: num(readField(r, 'CPI') || readField(r, 'cpi')),
    });
  });

  return Object.values(byCreative);
}

// Rebuilds full row objects from the deduplicated "compact-v2" payload.
// The API sends each creative's metadata once and references it by index from
// the per-day rows; this puts it back so every downstream consumer sees the
// same objects it always did. Nothing is dropped.
function expandCompactPayload(payload){
  const metaFields   = payload.metaFields   || [];
  const metricFields = payload.metricFields || [];
  const creatives    = payload.creatives    || [];
  const dates        = payload.dates        || [];
  const days         = payload.days         || [];

  const out = new Array(days.length);

  for (let i = 0; i < days.length; i++){
    const day  = days[i];
    const meta = creatives[day[0]] || [];
    const obj  = {};

    for (let m = 0; m < metaFields.length; m++) obj[metaFields[m]] = meta[m];

    obj.date = dates[day[1]];

    for (let k = 0; k < metricFields.length; k++) obj[metricFields[k]] = day[2 + k];

    out[i] = obj;
  }

  return out;
}

function getTabRows(payload){
  // New compact format. Older responses fall through to the legacy handling
  // below, so a stale deployment keeps working during a rollout.
  if (payload && payload.format === 'compact-v2') return expandCompactPayload(payload);

  const source = Array.isArray(payload) ? payload : (payload.rows || payload.values || payload.data || []);
  if (!Array.isArray(source) || !source.length) return [];
  if (source[0] && !Array.isArray(source[0]) && typeof source[0] === 'object') return source;
  const headers = payload.headers || source[0];
  if (!Array.isArray(headers)) return [];
  return source.slice(payload.headers ? 0 : 1).map(row => {
    const obj = {};
    headers.forEach((h,i) => { obj[str(h)] = row[i]; });
    return obj;
  });
}

/* ---------------------------------------------------------------------------
 * FETCH — with instant-paint cache
 * ------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
 * DAILY FRESHNESS BOUNDARY
 *
 * The sheets change ONCE A DAY and at a known time: the Google Ads Script runs
 * 5-7 AM and syncAllSources at 6:15 AM. Nothing else writes to them. So a
 * payload fetched after that window is still exactly correct at 3 PM, at 9 PM,
 * and at 4 AM the next morning — refetching it is pure cost for an identical
 * answer, and on Apps Script that cost is an execution on a runtime that
 * serves one at a time per user.
 *
 * A cached payload is therefore treated as CURRENT until the next boundary
 * passes, and only then refetched.
 *
 * WHY 8 AND NOT 7. The writers finish by 7, but they run in the SPREADSHEET's
 * timezone while this check runs in the BROWSER's. An hour of slack absorbs a
 * late run and a modest timezone difference. If your viewers are in a
 * substantially different timezone from the Google Ads account, raise it — the
 * failure mode of being too early is serving yesterday's numbers as today's,
 * which is worse than one extra request.
 * ------------------------------------------------------------------------- */
const DATA_BOUNDARY_HOUR = 10;

/* The most recent moment at which new data could have appeared. */
function lastDataBoundary(){
  const boundary = new Date();
  boundary.setHours(DATA_BOUNDARY_HOUR, 0, 0, 0);
  // Before this morning's boundary -> the last one was yesterday.
  if (Date.now() < boundary.getTime()) boundary.setDate(boundary.getDate() - 1);
  return boundary.getTime();
}

/* A cache entry is current when it was stored AFTER the last boundary. */
function cacheEntryIsCurrent(entry){
  return !!(entry && entry.cachedAt && entry.cachedAt >= lastDataBoundary());
}

/* ---------------------------------------------------------------------------
 * EXTENDED-WINDOW LOCAL CACHE — one entry, not one per range.
 *
 * The stored value is the RAW compact-v2 halves exactly as the server sent
 * them, not the expanded payload: compact is several times smaller, which is
 * what keeps the 90-day dataset compact in IndexedDB. It is expanded
 * with buildPayload() on read, the same path a live response takes.
 *
 * A current entry (stored after the last daily boundary) means a page open
 * costs ZERO requests: the sheets only change in the 5-7 AM write window, so
 * the stored bytes are identical to what the server would return.
 * ------------------------------------------------------------------------- */
function extCacheKey(){ return CONFIG.CACHE_KEY + '|ext'; }

const DASHBOARD_IDB = { name:'creative-dashboard', version:1, store:'snapshots' };

function openDashboardDb(){
  return new Promise((resolve,reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
    const request = indexedDB.open(DASHBOARD_IDB.name, DASHBOARD_IDB.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DASHBOARD_IDB.store)) {
        db.createObjectStore(DASHBOARD_IDB.store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

async function readExtendedCache(){
  try {
    const db = await openDashboardDb();
    const entry = await new Promise((resolve,reject) => {
      const tx = db.transaction(DASHBOARD_IDB.store,'readonly');
      const request = tx.objectStore(DASHBOARD_IDB.store).get(extCacheKey());
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (!entry || !entry.raw || !entry.startDate || !entry.endDate) return null;
    return entry;
  } catch(e){ return null; }
}

async function saveExtendedCache(entry){
  const stored = {
    cachedAt: entry.cachedAt,
    startDate: entry.startDate,
    endDate: entry.endDate,
    raw: entry.raw,
  };
  try {
    const db = await openDashboardDb();
    await new Promise((resolve,reject) => {
      const tx = db.transaction(DASHBOARD_IDB.store,'readwrite');
      tx.objectStore(DASHBOARD_IDB.store).put(stored,extCacheKey());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch(e){ /* IndexedDB unavailable — use the live request for this visit. */ }
}

async function clearExtendedCache(){
  try {
    const db = await openDashboardDb();
    await new Promise((resolve,reject) => {
      const tx = db.transaction(DASHBOARD_IDB.store,'readwrite');
      tx.objectStore(DASHBOARD_IDB.store).delete(extCacheKey());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch(e){}
}

// `tone` of 'info' renders the muted style instead of the red one. A session
// timing out is routine housekeeping, not something the user did wrong.
function showLoginError(message, tone){
  const el = document.getElementById('loginError');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('show', !!message);
  el.classList.toggle('info', !!message && tone === 'info');
}

function unlockDashboard(){
  document.getElementById('loginBackdrop').classList.remove('show');
  document.getElementById('appShell').classList.remove('auth-locked');
  _googleLoginPending = false;
  setLoginBusy(false);
}

function lockDashboard(message, tone){
  document.getElementById('appShell').classList.add('auth-locked');
  document.getElementById('loginBackdrop').classList.add('show');
  if (message) showLoginError(message, tone);
}

/* ============================================================================
 * GOOGLE SIGN-IN FLOW
 * ========================================================================== */
let _authResolve = null;
let _googleLoginPending = false;

function setLoginBusy(busy, message){
  const spin = document.getElementById('loginSpin');
  const btn  = document.getElementById('googleSignInBtn');
  if (spin) {
    spin.textContent = message || 'Checking access\u2026';
    spin.style.display = busy ? 'block' : 'none';
  }
  if (btn) {
    btn.style.opacity = busy ? '.4' : '1';
    btn.style.pointerEvents = busy ? 'none' : 'auto';
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
}

// Called by Google Identity Services with the signed ID token.
function handleGoogleCredential(response){
  const credential = response && response.credential;
  if (!credential){ showLoginError('Google did not return a sign-in token.'); return; }
  if (_googleLoginPending) return;

  _googleLoginPending = true;
  showLoginError('');
  setLoginBusy(true, 'Checking access\u2026');

  apiGoogleLogin(credential)
    .then(() => {
      // Authentication is complete. Reveal the dashboard immediately; the
      // startup flow paints cached data or a skeleton while sheet data loads.
      applyRoleUI();
      unlockDashboard();
      if (_authResolve){ const r = _authResolve; _authResolve = null; r(); }
    })
    .catch(err => {
      _googleLoginPending = false;
      setLoginBusy(false);
      // Let the user pick a different account after a rejection.
      try { google.accounts.id.disableAutoSelect(); } catch(e) {}
      showLoginError(String(err && err.message || err));
    });
}

// The GIS script is async/defer, so it may not be ready when this runs.
function initGoogleSignIn(){
  const target = document.getElementById('googleSignInBtn');

  if (!CONFIG.GOOGLE_CLIENT_ID) {
  showLoginError('Dashboard is not configured: CONFIG.GOOGLE_CLIENT_ID is not set.');
  return;
}

  if (!(window.google && google.accounts && google.accounts.id)){
    // The GIS <script> is async/defer — poll until it lands, give up at ~10s.
    initGoogleSignIn._tries = (initGoogleSignIn._tries || 0) + 1;
    if (initGoogleSignIn._tries > 100){
      showLoginError('Could not load Google Sign-In. Check your network or ad blocker.');
      return;
    }
    setTimeout(initGoogleSignIn, 100);
    return;
  }
  initGoogleSignIn._tries = 0;

  google.accounts.id.initialize({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true,
    // NOTE: no `hd` hint here on purpose. Hinting the domain would hide the
    // account picker for external guests, who are allowed by the allowlist.
    // The domain rule is enforced server-side on the verified `hd` claim.
  });

  google.accounts.id.renderButton(target, {
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    logo_alignment: 'left',
    width: 300
  });
}

function loadDashboardAuth(){
  return new Promise(resolve => {
    _authResolve = resolve;

    // A live session token from this tab? Skip the login screen; any expired
    // or revoked token is caught by the first fetch and re-locks the UI.
    if (SESSION_TOKEN){
      applyRoleUI();
      unlockDashboard();
      _authResolve = null;
      resolve();
      return;
    }

    document.getElementById('loginBackdrop').classList.add('show');
    document.getElementById('appShell').classList.add('auth-locked');
    setLoginBusy(false);
    initGoogleSignIn();
  });
}

/* ============================================================================
 * ROLE-AWARE UI
 * The server re-checks the role on every privileged action; hiding buttons is
 * a convenience, never the control itself.
 * ========================================================================== */
function applyRoleUI(){
  const isAdmin = SESSION_ROLE === 'admin';

  const adminBtn = document.getElementById('adminBtn');
  const chip     = document.getElementById('userChip');
  const logout   = document.getElementById('logoutBtn');

  if (adminBtn) adminBtn.style.display = isAdmin ? '' : 'none';

  // SYNC IS RETIRED — this must NOT un-hide it for admins.
  //
  // The button is hidden in the markup, but this line used to override that
  // for anyone with the admin role, which would have quietly brought it back
  // for exactly the people most likely to press it.
  //
  // The sheets are filled by scheduled triggers now: the Google Ads Script at
  // 5-7 AM and syncAllSources at 6 AM, each re-checking the last 5 days for
  // restatements. By the time anyone signs in, the data is already current.
  //
  // WHAT THIS GIVES UP: today's partial figures. A manual sync was the only
  // way to see spend logged since the morning run. If that turns out to matter,
  // restore it by deleting this block and putting back:
  //     if (syncBtn) syncBtn.style.display = isAdmin ? '' : 'none';
  // and removing style="display:none" from the button in the markup. The whole
  // sync path is still live on the server.
  // The Sync button is gone; the Reload button replaced it and is available to
  // everyone, so there is nothing role-dependent left to toggle here.

  if (chip && SESSION_EMAIL){
    chip.style.display = '';
    chip.classList.toggle('role-admin', isAdmin);
    document.getElementById('userChipRole').textContent = isAdmin ? 'Admin' : 'Viewer';
    chip.title = SESSION_EMAIL;
  }
  if (logout) logout.style.display = SESSION_EMAIL ? '' : 'none';
}

function signOut(){
  try { google.accounts.id.disableAutoSelect(); } catch(e) {}
  apiLogout().then(() => window.location.reload());
}

/* ============================================================================
 * ADMIN PANEL
 * ========================================================================== */
function adminMsg(kind, text){
  const el = document.getElementById('adminMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'admin-msg' + (text ? ' show ' + kind : '');
}

function openAdminPanel(){
  document.getElementById('adminBackdrop').classList.add('show');
  adminMsg('', '');
  document.getElementById('adminRows').innerHTML =
    '<tr><td colspan="5" style="color:var(--mut)">Loading…</td></tr>';

  apiAdmin('admin.list')
    .then(renderAdminUsers)
    .catch(err => handleAdminError(err));
}

function closeAdminPanel(){
  document.getElementById('adminBackdrop').classList.remove('show');
}

function handleAdminError(err){
  const message = String(err && err.message || err);
  if (message === 'unauthorized'){
    closeAdminPanel();
    lockDashboard('Your session expired. Please sign in again.');
    initGoogleSignIn();
    return;
  }
  adminMsg('err', message);
}

function renderAdminUsers(data){
  const rows = (data && data.users) || [];
  const body = document.getElementById('adminRows');
  const domain = (data && data.allowedDomain) || '';

  document.getElementById('adminHeadSub').textContent = domain
    ? 'Only these Google accounts can sign in. Non-@' + domain + ' accounts need the external flag.'
    : 'Only these Google accounts can sign in.';

  if (!rows.length){
    body.innerHTML = '<tr><td colspan="5" style="color:var(--mut)">No users yet.</td></tr>';
    return;
  }

  body.innerHTML = rows.map(user => {
    const isMe = user.email === SESSION_EMAIL;
    const revoked = user.status === 'revoked';
    return '<tr>' +
      '<td class="em">' + escapeHtml(user.email) +
        (isMe ? ' <span class="pill pill-me">you</span>' : '') + '</td>' +
      '<td><select class="admin-sel" data-role-for="' + escapeHtml(user.email) + '"' +
        (isMe ? ' disabled title="You cannot change your own role"' : '') + '>' +
        '<option value="viewer"' + (user.role === 'viewer' ? ' selected' : '') + '>Viewer</option>' +
        '<option value="admin"'  + (user.role === 'admin'  ? ' selected' : '') + '>Admin</option>' +
      '</select></td>' +
      '<td>' + (user.external
          ? '<span class="pill pill-ext">external</span>'
          : '<span style="color:var(--mut);font-size:11px">domain</span>') + '</td>' +
      '<td><span class="pill ' + (revoked ? 'pill-rev' : 'pill-act') + '">' +
        escapeHtml(user.status) + '</span></td>' +
      '<td style="text-align:right;white-space:nowrap">' +
        (isMe ? '' :
          '<button class="btn btn-xs" data-status-for="' + escapeHtml(user.email) + '" data-status="' +
            (revoked ? 'active' : 'revoked') + '">' + (revoked ? 'Restore' : 'Revoke') + '</button> ' +
          '<button class="btn btn-xs btn-danger" data-remove-for="' + escapeHtml(user.email) + '">Remove</button>'
        ) +
      '</td>' +
    '</tr>';
  }).join('');

  body.querySelectorAll('[data-role-for]').forEach(sel => {
    sel.addEventListener('change', () => {
      adminMsg('', '');
      apiAdmin('admin.setrole', { email: sel.dataset.roleFor, role: sel.value })
        .then(result => { renderAdminUsers(result); adminMsg('ok', 'Role updated. That user must sign in again.'); })
        .catch(err => { handleAdminError(err); openAdminPanel(); });
    });
  });

  body.querySelectorAll('[data-status-for]').forEach(btn => {
    btn.addEventListener('click', () => {
      adminMsg('', '');
      apiAdmin('admin.setstatus', { email: btn.dataset.statusFor, status: btn.dataset.status })
        .then(result => { renderAdminUsers(result); adminMsg('ok', 'Status updated.'); })
        .catch(err => handleAdminError(err));
    });
  });

  body.querySelectorAll('[data-remove-for]').forEach(btn => {
    btn.addEventListener('click', () => {
      const email = btn.dataset.removeFor;
      if (!window.confirm('Remove ' + email + '? They will be signed out immediately.')) return;
      adminMsg('', '');
      apiAdmin('admin.remove', { email: email })
        .then(result => { renderAdminUsers(result); adminMsg('ok', email + ' removed.'); })
        .catch(err => handleAdminError(err));
    });
  });
}

function adminAddUser(){
  const emailEl = document.getElementById('adminNewEmail');
  const email = String(emailEl.value || '').trim().toLowerCase();
  const role = document.getElementById('adminNewRole').value;
  const external = document.getElementById('adminNewExternal').checked;

  if (!email){ adminMsg('err', 'Enter an email address.'); return; }

  adminMsg('', '');
  const btn = document.getElementById('adminAddBtn');
  btn.disabled = true;

  apiAdmin('admin.add', { email: email, role: role, external: external ? 'TRUE' : 'FALSE' })
    .then(result => {
      emailEl.value = '';
      document.getElementById('adminNewExternal').checked = false;
      renderAdminUsers(result);
      adminMsg('ok', email + ' can now sign in.');
    })
    .catch(err => handleAdminError(err))
    .then(() => { btn.disabled = false; });
}

/* Wipes every stored dashboard entry — current AND legacy cache versions
   (the prefix predates the version suffix). Used when something has genuinely
   changed the underlying data, so no remembered answer can still be right.
   Deliberately does NOT touch the VALIA cache, which has its own key space. */
function clearStoredRanges(){ clearExtendedCache(); }

/* ---------------------------------------------------------------------------
 * FETCH LAYER — three tiers, cheapest first.
 *
 *   1. EXT — the extended dataset (last CONFIG.EXTENDED_DAYS) held in memory
 *      and IndexedDB. Any range inside it is filtered locally by
 *      aggregate(); a date change costs ZERO requests.
 *   2. _rangeCache — ranges older than the extended window, remembered for
 *      the session after their one server fetch.
 *   3. requestSheets() — the actual POST to Apps Script, used by both.
 *
 * The inflight map matters as much as the caches. Apps Script serves ONE
 * execution at a time per user, so two simultaneous asks for the same data
 * must join one request rather than queue two executions behind each other —
 * an earlier build was observed fetching applovin_data twice (263 kB each)
 * on a single page load for exactly this reason.
 * ------------------------------------------------------------------------- */
const RANGE_CACHE_TTL_MS = 15 * 60 * 1000;
const _rangeCache = new Map();     // key -> { at, payload }
const _rangeInflight = new Map();  // key -> Promise

function clearRangeCache(){
  _rangeCache.clear();
}

// The window the extended dataset covers when fetched right now.
function extendedWindowRange(){
  const today = accountToday();
  const start = new Date(today);
  start.setDate(today.getDate() - (CONFIG.EXTENDED_DAYS - 1));
  return { startDate: ymd(start), endDate: ymd(today) };
}

// True when `inner` (an explicit range) lies fully inside `outer`.
function rangeWithin(inner, outer){
  if (!inner || !inner.startDate || !inner.endDate) return false;
  if (!outer || !outer.startDate || !outer.endDate) return false;
  return inner.startDate >= outer.startDate && inner.endDate <= outer.endDate;
}

/* ---------------------------------------------------------------------------
 * TRANSPORT — one POST to doPost, with retries for the two ways an Apps
 * Script call fails in transit: a 404/429/5xx from the one-time
 * googleusercontent echo hop, and the 302-bounce that re-issues the POST as a
 * GET so doGet answers with code 'get_not_supported' (proof doPost never
 * ran). Backoffs are long and jittered on purpose — an immediate retry joins
 * the very queue that dropped the first request.
 * ------------------------------------------------------------------------- */
const FETCH_BACKOFF_MS = [6000, 12000];

function requestSheets(bodyParams){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
  const withJitter = ms => Math.round(ms * (0.75 + Math.random() * 0.5));
  const isRetryableStatus = s => s === 404 || s === 429 || s >= 500;
  const wait = ms => new Promise(done => setTimeout(done, withJitter(ms)));

  const attempt = tryNumber =>
    fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      signal: controller.signal,
      cache: 'no-store',
      body: JSON.stringify(Object.assign(
        { action: 'fetch_all', token: SESSION_TOKEN }, bodyParams))
    })
      .then(r => {
        if (isRetryableStatus(r.status) && tryNumber < FETCH_BACKOFF_MS.length){
          return wait(FETCH_BACKOFF_MS[tryNumber]).then(() => attempt(tryNumber + 1));
        }
        return readApiJson(r, 'dashboard data');
      })
      .then(data => {
        if (data && data.code === 'get_not_supported' && tryNumber < FETCH_BACKOFF_MS.length){
          return wait(FETCH_BACKOFF_MS[tryNumber]).then(() => attempt(tryNumber + 1));
        }
        if (data && data.error === 'unauthorized'){
          // Token missing, expired, or revoked by an admin -> drop the whole
          // session so the caller forces a fresh Google sign-in.
          clearSession();
          throw new Error('unauthorized');
        }
        if (data && data.error) throw new Error(data.error);
        return data;
      });

  return attempt(0)
    .catch(err => {
      throw (err && err.name === 'AbortError')
        ? new Error('Request timed out after ' + (CONFIG.FETCH_TIMEOUT_MS / 1000) +
            's — check API_URL and that the Apps Script deployment is still active.')
        : err;
    })
    .finally(() => clearTimeout(timeoutId));
}

// Turns a raw fetch_all response into the payload applyData() consumes.
function buildPayload(data){
  const appLovinData = (data && data.applovin) || {};
  const googleAdsData = (data && data.google) || {};

  const shapeOk = part => part && (
    Array.isArray(part.rows) ||
    (part.format === 'compact-v2' && Array.isArray(part.days))
  );

  // AppLovin must be present. Google Ads is allowed to arrive empty rather
  // than taking the whole dashboard down with it.
  if (!shapeOk(appLovinData)) {
    throw new Error('Unexpected API response shape from applovin_data');
  }

  return {
    game: appLovinData.game || googleAdsData.game || '',
    appLovinRefreshedAt: appLovinData.refreshedAt || '',
    googleRefreshedAt: googleAdsData.refreshedAt || '',
    appLovinCreatives: parseAppLovinDataRows(getTabRows(appLovinData)),
    googleCreatives: parseAppLovinDataRows(getTabRows(shapeOk(googleAdsData) ? googleAdsData : {})),
    currencyCode: appLovinData.currencyCode || googleAdsData.currencyCode || 'USD',
    // Resolves "today" in the ad account's timezone once the server sends it;
    // falls back to browser-local today until then.
    accountTimeZone: appLovinData.accountTimeZone || googleAdsData.accountTimeZone || '',
  };
}

/* Window fetch: {} for the default 45 days, {days: N} for the extended
 * window. Both are the exact params warmPayloadCache keeps warm server-side,
 * so these are normally cache HITS answered in well under a second of server
 * time. Returns { raw, payload } — raw is what gets stored in IndexedDB
 * (compact, several times smaller), payload is what gets painted. */
function fetchWindow(params){
  const key = 'win|' + JSON.stringify(params || {});
  const pending = _rangeInflight.get(key);
  if (pending) return pending;

  const request = requestSheets(params || {})
    .then(data => ({
      raw: { applovin: data.applovin, google: data.google },
      payload: buildPayload(data),
    }))
    .finally(() => { _rangeInflight.delete(key); });

  _rangeInflight.set(key, request);
  return request;
}

/* Range fetch: explicit dates outside the extended window (old custom
 * ranges). Remembered for the session; simultaneous asks join one request. */
function fetchRange(range){
  const key = 'range|' + (range.startDate || '') + '|' + (range.endDate || '');

  const hit = _rangeCache.get(key);
  if (hit && (Date.now() - hit.at) < RANGE_CACHE_TTL_MS){
    return Promise.resolve(hit.payload);
  }

  const pending = _rangeInflight.get(key);
  if (pending) return pending;

  // Widened a day each side (apiRangeForFetch) so timezone skew between the
  // browser and the sheet cannot clip a boundary day; aggregate() still cuts
  // the view to the exact range.
  const apiRange = apiRangeForFetch(range);

  const request = requestSheets({
    startDate: apiRange.startDate || '',
    endDate: apiRange.endDate || '',
  })
    .then(buildPayload)
    .then(payload => {
      _rangeCache.set(key, { at: Date.now(), payload: payload });
      return payload;
    })
    .finally(() => { _rangeInflight.delete(key); });

  _rangeInflight.set(key, request);
  return request;
}

/* NOTE: fetchDataOnce / fetchData / fetchDataUncached are gone. The staged
 * load in refresh() + the fetchWindow / fetchRange tier above replaced them:
 * the "both sheets in one request" rule, the slow jittered retries, and the
 * in-flight dedup all live on inside requestSheets/fetchWindow/fetchRange. */

/* ---------------------------------------------------------------------------
 * AGGREGATION for the selected date range
 * ------------------------------------------------------------------------- */
/* Span in days for a rolling preset. Anything unrecognised — including a
   preset value left over from an older build in a restored session — falls
   back to the default window rather than producing an empty range. */
function presetSpanDays(value){
  const days = parseInt(value, 10);
  return (isFinite(days) && days > 0) ? days : CONFIG.DEFAULT_VIEW_DAYS;
}

/* The last `days` days, INCLUSIVE of the latest day. */
function rollingRange(days){
  const today = accountToday();
  const start = new Date(today);
  start.setDate(today.getDate() - (days - 1));
  return { startDate: ymd(start), endDate: ymd(today) };
}

/* NOTE: defaultWindowRange() is gone. It existed only to decide whether the
   old two-stage load's first stage could cover the current view; with a single
   request there is no such decision left to make. The server still applies
   CONFIG.MAX_RESPONSE_DAYS to a dateless request — see loadWithinWindow's
   fallback, which is the one caller that still asks for it. */

function rangeForPreset(value){
  if (value === 'single'){
    const picked = appliedSingleDate || ymd(accountToday());
    return { startDate: picked, endDate: picked };
  }

  if (value === 'custom'){
    return {
      startDate: document.getElementById('customStart').value || '',
      endDate: document.getElementById('customEnd').value || '',
    };
  }

  return rollingRange(presetSpanDays(value));
}

function presetLabel(value){
  if (value === 'single') return 'Single date';
  if (value === 'custom') return 'Custom range';
  return 'Last ' + presetSpanDays(value) + ' days';
}

/* The from → to actually being shown, always spelled out. A single day is
   printed once rather than as "X → X". */
function rangeLabel(range){
  if (range.startDate && range.endDate){
    return range.startDate === range.endDate
      ? range.startDate
      : range.startDate + ' → ' + range.endDate;
  }
  if (range.startDate) return 'from ' + range.startDate;
  if (range.endDate) return 'up to ' + range.endDate;
  return 'no dates selected';
}

function aggregate(creatives, startDate, endDate){
  return creatives.map(c => {
    let spend=0, impr=0, clicks=0, interactions=0, installs=0, revenue=0, sales=0;
    let roasW=0, roas7Sum=0, roas30Sum=0, iap7Sum=0, ad7Sum=0, daysActive=0;
    let ctrW=0, ctrSum=0, cpmW=0, cpmSum=0, cpiW=0, cpiSum=0;
    c.days.forEach(d => {
      const rowDate = ymdCell(d.date);

      // Always filtered here, even though the request was also date-bounded:
      // apiRangeForFetch() widens the server window by a day on each side, so
      // the response is a superset of the selected range on purpose.
      // (This used to sit behind `const serverFiltered = false`, a constant that
      // read like a toggle but could never be anything else.)
      if ((startDate || endDate) && !rowDate) return;
      if (startDate && rowDate < startDate) return;
      if (endDate && rowDate > endDate) return;

      spend+=d.spend; impr+=d.impressions; clicks+=d.clicks; interactions+=d.interactions;
      installs+=d.installs; revenue+=d.revenue; sales+=d.sales;
      const w = d.installs || 0;
      roasW += w;
      roas7Sum += d.roas7*w; roas30Sum += d.roas30*w; iap7Sum += d.iapRoas7*w; ad7Sum += d.adRoas7*w;
      if (d.rowCtr){ const cw = d.impressions || 1; ctrW += cw; ctrSum += d.rowCtr*cw; }
      if (d.rowCpm){ const mw = d.impressions || 1; cpmW += mw; cpmSum += d.rowCpm*mw; }
      if (d.rowCpi){ const iw = d.installs || 1; cpiW += iw; cpiSum += d.rowCpi*iw; }
      daysActive++;
    });
    const w = roasW || 1;
    const ctr = impr ? clicks/impr : (ctrW ? ctrSum/ctrW : 0);
    const cpm = impr ? (spend/impr)*1000 : (cpmW ? cpmSum/cpmW : 0);
    const cpi = installs ? spend/installs : (cpiW ? cpiSum/cpiW : 0);
    return {
      network:c.network, id:c.id, name:c.name, assetName:c.assetName, format:c.format, subformat:c.subformat,
      previewUrl:c.previewUrl, parent:c.parent, campaigns:c.campaigns, platform:c.platform,
      campaignId:c.campaignId, campaignName:c.campaignName, campaignSubtype:c.campaignSubtype,
      campaignGoal:c.campaignGoal, appId:c.appId,
      spend, impressions:impr, clicks, installs, revenue, sales, daysActive,
      ctr,
      // Conversion = installs per CLICK. This used to divide by impressions,
      // which is install-per-impression — the same quantity `ipm` already
      // reports (x1000), just under a name that means something else.
      conversionRate: clicks ? installs/clicks : 0,
      cpi,
      cpm,
      ipm: impr ? (installs/impr)*1000 : 0,
      roas7: roasW ? roas7Sum/w : (spend ? revenue/spend : 0),
    };
  });
}

/* ---------------------------------------------------------------------------
 * RENDER
 * ------------------------------------------------------------------------- */
/* DATA FRESHNESS — visible, because a stale read looks exactly like a fresh one.
 *
 * WHY THIS MATTERS MORE NOW. With the Sync button gone, the sheets are filled
 * ONLY by the scheduled triggers: the Google Ads Script at 5-7 AM and
 * syncAllSources at 6 AM. If one of those fails, nothing anywhere says so. The
 * dashboard would keep loading quickly and correctly from sheets that quietly
 * stopped moving, and yesterday's spend would read as today's.
 *
 * So the header states how old the underlying data is, and says it loudly once
 * it is more than a day behind. This is the safety net that replaces the
 * button: you can no longer force a refresh, so you must at least be able to
 * SEE that one is overdue.
 */
function dataFreshnessSuffix(){
  const stamps = [META.appLovinRefreshedAt, META.googleRefreshedAt]
    .map(v => String(v || '').trim())
    .filter(Boolean);

  if (!stamps.length) return '';

  // Oldest of the two is what actually limits the dashboard.
  const oldest = stamps.slice().sort()[0];

  const parsed = new Date(oldest.replace(' ', 'T'));
  if (isNaN(parsed.getTime())) return ' · Data as of ' + oldest;

  const hours = (Date.now() - parsed.getTime()) / 3600000;

  if (hours > 36) {
    return ' · ⚠ Data last updated ' + Math.floor(hours / 24) + ' day(s) ago — '
      + 'the scheduled sync may have failed';
  }

  return ' · Data as of ' + oldest;
}

function updateLabels(){
  const range = rangeForPreset(appliedDatePreset);
  document.getElementById('sbGame').textContent = META.game || 'Creative Analytics BI';
  document.getElementById('pageSub').textContent = '';
  return;
  // The from → to is ALWAYS shown, for every preset — a spend figure is
  // meaningless without the window it covers.
  document.getElementById('pageSub').textContent =
    (META.game ? META.game + ' · ' : '') + presetLabel(appliedDatePreset) +
    ' · ' + rangeLabel(range);
  document.getElementById('sbRefreshed').textContent = 'AppLovin: ' + (META.appLovinRefreshedAt || '—') + ' · Google Ads: ' + (META.googleRefreshedAt || '—');
}

// aggregate() depends on CREATIVES and the date range, and on nothing else.
// Search, network, sort and the format tabs all re-run render(), and each of
// those was paying for a full re-aggregation — every creative, every day —
// before filtering a list it had just built identically a moment earlier.
// Memoising it makes typing in the search box cost a filter, not a rebuild.
//
// invalidateAggregateCache() must be called whenever CREATIVES is replaced.
let _aggCache = { key: '', rows: null };

function invalidateAggregateCache(){ _aggCache = { key: '', rows: null }; }

function aggregatedRowsFor(range){
  const key = (range.startDate || '') + '|' + (range.endDate || '') + '|' + CREATIVES.length;
  if (_aggCache.rows && _aggCache.key === key) return _aggCache.rows;

  let rows = aggregate(CREATIVES, range.startDate, range.endDate);
  if (range.startDate || range.endDate) rows = rows.filter(r => r.daysActive > 0);

  _aggCache = { key: key, rows: rows };
  return rows;
}

function render(){
  const range = rangeForPreset(appliedDatePreset);
  // slice() because the sort below mutates, and the cached array must not be
  // reordered under the next caller.
  let rows = aggregatedRowsFor(range).slice();

  const q = document.getElementById('search').value.toLowerCase().trim();
  const network = document.getElementById('network').value;
  const sort = document.getElementById('sort').value;

  if (network !== 'all') rows = rows.filter(r => r.network === network);
  if (q) rows = rows.filter(r =>
    (r.name||'').toLowerCase().indexOf(q) !== -1 ||
    (r.assetName||'').toLowerCase().indexOf(q) !== -1 ||
    (r.campaignName||'').toLowerCase().indexOf(q) !== -1 ||
    (r.campaigns||'').toLowerCase().indexOf(q) !== -1 ||
    (r.id||'').toLowerCase().indexOf(q) !== -1
  );

  const counts = { all: rows.length, Video:0, Playable:0, Image:0 };
  rows.forEach(r => { if (counts[r.format]!==undefined) counts[r.format]++; });
  Object.keys(counts).forEach(k => {
    const el1 = document.getElementById('count-'+k), el2 = document.getElementById('nav-count-'+k);
    if (el1) el1.textContent = counts[k];
    if (el2) el2.textContent = counts[k];
  });

  renderKpis(rows);

  const view = activeFormat === 'all' ? rows.slice() : rows.filter(r => r.format === activeFormat);
  view.sort((a,b) => {
    if (sort === 'cpi-asc'){
      const av = Number.isFinite(a.cpi) && a.cpi > 0 ? a.cpi : Infinity;
      const bv = Number.isFinite(b.cpi) && b.cpi > 0 ? b.cpi : Infinity;
      return av - bv;
    }
    const av = Number(a[sort]) || 0;
    const bv = Number(b[sort]) || 0;
    return bv - av;
  });
  renderGrid(view);

  requestAnimationFrame(() => renderCharts(rows));
}

function currency(n){ return '$' + Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function renderKpis(rows){
  // Both sources are already reduced to one asset/day row before reaching
  // this point. Sum the currently selected rows so Google Ads follows the
  // exact same date, network and search-filter behaviour as AppLovin.
  const totalSpend = rows.reduce((s,r)=>s+r.spend,0);
  const totalInstalls = rows.reduce((s,r)=>s+r.installs,0);
  const totalImpressions = rows.reduce((s,r)=>s+r.impressions,0);
  const totalInteractions = rows.reduce((s,r)=>s+r.clicks,0);
  const blendedCpi = totalInstalls ? totalSpend/totalInstalls : 0;
  const blendedCtr = totalImpressions ? totalInteractions/totalImpressions : 0;
  const blendedCpm = totalImpressions ? totalSpend/totalImpressions*1000 : 0;
  // installs per CLICK — see the note in aggregate(). Dividing by impressions
  // here reported install-per-impression under the "Conversion" label.
  const conversionRate = totalInteractions ? totalInstalls/totalInteractions : 0;
  const cards = [
    ['blue','Creatives in view', rows.length.toLocaleString()],
    ['green','Total spend', '$'+shortNum(totalSpend)],
    ['purple','Total installs', shortNum(totalInstalls)],
    ['amber','Blended CPI', blendedCpi ? currency(blendedCpi) : '—'],
    ['teal','Blended CPM', blendedCpm ? currency(blendedCpm) : '—'],
    ['blue','Blended CTR', blendedCtr ? (blendedCtr*100).toFixed(2)+'%' : '—'],
    ['red','Conversion', conversionRate ? (conversionRate*100).toFixed(2)+'%' : '—'],
  ];
  document.getElementById('kpis').innerHTML = cards.map(([c,l,v]) =>
    '<div class="kpi '+c+'"><div class="kpi-l">'+l+'</div><div class="kpi-v num">'+v+'</div></div>'
  ).join('');
}

function renderCharts(rows){
  if (!window.Chart) return;
  Chart.defaults.font.family = "'Roboto Condensed', 'Arial Narrow', sans-serif";
  Chart.defaults.font.size = 13;
  Chart.defaults.font.weight = '600';
  Chart.defaults.color = COLOR.ink3;

  const leaderboardColors = [
    '#f4c95d', '#b8c2d6', '#cd8b62',
    '#45a3ff', '#4d91f0', '#617fe4', '#776fda', '#8c62cf', '#a255c0', '#b84cac'
  ];

  const buckets = { Video:0, Playable:0, Image:0 };
  rows.forEach(r => {
    const fmt = FORMATS.includes(r.format) ? r.format : 'Image';
    buckets[fmt] += 1;
  });

  // Keep both the donut and its custom legend ranked dynamically by count.
  // Colours remain attached to the format, not to its current rank.
  const formatColors = {
    Video: leaderboardColors[0],
    Playable: leaderboardColors[2],
    Image: leaderboardColors[1]
  };
  const rankedFormats = Object.entries(buckets)
    .filter(([,count]) => count > 0)
    .sort((a,b) => b[1] - a[1]);
  const labels = rankedFormats.map(([label]) => label);
  const data = rankedFormats.map(([,count]) => count);
  const formatAlignedLegend = {
    id:'formatAlignedLegend',
    afterDraw(chart){
      const ctx = chart.ctx;
      const values = chart.data.datasets[0].data;
      const total = values.reduce((sum,value)=>sum + Number(value || 0),0) || 1;
      const startX = chart.chartArea.right + 30;
      const nameX = startX + 24;
      const countX = startX + 155;
      const shareX = startX + 250;
      const rowHeight = 44;
      const startY = chart.height / 2 - ((values.length - 1) * rowHeight) / 2;
      ctx.save();
      ctx.textBaseline = 'middle';
      chart.data.labels.forEach((label,index)=>{
        const y = startY + index * rowHeight;
        ctx.fillStyle = chart.data.datasets[0].backgroundColor[index];
        ctx.beginPath();
        ctx.arc(startX + 7, y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = "700 18px 'Roboto Condensed', 'Arial Narrow', sans-serif";
        ctx.textAlign = 'left';
        ctx.fillStyle = '#eef1ff';
        ctx.fillText(label, nameX, y);
        ctx.font = "800 17px 'Roboto Condensed', 'Arial Narrow', sans-serif";
        ctx.textAlign = 'right';
        ctx.fillText(Number(values[index]).toLocaleString(), countX, y);
        ctx.fillStyle = '#c7ccdd';
        ctx.fillText(((Number(values[index]) / total) * 100).toFixed(1) + '%', shareX, y);
      });
      ctx.restore();
    }
  };
  const formatCenterTotal = {
    id:'formatCenterTotal',
    afterDraw(chart){
      const arc = chart.getDatasetMeta(0).data[0];
      if (!arc) return;
      const total = chart.data.datasets[0].data.reduce((sum,value)=>sum + Number(value || 0),0);
      const ctx = chart.ctx;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f2f4ff';
      ctx.font = "800 40px 'Roboto Condensed', 'Arial Narrow', sans-serif";
      ctx.fillText(total.toLocaleString(), arc.x, arc.y - 10);
      ctx.fillStyle = '#c7ccdd';
      ctx.font = "600 16px 'Roboto Condensed', 'Arial Narrow', sans-serif";
      ctx.fillText('Total creatives', arc.x, arc.y + 25);
      ctx.restore();
    }
  };
  if (chartFormat) chartFormat.destroy();
  chartFormat = new Chart(document.getElementById('chart-format').getContext('2d'), {
    type:'doughnut',
    data:{ labels, datasets:[{ data, backgroundColor:labels.map(label=>formatColors[label]), borderColor:'#0b0c0f', borderWidth:3, spacing:2, borderRadius:5, hoverOffset:0 }] },
    plugins:[formatAlignedLegend,formatCenterTotal],
    options:{ responsive:true, maintainAspectRatio:false, cutout:'68%', radius:'96%', animation:{duration:200}, layout:{padding:{right:295}},
      plugins:{legend:{display:false},tooltip:{enabled:false}} }
  });

  const top = rows.slice().sort((a,b)=>b.spend-a.spend).slice(0,10);
  const leaderboardValueLabels = {
    id:'leaderboardValueLabels',
    afterDatasetsDraw(chart){
      const ctx = chart.ctx;
      const values = chart.data.datasets[0].data;
      ctx.save();
      ctx.font = "800 16px 'Roboto Condensed', 'Arial Narrow', sans-serif";
      ctx.textBaseline = 'middle';
      chart.getDatasetMeta(0).data.forEach((bar,index)=>{
        const label = '$' + shortNum(Number(values[index] || 0));
        const preferredX = bar.x + 7;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#eef1ff';
        ctx.fillText(label, preferredX, bar.y);
      });
      ctx.restore();
    }
  };
  const leaderboardAxisLabels = {
    id:'leaderboardAxisLabels',
    afterDraw(chart){
      const ctx = chart.ctx;
      const yScale = chart.scales.y;
      const rankX = chart.chartArea.left - 166;
      const nameX = chart.chartArea.left - 146;
      ctx.save();
      ctx.textBaseline = 'middle';
      top.forEach((item,index)=>{
        const y = yScale.getPixelForTick(index);
        ctx.font = "800 15px 'Roboto Condensed', 'Arial Narrow', sans-serif";
        ctx.textAlign = 'right';
        ctx.fillStyle = leaderboardColors[index];
        ctx.fillText(String(index + 1), rankX, y);
        ctx.font = "700 15px 'Roboto Condensed', 'Arial Narrow', sans-serif";
        ctx.textAlign = 'left';
        ctx.fillStyle = '#f2f4ff';
        ctx.fillText(truncate(item.name || item.id,16), nameX, y);
      });
      ctx.restore();
    }
  };
  if (chartTop10) chartTop10.destroy();
  chartTop10 = new Chart(document.getElementById('chart-top10').getContext('2d'), {
    type:'bar',
    data:{ labels: top.map(r=>r.name||r.id), datasets:[{ data: top.map(r=>r.spend), backgroundColor: top.map((r,index)=>leaderboardColors[index]), borderColor:top.map((r,index)=>leaderboardColors[index]), borderWidth:1, borderRadius:5, borderSkipped:false, categoryPercentage:.82, barPercentage:.68 }] },
    plugins:[leaderboardValueLabels,leaderboardAxisLabels],
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false, animation:{duration:200}, layout:{padding:{left:190,right:18,top:4,bottom:0}},
      onHover:(event,elements)=>{ if(event.native && event.native.target) event.native.target.style.cursor=elements.length?'pointer':'default'; },
      onClick:(event,elements)=>{ if(elements.length && top[elements[0].index]) openModal(top[elements[0].index]); },
      plugins:{ legend:{display:false}, tooltip:{ backgroundColor:'#10131b', borderColor:'rgba(77,159,255,.48)', borderWidth:1, cornerRadius:9, titleColor:'#f2f4ff', bodyColor:'#76b7ff', padding:12, caretPadding:8, displayColors:false, titleFont:{family:"'Roboto Condensed', 'Arial Narrow', sans-serif",size:14,weight:'700'}, bodyFont:{family:"'Roboto Condensed', 'Arial Narrow', sans-serif",size:16,weight:'800'}, callbacks:{ label:(item)=>'$'+Math.round(item.parsed.x).toLocaleString() } } },
      scales:{
        x:{ grace:'18%', border:{display:false}, grid:{display:false}, ticks:{ color:COLOR.ink3, font:{size:14,weight:'600'}, padding:8, callback:(v)=>'$'+shortNum(v) }, title:{display:false} },
        y:{ border:{display:false}, grid:{display:false}, ticks:{display:false}, title:{display:false} }
      } }
  });
}

// ── Lazy grid rendering (ported from the sprint dashboard's IntersectionObserver
// pattern) ───────────────────────────────────────────────────────────────────
// Instead of building every card in one innerHTML pass, render the first batch
// and append the next as a sentinel near the bottom approaches the viewport
// (rootMargin pre-loads before the user reaches it). Cuts the one-shot DOM cost
// on large asset lists. One observer per render cycle, disconnected and rebuilt
// on each renderGrid so stale rows never linger.
var GRID_BATCH = 24;          // cards drawn per batch
var _gridObserver = null;
var _gridRows = [];
var _gridDrawn = 0;

/* ---------------------------------------------------------------------------
 * CARD NODE CACHE
 *
 * Filter changes used to throw the whole grid away (innerHTML) and rebuild
 * every card from a string. That destroyed each loaded <video> along with it,
 * so the browser re-downloaded and re-decoded the SAME frames on the very next
 * click — All -> AppLovin -> All paid that cost three times over. It is why
 * AppLovin (~250 videos) lagged while Google Ads (mostly static <img> cards)
 * did not.
 *
 * Cards are now built once and kept. A filter change re-appends the SAME nodes
 * in a new order, so their media stays loaded and the work collapses to moving
 * elements around.
 *
 * The cache is keyed to _aggCache.key — the selected date range plus the
 * dataset identity. Card METRICS depend on the range, so when that changes the
 * cache is dropped and the cards rebuild with the new numbers. Network,
 * format, search and sort never change a card's numbers, only which cards are
 * shown and in what order, which is exactly why they can reuse nodes safely.
 * ------------------------------------------------------------------------- */
const _cardNodes = new Map();
let _cardCacheToken = '';

function cardKeyFor(r){
  return (r.network || '') + '|' + (r.campaignId || '') + '|' + (r.id || '');
}

/* Rank badge and click index depend on POSITION, which moves whenever the
   sort or filter changes, so they are refreshed every time a node is placed. */
function applyCardPosition(node, i){
  node.setAttribute('data-idx', i);

  let rank = node.querySelector('.asset-rank');
  if (i < 3){
    if (!rank){
      rank = document.createElement('div');
      rank.className = 'asset-rank';
      node.insertBefore(rank, node.firstChild);
    }
    rank.textContent = '#' + (i + 1);
  } else if (rank){
    rank.remove();
  }

  // Re-inserting a node restarts its CSS animation, so a card that already
  // made its entrance would replay the 300ms staggered fade on EVERY filter
  // change — up to 560ms of the grid visibly reassembling for no reason.
  // Let each card animate in exactly once.
  if (node.dataset.seen) node.style.animation = 'none';
  else node.dataset.seen = '1';
}

function cardNodeFor(r, i){
  const key = cardKeyFor(r);
  let node = _cardNodes.get(key);

  if (!node){
    const holder = document.createElement('div');
    holder.innerHTML = cardHtml(r, i);
    node = holder.firstElementChild;
    if (!node) return null;
    _cardNodes.set(key, node);
  }

  applyCardPosition(node, i);
  return node;
}

function appendCardBatch(){
  const grid = document.getElementById('assetGrid');
  if (!grid) return;
  const end = Math.min(_gridDrawn + GRID_BATCH, _gridRows.length);

  // One fragment, one insertion — appending nodes one by one would lay the
  // grid out once per card.
  const frag = document.createDocumentFragment();
  for (let i = _gridDrawn; i < end; i++){
    const node = cardNodeFor(_gridRows[i], i);
    if (node) frag.appendChild(node);
  }
  grid.appendChild(frag);

  _gridDrawn = end;
  observeNewVideoThumbs();
}

/* ---------------------------------------------------------------------------
 * LAZY VIDEO THUMBNAILS
 *
 * Card <video> elements are emitted with data-src and no src, so they cost
 * nothing at render time. This observer assigns the real src only when a card
 * comes within a screen of the viewport — after which the browser fetches
 * metadata, seeks to 0.1s and paints the frame. Concurrent media loads are
 * therefore bounded by what is (nearly) on screen, never by how many videos
 * the current filter matched. <img> gets this for free via loading="lazy";
 * <video> has no equivalent attribute, hence doing it by hand.
 * ------------------------------------------------------------------------- */
let _videoThumbObserver = null;

function hydrateVideoThumb(el){
  if (!el || !el.dataset || !el.dataset.src) return;
  if (!el.getAttribute('src')) el.setAttribute('src', el.dataset.src);
}

function observeNewVideoThumbs(){
  const grid = document.getElementById('assetGrid');
  if (!grid) return;

  // ":not([src])" is the whole bookkeeping: a video that already hydrated has
  // a src and is skipped, one that has not is (re-)observed. That matters now
  // that nodes are reused — a card cached before it ever scrolled into view
  // must still be watched by the NEW observer, or its thumbnail would stay
  // blank forever. Re-observing an already-observed target is a no-op.
  const pending = grid.querySelectorAll('video[data-src]:not([src])');
  if (!pending.length) return;

  // No observer support -> load immediately; correct, just not lazy.
  if (typeof IntersectionObserver !== 'function'){
    pending.forEach(hydrateVideoThumb);
    return;
  }

  if (!_videoThumbObserver){
    _videoThumbObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        hydrateVideoThumb(entry.target);
        _videoThumbObserver.unobserve(entry.target);
      });
    }, { root: null, rootMargin: '600px 0px' });   // one screen of lookahead
  }

  pending.forEach(el => _videoThumbObserver.observe(el));
}

function renderGrid(rows){
  const el = document.getElementById('content');

  // Tear down the previous cycle's observers so they can't fire on stale data.
  // Cached card nodes survive this — they are detached, not destroyed, which
  // is what keeps their loaded video frames alive across a filter change.
  if (_gridObserver){ try { _gridObserver.disconnect(); } catch(e){} _gridObserver = null; }
  if (_videoThumbObserver){ try { _videoThumbObserver.disconnect(); } catch(e){} _videoThumbObserver = null; }

  // Drop cached cards only when the NUMBERS on them could have changed, i.e.
  // a new date range or a new dataset. _aggCache.key is exactly that identity.
  // Filter and sort changes leave it untouched, so their cards are reused.
  const cacheToken = _aggCache.key || '';
  if (cacheToken !== _cardCacheToken){
    _cardNodes.clear();
    _cardCacheToken = cacheToken;
  }
  _gridRows = rows;
  _gridDrawn = 0;

  if (!rows.length){
    // Don't flash "No match" while a fetch is still in flight — a range that
    // falls outside the loaded window has zero rows until its payload lands.
    if (_isFetching){ renderSkeleton(8); return; }
    el.innerHTML = '<div class="empty"><h3>No '+(activeFormat==='all'?'creatives':activeFormat.toLowerCase()+'s')+' match</h3><p>Try a wider date range or different filters.</p></div>';
    return;
  }

  // Grid container + a sentinel the observer watches to trigger the next batch.
  el.innerHTML = '<div class="asset-grid" id="assetGrid"></div><div id="gridSentinel" class="grid-sentinel"></div>';
  const grid = document.getElementById('assetGrid');

  // ONE delegated click handler for the whole grid — survives batch appends,
  // no per-card listeners, no index drift.
  grid.addEventListener('click', e => {
    const card = e.target.closest('.asset-card');
    if (!card) return;
    const idx = Number(card.getAttribute('data-idx'));
    if (_gridRows[idx]) openModal(_gridRows[idx]);
  });

  // Draw the first batch, then let the sentinel pull in the rest as it nears
  // the viewport.
  //
  // This used to render EVERY batch up front. The reason given was that the
  // observer commonly stalled after ~48 cards because it watched .page-content
  // while the document was the real scroll container — a correct diagnosis, but
  // the fix disabled lazy rendering altogether, so every render (including
  // every keystroke in the search box) rebuilt the entire card list.
  //
  // Observing against `root: null` uses the viewport, which is right whichever
  // element actually scrolls. The sidebar and tab counts are unaffected either
  // way: they are computed in render() from `rows`, not from how many cards
  // happen to be drawn.
  appendCardBatch();

  const sentinel = document.getElementById('gridSentinel');

  if (typeof IntersectionObserver !== 'function'){
    // No observer support — draw everything rather than hide rows.
    while (_gridDrawn < _gridRows.length) appendCardBatch();
    sentinel.style.display = 'none';
    return;
  }

  // Keep appending while the sentinel is still within (viewport + margin).
  //
  // THIS IS THE PART THAT MAKES LAZY LOADING SAFE. IntersectionObserver only
  // fires when an element CROSSES the threshold. If one batch does not push the
  // sentinel below the fold, the sentinel simply stays intersecting, no further
  // callback ever arrives, and the grid is stuck at 24 cards — which is exactly
  // the stall that made the previous author give up and render everything.
  // Topping up until the sentinel is genuinely out of range removes that whole
  // failure mode. The guard is a runaway stop, nothing more.
  //
  // getBoundingClientRect() is viewport-relative, so this is correct whether
  // the document or .page-content is the element that actually scrolls.
  const FILL_MARGIN = 800;
  const fillUntilOffscreen = () => {
    let guard = 0;
    while (
      _gridDrawn < _gridRows.length &&
      guard++ < 500 &&
      sentinel.getBoundingClientRect().top < window.innerHeight + FILL_MARGIN
    ) {
      appendCardBatch();
    }
  };

  fillUntilOffscreen();

  if (_gridDrawn >= _gridRows.length){
    sentinel.style.display = 'none';
    return;
  }

  _gridObserver = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    fillUntilOffscreen();
    if (_gridDrawn >= _gridRows.length){
      _gridObserver.disconnect();
      _gridObserver = null;
      sentinel.style.display = 'none';
    }
  }, { root: null, rootMargin: FILL_MARGIN + 'px 0px' });   // null = viewport

  _gridObserver.observe(sentinel);
}

function money(n, digits){
  if (!n) return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function pct(n){
  return n ? (n*100).toFixed(2)+'%' : '—';
}

function iconSvg(format){
  if (format==='Video') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="6 4 20 12 6 20 6 4" stroke-linejoin="round"/></svg>';
  if (format==='Playable') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="6" width="18" height="12"/><path d="M9 12h6M12 9v6"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>';
}
function parseYouTubeId(url){ const m = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/); return m ? m[1] : null; }

function usesPlayableThumbnail(r){
  // Preserve the existing AppLovin behavior: only its HTML cards use the
  // custom thumbnail. Google Ads playables, including ZIP assets, use it too.
  return isHtmlCard(r) || (
    r.network === 'Google Ads' &&
    (r.format === 'Playable' || isPlayableUrl(cleanUrl(r.previewUrl || '')))
  );
}

function thumbHtml(r){
  const url = cleanUrl(r.previewUrl || '');
  const u = url.toLowerCase();

  // ── PLAYABLE ── never render a preview in the card. The thumb stays blank
  // (a same-height, themed placeholder) so nothing runs in the dashboard.
  // Clicking the card opens the modal, which shows an "Open in new tab" button.
  // Checked FIRST so a playable can never fall into the image/video branches.
  if (usesPlayableThumbnail(r)) {
    // Use the local custom image for AppLovin HTML cards and Google playables.
    return '<img src="' + escapeHtml(PLAYABLE_THUMB_IMG) + '" alt="" loading="lazy" ' +
      'onerror="this.style.display=\'none\'">';
  }

  if (isHtmlCard(r) || isPlayableUrl(u) || r.format === 'Playable') {
    return '<div class="asset-thumb-fallback fmt-Playable">' + iconSvg('Playable') + '</div>';
  }

  if (isImageUrl(u) || r.format === 'Image') {
    return '<img ' +
      'src="' + escapeHtml(url) + '" ' +
      'alt="" loading="lazy" ' +
      'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
      '<div class="asset-thumb-fallback fmt-' + escapeHtml(r.format) + '" style="display:none">' +
        iconSvg(r.format) +
      '</div>';
  }

  if (
    u.indexOf('youtube.com') !== -1 ||
    u.indexOf('youtu.be') !== -1
  ) {
    const id = parseYouTubeId(url);

    if (id) {
      return '<img src="https://img.youtube.com/vi/' +
        id +
        '/hqdefault.jpg" alt="" loading="lazy">';
    }
  }

  // Only actual video URLs are passed to the video player.
  if (isVideoUrl(u)) {
    // data-src, NOT src — deliberately inert until hydrated.
    //
    // With src set directly, EVERY video card opened its network request and
    // decoded a frame the instant the grid rendered. On the AppLovin filter
    // (~250 videos) that meant hundreds of simultaneous media loads, which is
    // exactly the lag the Google Ads filter (mostly static <img> cards) never
    // showed. observeNewVideoThumbs() assigns the real src only when a card
    // nears the viewport, so videos now load like the lazy images do.
    //
    // The #t=0.1 media fragment stays: preload="metadata" alone commonly
    // paints a black frame; seeking to 0.1s forces a real picture. Skipped
    // when the URL already carries a fragment — a second '#' would corrupt it.
    const thumbUrl = url.indexOf('#') === -1 ? url + '#t=0.1' : url;
    return '<video ' +
      'data-src="' + escapeHtml(thumbUrl) + '" ' +
      'muted playsinline preload="metadata">' +
    '</video>';
  }

  return '<div class="asset-thumb-fallback fmt-' +
    r.format +
  '">' +
    iconSvg(r.format) +
  '</div>';
}

function miniKpi(label, value, muted){
  const metricClass = 'metric-' + String(label).toLowerCase().replace(/[^a-z0-9]+/g,'-');
  return '<div class="'+metricClass+'"><div class="mini-l">'+label+'</div><div class="mini-v num'+(muted?' muted':'')+'">'+value+'</div></div>';
}
function cardHtml(r,i){
  const network = r.network==='AppLovin' ? 'AL' : (r.network==='Google Ads' ? 'GG' : escapeHtml(r.network));
  // Playables get a blank, themed thumb (see thumbHtml + .is-playable CSS).
  const isPlayable = (r.format === 'Playable') || isPlayableUrl(cleanUrl(r.previewUrl || ''));
  const thumbClass = 'asset-thumb' + (isPlayable ? ' is-playable' : '') + (usesPlayableThumbnail(r) ? ' has-custom-thumb' : '');
  return '<article class="asset-card" data-idx="'+i+'" style="animation-delay:'+Math.min(i*12,260)+'ms">'+
    (i<3 ? '<div class="asset-rank">#'+(i+1)+'</div>' : '') +
    '<div class="'+thumbClass+'">'+thumbHtml(r)+
      '<div class="asset-badges"><span class="asset-badge">'+network+'</span><span class="asset-badge fmt-'+r.format+'">'+r.format+'</span></div>'+
    '</div>'+
    '<div class="asset-body">'+
      '<div class="asset-name" title="'+escapeHtml(r.name)+'">'+escapeHtml(r.name||r.id)+'</div>'+
      '<div class="asset-kpis">'+
        miniKpi('Spend','$'+shortNum(r.spend),false)+
        miniKpi('Installs', r.installs ? shortNum(r.installs) : '—', !r.installs)+
        miniKpi('CTR', r.ctr ? (r.ctr*100).toFixed(2)+'%' : '—', !r.ctr)+
        miniKpi('Conversion', r.conversionRate ? (r.conversionRate*100).toFixed(2)+'%' : '—', !r.conversionRate)+
        miniKpi('IPM', r.ipm ? r.ipm.toFixed(2) : '—', !r.ipm)+
        miniKpi('CPI', r.cpi ? '$'+r.cpi.toFixed(2) : '—', !r.cpi)+
      '</div>'+
    '</div>'+
  '</article>';
}

function previewHtml(r){
  const url = cleanUrl(r.previewUrl || '');
  const u = url.toLowerCase();
  const safeUrl = escapeHtml(url);

  if (!url) {
    return '<div style="color:var(--mut);text-align:center;padding:20px">' +
      'No preview URL found for this asset in ' +
      (r.network === 'Google Ads' ? 'google_ads_data.' : 'applovin_data.') +
    '</div>';
  }

  // ── PLAYABLE ── never embedded (memory-heavy). The modal preview shows a
  // themed button that opens the playable in a new browser tab. Checked FIRST
  // (before image/video) so playables always route here. Covers ZIP too.
  // Direct MP4/video URLs always use the centered video player, even when
  // their sheet metadata is incorrectly marked as Playable.
  if (isVideoUrl(u) && !isHtmlCard(r)) {
    return '<video ' +
      'src="' + safeUrl + '" ' +
      'controls autoplay playsinline>' +
    '</video>';
  }

  if (isHtmlCard(r) || isPlayableUrl(u) || r.format === 'Playable') {
    return '<div class="preview-action">' +
      '<a class="ext-link" href="' + safeUrl + '" target="_blank" rel="noopener">' +
        'Open in new tab ↗' +
      '</a>' +
    '</div>';
  }

  if (isImageUrl(u) || r.format === 'Image') {
    return '<img src="' + safeUrl + '" alt="" ' +
      'onerror="this.outerHTML=\'<a class=&quot;ext-link&quot; href=&quot;' +
        safeUrl +
      '&quot; target=&quot;_blank&quot; rel=&quot;noopener&quot;>Open asset ↗</a>\'">';
  }

  if (u.indexOf('youtube.com') !== -1 || u.indexOf('youtu.be') !== -1) {
    const id = parseYouTubeId(url);

    if (id) {
      return '<iframe ' +
        'src="https://www.youtube.com/embed/' + id + '" ' +
        'allow="autoplay; encrypted-media; fullscreen" ' +
        'allowfullscreen>' +
      '</iframe>';
    }
  }

  // Only direct video URLs should enter the video element.
  if (isVideoUrl(u)) {
    return '<video ' +
      'src="' + safeUrl + '" ' +
      'controls autoplay playsinline>' +
    '</video>';
  }

  return '<a class="ext-link" href="' + safeUrl + '" target="_blank" rel="noopener">' +
    'Open asset ↗' +
  '</a>';
}

function modalInfoHtml(r){
  return [
    '<div>',
      '<div class="modal-badges">',
        '<span class="pill">'+(r.network==='AppLovin'?'AL':(r.network==='Google Ads'?'GG':escapeHtml(r.network)))+'</span>',
        '<span class="pill">'+r.format+'</span>',
        (r.subformat ? '<span class="pill">'+escapeHtml(r.subformat)+'</span>' : ''),
      '</div>',
      '<h2>'+escapeHtml(r.name||r.id)+'</h2>',
      '<div class="modal-id">'+escapeHtml(r.id)+'</div>',
    '</div>',
    '<div class="modal-section"><h3>Volume</h3><div class="mkpi-grid">'+
      miniKpi('Spend','$'+shortNum(r.spend),false)+miniKpi('Impressions',shortNum(r.impressions),false)+miniKpi('Clicks',shortNum(r.clicks),false)+
    '</div></div>',
    '<div class="modal-section"><h3>Install economics <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--mut)">(attributed by impression share within each set)</span></h3><div class="mkpi-grid">'+
      miniKpi('Installs', r.installs?shortNum(r.installs):'—', !r.installs)+
      miniKpi('IPM', r.ipm?r.ipm.toFixed(2):'—', !r.ipm)+
      miniKpi('CPI', r.cpi?'$'+r.cpi.toFixed(2):'—', !r.cpi)+
      miniKpi('CTR', r.ctr?(r.ctr*100).toFixed(2)+'%':'—', !r.ctr)+
      miniKpi('CPM', r.cpm?'$'+r.cpm.toFixed(2):'—', !r.cpm)+
      miniKpi('Conversion', r.conversionRate?(r.conversionRate*100).toFixed(2)+'%':'—', !r.conversionRate)+
    '</div></div>',

    (r.campaigns ? '<div class="modal-section"><h3>Campaigns</h3><p>'+escapeHtml(r.campaigns)+'</p></div>' : ''),
    (r.parent ? '<div class="modal-section"><h3>Creative sets</h3><p>'+escapeHtml(r.parent)+'</p></div>' : ''),
  ].join('');
}
function openModal(r){
  document.getElementById('modal-preview').innerHTML = '<button class="modal-close" id="modal-close">✕</button>'+previewHtml(r);
  document.getElementById('modal-info').innerHTML = modalInfoHtml(r);
  document.getElementById('modal-backdrop').classList.add('show');
  document.getElementById('modal-close').addEventListener('click', closeModal);
}
function closeModal(){
  document.getElementById('modal-backdrop').classList.remove('show');
  document.getElementById('modal-preview').querySelectorAll('video,iframe').forEach(el=>el.remove());
}
document.getElementById('modal-backdrop').addEventListener('click', e => { if (e.target.id==='modal-backdrop') closeModal(); });
document.addEventListener('keydown', e => { if (e.key==='Escape') closeModal(); });

/* ---------------------------------------------------------------------------
 * SKELETON / BANNERS
 * ------------------------------------------------------------------------- */
function renderSkeleton(n){
  const content = document.getElementById('content');
  if (!document.getElementById('skeleton')) content.innerHTML = '<div class="skeleton-grid" id="skeleton"></div>';
  const el = document.getElementById('skeleton');
  el.innerHTML = Array.from({length:n}).map(()=>
    '<div class="sk-card"><div class="sk-thumb"></div><div class="sk-lines"><div class="sk-line w60"></div><div class="sk-line w40"></div></div></div>'
  ).join('');
}

// renderLoadingCreatives() removed — never called; renderSkeleton() is the
// loading state the app actually uses, and .lc-spinner had no CSS rule anyway.
function showBanner(kind, msg){
  document.getElementById('banners').innerHTML = '<div class="banner '+kind+'">'+escapeHtml(msg)+'</div>';
}
function clearBanner(){ document.getElementById('banners').innerHTML = ''; }
function setStatus(state, text){
  const dot = document.getElementById('sbDot');
  const status = document.getElementById('sbStatus');
  if (dot) dot.className = 'sdot' + (state==='err' ? ' err' : '');
  if (status) status.textContent = text;
}

/* ---------------------------------------------------------------------------
 * BIND + BOOT
 * ------------------------------------------------------------------------- */
// Bind by id without letting one missing element take down the rest.
//
// bindFilters() is a flat list of getElementById(...).addEventListener(...)
// calls, so a single null threw and skipped EVERY binding after it — and
// because bindFilters runs inside async startDashboard(), that rejection also
// killed the refresh() call that loads the data. One absent element turned into
// a blank dashboard showing "Page error". Now a missing id costs exactly one
// handler and says so in the console.
function on(id, event, handler){
  const el = document.getElementById(id);
  if (!el){
    console.warn('bindFilters: #' + id + ' not found — "' + event + '" handler skipped.');
    return null;
  }
  el.addEventListener(event, handler);
  return el;
}

// Trailing debounce. The search box fires render() on every keystroke, and
// render() re-filters, re-sorts, rebuilds the whole card grid and repaints two
// charts. At typing speed that is several full rebuilds per second, all but the
// last of them discarded.
function debounce(fn, ms){
  let timer = null;
  return function(){
    const args = arguments, self = this;
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(self, args), ms);
  };
}

function bindFilters(){
  on('search', 'input', debounce(render, 180));
  on('network', 'change', render);
  on('sort', 'change', render);

  const dateSel = document.getElementById('dateRange');
  const singleWrap = document.getElementById('singleDateWrap');
  const customWrap = document.getElementById('customDates');
  const today = new Date();
  document.getElementById('singleDate').value = ymd(today);
  appliedDatePreset = dateSel.value;

  function updateDateInputs(){
    singleWrap.classList.toggle('hidden', dateSel.value !== 'single');
    customWrap.classList.toggle('hidden', dateSel.value !== 'custom');
  }

  dateSel.addEventListener('change', () => {
    updateDateInputs();
    if (dateSel.value === 'single') return;

    appliedDatePreset = dateSel.value;
    if (dateSel.value === 'custom'){
      const today=new Date(), seven=new Date(today); seven.setDate(today.getDate()-7);
      if (!document.getElementById('customStart').value) document.getElementById('customStart').value = ymd(seven);
      if (!document.getElementById('customEnd').value) document.getElementById('customEnd').value = ymd(today);
    }
    applyDateChange();
  });
  on('singleDateConfirm', 'click', () => {
    const singleDate = document.getElementById('singleDate');
    if (!singleDate.value){
      singleDate.reportValidity();
      return;
    }
    appliedSingleDate = singleDate.value;
    appliedDatePreset = 'single';
    applyDateChange();
  });
  // Both ends must be set before this means anything. Without the guard,
  // clearing one input fires a request for an open-ended range and the header
  // reads "no dates selected" while the grid repaints for no reason.
  const customRangeReady = () =>
    !!(document.getElementById('customStart').value &&
       document.getElementById('customEnd').value);

  on('customStart', 'change', () => { if (customRangeReady()) applyDateChange(); });
  on('customEnd', 'change', () => { if (customRangeReady()) applyDateChange(); });
  updateDateInputs();

  document.querySelectorAll('[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const fmt = btn.dataset.fmt;
      document.querySelectorAll('[data-fmt]').forEach(b => b.classList.toggle('on', b.dataset.fmt===fmt));
      activeFormat = fmt;
      render();
    });
  });

  // RELOAD — a cheap re-read, NOT a sync.
  //
  // The daily boundary means a normal visit sends no request at all, which is
  // the point. But if the 5-7 AM run was late or failed, that same rule would
  // keep showing yesterday's numbers until tomorrow's boundary with no way out.
  // This is the way out: drop every remembered range and fetch once.
  //
  // It does NOT pull from AppLovin or Google Ads — it only re-reads the sheets,
  // so it is one ordinary request and safe to press repeatedly.
  on('reloadBtn', 'click', () => {
    clearRangeCache();
    clearStoredRanges();
    EXT = null;               // force a genuine re-read, not a local replay
    _creativesSource = '';
    refresh(false);
  });

  on('adminBtn', 'click', openAdminPanel);
  on('adminClose', 'click', closeAdminPanel);
  on('adminAddBtn', 'click', adminAddUser);
  on('adminNewEmail', 'keydown', ev => {
    if (ev.key === 'Enter') adminAddUser();
  });
  on('adminBackdrop', 'click', ev => {
    if (ev.target.id === 'adminBackdrop') closeAdminPanel();
  });
  on('logoutBtn', 'click', signOut);
  on('hamburgerBtn', 'click', () => {
    const shell = document.getElementById('appShell');
    const sidebar = document.getElementById('sidebar');
    if (window.matchMedia('(max-width:860px)').matches) sidebar.classList.toggle('open');
    else shell.classList.toggle('sidebar-collapsed');
    setTimeout(() => {
      if (chartFormat) chartFormat.resize();
      if (chartTop10) chartTop10.resize();
    }, 240);
  });

  // The sidebar items and format tabs are divs carrying role="button", so the
  // browser gives them no keyboard activation of their own. Space/Enter has to
  // be wired by hand or they are mouse-only.
  document.querySelectorAll('.sb-item, .tab').forEach(el => {
    el.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      el.click();
    });
  });
}

// `partial` means this is the AppLovin-only first paint — Google Ads is still
// in flight. Everything renders, but the empty-state warning is suppressed
// (it would be wrong) and the status says so instead of claiming "Live".
/* ---------------------------------------------------------------------------
 * DATE CHANGES ARE LOCAL NOW — this used to refetch, and here is why it can't
 * break the way the last attempt did.
 *
 * The old failure: google_ads_data was aggregated on the SERVER per display
 * window, with every bucket stamped with a single date (the window's end), so
 * Google rows in memory carried no real dates and could not be re-windowed
 * locally. getCreativeData_ in code.gs now serves Google Ads as DAILY rows
 * through the same path as AppLovin — every row carries the day it happened
 * on — so aggregate() windows both networks correctly in the browser.
 *
 * Any range inside the extended dataset (last CONFIG.EXTENDED_DAYS) is
 * therefore answered without a request. Only ranges reaching further back go
 * to the server, through fetchRange()'s session cache and in-flight dedup.
 * ------------------------------------------------------------------------- */
function applyDateChange(){
  updateLabels();
  const range = rangeForPreset(appliedDatePreset);

  if (EXT && rangeWithin(range, EXT)){
    if (_creativesSource !== 'ext'){
      // CREATIVES currently holds a one-off out-of-window payload — put the
      // extended dataset back. Costs a parse at most, never a request.
      applyExtended(false);
    } else {
      render();
    }
    return;
  }

  refresh(false);
}

/* Paints the extended dataset. The expanded payload is built lazily from the
 * stored compact halves and then kept, so repeated preset hops are free. */
function applyExtended(fromCache){
  if (!EXT) return;
  if (!EXT.payload) EXT.payload = buildPayload(EXT.raw);
  applyData(EXT.payload, fromCache, 'ext');
}

/* NOTE: swapInExtended() is gone. It updated the data WITHOUT repainting, and
 * was only safe because the old stage 1 had just painted rows identical to the
 * ones being swapped in. With a single request nothing pre-paints those rows,
 * so skipping the render would leave stale numbers on screen. applyExtended()
 * is now the only way the extended dataset reaches the page. */

function applyData(payload, fromCache, source){
  unlockDashboard();
  applyRoleUI();
  META = { game: payload.game, appLovinRefreshedAt: payload.appLovinRefreshedAt,
    googleRefreshedAt: payload.googleRefreshedAt, currencyCode: payload.currencyCode || 'USD',
    accountTimeZone: payload.accountTimeZone || '' };
  CREATIVES = (payload.appLovinCreatives || []).concat(payload.googleCreatives || []);
  invalidateAggregateCache();   // CREATIVES replaced — any memoised rows are stale
  _creativesSource = source || 'range';
  updateLabels();
  clearBanner();
  if (!CREATIVES.length){
    showBanner('warn', 'No AppLovin or Google Ads creative rows matched the selected date range.');
  }
  render();
  setStatus('ok', fromCache ? 'Showing cached data' : 'Live');
  completeLoadingProgress();
}

/* ---------------------------------------------------------------------------
 * BACKGROUND SYNC
 *
 * "Sync Now" is no longer a read that happens to take a long time. The server
 * schedules the AppLovin pull as its own execution and answers immediately;
 * this polls for the outcome and reloads the data when it lands.
 *
 * WHY. Running the sync inside the request pushed that execution past 50
 * seconds, and a web-app response cannot reliably survive being made to wait
 * that long — the one-time googleusercontent URL had usually expired by the
 * time the browser followed the redirect. Measured 2026-08-04: every sync over
 * 50s returned 404, every one under 50s succeeded. Worse, the sync itself had
 * generally WORKED, so the button reported failure on refreshed data.
 *
 * Now nothing waits. The button starts a job and reports on it.
 * ------------------------------------------------------------------------- */
/* POLLING SCHEDULE — deliberately sparse.
 *
 * THE MISTAKE THIS FIXES. The first version polled every 5 seconds flat. Each
 * poll is a full POST -> 302 -> googleusercontent round trip, which is its own
 * Apps Script EXECUTION. Apps Script runs one execution at a time per user, so
 * twelve polls a minute queued behind each other AND behind the background
 * sync they were asking about.
 *
 * Measured 2026-08-04, poll execution times climbed as the queue deepened:
 *     1.25s, 4.80s, 6.05s, 8.83s, 17.17s, 24.72s -> 404
 * The 404 was a status poll that sat in the queue until its one-time echo key
 * expired. 45 requests over 5.6 minutes, almost all of them 0.2 kB of nothing.
 *
 * Moving the sync off the request thread was right. Replacing it with a stream
 * of polls recreated the same contention it was meant to remove, which made
 * things worse during a sync than before.
 *
 * A sync takes minutes. Knowing within 30 seconds is ample; knowing within 5
 * is worthless if the asking is what breaks it. This schedule costs about ten
 * requests for a four-minute sync instead of roughly fifty.
 */
const SYNC_POLL_SCHEDULE_MS = [15000, 20000, 30000, 30000, 30000, 45000];
const SYNC_POLL_STEADY_MS = 60000;   // every poll after the schedule runs out

// The sync itself takes minutes, so there is nothing to learn in the first
// half-minute. Starting here removes the densest, most contended polls.
const SYNC_FIRST_POLL_MS = 30000;

// Server marks a job stale after 15 minutes; stop watching a little after that
// so a dead job cannot leave this polling forever.
const SYNC_POLL_MAX_MS = 16 * 60 * 1000;

let _syncPollTimer = null;
let _syncWatching = false;
let _syncPollCount = 0;

function nextPollDelay(){
  const index = _syncPollCount;
  _syncPollCount++;
  return index < SYNC_POLL_SCHEDULE_MS.length
    ? SYNC_POLL_SCHEDULE_MS[index]
    : SYNC_POLL_STEADY_MS;
}

function setSyncBusy(busy){
  const btn = document.getElementById('reloadBtn');
  const icn = document.getElementById('reloadIcn');
  if (!btn || !icn) return;
  btn.disabled = !!busy;
  icn.classList.toggle('spinning', !!busy);
}

function stopSyncWatch(){
  if (_syncPollTimer) clearTimeout(_syncPollTimer);
  _syncPollTimer = null;
  _syncWatching = false;
  _syncPollCount = 0;
}

async function startSync(){
  if (_syncWatching){
    showBanner('warn', 'A sync is already running — waiting for it to finish.');
    return;
  }

  setSyncBusy(true);
  setStatus('ok', 'Starting sync…');
  showBanner('warn', 'Starting sync…');

  try {
    const res = await apiPost({ action: 'sync.start', token: SESSION_TOKEN });

    showBanner('warn', res.alreadyRunning
      ? 'A sync was already running — watching it instead of starting another.'
      : 'Sync started. This usually takes a few minutes; the dashboard will '
        + 'update on its own and you can keep using it meanwhile.');

    watchSync(Date.now());
  } catch (err){
    setSyncBusy(false);
    setStatus('err', 'Sync failed to start');
    const msg = String(err && err.message || err);
    showBanner('err', msg === 'unauthorized'
      ? 'Session expired — sign in again to start a sync.'
      : 'Could not start the sync: ' + msg);
  }
}

function watchSync(startedAt){
  _syncWatching = true;
  _syncPollCount = 0;
  setSyncBusy(true);
  setStatus('ok', 'Syncing…');

  const poll = async () => {
    // Give up watching rather than polling a dead job forever. The job may
    // still be running server-side, which is why this says "check" and not
    // "failed" — claiming a failure we cannot verify is how the old sync
    // button ended up lying about syncs that had actually worked.
    if (Date.now() - startedAt > SYNC_POLL_MAX_MS){
      stopSyncWatch();
      setSyncBusy(false);
      setStatus('err', 'Sync status unknown');
      showBanner('err',
        'Stopped watching the sync after 16 minutes. It may still be running — '
        + 'check the Apps Script Executions log before starting another.');
      return;
    }

    // YIELD TO REAL WORK. A user-initiated data load owns the runtime; a
    // status poll is housekeeping and must never compete with it for the
    // single execution slot. Skip this tick and ask again later.
    if (_isFetching){
      _syncPollTimer = setTimeout(poll, nextPollDelay());
      return;
    }

    let state;
    try {
      state = await apiPost({ action: 'sync.status', token: SESSION_TOKEN });
    } catch (err){
      // A dropped poll is NOT a failed sync, and it must NOT be retried
      // immediately — an immediate retry joins the very queue that dropped it.
      // Wait for the next scheduled tick like any other poll.
      _syncPollTimer = setTimeout(poll, nextPollDelay());
      return;
    }

    if (state.status === 'running'){
      const secs = Math.round((Date.now() - startedAt) / 1000);
      setStatus('ok', 'Syncing… ' + secs + 's');
      _syncPollTimer = setTimeout(poll, nextPollDelay());
      return;
    }

    stopSyncWatch();

    if (state.status === 'error'){
      setSyncBusy(false);
      setStatus('err', 'Sync failed');
      showBanner('err', 'Sync failed: ' + (state.message || 'unknown error'));
      return;
    }

    // done / idle -> the data on the server is fresh.
    //
    // CLEAR EVERY LOCAL COPY FIRST. Every range remembered in this session —
    // including the extended dataset — was computed from PRE-sync sheets, so
    // serving any of it now would show old numbers immediately after the sync
    // that was supposed to replace them — silently, because a cache hit looks
    // exactly like a fresh fetch.
    clearRangeCache();
    clearStoredRanges();
    EXT = null;
    _creativesSource = '';

    showBanner('ok', state.message || 'Sync finished — loading fresh data…');
    setSyncBusy(false);
    refresh(false);
  };

  // Nothing useful can have happened in the first few seconds of a
  // multi-minute job, so the first poll waits too.
  _syncPollTimer = setTimeout(poll, SYNC_FIRST_POLL_MS);
}

/* If a sync was already running when this tab opened — started here before a
   reload, or by someone else — pick it up rather than leaving the button idle
   while work is happening. */
async function resumeSyncIfRunning(){
  try {
    const state = await apiPost({ action: 'sync.status', token: SESSION_TOKEN });
    if (state && state.status === 'running'){
      showBanner('warn', 'A sync is already running — the dashboard will update when it finishes.');
      watchSync(Number(state.startedAt) || Date.now());
    }
  } catch (e) { /* not worth surfacing */ }
}

/* ---------------------------------------------------------------------------
 * THE WINDOW LOAD — ONE REQUEST
 *
 * WHAT THIS REPLACED. This used to be a two-stage load: fetch the default
 * 45-day window, paint it, then fetch the extended window in the background
 * and swap it in. The extended window is a SUPERSET of the default one, so
 * that first response was downloaded, painted, and then thrown away seconds
 * later by data that already contained every row of it.
 *
 * WHY THAT WAS WRONG HERE. Measured 2026-08-06 against the deployed build:
 *
 *     server execution     1.5 s   (warm cache — never the bottleneck)
 *     45-day window        2.13 MB
 *     62-day window        2.71 MB (was 92 days)
 *     observed transfer     ~18 s per window at ~200 Kbps
 *
 * Apps Script runs ONE execution at a time per user, so the two requests could
 * never overlap — the second always waited for the first. Staging therefore
 * bought a first paint a few seconds sooner in exchange for roughly DOUBLING
 * the bytes and the total time to a usable dashboard. On a fast link that
 * trade is near neutral; on a slow one it is what turned a 20-second load into
 * a 90-second one. It is never clearly positive, so there is now one request.
 *
 * The default window has not gone away — it is the FALLBACK below, paid for
 * only when the wider request actually fails.
 * ------------------------------------------------------------------------- */
async function loadWithinWindow(myReq){
  try {
    paintLoadingProgress(Math.max(_loadProgress,24),'Loading creative data');
    const extended = await fetchWindow({ days: CONFIG.EXTENDED_DAYS });
    paintLoadingProgress(90,'Preparing dashboard');
    const win = extendedWindowRange();
    EXT = {
      cachedAt: Date.now(),
      startDate: win.startDate,
      endDate: win.endDate,
      raw: extended.raw,
      payload: extended.payload,
    };
    saveExtendedCache(EXT);
  } catch (err){
    if (String(err && err.message || err) === 'unauthorized') throw err;
    if (myReq !== _reqSeq) throw err;

    // Fall back to the smaller default window rather than showing an error
    // screen — the same safety net the old stage 1 provided, except it now
    // costs a request only when something has actually gone wrong. Ranges
    // wider than the default fall back to per-range fetches until the next
    // successful load.
    console.warn('Extended-window load failed — falling back to the default window:', err);
    const fallback = await fetchWindow({});
    if (myReq === _reqSeq) applyData(fallback.payload, false, 'range');
    return;
  }

  if (myReq !== _reqSeq) return;   // a newer refresh started — stand down

  const current = rangeForPreset(appliedDatePreset);
  if (!rangeWithin(current, EXT)) return;   // user moved out of window meanwhile

  // Always a real paint. Nothing has pre-painted these rows now that stage 1
  // is gone, and what IS on screen may be a stale IndexedDB entry from a
  // previous day — swapping the data in without rendering would leave the old
  // numbers visible.
  applyExtended(false);
}

function loadOutsideWindow(myReq, range){
  paintLoadingProgress(Math.max(_loadProgress,24),'Loading selected date range');
  return fetchRange(range).then(payload => {
    if (myReq !== _reqSeq) return;
    paintLoadingProgress(90,'Preparing dashboard');
    applyData(payload, false, 'range');
  });
}

function refresh(forceIndicator){
  const btn = document.getElementById('reloadBtn');
  const icn = document.getElementById('reloadIcn');
  const myReq = ++_reqSeq;          // tag this request as the newest
  btn.disabled = true;
  icn.classList.add('spinning');
  _isFetching = true;
  startLoadingProgress(forceIndicator ? 'Refreshing dashboard' : 'Loading dashboard');

  // Keep whatever is already painted while refreshing behind it. The old
  // behaviour wiped real cards with a skeleton on every refresh, which made a
  // stale-cache open FEEL slow even though data was already on screen.
  const alreadyPainted = Array.isArray(CREATIVES) && CREATIVES.length > 0;
  if (alreadyPainted){
    setStatus('ok', 'Refreshing…');
  } else {
    setStatus('ok', 'Loading...');
    showBanner('warn', 'Loading data...');
    renderSkeleton(8);
  }

  const range = rangeForPreset(appliedDatePreset);
  const task = rangeWithin(range, extendedWindowRange())
    ? loadWithinWindow(myReq)
    : loadOutsideWindow(myReq, range);

  task
    .catch(err => {
      if (myReq !== _reqSeq) return;   // stale failure — ignore
      failLoadingProgress();
      setStatus('err', 'Load failed');
      const msg = String(err && err.message || err);
      if (/password|authorized|unauthorized|email|role/i.test(msg)) {
        // Bare 'unauthorized' is the server's wire value, not a message meant
        // for a human — say what it actually means, in the muted style. A
        // session reaching its 6-hour limit is expected, not an error, and
        // showing it in red made routine re-auth look like a broken dashboard.
        if (msg === 'unauthorized'){
          setStatus('ok', 'Signed out');
          lockDashboard('Session timed out. Sign in again to continue.', 'info');
        } else {
          lockDashboard(msg);
        }
        loadDashboardAuth().then(() => refresh(forceIndicator));
      } else {
        // Authentication succeeded, so do not strand the user behind the
        // sign-in overlay merely because the first data request failed.
        if (SESSION_TOKEN) unlockDashboard();

        // SAY THE NUMBERS ARE OLD.
        //
        // startDashboard() paints the stored extended dataset before the live request
        // finishes, so when that request then fails the screen is left showing
        // a PREVIOUS payload — real figures, quietly out of date, with nothing
        // to distinguish them from fresh ones. A spend dashboard silently
        // showing yesterday's numbers is worse than one showing an error,
        // because the error at least stops you acting on it.
        const painted = Array.isArray(CREATIVES) && CREATIVES.length > 0;

        showBanner('err',
          painted
            ? 'Showing previously loaded data — the live refresh failed: ' + msg
            : 'Could not refresh from the API: ' + msg);

        if (painted) setStatus('err', 'Stale data');
      }
    })
    .finally(() => {
      // NO STALE GUARD HERE — this must run for EVERY request, newest or not.
      //
      // It used to start with `if (myReq !== _reqSeq) return;`, which meant a
      // request that was superseded mid-flight never ran its own cleanup. With
      // the retry ladder that is easy to hit: refresh #1 is still backing off
      // when refresh #2 starts, #1 eventually settles, returns early, and the
      // spinner it switched on is never switched off by anyone. That is the
      // "everything is loaded but it keeps syncing" state.
      //
      // Turning the spinner off is safe to do unconditionally: if a newer
      // request is genuinely still running it will have set it on again, and
      // the line below re-asserts that.
      _isFetching = false;
      btn.disabled = false;
      icn.classList.remove('spinning');

      // A newer request owns the UI — restore the busy indicator it needs.
      if (myReq !== _reqSeq) {
        btn.disabled = true;
        icn.classList.add('spinning');
        _isFetching = true;
      }

      // A background sync outlives any individual read. If one is still being
      // watched, this refresh finishing must not make the button look idle
      // while real work continues on the server.
      if (_syncWatching) setSyncBusy(true);
    });
}
async function startDashboard(){
  // A non-absolute API_URL (a leftover placeholder like 'hide', or a redacted
  // value) is NOT an obvious failure: fetch() resolves it relative to the page,
  // so the request goes to your own host and comes back as a plain HTTP 404
  // that looks like a dead Apps Script deployment. Catch it up front instead.
  if (!/^https:\/\/script\.google\.com\//.test(CONFIG.API_URL || '')){
    setStatus('err','Setup required');
    showBanner('err',
      'CONFIG.API_URL is not a valid Apps Script URL (currently: "' +
      (CONFIG.API_URL || '') + '"). Paste the /exec URL from ' +
      'Apps Script → Deploy → Manage deployments.');
    document.getElementById('content').innerHTML = '';
    return;
  }

  if (!CONFIG.GOOGLE_CLIENT_ID || CONFIG.GOOGLE_CLIENT_ID.indexOf('.apps.googleusercontent.com') < 0){
    setStatus('err','Setup required');
    showBanner('err',
      'CONFIG.GOOGLE_CLIENT_ID is not a valid OAuth client ID (currently: "' +
      (CONFIG.GOOGLE_CLIENT_ID || '') + '"). It should end in ' +
      '.apps.googleusercontent.com');
    document.getElementById('content').innerHTML = '';
    return;
  }

  if (!CONFIG.API_URL || CONFIG.API_URL.indexOf('PASTE_') === 0){
    setStatus('err','Setup required');
    showBanner('err', 'Configure API_URL in the dashboard settings.');
    document.getElementById('content').innerHTML = '';
    return;
  }

  startLoadingProgress('Checking dashboard access');
  await loadDashboardAuth();

  bindFilters();
  renderSkeleton(8);

  // The extended dataset from a previous visit paints instantly — no request,
  // no skeleton. If it was stored before the last daily boundary it is still
  // painted (better a labelled stale view than a spinner) and then refreshed
  // behind itself.
  const stored = await readExtendedCache();
  paintLoadingProgress(18, stored ? 'Opening saved dashboard' : 'Loading creative data');

  if (stored){
    EXT = stored;
    try {
      applyExtended(true);
    } catch(e){
      // Unreadable cache (old format, corrupted) — drop it and load live.
      EXT = null;
      clearExtendedCache();
    }
  }

  if (!EXT) setStatus('ok','Loading…');

  if (EXT && cacheEntryIsCurrent(EXT)){
    // NO REQUEST AT ALL.
    //
    // This dataset was stored after the last 5-7 AM write window, and nothing
    // else writes to the sheets, so asking the server again would return the
    // same bytes at the cost of one execution. The header still shows the real
    // "Data as of" stamp from the payload itself, so nothing is hidden.
    setStatus('ok', 'Live');
  } else {
    refresh(false);
  }
  // Watch for the boundary rather than reloading on a blind 24-hour timer.
  //
  // A tab left open overnight crosses 8 AM and its data becomes yesterday's.
  // Checking hourly costs nothing (it is a clock comparison, not a request)
  // and fetches EXACTLY ONCE, when the boundary is actually crossed.
  let _lastSeenBoundary = lastDataBoundary();
  setInterval(() => {
    const boundary = lastDataBoundary();
    if (boundary === _lastSeenBoundary) return;   // still the same day's data
    _lastSeenBoundary = boundary;
    clearRangeCache();
    clearStoredRanges();
    EXT = null;
    _creativesSource = '';
    refresh(false);
  }, 60 * 60 * 1000);

  // A sync started before this reload — or by another admin — is still real
  // work in progress, and picking it up keeps the button honest.
  //
  // BUT IT MUST NOT RACE THE FIRST DATA LOAD.
  //
  // This used to fire immediately, right beside refresh(false). Apps Script
  // runs ONE execution at a time per user, so on every single page load a
  // sync.status poll queued alongside the data fetch and delayed the thing the
  // user is actually waiting for — to check on a sync that, almost always, is
  // not even running. That is why login felt slower than before.
  //
  // Waiting for the load to finish costs nothing: an in-progress sync will
  // still be in progress ten seconds later, and if none is running this poll
  // was pure overhead anyway.
  if (SESSION_TOKEN) {
    const whenIdle = () => {
      if (_isFetching) { setTimeout(whenIdle, 2000); return; }
      resumeSyncIfRunning();
    };
    setTimeout(whenIdle, 3000);
  }
}

// Boot only once the document is fully parsed.
//
// startDashboard() is async and awaits loadDashboardAuth(), which resolves
// synchronously when a session token is already in sessionStorage. The await
// continuation then runs on the end-of-script microtask checkpoint, i.e. before
// the parser has seen anything below this <script> block. Anything bindFilters()
// looks up down there would be null. The admin modal now lives above this
// script, so the ordering is already correct — this guard makes it stay correct
// no matter what markup gets appended later.
function bootDashboard(){
  startDashboard().catch(err => {
    failLoadingProgress();
    showBanner('err', 'Page error: ' + (err && err.message || err));
  });
}

if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', bootDashboard, { once: true });
} else {
  bootDashboard();
}


/* ============================================================================
 * VALIA PAGE  (added — everything above is untouched)
 * ----------------------------------------------------------------------------
 * Talks to its OWN Apps Script deployment (the one bound to the VALIA sheet),
 * separate from CONFIG.API_URL above. Read-only: it never writes anything.
 * ========================================================================== */


let VALIA_DATA = null;
let _valiaLoading = false;
let _valiaReq = 0;

/* ---- helpers (namespaced so nothing above can be shadowed) ---- */
function vEsc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}
function vYtId(url){
  const t = String(url == null ? '' : url).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  const m = t.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function vBanner(kind, msg){
  document.getElementById('valiaBanners').innerHTML =
    '<div class="banner ' + kind + '">' + vEsc(msg) + '</div>';
}
function vClearBanner(){ document.getElementById('valiaBanners').innerHTML = ''; }

/* ---- page routing ---- */
function valiaSetPage(on){
  const q = sel => document.querySelector(sel);
  const krow = q('.krow'), g2 = q('.g2'), tabs = q('#tabs'),
        content = q('#content'), page = q('#valiaPage'),
        actions = q('.main-actions'), mainSearch = q('#search'), title = q('.page-title'),
        sub = q('#pageSub');

  if (krow)    krow.style.display    = on ? 'none' : '';
  if (g2)      g2.style.display      = on ? 'none' : '';
  if (tabs)    tabs.style.display    = on ? 'none' : '';
  if (content) content.style.display = on ? 'none' : '';
  if (actions) actions.style.display = on ? 'none' : '';
  if (mainSearch) mainSearch.style.display = on ? 'none' : '';
  if (page)    page.style.display    = on ? '' : 'none';

  if (on){
    if (title) title.textContent = 'VALIA — AI Video Labels';
    if (sub) sub.textContent = 'Gemini-generated creative labels, joined on YouTube video ID';
    document.querySelectorAll('[data-fmt]').forEach(b => b.classList.remove('on'));
    document.querySelector('[data-page="valia"]').classList.add('on');
    if (!VALIA_DATA && !_valiaLoading) valiaRefresh();
  } else {
    if (title) title.textContent = 'Creative Performance';
    document.querySelector('[data-page="valia"]').classList.remove('on');
    if (typeof updateLabels === 'function') updateLabels();
  }
}

/* ---- fetch ---- */
function valiaFetch(){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIA_CONFIG.FETCH_TIMEOUT_MS);

  return fetch(VALIA_CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    signal: controller.signal,
    cache: 'no-store',
    body: JSON.stringify({ action: 'valia' })
  })
    .then(r => readApiJson(r, 'VALIA'))
    .then(data => {
      if (data && data.error) throw new Error(data.error);
      return data;
    })
    .finally(() => clearTimeout(timer));
}

function valiaRefresh(){
  const my = ++_valiaReq;
  const btn = document.getElementById('valiaRefresh');
  const icn = document.getElementById('valiaRefreshIcn');

  if (!VALIA_CONFIG.API_URL || VALIA_CONFIG.API_URL.indexOf('PASTE_') === 0){
    vBanner('err', 'Set VALIA_CONFIG.API_URL to your Valia Apps Script /exec URL.');
    document.getElementById('valiaContent').innerHTML = '';
    return;
  }

  _valiaLoading = true;
  btn.disabled = true;
  icn.classList.add('spinning');
  vBanner('warn', 'Loading labels from the VALIA sheet…');
  document.getElementById('valiaContent').innerHTML =
    '<div class="skeleton-grid">' + '<div class="skeleton-card"></div>'.repeat(6) + '</div>';

  valiaFetch()
    .then(data => {
      if (my !== _valiaReq) return;
      VALIA_DATA = data;
      vClearBanner();
      valiaRender();
    })
    .catch(err => {
      if (my !== _valiaReq) return;
      vBanner('err', 'Could not load VALIA: ' + (err && err.message || err));
      document.getElementById('valiaContent').innerHTML = '';
    })
    .finally(() => {
      if (my !== _valiaReq) return;
      _valiaLoading = false;
      btn.disabled = false;
      icn.classList.remove('spinning');
    });
}

/* ---- render ---- */
function valiaRender(){
  if (!VALIA_DATA) return;
  const sources = VALIA_DATA.sources || [];
  const all = VALIA_DATA.videos || [];

  const totalFields = sources.reduce((n, s) => n + s.fields.length, 0);
  const filledOf = v => sources.reduce(
    (n, s) => n + s.fields.filter(f => v.labels[s.tab] && v.labels[s.tab][f]).length, 0);

  all.forEach(v => {
    v._filled = filledOf(v);
    v._total = totalFields;
    v._state = v._filled === 0 ? 'none' : (v._filled === totalFields ? 'labelled' : 'partial');
  });

  const done = all.filter(v => v._state === 'labelled').length;
  const part = all.filter(v => v._state === 'partial').length;
  const none = all.filter(v => v._state === 'none').length;

  document.getElementById('valiaStats').innerHTML =
    '<div class="vstat"><div class="vstat-l">Videos</div><div class="vstat-v">' + all.length + '</div></div>' +
    '<div class="vstat done"><div class="vstat-l">Labelled</div><div class="vstat-v">' + done + '</div></div>' +
    '<div class="vstat part"><div class="vstat-l">Partial</div><div class="vstat-v">' + part + '</div></div>' +
    '<div class="vstat none"><div class="vstat-l">Awaiting</div><div class="vstat-v">' + none + '</div></div>';

  const navCount = document.getElementById('nav-count-valia');
  if (navCount) navCount.textContent = all.length;

  const mode = document.getElementById('valiaFilter').value;
  const q = document.getElementById('valiaSearch').value.trim().toLowerCase();

  let rows = all.filter(v => {
    if (mode === 'labelled' && v._state !== 'labelled') return false;
    if (mode === 'partial'  && v._state !== 'partial')  return false;
    if (mode === 'none'     && v._state !== 'none')     return false;
    if (!q) return true;
    const hay = (v.videoId + ' ' + v.url + ' ' + sources.map(
      s => s.fields.map(f => (v.labels[s.tab] || {})[f] || '').join(' ')).join(' ')).toLowerCase();
    return hay.indexOf(q) !== -1;
  });

  rows.sort((a, b) => b._filled - a._filled || a.videoId.localeCompare(b.videoId));

  const el = document.getElementById('valiaContent');

  if (!rows.length){
    el.innerHTML = all.length === 0
      ? '<div class="vempty"><h3>No videos in the VALIA sheet</h3><p>The <code>video_url</code> columns are empty. Run the Google Ads sync script, then reload.</p></div>'
      : '<div class="vempty"><h3>Nothing matches</h3><p>' + all.length + ' video(s) loaded, but none match the current filter or search.</p></div>';
    return;
  }

  el.innerHTML = '<div class="valia-grid">' + rows.map(v => {
    // videoId comes straight from the VALIA sheet and used to be interpolated
    // UNESCAPED into src="…" and into the onerror="…" handler below, while the
    // same function escaped it everywhere else (data-vid, .vcard-id) — so this
    // was an oversight, not a decision. A single apostrophe in a sheet cell
    // broke out of the attribute and executed.
    //
    // A YouTube ID has exactly one shape. Validating against it is both the
    // fix and a data check: anything else is not a video we can render.
    const id = vYtId(v.videoId);
    if (!id) return '';
    const thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    const cls = v._state === 'labelled' ? 'full' : (v._state === 'partial' ? 'part' : 'zero');

    const secs = sources.map((s, i) => {
      const vals = v.labels[s.tab] || {};
      const filled = s.fields.filter(f => vals[f]).length;
      return '' +
        '<section class="vsec c' + (i % 6) + (filled === 0 ? ' is-empty' : '') + '">' +
          '<div class="vsec-h">' +
            '<div class="vsec-name">' + vEsc(s.tab) + '</div>' +
            '<div class="vsec-badge">' + (filled === 0 ? 'awaiting labels' : filled + '/' + s.fields.length) + '</div>' +
          '</div>' +
          '<dl class="vfacts">' +
            s.fields.map(f =>
              '<div class="vfact">' +
                '<dt>' + vEsc(f) + '</dt>' +
                '<dd class="' + (vals[f] ? '' : 'none') + '">' + vEsc(vals[f] || 'not labelled yet') + '</dd>' +
              '</div>').join('') +
          '</dl>' +
        '</section>';
    }).join('');

    return '' +
      '<article class="vcard" data-vid="' + vEsc(id) + '" tabindex="0" role="button" ' +
              'aria-label="Open labels for ' + vEsc(id) + '">' +
        '<div class="vcard-thumb">' +
          '<img src="' + thumb + '" alt="" loading="lazy" ' +
               'onerror="this.src=\'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg\'">' +
          '<span class="vcard-play"><svg viewBox="0 0 68 48"><path fill="#f00" d="M66.5 7.7a8.6 8.6 0 0 0-6-6C55.2 0 34 0 34 0S12.8 0 7.5 1.7a8.6 8.6 0 0 0-6 6A89.5 89.5 0 0 0 0 24a89.5 89.5 0 0 0 1.5 16.3 8.6 8.6 0 0 0 6 6C12.8 48 34 48 34 48s21.2 0 26.5-1.7a8.6 8.6 0 0 0 6-6A89.5 89.5 0 0 0 68 24a89.5 89.5 0 0 0-1.5-16.3z"/><path fill="#fff" d="M27 34l18-10-18-10z"/></svg></span>' +
          '<span class="vcard-id">' + vEsc(id) + '</span>' +
          '<span class="vcard-prog ' + cls + '">' + v._filled + '/' + v._total + '</span>' +
        '</div>' +
        '<div class="vcard-url">' + vEsc(v.url) + '</div>' +
        '<div class="vcard-body">' + secs + '</div>' +
      '</article>';
  }).join('') + '</div>';
}

/* ---- popup ---- */
function valiaOpenModal(videoId){
  if (!VALIA_DATA) return;
  const v = (VALIA_DATA.videos || []).find(x => x.videoId === videoId);
  if (!v) return;

  const sources = VALIA_DATA.sources || [];
  const total = sources.reduce((n, s) => n + s.fields.length, 0);
  const filled = sources.reduce(
    (n, s) => n + s.fields.filter(f => v.labels[s.tab] && v.labels[s.tab][f]).length, 0);

  // Same reasoning as valiaRender(): v.videoId is sheet data going into a src
  // attribute, so validate it to the one shape a YouTube ID can have rather
  // than trusting it.
  const safeId = vYtId(v.videoId);
  if (!safeId) return;

  document.getElementById('valiaPlayer').innerHTML =
    '<iframe src="https://www.youtube-nocookie.com/embed/' + safeId +
    '?rel=0&modestbranding=1" title="YouTube video ' + vEsc(safeId) + '" ' +
    'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
    'allowfullscreen></iframe>';

  const urlEl = document.getElementById('valiaModalUrl');
  urlEl.textContent = v.url;
  // href takes a URL from the sheet. javascript: would execute on click, so
  // only http(s) is allowed through.
  urlEl.href = /^https?:\/\//i.test(String(v.url || '')) ? v.url : '#';
  document.getElementById('valiaModalYt').onclick = () => window.open(v.url, '_blank', 'noopener');

  document.getElementById('valiaModalInfo').innerHTML =
    '<div class="vmodal-hd">' +
      '<div>' +
        '<div class="vmodal-t">AI labels</div>' +
        '<div class="vmodal-sub">' + vEsc(v.videoId) + ' · ' + filled + ' of ' + total + ' fields labelled</div>' +
      '</div>' +
      '<button class="vmodal-close" id="valiaModalClose" aria-label="Close">✕</button>' +
    '</div>' +
    sources.map((s, i) => {
      const vals = v.labels[s.tab] || {};
      const n = s.fields.filter(f => vals[f]).length;
      return '<section class="vmsec c' + (i % 4) + '">' +
        '<div class="vmsec-h">' +
          '<div class="vmsec-name">' + vEsc(s.tab) + '</div>' +
          '<div class="vsec-badge">' + (n === 0 ? 'awaiting labels' : n + '/' + s.fields.length) + '</div>' +
        '</div>' +
        '<dl class="vmfacts">' +
          s.fields.map(f =>
            '<div class="vmfact">' +
              '<dt>' + vEsc(f) + '</dt>' +
              '<dd class="' + (vals[f] ? '' : 'none') + '">' + vEsc(vals[f] || 'not labelled yet') + '</dd>' +
            '</div>').join('') +
        '</dl>' +
      '</section>';
    }).join('');

  document.getElementById('valiaModalClose').addEventListener('click', valiaCloseModal);
  document.getElementById('valiaModalBackdrop').classList.add('open');
}

function valiaCloseModal(){
  document.getElementById('valiaModalBackdrop').classList.remove('open');
  // Unmount the iframe so audio stops when the popup closes.
  document.getElementById('valiaPlayer').innerHTML = '';
}

/* ---- wiring ---- */
(function valiaInit(){
  document.querySelector('[data-page="valia"]')
      .addEventListener('click', () => {
        valiaSetPage(true);
        document.getElementById('sidebar').classList.remove('open');
      });

  // Additive: the existing [data-fmt] handler still runs; this just returns
  // the shell to the assets page.
  document.querySelectorAll('[data-fmt]').forEach(b =>
      b.addEventListener('click', () => valiaSetPage(false)));

  document.getElementById('valiaContent').addEventListener('click', e => {
    const card = e.target.closest('.vcard');
    if (card) valiaOpenModal(card.dataset.vid);
  });
  document.getElementById('valiaContent').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.vcard');
    if (card){ e.preventDefault(); valiaOpenModal(card.dataset.vid); }
  });
  document.getElementById('valiaModalBackdrop').addEventListener('click', e => {
    if (e.target.id === 'valiaModalBackdrop') valiaCloseModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') valiaCloseModal();
  });

  document.getElementById('valiaRefresh').addEventListener('click', valiaRefresh);
  document.getElementById('valiaSearch').addEventListener('input', valiaRender);
  document.getElementById('valiaFilter').addEventListener('change', valiaRender);

  if (VALIA_DATA){
    const n = document.getElementById('nav-count-valia');
    if (n) n.textContent = (VALIA_DATA.videos || []).length;
  }
})();
