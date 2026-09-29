import { internalMutationGeneric as internalMutation } from 'convex/server';
import { v } from 'convex/values';
import { merge } from './terms.js';

export const sync = internalMutation({
  args: { add: v.array(v.string()), remove: v.array(v.string()) },
  handler: async (ctx, { add, remove }) => {
    const existing = await ctx.db.query('dictionaries').withIndex('by_name', q => q.eq('name', 'personal')).unique();
    const terms = merge(existing?.terms ?? [], add, remove);
    if (!existing) await ctx.db.insert('dictionaries', { name: 'personal', terms });
    else if (JSON.stringify(terms) !== JSON.stringify(existing.terms)) await ctx.db.patch(existing._id, { terms });
    return { terms };
  }
});
