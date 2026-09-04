'use strict';

/**
 * Bridge to the new LaunchDarkly AI SDK (AgentControl) — the package set from
 * launchdarkly/js-ai-sdk, not the older `@launchdarkly/server-sdk-ai`.
 *
 * Why the new SDK for agent mode: agent graphs are first class here.
 * `resolveGraph()` returns the topology straight from LaunchDarkly (root, edges
 * and each edge's handoff JSON) with every node's agent config already
 * evaluated for the context, and `runNode()` executes one node through the
 * tracked invoke path — so per-node duration, tokens, tool calls and handoff
 * events land on the graph's Monitoring tab with no tracker plumbing in this
 * repo. Conversation mode still runs on the old SDK (see `launchdarkly.js`);
 * the two share one LDClient, so there is only ever one flag stream.
 *
 * Three things worth knowing before editing this file:
 *
 * 1. **The new SDK is ESM-only.** `@launchdarkly/ai-server` publishes only an
 *    `import` condition, and this app is CommonJS, so it is loaded through a
 *    cached dynamic `import()`. Every entry point here is async anyway.
 * 2. **Handler selection is by provider + LD mode.** The handler below
 *    registers as `['*', 'agent']`, so it serves every agent-mode node whatever
 *    provider LD names. A *messages* handler would not match an agent-mode
 *    config at all ("Handler for provider Anthropic with mode agent not
 *    found").
 * 3. **Tool results must be strings.** The handler does `String(result)` on
 *    whatever a tool returns, and `src/tools/` returns objects — which would
 *    reach the model as "[object Object]". `instrumentTools()` JSON-stringifies
 *    them (and records the call for the dev view).
 */

const logger = require('./logger');

const GRAPH_KEY = 'ai-planner-graph';

let sdkPromise = null;

// Cached dynamic import of the ESM packages. Rejections are not cached, so a
// transient failure does not poison the process.
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const server = await import('@launchdarkly/ai-server');
      return {
        resolveGraph: server.resolveGraph,
        getClient: server.getClient,
        initClient: server.initClient,
        createHandler: server.createHandler,
        parseTemplate: server.parseTemplate,
      };
    })().catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

let initPromise = null;

/**
 * Hand the new SDK the LDClient this app already created. Without this it would
 * lazily init its own client from LD_SDK_KEY — a second SDK instance and a
 * second streaming connection for the same environment.
 */
function initGraphSdk(ldClient) {
  if (!ldClient) return Promise.resolve(false);
  if (!initPromise) {
    initPromise = loadSdk()
      .then(({ initClient }) => initClient(ldClient))
      .then(() => {
        logger.info('ai_graph_sdk_ready', { message: 'LaunchDarkly AI SDK (AgentControl) sharing the app LDClient' });
        return true;
      })
      .catch((err) => {
        initPromise = null;
        logger.warn('ai_graph_sdk_init_failed', { error: err.message });
        return false;
      });
  }
  return initPromise;
}

/**
 * Wrap the tool registry for one node run: JSON-stringify object results (the
 * handler only calls String() on them) and push each invocation into `sink` so
 * the dev view can still show which tools a specialist actually called — the
 * new SDK reports tool calls as OTel spans and LD events, not in the response.
 */
function instrumentTools(registry, sink) {
  return Object.fromEntries(Object.entries(registry).map(([name, fn]) => [
    name,
    async (args) => {
      sink.push(name);
      const result = await fn(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  ]));
}

// Recover the answer text from a LangChain agent run. Claude 5 models return
// content as an array of blocks — [{type:'thinking'}, {type:'text'}] — and the
// stock handler's `typeof content === 'string' ? content : ''` therefore yields
// an EMPTY answer for every Opus 5 / Sonnet 5 node. Same class of bug as the
// old SDK's extractLastMessageContent (see CLAUDE.md); this is why the graph
// runs on the handler below rather than createLangChainAgentsHandler().
function extractText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

let handlerPromise = null;

/**
 * The provider handler every graph node runs through.
 *
 * Registered as `['*', 'agent']` — wildcard provider, agent mode — so it serves
 * every agent-mode node whatever provider LaunchDarkly names on it, and the
 * model still comes from each node's own AI Config (never from this file).
 *
 * It is a corrected copy of `createLangChainAgentsHandler()`, which is unusable
 * here for two reasons: it drops array-content answers (see `extractText`), and
 * it ignores the token budget LD serves in `model.parameters`. Sampling params
 * are deliberately NOT forwarded — `temperature`/`topP`/`topK` are a hard 400
 * on Opus 5 and Sonnet 5.
 *
 * Wrapping it in `createHandler` keeps everything the SDK does around a
 * handler: `$ld:ai:duration:total`, `generation:success|error`, `tokens:*`,
 * `tool_call`, judge evaluation and graph attribution.
 */
function loadAgentHandler() {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const { createHandler, parseTemplate } = await loadSdk();
      const [{ createAgent }, { ChatAnthropic }, messages, tools] = await Promise.all([
        import('langchain'),
        import('@langchain/anthropic'),
        import('@langchain/core/messages'),
        import('@langchain/core/tools'),
      ]);
      const { HumanMessage } = messages;
      const { tool } = tools;

      return createHandler(['*', 'agent'], async (cfg, userInput = '', toolHandlers = {}, variables = {}) => {
        const params = cfg.model?.parameters || {};
        const maxTokens = params.max_tokens ?? params.maxTokens ?? params.maxOutputTokens;
        const model = new ChatAnthropic({
          model: cfg.model?.name,
          ...(Number.isFinite(Number(maxTokens)) ? { maxTokens: Number(maxTokens) } : {}),
        });

        // LD declares each tool's name, description and JSON schema; the caller
        // supplies the implementations. A tool declared in LD with no
        // implementation is skipped, so registry keys must equal LD tool keys.
        const bound = Object.entries(cfg.tools || {})
          .filter(([name]) => typeof toolHandlers[name] === 'function')
          .map(([name, decl]) => tool(async (args) => String(await toolHandlers[name](args)), {
            name,
            description: decl.description || '',
            schema: decl.parameters,
          }));

        const systemPrompt = cfg.instructions
          ? parseTemplate(cfg.instructions, variables)
          : undefined;

        const agent = createAgent({ model, tools: bound, ...(systemPrompt ? { systemPrompt } : {}) });
        const result = await agent.invoke({ messages: [new HumanMessage(userInput)] });

        let inputTokens = 0;
        let outputTokens = 0;
        for (const msg of result.messages || []) {
          const usage = msg?.usage_metadata;
          if (usage) {
            inputTokens += Number(usage.input_tokens || 0);
            outputTokens += Number(usage.output_tokens || 0);
          }
        }

        return {
          output: extractText(result.messages),
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        };
      });
    })().catch((err) => {
      handlerPromise = null;
      throw err;
    });
  }
  return handlerPromise;
}

/**
 * Resolve the agent graph for this context. Returns null when LD has it off or
 * the topology is invalid — a missing root, a node unreachable from the root,
 * or any referenced agent config disabled disables the whole graph, matching
 * the Python SDK.
 */
async function resolveAgentGraph(context, variables = {}, tools = {}) {
  const [{ resolveGraph }, handler] = await Promise.all([loadSdk(), loadAgentHandler()]);
  const def = await resolveGraph(GRAPH_KEY, {
    context,
    handlers: [handler],
    toolHandlers: tools,
  });
  if (!def?.enabled) {
    logger.info('ai_graph_disabled', { graph_key: GRAPH_KEY });
    return null;
  }
  return def;
}

/**
 * Graph-level metrics. `runNode()` tracks each node and each handoff on its
 * own, but the whole-workflow events (`$ld:ai:graph:invocation_success`,
 * `:duration:total`, `:total_tokens`, `:path`) are only emitted by the SDK's
 * own `graph().invoke()` router. This app runs its own fan-out — supervisor
 * PLAN, specialists in parallel, supervisor COMPOSE — so it emits them here,
 * with one runId per turn and the graph flag's variation metadata, exactly as
 * the SDK's router builds it.
 */
function createGraphRun(ldClient, context, graphMeta = {}) {
  const trackData = {
    runId: require('node:crypto').randomUUID(),
    configKey: GRAPH_KEY,
    variationKey: graphMeta.variationKey || '',
    version: graphMeta.version || 1,
    modelName: '',
    providerName: '',
    graphKey: GRAPH_KEY,
  };

  const track = (event, value, extra) => {
    if (!ldClient) return;
    try {
      ldClient.track(event, context, extra ? { ...trackData, ...extra } : trackData, value);
    } catch (err) {
      logger.warn('ai_graph_track_failed', { event, error: err.message });
    }
  };

  return {
    trackData,
    path: (path) => track('$ld:ai:graph:path', path.length, { path }),
    duration: (ms) => track('$ld:ai:graph:duration:total', ms),
    tokens: (total) => { if (total > 0) track('$ld:ai:graph:total_tokens', total); },
    success: () => track('$ld:ai:graph:invocation_success', 1),
    failure: () => track('$ld:ai:graph:invocation_failure', 1),
  };
}

module.exports = { GRAPH_KEY, loadSdk, initGraphSdk, instrumentTools, resolveAgentGraph, createGraphRun, extractText };
