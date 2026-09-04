'use strict';

/**
 * Simple overnight load generator for the AI Planner chatbot.
 *
 * Every INTERVAL it sends one conversation-mode chat per persona (a Diamond
 * and a Gold user; LaunchDarkly's targeting rules on `complexity` — and, for
 * Diamond + complex, on tier — decide which Claude model answers), so by
 * morning the AI Config Monitoring tabs show steady per-variation traffic,
 * tokens, judge scores and cost. With --agent it also sends a small number of
 * agent-mode turns so the agent graph's Monitoring tab has traffic too.
 *
 *   node scripts/chat-load.js                              # localhost:3000, every 60s, forever
 *   node scripts/chat-load.js --host http://1.2.3.4        # against a remote/EC2 host
 *   node scripts/chat-load.js --interval 120 --rounds 30   # slower, and stop after 30 rounds
 *   node scripts/chat-load.js --agent 4                    # plus one agent turn every 4th round
 *
 * No dependencies — it just makes HTTP calls to a running server (the server
 * holds the LD + provider keys and reports metrics to LaunchDarkly).
 */

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const HOST = arg('host', 'http://localhost:3000').replace(/\/$/, '');
const INTERVAL_MS = parseInt(arg('interval', '60'), 10) * 1000;
const ROUNDS = parseInt(arg('rounds', '0'), 10); // 0 = run forever
// Agent turns cost ~30x a conversation turn: send one every N rounds (0 = never).
const AGENT_EVERY = parseInt(arg('agent', '0'), 10);

// Real personas from the server-side user store (src/users.js) — the server
// resolves the tier from the key, so the header is just a hint.
const USERS = [
  { label: 'diamond', key: 'diamond@toggletravel.io', tier: 'diamond', name: 'Diamond User' },
  { label: 'gold',    key: 'gold@toggletravel.io',    tier: 'gold',    name: 'Gold User' },
];

// Mix of simple, complex, and live-data (judge-failing) questions so the
// classifier, judge, and retry all get exercised over the night.
const QUESTIONS = [
  "What's the typical carry-on baggage allowance for an economy flight to Miami?",
  'Do I need a passport to fly from Denver to Cancun?',
  "What's the best month to visit Tokyo for cherry blossoms?",
  'How early should I arrive for a domestic flight?',
  'My flight to Miami was cancelled and I have a cruise the next day — what are my rebooking and refund options, and would insurance cover a hotel?',
  'I missed my connection because my first flight was delayed three hours; can I get rebooked tonight and am I owed compensation?',
  'How much exactly does it cost to upgrade to first class on the Denver to Miami flight next Friday?',
  "What's the current status of flight TT-204 from Denver to Miami tonight?",
];

// Agent-mode questions: one specialist, the full fan-out, and an unanswerable one.
const AGENT_QUESTIONS = [
  'Will it rain in Kyoto next week?',
  'Which of your destinations is the best value per night?',
  'Find me somewhere under $2500 that sits in the 70s next week with no storms and a serious food scene — and tell me whether I should shift my dates.',
  "What's the cheapest business-class fare to Tokyo next Tuesday, and will my flight be delayed?",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function stamp() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

async function sendOne(user, { agent = false } = {}) {
  const message = agent ? pick(AGENT_QUESTIONS) : pick(QUESTIONS);
  const started = Date.now();
  const path = agent ? '/api/ai-planner/agent-chat' : '/api/ai-planner/chat';
  try {
    const res = await fetch(HOST + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': user.key,
        'x-user-key': user.key,
        'x-user-tier': user.tier,
        'x-user-name': user.name,
      },
      body: JSON.stringify({ message }),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      console.log(`[${stamp()}] ${user.label.padEnd(7)} ${agent ? 'AGENT ' : ''}HTTP ${res.status} (${ms}ms)`);
      return;
    }
    const data = await res.json();
    const m = data.meta || {};
    const dbg = data.debug || {};
    const judge = dbg.judge && dbg.judge.verdict ? ` judge=${dbg.judge.verdict}` : '';
    const judgesList = Array.isArray(dbg.judges) && !dbg.judge
      ? ' judges=' + dbg.judges.map((j) => `${j.kind}:${j.verdict || '?'}`).join(',')
      : '';
    const retried = dbg.retry && dbg.retry.retried ? ' RETRIED' : '';
    const agentInfo = agent ? ` specialists=${(m.specialists || []).join('+') || 'none'} tools=${m.toolCalls ?? '?'}` : '';
    console.log(`[${stamp()}] ${user.label.padEnd(7)} ${agent ? 'AGENT ' : ''}model=${m.model} variation=${m.variationKey} complexity=${m.complexity}${judge}${judgesList}${retried}${agentInfo} (${ms}ms)`);
  } catch (err) {
    console.log(`[${stamp()}] ${user.label.padEnd(7)} ERROR ${err.message}`);
  }
}

// Recursive timeout (not setInterval) so rounds never overlap, even if a round
// runs long due to a judge-triggered retry.
async function loop(n) {
  if (ROUNDS && n > ROUNDS) { console.log(`Done after ${ROUNDS} rounds.`); return; }
  console.log(`--- round ${n} @ ${stamp()} ---`);
  for (const user of USERS) await sendOne(user); // sequential = gentler on rate limits
  if (AGENT_EVERY && n % AGENT_EVERY === 0) await sendOne(pick(USERS), { agent: true });
  setTimeout(() => loop(n + 1), INTERVAL_MS);
}

console.log(`Chat load gen → ${HOST} | every ${INTERVAL_MS / 1000}s | ${ROUNDS ? ROUNDS + ' rounds' : 'forever (Ctrl-C to stop)'}${AGENT_EVERY ? ` | agent turn every ${AGENT_EVERY} rounds` : ''}`);
loop(1);
