// Minimal in-memory stand-in for the parts of ctx.db the mutations use.
export function fakeDb() {
  const tables = {}; let next = 0;
  const rows = name => tables[name] ??= new Map();
  const match = (name, filters) => [...rows(name).values()].filter(row => filters.every(([field, value]) => row[field] === value));
  const find = id => [...Object.values(tables)].map(table => table.get(id)).find(Boolean) ?? null;
  return {
    tables,
    ctx: { db: {
      get: async id => find(id),
      query: name => ({ withIndex: (_, build) => {
        const filters = []; const range = { eq: (field, value) => (filters.push([field, value]), range) }; build(range);
        return { collect: async () => match(name, filters), unique: async () => match(name, filters)[0] ?? null };
      } }),
      insert: async (name, doc) => { const _id = `${name}:${++next}`; rows(name).set(_id, { ...doc, _id }); return _id; },
      patch: async (id, fields) => { Object.assign(find(id), fields); },
      delete: async id => { for (const table of Object.values(tables)) table.delete(id); }
    } }
  };
}
