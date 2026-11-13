// Minimal in-memory stand-in for the parts of ctx.db the mutations use.
export function fakeDb() {
  const tables = {}; let next = 0;
  const rows = name => tables[name] ??= new Map();
  const match = (name, filters) => [...rows(name).values()].filter(row => filters.every(([field, value, test]) => test(row[field], value)));
  const find = id => [...Object.values(tables)].map(table => table.get(id)).find(Boolean) ?? null;
  return {
    tables,
    ctx: { db: {
      get: async id => find(id),
      query: name => ({ withIndex: (_, build) => {
        const filters = []; const add = test => (field, value) => (filters.push([field, value, test]), range);
        const range = { eq: add((a, b) => a === b), lt: add((a, b) => a < b), lte: add((a, b) => a <= b), gt: add((a, b) => a > b), gte: add((a, b) => a >= b) };
        build?.(range);
        return { collect: async () => match(name, filters), unique: async () => match(name, filters)[0] ?? null, take: async count => match(name, filters).slice(0, count) };
      } }),
      insert: async (name, doc) => { const _id = `${name}:${++next}`; rows(name).set(_id, { ...doc, _id }); return _id; },
      patch: async (id, fields) => { Object.assign(find(id), fields); },
      delete: async id => { for (const table of Object.values(tables)) table.delete(id); }
    } }
  };
}
