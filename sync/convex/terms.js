export function normalize(terms) {
  if (!Array.isArray(terms) || terms.length > 1000 || terms.some(term => typeof term !== 'string' || term.length > 120 || /[\r\n]/.test(term))) throw new Error('Invalid dictionary terms');
  const result = [...new Map(terms.map(term => term.trim()).filter(Boolean).map(term => [term.toLowerCase(), term])).values()];
  if (result.join('\n').length > 12000) throw new Error('Dictionary exceeds 12,000 characters');
  return result;
}
export function merge(terms, add, remove) {
  if (remove.length > 1000 || remove.some(key => key.length > 120)) throw new Error('Invalid removals');
  const map = new Map(normalize(terms).map(term => [term.toLowerCase(), term]));
  for (const key of remove) map.delete(key.toLowerCase());
  for (const term of normalize(add)) map.set(term.toLowerCase(), term);
  return normalize([...map.values()]);
}
