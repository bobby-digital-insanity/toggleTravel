'use strict';

/**
 * Standalone Gemini connection test. Proves the API key + model work before
 * touching the app. Run with:
 *
 *   node scripts/gemini-test.js
 */

require('dotenv').config();

const { chat, MODEL } = require('../src/gemini');

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY is not set in .env');
    process.exit(1);
  }

  console.log(`→ Model: ${MODEL}`);
  console.log('→ Sending a test message to Gemini...\n');

  try {
    const { text, usage, stopReason } = await chat(
      [{ role: 'user', content: 'Reply with a short one-sentence hello and name the model you are.' }],
      { system: 'You are a travel assistant for Toggle Travel.' },
    );
    console.log('✅ Gemini responded:\n');
    console.log('   ' + (text || '(empty)').replace(/\n/g, '\n   '));
    console.log('\n— finishReason:', stopReason, '| tokens:', JSON.stringify(usage));
  } catch (err) {
    console.error('❌ Gemini call failed:');
    console.error('   name:    ', err.name);
    console.error('   message: ', err.message);
    if (err.status) console.error('   status:  ', err.status);
    process.exit(1);
  }
}

main();
