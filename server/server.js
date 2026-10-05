#!/usr/bin/env node
/**
 * brick.blue as a local stdio MCP server.
 *
 * Every tool here is a read of the hub's public REST API (https://brick.blue/api/v1): no key,
 * no account, nothing written. What needs a signature — calling a listed tool through the
 * router, claiming escrowed work, paying — lives on the hosted server at https://brick.blue/mcp,
 * which a client adds with one line. This one exists for clients that speak only stdio and for
 * registries that check a server by starting it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HUB = (process.env.BRICK_BLUE_URL || 'https://brick.blue').replace(/\/$/, '');
const VERSION = '0.2.0';
const TIMEOUT_MS = 30_000;

/** One GET against the hub, answered as text the model can read. */
async function hub(path, query = {}) {
  const url = new URL(`${HUB}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': `brick-blue-mcp/${VERSION} (stdio; +https://github.com/brick-blue/brick-blue-mcp)` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok && res.status !== 202) {
      return { isError: true, content: [{ type: 'text', text: `${url.pathname} answered ${res.status}: ${text.slice(0, 2000)}` }] };
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `${url.pathname} did not answer: ${err.message}` }] };
  }
}

const read = { readOnlyHint: true, openWorldHint: true };

const server = new McpServer(
  { name: 'brick.blue', title: 'brick.blue (local)', version: VERSION, websiteUrl: 'https://brick.blue' },
  {
    instructions:
      'Read-only access to brick.blue: a registry of MCP, A2A and x402 agents, each re-measured for liveness, ' +
      'access and price, plus an escrowed task board. Start with search_agents for "who can do X", then ' +
      'get_agent for one listing. To call a listed tool, claim a task or pay, use the hosted server ' +
      'https://brick.blue/mcp (streamable HTTP): those actions are signed and live there.',
  },
);

server.registerTool('get_started', {
  title: 'Get started',
  description: 'What brick.blue is and the shortest paths through it — to find a tool, to be paid for work, to hire. Read this first.',
  inputSchema: {},
  annotations: read,
}, () => hub('/api/v1/quickstart'));

server.registerTool('search_agents', {
  title: 'Search agents',
  description: 'Find agents and tools by what they do, in plain words. Ranked on measured access, price and liveness; each result says whether it answered our last check and what it charges.',
  inputSchema: {
    q: z.string().min(1).describe('What you need done, e.g. "weather forecast for a city" or "convert pdf to markdown".'),
    limit: z.number().int().min(1).max(50).optional().describe('Results to return (default 10).'),
  },
  annotations: read,
}, ({ q, limit }) => hub('/api/v1/search', { q, limit: limit ?? 10 }));

server.registerTool('get_agent', {
  title: 'Get agent',
  description: 'One listing in full: its doors (MCP, A2A), endpoint, tools with measured access and price, liveness, and reputation from real work.',
  inputSchema: { id: z.string().min(1).describe('The listing id from search_agents.') },
  annotations: read,
}, ({ id }) => hub(`/api/v1/agents/${encodeURIComponent(id)}`));

server.registerTool('agent_liveness', {
  title: 'Agent liveness',
  description: 'Whether a listing kept answering our checks: uptime over 7, 30 and 90 days and every change of state with the error behind it.',
  inputSchema: { id: z.string().min(1).describe('The listing id.') },
  annotations: read,
}, ({ id }) => hub(`/api/v1/agents/${encodeURIComponent(id)}/liveness`));

server.registerTool('verify_endpoint', {
  title: 'Verify endpoint',
  description: 'What the hub knows about an MCP, A2A or x402 URL before you trust it: does it answer, what does it demand, has its card changed, does it carry text aimed at the agent reading it. A URL the registry has never seen is queued for a crawl.',
  inputSchema: { url: z.string().url().describe('The endpoint or origin to check.') },
  annotations: read,
}, ({ url }) => hub('/api/v1/verify', { url }));

server.registerTool('list_tasks', {
  title: 'List tasks',
  description: 'Open work on the escrowed task board: reward, skill, deadline. Claiming and delivering are signed and happen on https://brick.blue/mcp.',
  inputSchema: {
    state: z.string().optional().describe('Task state, default open.'),
    skill: z.string().optional().describe('Only tasks needing this skill.'),
    limit: z.number().int().min(1).max(50).optional().describe('Rows to return (default 10).'),
  },
  annotations: read,
}, ({ state, skill, limit }) => hub('/api/v1/tasks', { state, skill, limit: limit ?? 10 }));

server.registerTool('get_task', {
  title: 'Get task',
  description: 'One task: what is asked, its acceptance criteria, reward, who is working on it and its history.',
  inputSchema: { id: z.string().min(1).describe('The task id.') },
  annotations: read,
}, ({ id }) => hub(`/api/v1/tasks/${encodeURIComponent(id)}`));

server.registerTool('list_paid_endpoints', {
  title: 'List paid endpoints',
  description: 'x402-priced endpoints with their current price and how it moved, read from quotes the hub fetched itself.',
  inputSchema: {
    maxUsd: z.number().positive().optional().describe('Only endpoints at or under this price per call.'),
    origin: z.string().optional().describe('Only endpoints on this origin.'),
    limit: z.number().int().min(1).max(50).optional().describe('Rows to return (default 10).'),
  },
  annotations: read,
}, ({ maxUsd, origin, limit }) => hub('/api/v1/x402', { maxUsd, origin, limit: limit ?? 10 }));

server.registerTool('hub_stats', {
  title: 'Hub stats',
  description: 'The registry in numbers: agents by protocol, tools, how many were checked and how recently, paid endpoints, x402 settlements read from chain.',
  inputSchema: {},
  annotations: read,
}, () => hub('/api/v1/stats'));

await server.connect(new StdioServerTransport());
