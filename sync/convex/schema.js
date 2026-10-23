import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// What a device may sync. Each group is enforced here on the server; a device without `secrets` is also never given
// the key that opens them. `history` is modelled but not offered yet. `dictionary` names the one list it syncs.
export const grants = v.object({ secrets: v.boolean(), settings: v.boolean(), history: v.boolean(), dictionary: v.union(v.string(), v.null()) });

export default defineSchema({
  // `name` is set only on the legacy shared-key dictionary; account dictionaries use `userId` and `list`.
  dictionaries: defineTable({ name: v.optional(v.string()), userId: v.optional(v.id('users')), list: v.optional(v.string()), terms: v.array(v.string()) })
    .index('by_name', ['name']).index('by_user', ['userId', 'list']),
  // `email` is only a username; nothing is ever sent to it. `authHash` is the SHA-256 of a key derived from the
  // passphrase on the device, and `keyring` holds the group keys sealed with another key derived from it.
  users: defineTable({ email: v.string(), authHash: v.string(), keyring: v.string(), createdAt: v.number() }).index('by_email', ['email']),
  signInFailures: defineTable({ email: v.string(), at: v.number() }).index('by_email', ['email']),
  // `admin` devices signed in with the passphrase and can manage the others. `hasKeys` records whether the device
  // was ever given the API-key key, since a grant cannot be added later without pairing again.
  devices: defineTable({ userId: v.id('users'), tokenHash: v.string(), name: v.string(), admin: v.boolean(), hasKeys: v.boolean(), grants, createdAt: v.number(), lastSeen: v.number() })
    .index('by_token', ['tokenHash']).index('by_user', ['userId']),
  // A pairing code waiting to be typed on a new device. `pairId` is derived from the code on both devices, and
  // `payload` is sealed with a key derived from it, so the server can read neither the code nor the keys.
  pairings: defineTable({ userId: v.id('users'), pairId: v.string(), name: v.string(), grants, payload: v.string(), expiresAt: v.number() })
    .index('by_pair_id', ['pairId']).index('by_user', ['userId']),
  // Named values shared by an account's devices. `secrets.*` values are sealed on the device; the server never sees a key.
  syncItems: defineTable({ userId: v.id('users'), name: v.string(), value: v.string(), deleted: v.boolean(), updatedAt: v.number() })
    .index('by_user', ['userId'])
});
