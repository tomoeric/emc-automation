import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import type { IgniteSession } from './ignite.js';

const MODEL = 'claude-opus-5-5';

const tools: Anthropic.Tool[] = [
  {
    name: 'list_domains',
    description:
      'List the Watchfire domains available in the account switcher ' +
      '(e.g. Mammoth Holdings, Mojo Car Wash, Silverstar Car Wash).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'switch_domain',
    description: 'Switch the active Watchfire domain by its exact name.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact domain name' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'network_status',
    description:
      'Open the Network view and capture the current sign / display status. ' +
      'Returns a screenshot — READ IT to determine which signs are online or offline.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'snapshot_screen',
    description: 'Capture the current Ignite screen (text + screenshot) to see where you are.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'click',
    description:
      'Click a link, button, menu item, tab, or row by its visible text ' +
      '(e.g. "Network", "View All", a sign name). Use this to navigate deeper. ' +
      'Returns the resulting screen as a screenshot you should read.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Exact visible text to click' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_screen',
    description: 'Capture the current screen (text + screenshot) to see where you are and what to click next.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const SYSTEM =
  'You are the EMC Automation assistant. You control a logged-in Watchfire ' +
  'Ignite OPx session through the provided tools. The account has three ' +
  'domains: Mammoth Holdings, Mojo Car Wash, Silverstar Car Wash. ' +
  'When asked about sign or display status, call network_status and READ THE ' +
  'SCREENSHOT to report which signs are online or offline. Be concise and ' +
  'factual. If a tool returns an error, say what happened. Never invent sign ' +
  'names, counts, or statuses you did not actually see on screen. ' +
  'To find sign / display status, open the Network section, then click into ' +
  'the list of individual signs (for example "View All") and READ THE ' +
  'SCREENSHOT for each sign\'s name and online/offline/connection status. ' +
  'Navigate with the click tool using the visible text of links, tabs, or ' +
  'rows, and use read_screen to see where you are before deciding what to ' +
  'click next. To change domain, click the current domain name to open the ' +
  'switcher, then click the target domain.';

async function runTool(
  session: IgniteSession,
  name: string,
  input: any,
): Promise<any> {
  if (name === 'list_domains') {
    const d = await session.listDomains();
    return [{ type: 'text', text: d.length ? 'Domains: ' + d.join(', ') : 'No domains visible on screen.' }];
  }
  let res;
  if (name === 'switch_domain') res = await session.switchDomain(String(input?.name ?? ''));
  else if (name === 'network_status') res = await session.getNetworkStatus();
  else if (name === 'snapshot_screen' || name === 'read_screen') res = await session.snapshot();
  else if (name === 'click') res = await session.click(String(input?.text ?? ''));
  else return [{ type: 'text', text: `Unknown tool: ${name}` }];

  const blocks: any[] = [
    { type: 'text', text: (res.ok ? 'OK' : 'Error: ' + (res.reason ?? '')) + (res.text ? '\n\n' + res.text.slice(0, 2000) : '') },
  ];
  if (res.screenshot) {
    const b64 = res.screenshot.split(',')[1];
    if (b64) blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  }
  return blocks;
}

export async function runAgent(
  session: IgniteSession,
  userText: string,
  history: Anthropic.MessageParam[],
): Promise<{ reply: string; history: Anthropic.MessageParam[] }> {
  if (!config.anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it as a secret to enable AI chat.');
  }
  const client = new Anthropic({ apiKey: config.anthropicKey });
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: userText }];

  for (let step = 0; step < 14; step++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      tools,
      messages,
    });
    messages.push({ role: 'assistant', content: resp.content as any });

    if (resp.stop_reason === 'tool_use') {
      const results: any[] = [];
      for (const block of resp.content) {
        if (block.type === 'tool_use') {
          const content = await runTool(session, block.name, block.input);
          results.push({ type: 'tool_result', tool_use_id: block.id, content });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { reply: text || '(no text response)', history: messages };
  }
  return { reply: 'Stopped after too many tool steps — try a more specific request.', history: messages };
}
