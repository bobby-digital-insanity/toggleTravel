'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../logger');
const destinations = require('../data/destinations.json');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function toggle({ enabled, preferences = {}, bookingHistory = [] }) {
  const model = process.env.CLAUDE_MODEL || 'claude-opus-4-5';
  const startTime = Date.now();

  const destinationList = destinations
    .map((d) => `${d.id}: ${d.name} (${d.region}, $${d.basePrice})`)
    .join('\n');

  let userPrompt;
  if (enabled) {
    const prefsText = Object.keys(preferences).length
      ? `User preferences: budget=${preferences.budget || 'flexible'}, duration=${preferences.duration || 'flexible'}, style=${preferences.style || 'any'}.`
      : 'No specific preferences provided.';
    const historyText = bookingHistory.length
      ? `Booking history: ${bookingHistory.map((b) => b.destinationName).join(', ')}.`
      : 'No booking history yet.';

    userPrompt = `The user has just enabled Vacation Mode on Toggle Travel. ${prefsText} ${historyText}

Available destinations:
${destinationList}

Please respond with a JSON object (no markdown, just raw JSON) with exactly these fields:
{
  "welcomeMessage": "A warm, personalized welcome message under 3 sentences. Make them feel excited about their next adventure.",
  "recommendedDestinationIds": ["dest-XXX", "dest-XXX", "dest-XXX"],
  "vacationVibe": "A one-sentence tagline capturing the user's travel vibe for the banner.",
  "travelPersona": "A fun 2-3 word travel persona label e.g. 'Adventure Seeker', 'Culture Connoisseur', 'Beach Lover'"
}`;
  } else {
    userPrompt = `The user has just disabled Vacation Mode on Toggle Travel. Write a warm, brief farewell message (2 sentences max) that acknowledges their adventure spirit and encourages them to return. Be friendly and leave them excited to plan their next trip. Respond with just the message text, no JSON.`;
  }

  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system:
      'You are a friendly, knowledgeable travel concierge AI embedded in Toggle Travel, a premium travel booking platform. You help users discover and plan their perfect vacations. Be warm, enthusiastic, and inspirational.',
    messages: [{ role: 'user', content: userPrompt }],
  });

  const durationMs = Date.now() - startTime;
  const rawContent = response.content[0].text;

  logger.info('vacation_mode_toggled', {
    enabled,
    model,
    duration_ms: durationMs,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    stop_reason: response.stop_reason,
  });

  if (enabled) {
    try {
      const parsed = JSON.parse(rawContent);
      return { enabled, ...parsed };
    } catch {
      logger.warn('vacation_mode_json_parse_failed', { raw: rawContent.slice(0, 100) });
      return {
        enabled,
        welcomeMessage: rawContent,
        recommendedDestinationIds: [],
        vacationVibe: 'Your adventure awaits.',
        travelPersona: 'World Explorer',
      };
    }
  } else {
    return { enabled, farewellMessage: rawContent };
  }
}

module.exports = { toggle };
