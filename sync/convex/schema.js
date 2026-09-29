import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  dictionaries: defineTable({ name: v.string(), terms: v.array(v.string()) }).index('by_name', ['name'])
});
