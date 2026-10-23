import { internalMutationGeneric as internalMutation } from 'convex/server';
import { v } from 'convex/values';
import { merge } from './terms.js';
import { deviceFor } from './deviceCore.js';

async function mergeInto(ctx, existing, fields, add, remove) {
  const terms = merge(existing?.terms ?? [], add, remove);
  if (!existing) await ctx.db.insert('dictionaries', { ...fields, terms });
  else if (JSON.stringify(terms) !== JSON.stringify(existing.terms)) await ctx.db.patch(existing._id, { terms });
  return { terms };
}

// Legacy shared-key dictionary.
export const sync = internalMutation({
  args: { add: v.array(v.string()), remove: v.array(v.string()) },
  handler: async (ctx, { add, remove }) => {
    const existing = await ctx.db.query('dictionaries').withIndex('by_name', q => q.eq('name', 'personal')).unique();
    return mergeInto(ctx, existing, { name: 'personal' }, add, remove);
  }
});

// The one dictionary list this device syncs. Returns null when the device token is unknown or has been signed out,
// and { off: true } when the device has no list.
export const syncForDevice = internalMutation({
  args: { tokenHash: v.string(), add: v.array(v.string()), remove: v.array(v.string()) },
  handler: async (ctx, { tokenHash, add, remove }) => {
    const device = await deviceFor(ctx, tokenHash);
    if (!device) return null;
    const list = device.grants.dictionary;
    if (!list) return { off: true };
    const existing = await ctx.db.query('dictionaries').withIndex('by_user', q => q.eq('userId', device.userId).eq('list', list)).unique();
    return { ...(await mergeInto(ctx, existing, { userId: device.userId, list }, add, remove)), list };
  }
});
