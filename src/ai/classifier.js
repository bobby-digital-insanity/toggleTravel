'use strict';

/**
 * Complexity classifier — the routing "brain" is LD config, not code.
 *
 * Its model and prompt live in the LD AI Config `ai-planner-classifier`. The
 * verdict (`simple` | `complex`) is stamped onto the LD context as
 * `complexity`, and the `ai-planner` / `ai-planner-agent` configs' TARGETING
 * RULES in LaunchDarkly decide which model answers — the code never picks cheap
 * vs. strong itself. Fails safe to `simple` (the cheap path) on any error.
 */

const { invokeConfig, isDisabledError } = require('./invoke');
const logger = require('../logger');

const CLASSIFIER_CONFIG_KEY = 'ai-planner-classifier';

async function classifyMessage(message, context, variables = {}) {
  const startedAt = Date.now();
  try {
    const { response, usage, trackData } = await invokeConfig(CLASSIFIER_CONFIG_KEY, {
      context, input: message, variables,
    });
    const complexity = String(response || '').toLowerCase().includes('complex') ? 'complex' : 'simple';
    return {
      complexity,
      debug: {
        configKey: CLASSIFIER_CONFIG_KEY,
        variationKey: trackData?.variationKey || null,
        version: trackData?.version ?? null,
        model: trackData?.modelName || null,
        verdict: complexity,
        durationMs: Date.now() - startedAt,
        tokens: usage || null,
      },
    };
  } catch (err) {
    if (isDisabledError(err)) {
      return { complexity: 'simple', debug: { configKey: CLASSIFIER_CONFIG_KEY, skipped: 'config disabled', fellBackTo: 'simple' } };
    }
    logger.warn('ai_planner_classify_failed', { error: err.message });
    return {
      complexity: 'simple',
      debug: { configKey: CLASSIFIER_CONFIG_KEY, error: err.message, durationMs: Date.now() - startedAt, fellBackTo: 'simple' },
    };
  }
}

module.exports = { classifyMessage, CLASSIFIER_CONFIG_KEY };
