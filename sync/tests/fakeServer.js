// The real HTTP routes and mutations running on the in-memory database, reachable through a fetch function.
// Used by these tests and by the desktop tests, so clients are checked against the actual server code.
import { getFunctionName } from 'convex/server';
import http from '../convex/http.js';
import * as auth from '../convex/auth.js';
import * as dictionary from '../convex/dictionary.js';
import * as items from '../convex/items.js';
import { fakeDb } from './fakeDb.js';

const modules = { auth, dictionary, items };

export function fakeServer(origin = 'https://test.convex.site') {
  const { ctx: db, tables } = fakeDb();
  const ctx = {
    runMutation: async (reference, args) => {
      const [module, name] = getFunctionName(reference).split(':');
      return modules[module][name]._handler(db, structuredClone(args));
    }
  };
  const routes = new Map(http.getRoutes().map(([path, method, handler]) => [`${method} ${path}`, handler._handler]));
  async function fetch(url, init = {}) {
    const parsed = new URL(url);
    if (parsed.origin !== origin) throw new TypeError('fetch failed');
    const handler = routes.get(`${init.method ?? 'GET'} ${parsed.pathname}`);
    if (!handler) return new Response('Not found', { status: 404 });
    return handler(ctx, new Request(url, { method: init.method, headers: init.headers, body: init.body }));
  }
  return { fetch, tables, db, origin };
}
