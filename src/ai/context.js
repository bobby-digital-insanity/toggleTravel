'use strict';

/**
 * The LaunchDarkly evaluation context for one AI Planner request, and the
 * prompt variables derived from it. Shared by conversation mode, agent mode
 * and the supervisor so every flag evaluation, AI Config resolution and custom
 * event on this feature sees the same identity.
 *
 * Shape: a multi-context — the person and the browser session are two kinds,
 * so a flag can target either ("agent mode for Platinum+" targets `user.tier`;
 * a per-session kill switch targets `session.key`), and custom events carry
 * the person's attributes for metric breakdowns by tier.
 *
 *   { kind: 'multi',
 *     user:    { key, name?, tier?, anonymous?, complexity? },
 *     session: { key: <x-session-id>, anonymous: true } }
 *
 * `complexity` is stamped onto the user part by the classifier before the
 * planner config is resolved; the `ai-planner` targeting rules read it.
 */

const { findUser, isValidTier } = require('../users');
const logger = require('../logger');

const ANON_KEY_RE = /^anon-/i;

// The user half of the multi-context — every attribute read goes through here
// so the rest of the code never has to know the context is a multi.
function userOf(context) {
  if (!context) return {};
  return context.kind === 'multi' ? (context.user || {}) : context;
}

/**
 * Build the context from the headers the AI Planner page sends.
 *
 * The tier is resolved SERVER-SIDE: `x-user-key` is looked up in the user
 * store and the store's tier wins. `x-user-tier` is honoured only for keys the
 * store does not know (synthetic load-gen personas), and only if it is one of
 * the tiers the app actually has; a header that disagrees with the store is
 * logged as `tier_header_mismatch` and ignored — a browser must not be able to
 * upgrade itself to the Opus tier by editing a header.
 */
function buildContext(req) {
  const sessionId = req.sessionId || req.get('x-session-id') || null;
  const rawKey = req.get('x-user-key') || sessionId || 'anonymous';
  const headerTier = String(req.get('x-user-tier') || '').trim().toLowerCase() || null;
  const headerName = req.get('x-user-name') || null;

  const known = findUser(rawKey);
  const user = { key: rawKey };

  if (known) {
    user.tier = known.tier;
    user.name = headerName || known.name;
    if (headerTier && headerTier !== known.tier) {
      logger.warn('tier_header_mismatch', {
        user_key: rawKey, header_tier: headerTier, resolved_tier: known.tier,
        message: 'x-user-tier disagreed with the user store; the store wins',
      });
    }
  } else {
    if (headerName) user.name = headerName;
    if (headerTier) {
      if (isValidTier(headerTier)) {
        user.tier = headerTier;
        user.tierSource = 'header'; // unverified — the key is not in the store
      } else {
        logger.warn('tier_header_invalid', { user_key: rawKey, header_tier: headerTier });
      }
    }
  }

  // Visitors with no identity are anonymous: LD keeps them out of the
  // Contexts list and does not index their attributes.
  if (!known && (ANON_KEY_RE.test(rawKey) || rawKey === 'anonymous' || rawKey === sessionId)) {
    user.anonymous = true;
  }

  const context = { kind: 'multi', user };
  if (sessionId) context.session = { key: sessionId, anonymous: true };
  return context;
}

// Stamp the classifier's verdict onto the user part (where the targeting
// rules read it). Returns the same context object.
function withComplexity(context, complexity) {
  userOf(context).complexity = complexity;
  return context;
}

// A copy of the context with a different complexity — for the judge-triggered
// retry, which re-resolves the planner config as if the request were complex.
function asComplexity(context, complexity) {
  const user = { ...userOf(context), complexity };
  return context.kind === 'multi' ? { ...context, user } : user;
}

/**
 * Prompt variables for every AI Config resolution on this feature. The LD AI
 * SDK Mustache-renders these into the config's messages (completion/judge
 * configs) or instructions (agent configs), so a prompt authored in
 * LaunchDarkly can say
 *
 *   You are a support agent for {{product_tier}} customers.
 *   Address the user as {{user_name}}.
 *
 * and the personalization is config, not string-building in code. The SDK also
 * injects the raw context (`ldctx` in the old SDK, `ldContext` in the new); we
 * add `ldctx` explicitly so either name resolves to the user attributes.
 */
function buildPromptVariables(context) {
  const user = userOf(context);
  const displayName = String(user.name || '').trim();
  const rawTier = String(user.tier || 'standard');
  return {
    // Display name — falls back to a neutral noun so the prompt never renders
    // "Address the user as ." for anonymous visitors.
    user_name: displayName || 'traveler',
    user_key: user.key,
    // Title Case for the prompt ("Diamond"); the context attribute stays
    // lowercase because that is what the targeting rules in LD match on.
    product_tier: rawTier.charAt(0).toUpperCase() + rawTier.slice(1),
    tier_key: rawTier.toLowerCase(),
    // Truthy/falsy so prompts can use Mustache sections:
    // {{#signed_in}}Greet {{user_name}} by name.{{/signed_in}}
    signed_in: !!displayName,
    today: new Date().toISOString().slice(0, 10),
    // Legacy aliases — earlier variations of these prompts referenced
    // {{name}}/{{tier}}. Kept so an unedited variation keeps rendering.
    name: displayName || 'traveler',
    tier: rawTier.charAt(0).toUpperCase() + rawTier.slice(1),
    ldctx: user,
  };
}

// Compact identity for logs and the dev view.
function describeContext(context) {
  const user = userOf(context);
  return {
    kind: context?.kind || 'user',
    key: user.key || null,
    name: user.name || null,
    tier: user.tier || null,
    tierSource: user.tierSource || (user.tier ? 'store' : null),
    anonymous: !!user.anonymous,
    complexity: user.complexity || null,
    session: context?.session?.key || null,
  };
}

module.exports = { buildContext, userOf, withComplexity, asComplexity, buildPromptVariables, describeContext };
