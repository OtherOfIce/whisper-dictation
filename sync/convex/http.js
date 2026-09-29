import { httpRouter, httpActionGeneric as httpAction, makeFunctionReference } from 'convex/server';

const http = httpRouter();
http.route({
  path: '/dictionary/sync', method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const key = process.env.DICTIONARY_SYNC_KEY;
    if (!key || key.length < 32 || request.headers.get('Authorization') !== `Bearer ${key}`) return new Response('Unauthorized', { status: 401 });
    if ((request.headers.get('Content-Length') ?? 0) > 100000) return new Response('Request too large', { status: 413 });
    let args;
    try {
      const text = await request.text();
      if (text.length > 100000) return new Response('Request too large', { status: 413 });
      args = JSON.parse(text);
      if (!args || !Array.isArray(args.add) || !Array.isArray(args.remove) || args.add.length > 1000 || args.remove.length > 1000 || [...args.add, ...args.remove].some(term => typeof term !== 'string' || term.length > 120)) throw new Error();
    } catch { return new Response('Invalid dictionary changes', { status: 400 }); }
    try {
      const result = await ctx.runMutation(makeFunctionReference('dictionary:sync'), { add: args.add, remove: args.remove });
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch { return new Response('Dictionary changes could not be saved. Check the dictionary limits.', { status: 400 }); }
  })
});
export default http;
