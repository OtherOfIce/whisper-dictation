// Shared by the mutations: finds the device behind a token and keeps its last-seen time roughly current.
const SEEN_INTERVAL = 10 * 60 * 1000;

export async function deviceFor(ctx, tokenHash) {
  const device = await ctx.db.query('devices').withIndex('by_token', q => q.eq('tokenHash', tokenHash)).unique();
  if (!device) return null;
  const now = Date.now();
  if (now - device.lastSeen > SEEN_INTERVAL) await ctx.db.patch(device._id, { lastSeen: now });
  return device;
}

export const allows = (device, name) => {
  const group = name.split('.')[0];
  return group === 'secrets' ? device.grants.secrets && device.hasKeys : Boolean(device.grants[group]);
};
