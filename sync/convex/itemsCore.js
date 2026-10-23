// Account items are small named values that devices keep in step. The prefix is the group a device must be granted:
// shared settings in the clear (`settings.*`), API keys sealed on the device (`secrets.*`), and `history.*` reserved
// for later. Any name in a group syncs, so a new key or setting needs no server change (see docs/dictionary-sync.md).
export const MAX_ITEMS = 200;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const NAME_PATTERN = /^(settings|secrets|history)\.[a-z][A-Za-z0-9]{0,39}$/;
const VALUE_LIMITS = { settings: 512, secrets: 4096, history: 4096 };

export function validateItem(item) {
  if (!item || typeof item.name !== 'string' || !NAME_PATTERN.test(item.name)) return 'Invalid item name';
  if (typeof item.value !== 'string' || typeof item.deleted !== 'boolean' || !Number.isFinite(item.updatedAt) || item.updatedAt < 0) return 'Invalid item';
  if (item.value.length > VALUE_LIMITS[item.name.split('.')[0]]) return 'Item is too large';
  if (item.deleted && item.value !== '') return 'Deleted items carry no value';
  return null;
}
