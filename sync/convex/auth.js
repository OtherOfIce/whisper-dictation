import { internalMutationGeneric as internalMutation } from 'convex/server';
import { v } from 'convex/values';
import { grants } from './schema.js';
import { ALL_GRANTS, MAX_DEVICES, MAX_FAILURES_PER_HOUR, PAIRING_TTL_MS } from './authCore.js';
import { deviceFor } from './deviceCore.js';

const HOUR = 60 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 5;
const byEmail = (ctx, table, email) => ctx.db.query(table).withIndex('by_email', q => q.eq('email', email));
const devicesOf = (ctx, userId) => ctx.db.query('devices').withIndex('by_user', q => q.eq('userId', userId)).collect();

// Makes room for one more device by dropping the ones used least recently.
async function addDevice(ctx, userId, fields) {
  const devices = await devicesOf(ctx, userId);
  for (const stale of devices.sort((a, b) => a.lastSeen - b.lastSeen).slice(0, Math.max(0, devices.length - MAX_DEVICES + 1))) await ctx.db.delete(stale._id);
  const now = Date.now();
  await ctx.db.insert('devices', { userId, createdAt: now, lastSeen: now, ...fields });
}
// A new admin device keeps the dictionary list the account's admin devices already use.
async function adminGrants(ctx, userId) {
  const admin = (await devicesOf(ctx, userId)).filter(device => device.admin).sort((a, b) => b.lastSeen - a.lastSeen)[0];
  return admin ? { ...ALL_GRANTS, dictionary: admin.grants.dictionary } : ALL_GRANTS;
}
async function adminFor(ctx, tokenHash) {
  const device = await deviceFor(ctx, tokenHash);
  return device?.admin ? device : null;
}
const publicDevice = (device, current) => ({
  id: device._id, name: device.name, admin: device.admin, hasKeys: device.hasKeys, grants: device.grants,
  createdAt: device.createdAt, lastSeen: device.lastSeen, current: device._id === current
});

export const createAccount = internalMutation({
  args: { email: v.string(), authHash: v.string(), keyring: v.string(), tokenHash: v.string(), deviceName: v.string() },
  handler: async (ctx, { email, authHash, keyring, tokenHash, deviceName }) => {
    if (await byEmail(ctx, 'users', email).unique()) return { ok: false };
    const userId = await ctx.db.insert('users', { email, authHash, keyring, createdAt: Date.now() });
    await addDevice(ctx, userId, { tokenHash, name: deviceName, admin: true, hasKeys: true, grants: ALL_GRANTS });
    return { ok: true, grants: ALL_GRANTS };
  }
});

// Wrong passphrases are counted per username, so guessing online is limited to a few tries an hour.
export const signIn = internalMutation({
  args: { email: v.string(), authHash: v.string(), tokenHash: v.string(), deviceName: v.string() },
  handler: async (ctx, { email, authHash, tokenHash, deviceName }) => {
    const now = Date.now();
    const failures = await byEmail(ctx, 'signInFailures', email).collect();
    for (const old of failures) if (old.at < now - HOUR) await ctx.db.delete(old._id);
    if (failures.filter(failure => failure.at >= now - HOUR).length >= MAX_FAILURES_PER_HOUR) return { ok: false, limited: true };
    const user = await byEmail(ctx, 'users', email).unique();
    if (!user || user.authHash !== authHash) { await ctx.db.insert('signInFailures', { email, at: now }); return { ok: false }; }
    const deviceGrants = await adminGrants(ctx, user._id);
    await addDevice(ctx, user._id, { tokenHash, name: deviceName, admin: true, hasKeys: true, grants: deviceGrants });
    return { ok: true, keyring: user.keyring, grants: deviceGrants };
  }
});

export const signOut = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const device = await ctx.db.query('devices').withIndex('by_token', q => q.eq('tokenHash', tokenHash)).unique();
    if (device) await ctx.db.delete(device._id);
    return { ok: true };
  }
});

export const me = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const device = await deviceFor(ctx, tokenHash);
    if (!device) return null;
    const user = await ctx.db.get(device.userId);
    return { email: user.email, name: device.name, admin: device.admin, hasKeys: device.hasKeys, grants: device.grants };
  }
});

// The new passphrase re-wraps the same group keys, so paired devices keep working. Other admin devices are signed
// out, since they were signed in with the old passphrase.
export const changePassphrase = internalMutation({
  args: { tokenHash: v.string(), authHash: v.string(), keyring: v.string() },
  handler: async (ctx, { tokenHash, authHash, keyring }) => {
    const device = await adminFor(ctx, tokenHash);
    if (!device) return null;
    await ctx.db.patch(device.userId, { authHash, keyring });
    for (const other of await devicesOf(ctx, device.userId)) if (other.admin && other._id !== device._id) await ctx.db.delete(other._id);
    return { ok: true };
  }
});

export const listDevices = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const device = await adminFor(ctx, tokenHash);
    if (!device) return null;
    const devices = await devicesOf(ctx, device.userId);
    const dictionaries = await ctx.db.query('dictionaries').withIndex('by_user', q => q.eq('userId', device.userId)).collect();
    const lists = new Set(['Personal', ...dictionaries.map(row => row.list), ...devices.map(entry => entry.grants.dictionary)].filter(Boolean));
    return { devices: devices.sort((a, b) => a.createdAt - b.createdAt).map(entry => publicDevice(entry, device._id)), lists: [...lists].sort() };
  }
});

export const createPairing = internalMutation({
  args: { tokenHash: v.string(), pairId: v.string(), name: v.string(), grants, payload: v.string() },
  handler: async (ctx, { tokenHash, pairId, name, grants: pairGrants, payload }) => {
    const device = await adminFor(ctx, tokenHash);
    if (!device) return null;
    const now = Date.now();
    const pending = await ctx.db.query('pairings').withIndex('by_user', q => q.eq('userId', device.userId)).collect();
    for (const old of pending) if (old.expiresAt <= now) await ctx.db.delete(old._id);
    if (pending.filter(entry => entry.expiresAt > now).length >= MAX_PENDING_PAIRINGS) throw new Error('Too many pairing codes are waiting. Use one or wait 10 minutes.');
    const expiresAt = now + PAIRING_TTL_MS;
    await ctx.db.insert('pairings', { userId: device.userId, pairId, name, grants: pairGrants, payload, expiresAt });
    return { expiresAt };
  }
});

// One use only. The new device gets the name and grants chosen on the admin device.
export const claimPairing = internalMutation({
  args: { pairId: v.string(), tokenHash: v.string() },
  handler: async (ctx, { pairId, tokenHash }) => {
    const pairing = await ctx.db.query('pairings').withIndex('by_pair_id', q => q.eq('pairId', pairId)).unique();
    if (!pairing) return null;
    await ctx.db.delete(pairing._id);
    if (pairing.expiresAt <= Date.now()) return null;
    await addDevice(ctx, pairing.userId, { tokenHash, name: pairing.name, admin: false, hasKeys: pairing.grants.secrets, grants: pairing.grants });
    const user = await ctx.db.get(pairing.userId);
    return { email: user.email, name: pairing.name, grants: pairing.grants, payload: pairing.payload };
  }
});

export const updateDevice = internalMutation({
  args: { tokenHash: v.string(), deviceId: v.string(), name: v.optional(v.string()), grants },
  handler: async (ctx, { tokenHash, deviceId, name, grants: next }) => {
    const device = await adminFor(ctx, tokenHash);
    if (!device) return null;
    const target = (await devicesOf(ctx, device.userId)).find(entry => entry._id === deviceId);
    if (!target) throw new Error('That device is no longer on this account.');
    if (next.secrets && !target.hasKeys) throw new Error('This device was paired without API keys. Remove it and pair it again to add them.');
    await ctx.db.patch(target._id, { grants: next, ...(name ? { name } : {}) });
    return { ok: true };
  }
});

export const removeDevice = internalMutation({
  args: { tokenHash: v.string(), deviceId: v.string() },
  handler: async (ctx, { tokenHash, deviceId }) => {
    const device = await adminFor(ctx, tokenHash);
    if (!device) return null;
    if (deviceId === device._id) throw new Error('Use Sign out to remove this device.');
    const target = (await devicesOf(ctx, device.userId)).find(entry => entry._id === deviceId);
    if (target) await ctx.db.delete(target._id);
    return { ok: true };
  }
});
