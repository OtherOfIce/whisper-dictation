// Sync settings: turn on, link devices with a code, remove them, and show the recovery key.
let removeArmed = null, signOutArmed = false, linkTimer = null, lastSynced = 0;

function syncMessage(sync) {
  const items = sync?.items?.message, dictionary = sync?.dictionary?.message;
  return sync?.account?.message || (items && items !== 'Synced' ? items : '') || dictionary || items || '';
}
function renderSync(sync = app.sync) {
  const wasOn = !!app.sync?.account?.signedIn;
  app.sync = sync;
  const account = sync?.account || {};
  const on = !!account.signedIn;
  $('sync-off').hidden = on; $('sync-on').hidden = !on;
  const message = syncMessage(sync);
  if (on && (!message || message === 'Synced')) lastSynced = Date.now();
  $('sync-status').textContent = message && message !== 'Synced' ? message : on ? `Last synced ${lastSynced && Date.now() - lastSynced > 60000 ? new Date(lastSynced).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'just now'}` : '';
  $('sync-state-title').textContent = on ? `Sync on · ${account.name || 'this device'}` : 'Sync is off';
  $('link-device').disabled = !account.canManage;
  $('link-hint').textContent = account.canManage ? 'Add your phone or another computer. It gets your keys, voice settings and dictionary.' : 'Linking from this device needs the updated sync server. Use the device that turned sync on.';
  const legacy = account.kind === 'legacy';
  $('recovery-show').hidden = legacy || !account.hasRecoveryKey;
  $('recovery-note').textContent = legacy
    ? `This account uses ${account.username || 'an email'} and a passphrase. Keep the passphrase safe: it is how you get back in if you lose every device.`
    : account.hasRecoveryKey ? 'If you lose every device, the recovery key brings your synced keys and dictionary back.'
      : 'The recovery key was shown on the device that turned sync on.';
  if (!on) $('device-list').replaceChildren();
  else if (!wasOn) loadDevices();
}
function timeAgo(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 15) return 'Active now';
  if (minutes < 120) return `Seen ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Seen ${hours} hours ago` : `Seen ${Math.round(hours / 24)} days ago`;
}
function renderDevices({ devices = [] }) {
  $('device-list').replaceChildren(...devices.map(device => {
    const row = el('li'); const text = el('div');
    const name = el('strong', '', device.name); if (device.current) name.append(el('span', 'this-device', 'This device'));
    const details = [device.current ? '' : timeAgo(device.lastSeen), device.hasKeys === false || device.grants?.secrets === false ? 'Does not receive API keys' : '', device.grants?.dictionary === null ? 'No dictionary' : ''].filter(Boolean);
    text.append(name, el('div', 'small', details.join(' · ') || 'Keys, settings and dictionary'));
    row.append(text);
    if (!device.current) {
      const remove = el('button', 'text-button', removeArmed === device.id ? 'Click again to remove' : 'Remove'); remove.type = 'button';
      remove.onclick = () => removeDevice(device, remove); row.append(remove);
    }
    return row;
  }));
}
async function loadDevices() {
  if (!app.sync?.account?.signedIn || !app.sync.account.canManage) return;
  try { renderDevices(await call('accountDevices')); } catch (error) { fail(error); }
}
async function removeDevice(device, button) {
  if (removeArmed !== device.id) {
    removeArmed = device.id; button.textContent = 'Click again to remove';
    setTimeout(() => { if (removeArmed === device.id) { removeArmed = null; button.textContent = 'Remove'; } }, 6000); return;
  }
  removeArmed = null; button.disabled = true;
  try { renderDevices(await call('accountRemoveDevice', { id: device.id })); toast(`${device.name} removed. It keeps the keys it already had, so consider replacing them if the device is lost.`, { duration: 9000 }); }
  catch (error) { fail(error); button.disabled = false; }
}
async function syncAction(button, work, busyText) {
  const label = button.textContent; button.disabled = true; if (busyText) button.textContent = busyText;
  try { return await work(); } catch (error) { fail(error); return null; } finally { button.disabled = false; button.textContent = label; renderSync(); }
}
function showRecoveryKey(key, intro) {
  $('recovery-key').textContent = key; $('recovery-key').hidden = false; $('recovery-show').textContent = 'Hide';
  if (intro) toast(intro, { duration: 10000 });
}
function hideRecoveryKey() { $('recovery-key').hidden = true; $('recovery-key').textContent = ''; $('recovery-show').textContent = 'Show'; }

$('sync-turn-on').onclick = () => syncAction($('sync-turn-on'), async () => {
  const { sync, recoveryKey } = await call('syncTurnOn');
  renderSync(sync); showRecoveryKey(recoveryKey, 'Sync is on. Save your recovery key somewhere safe, such as a password manager.');
}, 'Turning on…');
$('sync-link').onclick = () => syncAction($('sync-link'), async () => {
  renderSync(await call('accountPair', { code: $('sync-code').value })); $('sync-code').value = ''; toast('Linked. Your keys, settings and dictionary are syncing.');
}, 'Linking…');
$('sync-code').onkeydown = event => { if (event.key === 'Enter') $('sync-link').click(); };
$('sync-recover').onclick = () => syncAction($('sync-recover'), async () => {
  renderSync(await call('syncRecover', { recoveryKey: $('sync-recovery').value })); $('sync-recovery').value = ''; toast('Recovered. This device is syncing again.');
}, 'Checking…');
$('legacy-sign-in').onclick = () => syncAction($('legacy-sign-in'), async () => {
  try { renderSync(await call('accountSignIn', { username: $('legacy-username').value, passphrase: $('legacy-passphrase').value })); }
  finally { $('legacy-passphrase').value = ''; }
}, 'Checking…');
$('sync-now').onclick = () => syncAction($('sync-now'), async () => renderSync(await call('syncDictionary')), 'Syncing…');
$('link-device').onclick = () => syncAction($('link-device'), async () => {
  const { code, expiresAt } = await call('accountLinkDevice', {});
  $('link-code').textContent = code; $('link-panel').hidden = false; $('link-device').closest('.row').hidden = true;
  clearInterval(linkTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    $('link-expiry').textContent = left ? `Single-use code · expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'This code has expired. Make a new one.';
    if (!left) clearInterval(linkTimer);
  };
  tick(); linkTimer = setInterval(tick, 1000);
});
$('link-done').onclick = () => { clearInterval(linkTimer); $('link-panel').hidden = true; $('link-device').closest('.row').hidden = false; $('link-code').textContent = ''; loadDevices(); };
$('recovery-show').onclick = async () => {
  if (!$('recovery-key').hidden) { hideRecoveryKey(); return; }
  try { const key = await call('accountRecoveryKey'); if (key) showRecoveryKey(key); else toast('This device does not have the recovery key.'); } catch (error) { fail(error); }
};
$('sync-sign-out').onclick = () => {
  if (!signOutArmed) { signOutArmed = true; $('sync-sign-out').textContent = 'Click again to turn off'; setTimeout(() => { signOutArmed = false; $('sync-sign-out').textContent = 'Turn off'; }, 6000); return; }
  signOutArmed = false; $('sync-sign-out').textContent = 'Turn off';
  syncAction($('sync-sign-out'), async () => { renderSync(await call('accountSignOut')); hideRecoveryKey(); toast('Sync is off on this device.'); });
};
