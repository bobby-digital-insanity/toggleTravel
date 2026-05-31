'use strict';

const anthropic = require('../anthropic');
const logger = require('../logger');

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-5';
const FAST_MODEL = process.env.CLAUDE_FAST_MODEL || 'claude-haiku-4-5';

function tryParseJson(text) {
  if (!text) return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
    }
    const aStart = trimmed.indexOf('[');
    const aEnd = trimmed.lastIndexOf(']');
    if (aStart !== -1 && aEnd > aStart) {
      try { return JSON.parse(trimmed.slice(aStart, aEnd + 1)); } catch {}
    }
    return null;
  }
}

function buildConversationText(history) {
  if (!Array.isArray(history) || history.length === 0) return '(no prior turns)';
  return history
    .map((m) => `${(m.role || 'user').toUpperCase()}: ${m.content || ''}`)
    .join('\n');
}

async function callAgent({ agentName, model, system, userPrompt, maxTokens = 1024, sessionId }) {
  const startTime = Date.now();
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = response.content?.[0]?.text || '';
    logger.info('ai_planner_agent_call', {
      agent: agentName,
      model,
      duration_ms: Date.now() - startTime,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      stop_reason: response.stop_reason,
      session_id: sessionId,
    });
    return { text, usage: response.usage };
  } catch (err) {
    logger.warn('ai_planner_agent_error', {
      agent: agentName,
      model,
      duration_ms: Date.now() - startTime,
      error: err.message,
      session_id: sessionId,
    });
    throw err;
  }
}

async function intentAgent(userMessage, history, sessionId) {
  const system = `You are the Intent Agent for ToggleTravel's AI Travel Planner. Parse the user's latest message together with conversation history and extract structured travel intent. Respond ONLY with raw JSON (no markdown, no commentary). Schema: { "destination": string|null, "origin": string|null, "dates": string|null, "budget": number|null, "preferences": string[]|null, "readyToBook": boolean }. Set "readyToBook": true only when the user clearly signals they want to book (e.g. "book it", "let's do it", "yes, book").`;
  const userPrompt = `Conversation so far:\n${buildConversationText(history)}\n\nLatest user message: ${userMessage}\n\nReturn the intent JSON now.`;
  const { text } = await callAgent({ agentName: 'Intent Agent', model: FAST_MODEL, system, userPrompt, maxTokens: 400, sessionId });
  const parsed = tryParseJson(text) || {};
  return {
    destination: parsed.destination ?? null,
    origin: parsed.origin ?? null,
    dates: parsed.dates ?? null,
    budget: parsed.budget ?? null,
    preferences: parsed.preferences ?? null,
    readyToBook: parsed.readyToBook === true,
  };
}

async function searchAgent(intent, sessionId) {
  const system = `You are the Search Agent. Given a travel intent JSON, invent 3 realistic mock flight options as a JSON array. Respond ONLY with raw JSON array (no markdown). Each flight: { "flightId": string, "airline": string, "origin": string, "destination": string, "departureTime": ISO8601 string, "arrivalTime": ISO8601 string, "stops": number, "price": number (USD), "duration": string (e.g. "5h 20m") }. Use plausible carriers, realistic times, and prices that respect the budget if one was provided.`;
  const userPrompt = `Travel intent:\n${JSON.stringify(intent, null, 2)}\n\nGenerate the 3 flight options now.`;
  const { text } = await callAgent({ agentName: 'Search Agent', model: FAST_MODEL, system, userPrompt, maxTokens: 900, sessionId });
  const parsed = tryParseJson(text);
  return Array.isArray(parsed) ? parsed : [];
}

async function recommendationAgent(intent, flights, sessionId) {
  const system = `You are the Recommendation Agent. Given the user's intent and a list of flight options, rank them and explain the tradeoff for each. Respond ONLY with raw JSON: { "rankedFlights": [{ ...flight, "rank": number, "tradeoff": string }], "recommendation": string }. The "recommendation" field is a one-sentence pick of the top flight with a reason.`;
  const userPrompt = `Intent:\n${JSON.stringify(intent, null, 2)}\n\nFlight options:\n${JSON.stringify(flights, null, 2)}\n\nRank them now.`;
  const { text } = await callAgent({ agentName: 'Recommendation Agent', model: FAST_MODEL, system, userPrompt, maxTokens: 1200, sessionId });
  const parsed = tryParseJson(text) || {};
  return {
    rankedFlights: Array.isArray(parsed.rankedFlights) ? parsed.rankedFlights : flights,
    recommendation: typeof parsed.recommendation === 'string' ? parsed.recommendation : '',
  };
}

async function explainerAgent({ intent, ranked, history, userMessage, model, sessionId }) {
  const system = `You are a friendly travel assistant for ToggleTravel. Using the conversation context and any flight data provided, write a natural, helpful conversational reply to the user. Be concise. If flights are available, present the top recommendation clearly (airline, route, price, departure, duration) and offer to book. If you need more info, ask ONE focused question. Plain text — no markdown headings, no bullet lists longer than 3 items.`;
  const flightsBlock = ranked
    ? `Ranked flights from Recommendation Agent:\n${JSON.stringify(ranked, null, 2)}`
    : '(no flight data yet)';
  const userPrompt = `Conversation so far:\n${buildConversationText(history)}\n\nLatest user message: ${userMessage}\n\nParsed intent:\n${JSON.stringify(intent, null, 2)}\n\n${flightsBlock}\n\nWrite the reply now.`;
  const { text } = await callAgent({ agentName: 'Explainer Agent', model, system, userPrompt, maxTokens: 600, sessionId });
  return text.trim();
}

async function bookingAgent({ intent, ranked, history, userMessage, sessionId }) {
  const reference = 'TT-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const system = `You are the Booking Agent for ToggleTravel. The user wants to book. Confirm the selected flight details clearly, include the booking reference verbatim, and produce a friendly confirmation message. End with a one-line note that this is a demo booking. Plain text only.`;
  const flightsBlock = ranked
    ? `Ranked flights:\n${JSON.stringify(ranked, null, 2)}`
    : '(no specific flight selected — pick the most likely one from intent)';
  const userPrompt = `Conversation so far:\n${buildConversationText(history)}\n\nLatest user message: ${userMessage}\n\nIntent:\n${JSON.stringify(intent, null, 2)}\n\n${flightsBlock}\n\nUse this booking reference (do not invent another): ${reference}\n\nWrite the confirmation now.`;
  const { text } = await callAgent({ agentName: 'Booking Agent', model: FAST_MODEL, system, userPrompt, maxTokens: 500, sessionId });
  return { text: text.trim(), reference };
}

/**
 * Orchestrates the 5-agent pipeline.
 * @param {string} userMessage      Latest user turn
 * @param {Array}  conversationHistory  [{ role, content }]
 * @param {Object} opts
 * @param {string} opts.explainerModel  Resolved model name from LD AI Config
 * @param {string} opts.sessionId
 * @returns {{ reply: string, agentUsed: string, done: boolean }}
 */
async function runAIPlannerAgents(userMessage, conversationHistory = [], opts = {}) {
  const explainerModel = opts.explainerModel || DEFAULT_MODEL;
  const sessionId = opts.sessionId || 'anonymous';
  const pipelineStart = Date.now();

  // 1. Intent Agent — always runs
  let intent;
  try {
    intent = await intentAgent(userMessage, conversationHistory, sessionId);
  } catch (err) {
    return {
      reply: "Sorry — I had trouble understanding that. Could you rephrase what trip you're planning?",
      agentUsed: 'Intent Agent',
      done: false,
    };
  }

  // 5. Booking Agent — short-circuits the rest when ready to book
  if (intent.readyToBook) {
    try {
      // If we have flights from prior turns we'd ideally pass them, but server is stateless;
      // generate a fresh ranked set so the booking confirmation references a real option.
      let ranked = null;
      if (intent.destination || intent.origin) {
        const flights = await searchAgent(intent, sessionId);
        if (flights.length) {
          const rec = await recommendationAgent(intent, flights, sessionId);
          ranked = rec.rankedFlights;
        }
      }
      const { text } = await bookingAgent({ intent, ranked, history: conversationHistory, userMessage, sessionId });
      logger.info('ai_planner_pipeline_complete', {
        path: 'booking',
        duration_ms: Date.now() - pipelineStart,
        session_id: sessionId,
      });
      return { reply: text, agentUsed: 'Booking Agent', done: true };
    } catch (err) {
      logger.warn('ai_planner_booking_failed', { error: err.message, session_id: sessionId });
      return {
        reply: "I tried to lock in that booking but something hiccupped. Want to try again?",
        agentUsed: 'Booking Agent',
        done: false,
      };
    }
  }

  // 2 & 3. Search + Recommendation — only if we have at least a destination or origin
  let ranked = null;
  let agentUsed = 'Explainer Agent';
  if (intent.destination || intent.origin) {
    try {
      const flights = await searchAgent(intent, sessionId);
      if (flights.length) {
        const rec = await recommendationAgent(intent, flights, sessionId);
        ranked = rec.rankedFlights;
        agentUsed = 'Recommendation Agent';
      }
    } catch (err) {
      logger.warn('ai_planner_search_or_rec_failed', { error: err.message, session_id: sessionId });
      // fall through to explainer with no flight data
    }
  }

  // 4. Explainer Agent — always runs (produces user-facing reply)
  let reply;
  try {
    reply = await explainerAgent({
      intent,
      ranked,
      history: conversationHistory,
      userMessage,
      model: explainerModel,
      sessionId,
    });
  } catch (err) {
    logger.warn('ai_planner_explainer_failed', { error: err.message, session_id: sessionId });
    reply = "Hmm, my travel brain glitched for a moment. Can you tell me a bit more about where you'd like to go?";
  }

  logger.info('ai_planner_pipeline_complete', {
    path: ranked ? 'search_rec_explain' : 'explain_only',
    duration_ms: Date.now() - pipelineStart,
    session_id: sessionId,
  });

  return { reply, agentUsed, done: false };
}

module.exports = { runAIPlannerAgents };
