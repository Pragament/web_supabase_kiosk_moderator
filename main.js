import {createClient} from '@supabase/supabase-js';
import {classControl} from './class-control.js';
import {cachedRows, institutionDate, openCache, purge, readMetadata, supabaseSource, synchronize} from './sync.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const env = import.meta.env;
const project = env.VITE_SUPABASE_URL?.replace(/\/$/, '');
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const retention = Math.max(1, Math.min(365, Number.parseInt(env.VITE_CACHE_RETENTION_DAYS, 10) || 30));
const storageKey = `kiosk-teacher-session:${project}`;
const db = openCache();
const summary = 'daily_summary';
const detailStreams = ['usage_logs', 'pc_activity_logs'];
const pageSize = 100;
const timeFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
});
const online = () => navigator.onLine;
const client = project?.startsWith('https://') && key?.startsWith('sb_publishable_')
  ? createClient(project, key, {
    auth: {storage: sessionStorage, storageKey, detectSessionInUrl: false},
  }) : null;

let session;
let allowed = [];
let expiry = 0;
let details = false;
let today = institutionDate();
let work;
let controller;
let page = 0;
let view = {data: [], totals: []};
let report = {headings: [], rows: []};
const tell = (text) => { $('message').textContent = text; };
const owner = () => [project, session.user.id];
const names = () => details ? [summary, ...detailStreams] : [summary];
const isVerified = () => !!session && Date.now() < expiry;
const classes = () => $('class-filter').value ? [$('class-filter').value] : allowed;
const controlPanel = client ? classControl(client, isVerified, async () => {
  await run((signal) => loadView(signal, true));
}) : null;

function selectOptions(select, entries, first) {
  const current = select.value;
  select.replaceChildren(new Option(first, ''), ...entries.map((value) => new Option(value, value)));
  if (entries.includes(current)) select.value = current;
}

function buttons() {
  $('sync').disabled = !!work || !online() || !allowed.length;
  $('details').disabled = !!work || details || !online() || !allowed.length;
  $('date').disabled = !!work;
  $('class-filter').disabled = !!work;
  $('connectivity').textContent = online() ? 'Online' : 'Offline';
}

function clearView() {
  view = {data: [], totals: []};
  report = {headings: [], rows: []};
  for (const id of ['rows', 'thead', 'chart', 'metrics']) $(id).replaceChildren();
  $('search').value = '';
  $('app-filter').replaceChildren();
}

$('forgot-password').addEventListener('click', async () => {
  if (!client) return;
  const email = $('login-form').elements.email;
  if (!email.reportValidity()) return;
  const redirectTo = new URL(location.pathname, location.origin).href;
  const {error} = await client.auth.resetPasswordForEmail(email.value, {redirectTo});
  tell(error ? error.message : 'If the account exists, a password reset email will arrive shortly.');
});

const recovery = new URLSearchParams(location.hash.slice(1));
const recovering = recovery.get('type') === 'recovery';
if (client && recovering) {
  history.replaceState(null, '', location.pathname + location.search);
  const access_token = recovery.get('access_token');
  const refresh_token = recovery.get('refresh_token');
  if (access_token && refresh_token) {
    client.auth.setSession({access_token, refresh_token}).then(({error}) => {
      if (error) return tell('This password reset link is unavailable.');
      $('login-form').hidden = true;
      $('reset-password').hidden = false;
    });
  } else tell('This password reset link is unavailable.');
}
$('reset-password').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const {error} = await client.auth.updateUser({password: new FormData(form).get('password')});
  form.reset();
  if (error) return tell(error.message);
  await client.auth.signOut({scope: 'local'});
  sessionStorage.removeItem(storageKey);
  form.hidden = true;
  $('login-form').hidden = false;
  tell('Password updated. Sign in with your new password.');
});

async function verifyAccess(signal) {
  const {data: {session: current}, error: sessionError} = await client.auth.getSession();
  if (sessionError || !current || (session && session.user.id !== current.user.id)) {
    expiry = 0;
    throw new Error('Sign in to view activity.');
  }
  const {data: {user}, error: userError} = await client.auth.getUser(current.access_token);
  signal.throwIfAborted();
  if (userError || !user || user.id !== current.user.id) {
    if (userError?.status === 401 || userError?.status === 403 || !userError) expiry = 0;
    throw new Error('Could not validate your teacher session.');
  }
  // The RPC returns only this teacher’s class codes in one response.
  const {data, error} = await client.rpc('kiosk_teacher_access').abortSignal(signal);
  signal.throwIfAborted();
  if (error) {
    if (error.code === '42501') expiry = 0;
    throw new Error('Could not verify your class assignments.');
  }
  if (!data) {
    expiry = 0;
    await purge(db, [project, user.id]);
    throw new Error('This account has no teacher profile.');
  }
  session = current;
  const nextClasses = data.classes;
  const cutoff = new Date(Date.now() - retention * 86400000).toISOString();
  await purge(db, owner(), (row) => nextClasses.includes(row.class_code), cutoff);
  allowed = nextClasses;
  selectOptions($('class-filter'), allowed, 'All assigned classes');
  expiry = Math.min(current.expires_at * 1000, Date.now() + 15 * 60 * 1000);
}

function run(task) {
  if (work) return work;
  controller = new AbortController();
  const {signal} = controller;
  const job = Promise.resolve().then(() => task(signal));
  work = job;
  buttons();
  return job.catch((error) => {
    if (signal.aborted) return;
    if (!isVerified()) {
      $('dashboard').hidden = true;
      $('login-panel').hidden = false;
      clearView();
    }
    tell(error.message || 'The activity request failed.');
  }).finally(() => {
    work = null;
    buttons();
  });
}

async function refreshLocal(state) {
  if (!isVerified()) return;
  const date = $('date').value;
  const streamNames = names();
  const options = [owner(), classes(), date];
  const [totals, usage, activity, meta] = await Promise.all([
    cachedRows(db, summary, ...options),
    details ? cachedRows(db, detailStreams[0], ...options) : [],
    details ? cachedRows(db, detailStreams[1], ...options) : [],
    readMetadata(db, ...options, streamNames),
  ]);
  if (!isVerified() || controller?.signal.aborted) return;
  const studentNames = new Map([...totals, ...usage].filter((row) => row.student_id && row.student_name)
    .map((row) => [JSON.stringify([row.class_code, row.student_id]), row.student_name]));
  view = {totals, data: details ? [
    ...usage.map((row) => ({...row, action: 'OPENED'})),
    ...activity.map((row) => ({
      ...row, student_name: studentNames.get(JSON.stringify([row.class_code, row.student_id])),
    })),
  ] : totals};
  selectOptions($('app-filter'), [...new Set([...view.data, ...totals].map((row) => row.app_name))].sort(), 'All applications');
  const last = meta.filter(Boolean).map((row) => row.syncedAt).sort()[0];
  const status = last && meta.every(Boolean)
    ? `${state} · Last successful sync ${timeFormat.format(new Date(last))}`
    : last ? `Partial cache · Last successful sync ${timeFormat.format(new Date(last))}`
      : allowed.length ? 'No cached data for this view' : 'No assigned classes';
  $('cache-status').textContent = status;
  render();
}

async function loadView(signal, initialOnly, previouslyVerified = false) {
  if (!previouslyVerified && online()) await verifyAccess(signal);
  if (!isVerified()) throw new Error('Sign in online to validate your access.');
  $('login-panel').hidden = true;
  $('dashboard').hidden = false;
  await refreshLocal('Cached data');
  if (!online() || !classes().length) return;
  const date = $('date').value;
  const selectedClasses = classes();
  const streamNames = names();
  if (initialOnly && (await readMetadata(db, owner(), selectedClasses, date, streamNames)).every(Boolean)) return;
  const watermarkOwner = owner();
  const result = await synchronize({
    db, owner: watermarkOwner, classes: selectedClasses, date, names: streamNames, initialOnly,
    source: supabaseSource(client, signal),
    validate: () => { signal.throwIfAborted(); if (!isVerified()) throw new Error('Teacher access expired.'); },
  });
  signal.throwIfAborted();
  if (result) {
    await refreshLocal('Synchronized');
    const {added, updated, deleted} = result.counts;
    tell(`Synchronization complete. ${added} new, ${updated} updated, ${deleted} removed.`);
  }
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

const duration = (seconds) => seconds == null ? 'Unavailable' : `${seconds} s`;
const nameOf = (row) => row.student_name || row.student_id || 'Unidentified';
const number = (value) => Number(value) || 0;

function render(all = false) {
  if (!isVerified()) return;
  const search = $('search').value.trim().toLocaleLowerCase();
  const app = $('app-filter').value;
  const action = $('action-filter').value;
  const sort = $('sort').value;
  const matches = (row) => (!app || app === row.app_name)
    && (!search || [row.student_name, row.student_id].some((value) => value?.toLocaleLowerCase().includes(search)));
  const totals = view.totals.filter(matches);
  const source = view.data.filter((row) => matches(row) && (!action || (details ? row.action === action
    : number(action === 'OPENED' ? row.total_open_count : row.total_blocked_count) > 0)));
  const secondsOf = (row) => row.usage_duration_seconds ?? row.total_usage_seconds;
  const byTime = (a, b) => number(b.timestamp) - number(a.timestamp);
  source.sort((a, b) => sort === 'student_name' ? nameOf(a).localeCompare(nameOf(b)) || byTime(a, b)
    : sort === 'duration' ? (secondsOf(b) ?? -1) - (secondsOf(a) ?? -1) || byTime(a, b) : byTime(a, b));
  const measured = totals.filter((row) => row.total_usage_seconds != null);
  const total = (field) => totals.reduce((sum, row) => sum + number(row[field]), 0);
  const metrics = [
    ['Measured usage', measured.length ? duration(total('total_usage_seconds')) : 'Unavailable'],
    ['Student opens', total('total_open_count')], ['Student blocks', total('total_blocked_count')],
  ];
  $('metrics').replaceChildren(...metrics.map(([label, value]) => {
    const card = element('div', label);
    card.className = 'metric';
    card.append(element('strong', value));
    return card;
  }));
  const appTotals = new Map();
  const chartField = measured.length ? 'total_usage_seconds' : 'total_open_count';
  for (const row of totals) appTotals.set(row.app_name, (appTotals.get(row.app_name) || 0) + number(row[chartField]));
  const bars = [...appTotals].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  $('chart').replaceChildren(...bars.map(([label, value]) => {
    const bar = element('div', '');
    bar.className = 'bar';
    const meter = element('meter', '');
    meter.max = bars[0][1];
    meter.value = value;
    meter.setAttribute('aria-label', label);
    bar.append(element('span', label), meter, element('span', measured.length ? duration(value) : `${value} opens`));
    return bar;
  }));

  $('report-title').textContent = details ? 'Detailed activity' : 'Daily report';
  $('sort').options[0].disabled = !details;
  const headings = ['Student name', 'Student ID', 'Class', 'Application', 'Duration',
    ...(details ? ['Activity', 'PC', 'Time'] : ['Opened', 'Blocked'])];
  const rows = source.map((row) => [nameOf(row), row.student_id || '', row.class_code, row.app_name,
    duration(secondsOf(row)), ...(details ? [row.action, row.pc_name || '', timeFormat.format(new Date(row.timestamp))]
      : [row.total_open_count, row.total_blocked_count])]);
  report = {headings, rows};
  const header = element('tr', '');
  header.append(...headings.map((heading) => element('th', heading)));
  $('thead').replaceChildren(header);
  page = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  const start = page * pageSize;
  const fragment = document.createDocumentFragment();
  for (const row of all ? rows : rows.slice(start, start + pageSize)) {
    const tr = element('tr', '');
    tr.append(...row.map((cell) => element('td', cell)));
    fragment.append(tr);
  }
  $('rows').replaceChildren(fragment);
  $('empty').hidden = !!rows.length;
  $('previous').disabled = page === 0;
  $('next').disabled = start + pageSize >= rows.length;
  $('page-info').textContent = rows.length ? `${start + 1}–${Math.min(start + pageSize, rows.length)} of ${rows.length}` : '';
}

function changeDate() {
  details = $('date').value === today;
  page = 0;
  tell('');
  clearView();
  run((signal) => loadView(signal, true));
}

$('date').value = today;
$('date').max = today;
$('date').addEventListener('change', () => { if ($('date').validity.valid) changeDate(); });
$('class-filter').addEventListener('change', () => {
  page = 0;
  tell('');
  run(async (signal) => {
    if (!isVerified()) return;
    await refreshLocal('Cached data');
    if (online() && !(await readMetadata(db, owner(), classes(), $('date').value, names())).every(Boolean)) {
      await loadView(signal, true);
    }
  });
});
$('sync').addEventListener('click', () => {
  tell('Synchronizing activity…');
  run((signal) => loadView(signal, false));
});
$('details').addEventListener('click', () => {
  details = true;
  page = 0;
  tell('Loading detailed activity…');
  run((signal) => loadView(signal, true)).then(() => {
    if ($('message').textContent === 'Loading detailed activity…') tell('');
  });
});
for (const id of ['search', 'app-filter', 'action-filter', 'sort']) {
  $(id).addEventListener('input', () => { page = 0; render(); });
}
$('previous').addEventListener('click', () => { page--; render(); });
$('next').addEventListener('click', () => { page++; render(); });
$('print').addEventListener('click', () => { if (isVerified()) { render(true); window.print(); render(); } });
$('csv').addEventListener('click', () => {
  if (!isVerified()) return;
  const csvCell = (value) => {
    let text = String(value ?? '');
    if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const csv = [report.headings, ...report.rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  const download = element('a', '');
  download.href = url;
  download.download = `activity-${$('date').value}.csv`;
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!client || work) return;
  const form = new FormData(event.currentTarget);
  event.currentTarget.reset();
  tell('Signing in…');
  run(async (signal) => {
    const {error, data} = await client.auth.signInWithPassword({email: form.get('email'), password: form.get('password')});
    if (error) throw new Error(error.message);
    if (session && session.user.id !== data.user.id) {
      await purge(db, owner());
      session = undefined;
    }
    await verifyAccess(signal);
    details = $('date').value === today;
    tell('');
    await loadView(signal, true, true);
  });
});

$('logout').addEventListener('click', async () => {
  if (!session) return;
  const signedOutOwner = owner();
  controller?.abort();
  expiry = 0;
  $('dashboard').hidden = true;
  controlPanel?.reset();
  clearView();
  tell('Signing out…');
  try {
    await work?.catch(() => {});
    await purge(db, signedOutOwner);
  } catch {
    tell('Could not erase browser storage. Clear this site’s data on shared computers.');
  } finally {
    try { await client.auth.signOut({scope: 'local'}); } catch {
      // Local storage is cleared even if the network is unavailable.
    } finally {
      sessionStorage.removeItem(storageKey);
      session = undefined;
      allowed = [];
      $('login-panel').hidden = false;
      if ($('message').textContent === 'Signing out…') tell('');
    }
  }
});

window.addEventListener('offline', buttons);
window.addEventListener('online', () => {
  buttons();
  if (session) run(async (signal) => {
    await verifyAccess(signal);
    $('dashboard').hidden = false;
    $('login-panel').hidden = true;
    await refreshLocal('Cached data');
  });
});
function checkDateAndAccess() {
  if (session && !isVerified()) {
    $('dashboard').hidden = true;
    controlPanel?.reset();
    $('login-panel').hidden = false;
    clearView();
    tell('Verify your session online to view cached activity.');
  }
  const now = institutionDate();
  if (now !== today && !work) {
    const followingToday = $('date').value === today;
    today = now;
    $('date').max = today;
    if (followingToday) {
      $('date').value = today;
      if (isVerified()) changeDate();
    }
  }
}
document.addEventListener('visibilitychange', checkDateAndAccess);
setInterval(checkDateAndAccess, 15000);
buttons();
if (!client) {
  $('login-form').querySelector('button').disabled = true;
  tell('Configure the dashboard’s Supabase URL and publishable key.');
} else if (!recovering && online() && sessionStorage.getItem(storageKey)) {
  details = true;
  run((signal) => loadView(signal, true));
}
