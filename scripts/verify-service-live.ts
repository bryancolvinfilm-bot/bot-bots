import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Bootstrap, Run } from '../packages/shared/types';
import type { CredentialManagerState } from '../packages/shared/credentials';
import { PAGES_API } from '../packages/shared/service-api';

// Explicitly publishes one new seven-day test site. This never reads a saved key.
assert.ok(
  process.argv.includes('--publish'),
  'Pass --publish to create a real test page and short link with the existing private connection.',
);
const base = process.env.BOT_BOTS_VERIFY_URL ?? 'http://127.0.0.1:3211';
const dir = resolve(`test-results/service-upgrade/live-${Date.now()}`);
mkdirSync(dir, { recursive: true });
async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok) throw Error(`${path}: ${data.error ?? response.status}`);
  return data;
}
const health = await api('/health');
assert.equal(health.version, '0.2.15');
const initial = await api<Bootstrap>('/bootstrap');
assert.equal(initial.settings.localOnly, true, 'This verification must use local inference only.');
const loaded = initial.models.filter(
  (model) =>
    model.enabled &&
    model.loadState === 'loaded' &&
    initial.providers.some(
      (provider) => provider.id === model.providerId && provider.enabled && provider.local,
    ),
);
assert.ok(
  loaded.length && loaded.every((model) => /qwen.*(?:3\.5|3.5).*9b/i.test(model.name)),
  'Only the already-loaded local Qwen 3.5 9B model is allowed for this check.',
);
assert.ok(
  !initial.runs.some((run) => run.status === 'running'),
  'Wait for existing work to finish before this verification.',
);
const botId = 'info-page-generate';
let manager = await api<CredentialManagerState>('/credentials/manager');
let service = manager.connections.find(
  (connection) =>
    connection.enabled &&
    connection.purpose === 'service' &&
    connection.api?.id === PAGES_API.id &&
    connection.botIds?.includes(botId),
);
if (!service) {
  const legacy = manager.connections.findLast(
    (connection) =>
      connection.enabled &&
      connection.purpose === 'operation' &&
      connection.url.startsWith(PAGES_API.baseUrl) &&
      connection.botIds?.includes(botId),
  );
  const saved =
    manager.secrets.find((secret) => secret.present && secret.id === legacy?.secretId) ??
    manager.secrets.findLast((secret) => secret.present && /pages/i.test(secret.name));
  assert.ok(
    saved,
    'A Pages token must already be in the operating-system store. No value is read by this script.',
  );
  const connected = await api('/credentials/manager/connect-service', 'POST', {
    version: manager.version,
    secretId: saved.id,
    api: PAGES_API,
    botIds: legacy?.botIds ?? [botId],
    approval: 'connected',
  });
  manager = connected.state;
  service = manager.connections.find((connection) => connection.id === connected.grantId);
}
assert.ok(service);
const checked = await api('/credentials/manager/check-service', 'POST', {
  serviceId: service.id,
  botId,
});
assert.equal(checked.verified, true);
assert.equal(checked.actions, PAGES_API.operations.length);
console.log(
  JSON.stringify({ connectionVerified: true, actions: checked.actions, tokenRead: false }),
);
const marker = `Bot-Bots publish check ${new Date().toISOString()}`;
const prompt = `Make a tiny self-contained HTML test page with the exact visible heading "${marker}" and a friendly sentence saying the local bot and publishing connection work. Use page_create or a fenced HTML block to save it. Then publish it through the connected Bottools Pages API and pass back a short link. This authorizes one new test site with the default expiration. Do not research, delegate, delete existing sites, pin anything, or ask for a token or another connection. Keep the page under 1500 characters.`;
let run = await api<Run>('/runs', 'POST', {
  botId,
  prompt,
  clientMessageId: crypto.randomUUID(),
  options: { task: 'coding' },
});
writeFileSync(
  join(dir, 'task.json'),
  JSON.stringify({ id: run.id, conversationId: run.conversationId, prompt }, null, 2),
);
console.log(JSON.stringify({ runId: run.id, model: loaded.map((model) => model.name) }));
let previous = '';
for (let n = 0; n < 1200 && run.status === 'running'; n++) {
  await new Promise((done) => setTimeout(done, 500));
  run = await api<Run>(`/runs/${run.id}`);
  const event = run.events.at(-1)?.text ?? '';
  if (event !== previous) {
    console.log(JSON.stringify({ status: run.status, event }));
    previous = event;
  }
}
writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
assert.equal(run.status, 'completed', run.error ?? 'Live publishing did not complete.');
const finished = await api<Bootstrap>('/bootstrap');
const page = finished.pages.find((page) => page.runId === run.id && page.publication?.shortUrl);
assert.ok(
  page?.publication?.shortUrl,
  'A service-backed short link must exist; a local page is insufficient.',
);
const response = await fetch(page.publication.shortUrl, { signal: AbortSignal.timeout(45000) });
assert.equal(response.status, 200);
const html = await response.text();
assert.ok(html.includes(marker), 'The public short link must serve the newly generated HTML.');
const messages = await api<any[]>(`/conversations/${run.conversationId}/messages`);
const setups = await api<any[]>('/credentials/manager/requests');
assert.equal(
  setups.filter((request) => request.runId === run.id).length,
  0,
  'An already-connected API must not open another key window.',
);
assert.equal(
  messages.filter((message) => message.role === 'user' && message.content === prompt).length,
  1,
);
assert.ok(
  messages.some(
    (message) =>
      message.role === 'assistant' && message.content.includes(page.publication!.shortUrl!),
  ),
);
const result = {
  verified: true,
  version: health.version,
  runId: run.id,
  model: run.modelId,
  localOnly: true,
  connectedActions: checked.actions,
  tokenRead: false,
  site: page.publication.site,
  shortUrl: page.publication.shortUrl,
  publicUrl: page.publication.publicUrl,
  publicHtmlVerified: true,
  originalMessageRetained: true,
  repeatedKeyWindow: false,
  botProfilesChanged: false,
};
writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, evidence: dir }));
