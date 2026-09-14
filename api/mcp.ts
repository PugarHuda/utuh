import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../offchain/mcp';

/// The Utuh watcher as a remote MCP server: a URL instead of `npx`.
///
///   POST https://utuh.vercel.app/api/mcp        Streamable HTTP, stateless
///
/// Claude.ai connectors, ChatGPT and most hosted agents take a remote MCP URL and cannot run a local
/// command, so the stdio package never reached them. This serves the same `createServer` the package
/// runs — every tool, resource and prompt defined once in `offchain/mcp.ts` — over HTTP.
///
/// Stateless, because a function instance may never see the same client twice: every POST gets a new
/// server and transport, answers, and is gone. There is no session to resume and no standalone GET
/// stream to open, so GET and DELETE answer 405, which is what the transport spec asks of a server
/// that offers neither.
///
/// It holds no key. `refute_claim` returns an unsigned transaction here and can send nothing — the
/// function never reads PRIVATE_KEY, and `mcpHttpTest.ts` runs it with one in the environment to
/// prove that. A sweep gets `UTUH_MCP_BUDGET_MS` (50s by default) inside the platform's 60s limit set
/// in vercel.json, and answers inconclusive with how far it got rather than being killed mid-call.
///
/// Built by `npm run mcp:package` into `dist-mcp/api/mcp.js`, one self-contained file, which the
/// deploy stages as `api/mcp.js` next to the static site.

/// Browser-based clients — the MCP Inspector, web agents — call cross-origin and preflight first.
/// Nothing here is credentialed, so any origin may ask; the headers are the ones the transport reads
/// and writes.
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers':
    'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '86400',
};

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> {
  for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, OPTIONS' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'This MCP server is stateless: POST JSON-RPC to it; there is no stream to GET.',
        },
        id: null,
      }),
    );
    return;
  }

  // Read per request, so a harness can change it between calls without reloading the bundle.
  const budgetMs = Number(process.env.UTUH_MCP_BUDGET_MS ?? 50_000);
  const server = createServer({ transport: 'http', budgetMs });
  // No `sessionIdGenerator` is what makes the transport stateless: no session id issued, none checked.
  const transport = new StreamableHTTPServerTransport({});
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    // The SDK's transport declares its handlers `?: T | undefined` and its interface `?: T`, which
    // only `exactOptionalPropertyTypes` tells apart; the object is the one the SDK's own examples pass.
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    // Vercel's Node runtime has already parsed a JSON body into `req.body` by the time the handler
    // runs; a plain node:http server has not, and the transport reads the stream itself.
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal server error' }, id: null }));
    }
  }
}
