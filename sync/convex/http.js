import { httpRouter, httpActionGeneric as httpAction, makeFunctionReference } from 'convex/server';
import { TOKEN_PATTERN, deviceName, generateToken, hashAuthKey, isAuthKey, isEnvelope, isPairId, mayCreate, normalizeEmail, sha256Hex, validateGrants } from './authCore.js';
import { MAX_ITEMS, validateItem } from './itemsCore.js';

const http = httpRouter();
const noStore = { 'Cache-Control': 'no-store' };
const reply = (body, status = 200) => Response.json(body, { status, headers: noStore });

async function readJson(request, limit = 2000) {
  if ((request.headers.get('Content-Length') ?? 0) > limit) return null;
  const text = await request.text();
  if (text.length > limit) return null;
  try { const body = JSON.parse(text); return body && typeof body === 'object' && !Array.isArray(body) ? body : null; } catch { return null; }
}
const bearerToken = request => {
  const match = /^Bearer (lwd_\S+)$/.exec(request.headers.get('Authorization') ?? '');
  return match && TOKEN_PATTERN.test(match[1]) ? match[1] : null;
};

http.route({
  path: '/dictionary/sync', method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const shared = process.env.DICTIONARY_SYNC_KEY;
    const sharedKeyOk = Boolean(shared) && shared.length >= 32 && request.headers.get('Authorization') === `Bearer ${shared}`;
    const token = sharedKeyOk ? null : bearerToken(request);
    if (!sharedKeyOk && !token) return new Response('Unauthorized', { status: 401 });
    if ((request.headers.get('Content-Length') ?? 0) > 100000) return new Response('Request too large', { status: 413 });
    let args;
    try {
      const text = await request.text();
      if (text.length > 100000) return new Response('Request too large', { status: 413 });
      args = JSON.parse(text);
      if (!args || !Array.isArray(args.add) || !Array.isArray(args.remove) || args.add.length > 1000 || args.remove.length > 1000 || [...args.add, ...args.remove].some(term => typeof term !== 'string' || term.length > 120)) throw new Error();
    } catch { return new Response('Invalid dictionary changes', { status: 400 }); }
    try {
      const result = sharedKeyOk
        ? await ctx.runMutation(makeFunctionReference('dictionary:sync'), { add: args.add, remove: args.remove })
        : await ctx.runMutation(makeFunctionReference('dictionary:syncForDevice'), { tokenHash: await sha256Hex(token), add: args.add, remove: args.remove });
      if (!result) return new Response('Unauthorized', { status: 401 });
      return Response.json(result, { headers: noStore });
    } catch { return new Response('Dictionary changes could not be saved. Check the dictionary limits.', { status: 400 }); }
  })
});

// Runs `mutation` for the device behind the bearer token. `build` turns the request body into the mutation's
// arguments, or returns a string describing what is wrong with it.
function authed(path, mutation, build = () => ({}), limit = 2000) {
  http.route({
    path, method: 'POST',
    handler: httpAction(async (ctx, request) => {
      const token = bearerToken(request);
      if (!token) return reply({ error: 'Unauthorized' }, 401);
      const body = await readJson(request, limit);
      const args = body ? await build(body) : 'Invalid request';
      if (typeof args === 'string') return reply({ error: args }, 400);
      try {
        const result = await ctx.runMutation(makeFunctionReference(mutation), { ...args, tokenHash: await sha256Hex(token) });
        return result ? reply(result) : reply({ error: 'Unauthorized' }, 401);
      } catch (error) { return reply({ error: error.message || 'The request could not be completed' }, 400); }
    })
  });
}

http.route({
  path: '/account/create', method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await readJson(request);
    const email = normalizeEmail(body?.username);
    if (!email) return reply({ error: 'Use an email address as your username' }, 400);
    if (!isAuthKey(body.authKey) || !isEnvelope(body.keyring)) return reply({ error: 'Invalid request' }, 400);
    if (!mayCreate(email)) return reply({ error: 'This server does not accept new accounts for that username' }, 403);
    const token = generateToken();
    const result = await ctx.runMutation(makeFunctionReference('auth:createAccount'), {
      email, authHash: await hashAuthKey(body.authKey), keyring: body.keyring, tokenHash: await sha256Hex(token), deviceName: deviceName(body.deviceName, 'Windows')
    });
    return result.ok ? reply({ token, username: email, admin: true, grants: result.grants }) : reply({ error: 'That username already has an account. Sign in instead.' }, 409);
  })
});

http.route({
  path: '/account/sign-in', method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await readJson(request);
    const email = normalizeEmail(body?.username);
    if (!email || !isAuthKey(body.authKey)) return reply({ error: 'Enter your username and passphrase' }, 400);
    const token = generateToken();
    const result = await ctx.runMutation(makeFunctionReference('auth:signIn'), {
      email, authHash: await hashAuthKey(body.authKey), tokenHash: await sha256Hex(token), deviceName: deviceName(body.deviceName, 'Windows')
    });
    if (result.ok) return reply({ token, username: email, admin: true, grants: result.grants, keyring: result.keyring });
    return reply({ error: result.limited ? 'Too many wrong passphrases. Try again in an hour.' : 'That username and passphrase do not match an account' }, result.limited ? 429 : 401);
  })
});

http.route({
  path: '/pair/claim', method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await readJson(request);
    if (!isPairId(body?.pairId)) return reply({ error: 'Invalid request' }, 400);
    const token = generateToken();
    const result = await ctx.runMutation(makeFunctionReference('auth:claimPairing'), { pairId: body.pairId, tokenHash: await sha256Hex(token) });
    return result ? reply({ token, username: result.email, name: result.name, admin: false, grants: result.grants, payload: result.payload })
      : reply({ error: 'That pairing code did not work. Codes last 10 minutes and work once; make a new one on your desktop.' }, 404);
  })
});

authed('/account/sign-out', 'auth:signOut');
authed('/account/me', 'auth:me');
authed('/account/passphrase', 'auth:changePassphrase', async body => isAuthKey(body.authKey) && isEnvelope(body.keyring) ? { authHash: await hashAuthKey(body.authKey), keyring: body.keyring } : 'Invalid request');
authed('/devices/list', 'auth:listDevices');
authed('/devices/pair', 'auth:createPairing', body => {
  const grants = validateGrants(body.grants);
  if (!grants || !isPairId(body.pairId) || !isEnvelope(body.payload)) return 'Invalid request';
  return { pairId: body.pairId, name: deviceName(body.name), grants, payload: body.payload };
});
authed('/devices/update', 'auth:updateDevice', body => {
  const grants = validateGrants(body.grants);
  if (!grants || typeof body.id !== 'string' || body.id.length > 64) return 'Invalid request';
  return { deviceId: body.id, grants, ...(typeof body.name === 'string' && body.name.trim() ? { name: deviceName(body.name) } : {}) };
});
authed('/devices/remove', 'auth:removeDevice', body => typeof body.id === 'string' && body.id.length <= 64 ? { deviceId: body.id } : 'Invalid request');
authed('/sync/items', 'items:syncItems', body => {
  const items = body.items ?? [];
  if (!Array.isArray(items) || items.length > MAX_ITEMS || items.some(item => validateItem(item))) return 'Invalid sync request';
  return { items: items.map(({ name, value, deleted, updatedAt }) => ({ name, value, deleted, updatedAt })) };
}, 400000);

export default http;
