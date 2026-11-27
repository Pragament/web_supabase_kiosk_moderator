const managedApps = [
  'notepad.exe', 'calc.exe', 'calculatorapp.exe', 'mspaint.exe',
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe',
  'winword.exe', 'excel.exe', 'powerpnt.exe', 'vlc.exe', 'code.exe',
  'teams.exe', 'zoom.exe', 'discord.exe', 'spotify.exe', 'blender.exe',
].sort();

export function classControl(client, authorized, onClassCreated) {
  const $ = (id) => document.getElementById(id);
  const panel = $('class-control');
  const tell = (message) => { $('class-message').textContent = message; };
  let sessions = [];
  let pending = false;
  let generation = 0;
  let rules = [];
  let devices = [];
  const allowed = () => authorized() && navigator.onLine && panel.open;
  const current = () => sessions.find(({id}) => id === $('managed-session').value);
  const reloadOptions = (select, options) => {
    const selected = select.value;
    select.replaceChildren(...options.map(([text, value]) => new Option(text, value)));
    if (options.some(([, value]) => value === selected)) select.value = selected;
  };
  async function rpc(name, values) {
    const {data, error} = await client.rpc(name, values);
    if (error) throw new Error(error.message);
    return data;
  }
  function controls() {
    const ready = allowed() && !pending;
    for (const id of ['create-class', 'app-rule', 'website-rule']) {
      for (const item of $(id).elements) item.disabled = !ready || (id !== 'create-class' && !current()?.active);
    }
    $('start-class').disabled = !ready || !$('managed-class').value;
    $('end-class').disabled = !ready || !current()?.active;
    $('copy-code').disabled = !ready || !current()?.active;
    $('app-mode').disabled = !ready || !current()?.active;
    $('save-app-mode').disabled = $('app-mode').disabled;
  }
  async function presence() {
    const version = generation;
    const selected = current();
    const rows = selected ? await rpc('kiosk_class_presence', {p_session: selected.id}) : [];
    if (version !== generation || !allowed() || current()?.id !== selected?.id) return;
    devices = rows;
    const computers = new Map(rows.map((row) => [row.device_id, row.pc_name]));
    reloadOptions($('website-target'), [['All computers', ''], ...[...computers].map(([id, name]) => [name, id])]);
    reloadOptions($('policy-target'), [['All computers', 'CLASS'], ...rows.filter((row) => row.online)
      .flatMap((row) => [[`Computer · ${row.pc_name}`, `DEVICE:${row.device_id}`],
        [`Student · ${row.student_name}`, `STUDENT:${row.student_session}`]])]);
    $('class-presence').replaceChildren(...rows.map((row) => {
      const tr = document.createElement('tr');
      const status = row.online && row.status !== 'FAILED' && row.applied_version !== selected.policy_version
        ? 'Pending' : row.status;
      for (const value of [row.student_name, row.roll_number, row.pc_name, row.online ? 'Online' : 'Offline',
        new Date(row.last_seen).toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata'}),
        `${status} · v${row.applied_version ?? '–'}`]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      return tr;
    }));
  }
  async function loadWebsiteRules(selected, version) {
    try {
      const rows = selected ? await rpc('kiosk_website_rules', {p_session: selected.id}) : [];
      if (version !== generation || !allowed() || current()?.id !== selected?.id) return;
      $('website-policy-status').textContent = rows.length ? '' : 'No website rules saved for this session.';
      $('website-rule-rows').replaceChildren(...rows.map((row) => {
        const tr = document.createElement('tr');
        const target = row.device_id ? devices.find((device) => device.device_id === row.device_id)?.pc_name
          ?? 'Selected computer' : 'All computers';
        for (const value of [row.domain, target, row.blocked ? 'Blocked' : 'Allowed']) {
          const cell = document.createElement('td');
          cell.textContent = value;
          tr.append(cell);
        }
        return tr;
      }));
    } catch {
      if (version !== generation || current()?.id !== selected?.id) return;
      $('website-rule-rows').replaceChildren();
      $('website-policy-status').textContent = 'Website rules are unavailable. Apply the website migration or try again.';
    }
  }
  function renderPolicy() {
    const selected = current();
    const [scope, target] = $('policy-target').value.split(':');
    const device = scope === 'STUDENT'
      ? devices.find((row) => row.student_session === target)?.device_id : target;
    $('app-policy-rows').replaceChildren();
    if (!selected) {
      $('app-policy-default').textContent = 'Start or select a class session to see its policy.';
      return;
    }
    const allowlist = selected.app_mode === 'ALLOWLIST';
    $('app-policy-default').textContent = allowlist
      ? 'Managed apps are blocked by default. Allow an app before students need it.'
      : 'Managed apps are allowed by default. Individual overrides may differ.';
    const effective = new Map();
    for (const tier of ['CLASS', 'DEVICE', 'STUDENT']) {
      for (const rule of rules) {
        if (rule.scope === tier && (tier === 'CLASS'
          || (tier === 'DEVICE' && rule.target_id === device)
          || (tier === 'STUDENT' && scope === tier && rule.target_id === target))) {
          effective.set(rule.process_name, rule);
        }
      }
    }
    for (const app of [...new Set([...managedApps, ...effective.keys()])].sort()) {
      const rule = effective.get(app);
      const unavailable = !managedApps.includes(app);
      const protectedApp = app === 'code.exe';
      const tr = document.createElement('tr');
      const status = unavailable ? 'Unsupported' : (!protectedApp && (rule?.blocked ?? allowlist)) ? 'Blocked' : 'Allowed';
      for (const value of [app, status, protectedApp ? 'Protected' : rule?.scope ?? 'Class default']) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      $('app-policy-rows').append(tr);
    }
  }
  async function loadSessions() {
    const version = generation;
    const code = $('managed-class').value;
    const next = code ? await rpc('kiosk_class_sessions', {p_class: code}) : [];
    if (version !== generation || !allowed() || $('managed-class').value !== code) return;
    sessions = next;
    reloadOptions($('managed-session'), sessions.map((row) =>
      [`${row.active ? 'Active' : 'Ended'} · ${new Date(row.started_at).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`, row.id]));
    $('class-code').textContent = current()?.active ? `Join code ${current().join_code} · Policy v${current().policy_version}` : '';
    if (current()?.app_mode) $('app-mode').value = current().app_mode;
    await presence();
    const selected = current();
    await loadWebsiteRules(selected, version);
    try {
      const nextRules = selected ? await rpc('kiosk_app_rules', {p_session: selected.id}) : [];
      if (version !== generation || !allowed() || current()?.id !== selected?.id) return;
      rules = nextRules;
      renderPolicy();
    } catch {
      if (version !== generation) return;
      $('app-policy-rows').replaceChildren();
      $('app-policy-default').textContent = 'Saved policy rules are unavailable. Apply the application policy migration or try again.';
    }
  }
  async function loadClasses() {
    const version = generation;
    const {data: {user}, error: authError} = await client.auth.getUser();
    if (authError || !user) throw new Error('Sign in again to manage classes.');
    const {data, error} = await client.from('kiosk_classes').select('class_code,class_name,subject')
      .eq('owner_id', user.id).order('class_name');
    if (error) throw new Error(error.message);
    if (version !== generation || !allowed()) return;
    reloadOptions($('managed-class'), data.map((row) => [row.class_name, row.class_code]));
    await loadSessions();
  }
  async function run(task) {
    if (!allowed() || pending) return;
    pending = true;
    controls();
    try { await task(); } catch (error) { tell(error.message); } finally { pending = false; controls(); }
  }
  function reset() {
    generation++;
    sessions = [];
    rules = [];
    devices = [];
    $('app-policy-rows').replaceChildren();
    for (const id of ['managed-class', 'managed-session', 'class-presence', 'policy-target',
      'website-target', 'website-rule-rows', 'website-policy-status']) $(id).replaceChildren();
    for (const id of ['class-code', 'class-message']) $(id).textContent = '';
    panel.open = false;
    controls();
  }
  panel.addEventListener('toggle', () => { controls(); if (panel.open) run(loadClasses); });
  $('managed-class').addEventListener('change', () => run(loadSessions));
  $('managed-session').addEventListener('change', () => run(loadSessions));
  $('policy-target').addEventListener('change', renderPolicy);
  $('create-class').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const formElement = event.currentTarget;
    run(async () => {
      await rpc('kiosk_create_class', {p_name: form.get('className'), p_subject: form.get('subject')});
      formElement.reset();
      await loadClasses();
      await onClassCreated();
      tell('Class created. An administrator can enroll computers for this class.');
    });
  });
  $('start-class').addEventListener('click', () => run(async () => {
    const id = await rpc('kiosk_start_class', {p_class: $('managed-class').value});
    await loadSessions();
    $('managed-session').value = id;
    await loadSessions();
    tell('Class started.');
  }));
  $('end-class').addEventListener('click', () => run(async () => {
    await rpc('kiosk_end_class', {p_session: current().id});
    await loadSessions();
    tell('Class ended. Online kiosks will remove the policy at their next check.');
  }));
  $('copy-code').addEventListener('click', () => run(async () => {
    await navigator.clipboard.writeText(current().join_code);
    tell('Join code copied.');
  }));
  $('save-app-mode').addEventListener('click', () => run(async () => {
    const version = await rpc('kiosk_set_app_mode', {p_session: current().id, p_mode: $('app-mode').value});
    await loadSessions();
    tell(`Policy mode saved as version ${version}.`);
  }));
  $('app-rule').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const app = form.get('process').trim().toLowerCase();
    if (!managedApps.includes(app) || app === 'code.exe') {
      tell('Enter a supported executable from the policy list. VS Code is protected.');
      return;
    }
    const [scope, target] = form.get('target').split(':');
    run(async () => {
      const version = await rpc('kiosk_set_app_rule', {p_session: current().id, p_scope: scope,
        p_target: target || null, p_process: app, p_blocked: form.get('action') === 'block'});
      await loadSessions();
      tell(`Policy v${version} saved. Device acknowledgements appear below.`);
    });
  });
  $('website-rule').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const domain = form.get('domain').trim().toLowerCase().replace(/\.$/, '');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      tell('Enter a domain such as example.org.');
      return;
    }
    run(async () => {
      const version = await rpc('kiosk_set_website_rule', {p_session: current().id,
        p_device: form.get('device') || null, p_domain: domain, p_blocked: form.get('action') === 'block'});
      await loadSessions();
      tell(`Website policy v${version} saved. Paired browsers fetch it automatically.`);
    });
  });
  window.addEventListener('online', () => { controls(); run(loadSessions); });
  window.addEventListener('offline', controls);
  setInterval(() => { if (allowed() && !document.hidden) run(loadSessions); }, 15000);
  return {reset};
}
