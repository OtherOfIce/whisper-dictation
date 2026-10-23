import { internalMutationGeneric as internalMutation } from 'convex/server';
import { v } from 'convex/values';
import { MAX_CLOCK_SKEW_MS, MAX_ITEMS, validateItem } from './itemsCore.js';
import { allows, deviceFor } from './deviceCore.js';

const itemShape = v.object({ name: v.string(), value: v.string(), deleted: v.boolean(), updatedAt: v.number() });
const publicItem = ({ name, value, deleted, updatedAt }) => ({ name, value, deleted, updatedAt });

// Applies the newer side of each item and answers with everything this device may see. Items in a group the device
// was not granted are refused and never returned. Returns null when the device token is unknown or signed out.
export const syncItems = internalMutation({
  args: { tokenHash: v.string(), items: v.array(itemShape) },
  handler: async (ctx, { tokenHash, items }) => {
    const device = await deviceFor(ctx, tokenHash);
    if (!device) return null;
    const now = Date.now();
    const stored = new Map((await ctx.db.query('syncItems').withIndex('by_user', q => q.eq('userId', device.userId)).collect()).map(row => [row.name, row]));
    const rejected = [];
    for (const item of items) {
      const problem = validateItem(item);
      if (problem) throw new Error(problem);
      if (!allows(device, item.name)) { rejected.push(item.name); continue; }
      const updatedAt = Math.min(Math.floor(item.updatedAt), now + MAX_CLOCK_SKEW_MS);
      const existing = stored.get(item.name);
      if (existing && existing.updatedAt >= updatedAt) continue;
      const fields = { value: item.value, deleted: item.deleted, updatedAt };
      if (existing) { await ctx.db.patch(existing._id, fields); stored.set(item.name, { ...existing, ...fields }); }
      else {
        if (stored.size >= MAX_ITEMS) throw new Error('Too many items');
        const row = { userId: device.userId, name: item.name, ...fields };
        stored.set(item.name, { ...row, _id: await ctx.db.insert('syncItems', row) });
      }
    }
    const visible = [...stored.values()].filter(row => allows(device, row.name)).map(publicItem);
    return { items: visible, rejected, serverTime: now, grants: device.grants, admin: device.admin };
  }
});
