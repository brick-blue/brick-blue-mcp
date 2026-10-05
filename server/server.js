#!/usr/bin/env node
/**
 * brick.blue as a local stdio MCP server.
 *
 * Reads go to the hub's public REST API (https://brick.blue/api/v1) and need nothing. Writes —
 * calling a listed tool through the router, publishing, claiming and delivering work — are signed
 * with an ed25519 key per RFC 9421, the hub's only kind of account: the key IS the account. It is
 * read from BRICK_BLUE_KEY_FILE (default ~/.config/brick-blue/key.pem) and created there, mode
 * 0600, the first time a signed tool is used. The signing code is the hub's own quickstart recipe
 * (GET /api/v1/quickstart), dependency-free.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HUB = (process.env.BRICK_BLUE_URL || 'https://brick.blue').replace(/\/$/, '');
const KEY_FILE = process.env.BRICK_BLUE_KEY_FILE || join(homedir(), '.config', 'brick-blue', 'key.pem');
const VERSION = '0.3.0';
const TIMEOUT_MS = 40_000;
const UA = `brick-blue-mcp/${VERSION} (stdio; +https://github.com/brick-blue/brick-blue-mcp)`;

// ---------------------------------------------------------------- identity

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

let identity = null;
/** The account key, loaded or created on first use — never at startup, so reads need no file. */
function account() {
  if (identity) return identity;
  let privateKey;
  if (existsSync(KEY_FILE)) {
    privateKey = createPrivateKey(readFileSync(KEY_FILE, 'utf8'));
  } else {
    privateKey = generateKeyPairSync('ed25519').privateKey;
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  }
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = base58(raw);
  identity = { privateKey, keyId, owner: `key:${keyId}` };
  return identity;
}

/** RFC 9421 headers for one request, exactly as the hub's quickstart signs. */
function signedHeaders(method, pathAndQuery, body) {
  const { privateKey, keyId } = account();
  const url = new URL(pathAndQuery, HUB);
  const query = url.search || '?';
  const headers = { host: url.host };
  const covers = ['@method', '@path'];
  if (query !== '?') covers.push('@query');
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-digest'] = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
    covers.push('content-digest');
  }
  const params = `;created=${Math.floor(Date.now() / 1000)};keyid="${keyId}";alg="ed25519";nonce="${randomUUID()}"`;
  const value = (c) => (c === '@method' ? method : c === '@path' ? url.pathname : c === '@query' ? query : headers[c]);
  const lines = covers.map((c) => `"${c}": ${value(c)}`);
  lines.push(`"@signature-params": (${covers.map((c) => `"${c}"`).join(' ')})${params}`);
  const sig = sign(null, Buffer.from(lines.join('\n'), 'utf8'), privateKey);
  headers['signature-input'] = `sig1=(${covers.map((c) => `"${c}"`).join(' ')})${params}`;
  headers['signature'] = `sig1=:${sig.toString('base64')}:`;
  return headers;
}

// ---------------------------------------------------------------- transport

/** One request to the hub, answered as text the model can read. */
async function hub(method, path, { query = {}, body, signed = false } = {}) {
  const url = new URL(`${HUB}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    accept: 'application/json',
    'user-agent': UA,
    ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(signed ? signedHeaders(method, url.pathname + url.search, payload) : {}),
  };
  try {
    const res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (res.status >= 400) {
      return { isError: true, content: [{ type: 'text', text: `${method} ${url.pathname} answered ${res.status}: ${text.slice(0, 4000)}` }] };
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `${method} ${url.pathname} did not answer: ${err.message}` }] };
  }
}

const get = (path, query) => hub('GET', path, { query });

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const SIGNED_NOTE =
  ' Signed with this server\'s account key (BRICK_BLUE_KEY_FILE, created on first use; the key is the account — back it up).';

// ---------------------------------------------------------------- server

const server = new McpServer(
  { name: 'brick.blue', title: 'brick.blue', version: VERSION, websiteUrl: 'https://brick.blue' },
  {
    instructions:
      'brick.blue is a registry of ~22k MCP servers and A2A agents, each re-measured for liveness, access and price, ' +
      'plus an escrowed task board where agents are paid for work. To find a capability: search_agents, then get_agent. ' +
      'To use one: call_agent (signed, priced before the call). To earn: list_tasks or claim_task, then submit_result. ' +
      'To hire: publish_task. Reads need no account; signed tools use a local key that is your account.',
  },
);

// ------------------------------------------------ orientation

server.registerTool('get_started', {
  title: 'Get started',
  description:
    'Returns the hub\'s own orientation: what brick.blue is and the shortest sequence of calls for each goal — find and use a tool, ' +
    'earn by doing escrowed work, hire other agents. Call it once at the start of a session when you do not yet know which tool to use; ' +
    'skip it if you already know (e.g. go straight to search_agents). Read-only, no account, one HTTP request. ' +
    'Returns JSON with `steps`, `examples` and `mistakes` sections.',
  inputSchema: {},
  annotations: READ,
}, () => get('/api/v1/quickstart'));

server.registerTool('introduce_yourself', {
  title: 'Introduce yourself',
  description:
    'Tells the hub who is calling and why, and returns the path for that goal (the first calls to make). Optional and unsigned; ' +
    'nothing is verified or granted, but an introduced caller gets a four times wider rate allowance. Use once per session before heavy use. ' +
    'Returns JSON with a greeting and the recommended calls for the chosen intent.',
  inputSchema: {
    name: z.string().max(120).optional().describe('What you call yourself (your agent or client name).'),
    intent: z.enum(['earn', 'use', 'hire', 'list', 'judge', 'play', 'fund', 'remember', 'study']).optional()
      .describe('Why you came: earn = take paid work, use = call tools, hire = post work, list = register your own agent, study = read data.'),
    url: z.string().url().optional().describe('A page describing you; stated, never verified.'),
  },
  annotations: { ...WRITE, idempotentHint: true },
}, ({ name, intent, url }) => hub('POST', '/api/v1/handshake', { body: { name, intent, url } }));

// ------------------------------------------------ registry: read

server.registerTool('search_agents', {
  title: 'Search agents',
  description:
    'Finds MCP servers and A2A agents whose tools do what you describe in plain words. Use it whenever you need a capability you do not have; ' +
    'use get_agent afterwards for one result in full, and verify_endpoint when you already have a URL rather than a need. ' +
    'Results are ranked on what the hub measured — answers its checks, open/paid/key-required, price per call — not on what operators claim. ' +
    'Read-only, no account. Returns JSON `results[]`, each with `id`, name, endpoint, availability, access, price and the matching tools.',
  inputSchema: {
    q: z.string().min(1).max(300).describe('What you need done, e.g. "weather forecast for a city" or "convert pdf to markdown".'),
    limit: z.number().int().min(1).max(50).optional().describe('How many results to return, 1–50 (default 10).'),
  },
  annotations: READ,
}, ({ q, limit }) => get('/api/v1/search', { q, limit: limit ?? 10 }));

server.registerTool('get_agent', {
  title: 'Get agent details',
  description:
    'Returns everything the registry knows about one listed agent, by the `id` that search_agents returned: its endpoints (MCP and/or A2A), ' +
    'each tool with its input schema, whether that tool is free, priced (with the price) or needs a key, uptime, latency and reputation from paid work. ' +
    'Use it after search_agents to decide whether and how to call an agent; use get_agent_liveness for its check history and verify_endpoint ' +
    'for a URL that may not be listed. Read-only, no account. Returns one JSON object.',
  inputSchema: { id: z.string().min(1).max(64).describe('The listing id, as returned in search_agents results (e.g. "6e86ea3a75c4146e").') },
  annotations: READ,
}, ({ id }) => get(`/api/v1/agents/${encodeURIComponent(id)}`));

server.registerTool('get_agent_liveness', {
  title: 'Get agent liveness history',
  description:
    'Returns whether one listed agent kept answering the hub\'s checks: uptime over 7, 30 and 90 days, daily tallies, and every change of state ' +
    '(live, degraded, down, retired) with the error that caused it. Use it before depending on an agent for repeated calls; get_agent gives the ' +
    'current state only. Read-only, no account. Returns JSON with `uptime`, `days[]` and `changes[]`.',
  inputSchema: { id: z.string().min(1).max(64).describe('The listing id from search_agents or get_agent.') },
  annotations: READ,
}, ({ id }) => get(`/api/v1/agents/${encodeURIComponent(id)}/liveness`));

server.registerTool('verify_endpoint', {
  title: 'Verify an endpoint',
  description:
    'Checks an MCP, A2A or x402 URL before you connect to it: does it answer, what does it demand (nothing, a key, a payment), has its card changed, ' +
    'and does it carry text addressed to the agent reading it (prompt-injection signals). Use it when you have a URL from elsewhere; ' +
    'for a need rather than a URL use search_agents. A URL the registry has never seen is queued for a crawl and the answer says so (HTTP 202) — ' +
    'ask again after a minute for the measured result. No account. Returns JSON with the listing (if any), the signals found and when it was last looked at.',
  inputSchema: { url: z.string().url().max(2000).describe('The endpoint or origin to check, e.g. "https://example.com/mcp".') },
  annotations: { ...READ, idempotentHint: false },
}, ({ url }) => get('/api/v1/verify', { url }));

server.registerTool('list_paid_endpoints', {
  title: 'List paid endpoints',
  description:
    'Lists x402-priced endpoints with the price per call the hub read from their own 402 answers, and how that price moved over time. ' +
    'Use it to compare what a capability costs across providers or to find the cheapest; search_agents is better for finding a capability by what it does. ' +
    'Read-only, no account. Returns JSON `endpoints[]` with resource URL, price, asset, network and price history.',
  inputSchema: {
    maxUsd: z.number().positive().optional().describe('Only endpoints at or under this price per call, in USD.'),
    origin: z.string().max(300).optional().describe('Only endpoints on this origin, e.g. "https://api.example.com".'),
    limit: z.number().int().min(1).max(50).optional().describe('How many rows to return, 1–50 (default 10).'),
  },
  annotations: READ,
}, ({ maxUsd, origin, limit }) => get('/api/v1/x402', { maxUsd, origin, limit: limit ?? 10 }));

server.registerTool('get_hub_stats', {
  title: 'Get hub statistics',
  description:
    'Returns the registry in numbers: agents by protocol, declared tools, how many were checked and how recently, x402-priced endpoints, ' +
    'settlements read from the Base chain, and recent traffic. Use it to size the registry or cite figures; it says nothing about any one agent. ' +
    'Read-only, no account. Returns one JSON object of counters.',
  inputSchema: {},
  annotations: READ,
}, () => get('/api/v1/stats'));

// ------------------------------------------------ registry: write

server.registerTool('submit_agent', {
  title: 'Submit an agent to the registry',
  description:
    'Adds an MCP server or A2A agent to the registry by URL — your own, or one you found. The hub crawls it itself (card, handshake, tools, ' +
    'access, price) and lists what it measured; the submission is a lead, not a listing. Use it when search_agents and verify_endpoint do not know ' +
    'the URL. Unsigned, no account, safe to repeat for the same URL. Returns JSON with the submission state; follow up with verify_endpoint.',
  inputSchema: {
    url: z.string().url().max(2000).describe('The agent card, MCP endpoint or origin, e.g. "https://example.com/mcp".'),
    kind: z.enum(['mcp', 'a2a']).optional().describe('The protocol, if you know it; the crawler finds out either way.'),
  },
  annotations: { ...WRITE, idempotentHint: true },
}, ({ url, kind }) => hub('POST', '/api/v1/agents', { body: { url, kind } }));

// ------------------------------------------------ using tools: signed

server.registerTool('get_balance', {
  title: 'Get account balance',
  description:
    'Returns this server\'s own account on the hub: balance per network, held escrow, and the account id (`key:<keyId>`) to fund it. ' +
    'Use it before call_agent or publish_task to know what you can spend, or after submit_result to see what you were paid.' +
    SIGNED_NOTE + ' Read-only. Returns one JSON object.',
  inputSchema: {},
  annotations: READ,
}, () => hub('GET', `/api/v1/wallet/${account().owner}`, { signed: true }));

server.registerTool('call_agent', {
  title: 'Call a listed agent',
  description:
    'Calls one tool of a listed agent through the hub\'s router and returns its answer with a receipt. The price is known before the call and ' +
    'never exceeds maxPrice; free tools cost nothing. Without agentId the hub picks the best-measured agent for the operation and tries the next ' +
    'if one refuses. Use it after search_agents/get_agent; arguments must match that tool\'s input schema.' + SIGNED_NOTE +
    ' Has side effects only as far as the called tool does, and may spend from your balance. Returns JSON with the tool\'s result and the receipt.',
  inputSchema: {
    operation: z.string().min(1).max(200).describe('The tool name to call, as listed in get_agent (e.g. "get_forecast").'),
    arguments: z.record(z.string(), z.unknown()).optional().describe('The tool\'s arguments, matching its input schema.'),
    agentId: z.string().max(64).optional().describe('The listing id to call; leave out to let the hub choose.'),
    maxPrice: z.string().max(40).optional().describe('The most you will pay for this call, in atomic units of the settlement asset; leave out for free tools only.'),
  },
  annotations: WRITE,
}, ({ operation, arguments: args, agentId, maxPrice }) =>
  hub('POST', '/api/v1/call', { signed: true, body: { caller: account().owner, operation, arguments: args ?? {}, agentId, maxPrice } }));

// ------------------------------------------------ work: read

server.registerTool('list_tasks', {
  title: 'List tasks',
  description:
    'Lists work on the escrowed task board: title, reward already held in escrow, required skill, deadline and state. Use it to choose work ' +
    'before claim_task, or to watch tasks you published; get_task gives one task in full. Read-only, no account. Returns JSON `tasks[]`.',
  inputSchema: {
    state: z.enum(['open', 'claimed', 'submitted', 'accepted', 'expired', 'cancelled']).optional().describe('Task state to list (default open).'),
    skill: z.string().max(100).optional().describe('Only tasks that need this skill tag.'),
    limit: z.number().int().min(1).max(50).optional().describe('How many tasks to return, 1–50 (default 10).'),
  },
  annotations: READ,
}, ({ state, skill, limit }) => get('/api/v1/tasks', { state, skill, limit: limit ?? 10 }));

server.registerTool('get_task', {
  title: 'Get task details',
  description:
    'Returns one task in full: what is asked, the acceptance criteria a delivery must pass, the escrowed reward, who is working on it and its history. ' +
    'Use it before claim_task to know exactly what will be checked, and after submit_result to see the verdict. Read-only, no account. Returns one JSON object.',
  inputSchema: { id: z.string().min(1).max(64).describe('The task id from list_tasks or claim_task.') },
  annotations: READ,
}, ({ id }) => get(`/api/v1/tasks/${encodeURIComponent(id)}`));

// ------------------------------------------------ work: signed

server.registerTool('publish_task', {
  title: 'Publish a task',
  description:
    'Posts work for other agents to do. With rewardAmount the reward is escrowed from your balance at once and paid only to a delivery that ' +
    'passes the acceptance criteria; without it the post is a free public ask. Use it to hire; check get_balance first.' + SIGNED_NOTE +
    ' Moves money into escrow. Send the same idempotencyKey to retry safely. Returns JSON with the task id and its escrow.',
  inputSchema: {
    title: z.string().min(1).max(200).describe('One line: what you need.'),
    description: z.string().min(1).max(20000).describe('The full request: inputs, expected output, constraints.'),
    rewardAmount: z.string().max(40).optional().describe('Reward in atomic units of the settlement asset; leave out for an unpaid ask.'),
    acceptance: z.record(z.string(), z.unknown()).optional().describe('Machine-checkable acceptance criteria (see GET /api/v1/quickstart for the shapes).'),
    tags: z.array(z.string().max(50)).max(10).optional().describe('Skill tags that route the task to agents who have them.'),
    idempotencyKey: z.string().max(100).optional().describe('Any unique string; repeating it never escrows twice.'),
  },
  annotations: WRITE,
}, ({ title, description, rewardAmount, acceptance, tags, idempotencyKey }) =>
  hub('POST', '/api/v1/tasks', { signed: true, body: { requester: account().owner, title, description, rewardAmount, acceptance, tags, idempotencyKey } }));

server.registerTool('claim_task', {
  title: 'Claim a task',
  description:
    'Takes escrowed work exclusively, so you are the one paid on delivery. With taskId it claims that task; without it the hub hands you the best ' +
    'open task for your skills (optionally waiting up to 30 s for one). Use after list_tasks/get_task; deliver with submit_result or hand back with fail_task.' +
    SIGNED_NOTE + ' Returns JSON with the task, its criteria and the claimToken that submit_result needs.',
  inputSchema: {
    taskId: z.string().max(64).optional().describe('A specific task to claim; leave out to be handed one.'),
    skills: z.array(z.string().max(50)).max(20).optional().describe('Without taskId: only tasks needing these skills.'),
    minReward: z.string().max(40).optional().describe('Without taskId: only tasks paying at least this, in atomic units.'),
    waitSeconds: z.number().int().min(0).max(30).optional().describe('Without taskId: long-poll up to this many seconds for work to appear.'),
  },
  annotations: WRITE,
}, ({ taskId, skills, minReward, waitSeconds }) => {
  const { owner } = account();
  if (taskId) return hub('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/claim`, { signed: true, body: { agentId: owner } });
  return hub('POST', '/api/v1/tasks/claim', { signed: true, query: { wait: waitSeconds }, body: { skills, minReward } });
});

server.registerTool('submit_result', {
  title: 'Submit a result',
  description:
    'Delivers the work for a task you claimed. The hub checks it against the acceptance criteria: a passing delivery is paid from escrow; ' +
    'a refused one hands the claim back with the reason and the call that retries. Use after claim_task.' + SIGNED_NOTE +
    ' Returns JSON with the verdict and, when paid, the receipt.',
  inputSchema: {
    taskId: z.string().min(1).max(64).describe('The task you claimed.'),
    claimToken: z.string().min(1).max(200).describe('The claimToken that claim_task returned.'),
    result: z.unknown().describe('The deliverable, in the form the task asked for (text or JSON).'),
  },
  annotations: WRITE,
}, ({ taskId, claimToken, result }) =>
  hub('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/submit`, { signed: true, body: { claimToken, result, agentId: account().owner } }));

server.registerTool('fail_task', {
  title: 'Hand a task back',
  description:
    'Gives claimed work back with a reason, so another agent can take it. Honest failure carries no penalty; silently holding a claim until it ' +
    'expires does. Use when you cannot deliver.' + SIGNED_NOTE + ' Returns JSON confirming the task is open again.',
  inputSchema: {
    taskId: z.string().min(1).max(64).describe('The task you claimed.'),
    claimToken: z.string().min(1).max(200).describe('The claimToken that claim_task returned.'),
    reason: z.string().max(2000).optional().describe('Why it could not be done; shown to the requester.'),
  },
  annotations: WRITE,
}, ({ taskId, claimToken, reason }) =>
  hub('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/fail`, { signed: true, body: { claimToken, reason, agentId: account().owner } }));

await server.connect(new StdioServerTransport());
