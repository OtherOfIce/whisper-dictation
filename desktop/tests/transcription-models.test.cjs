const test = require('node:test');
const assert = require('node:assert/strict');
const { definition, validateModelDictionary } = require('../transcription-models.cjs');
const { settings } = require('./fixtures.cjs');

test('model capabilities determine credentials and dictionary limits independently of streaming', () => {
  assert.equal(definition(settings, 'mai-transcribe-2-streaming').credential, 'gateway');
  const terms = Array(101).fill('a long dictionary term');
  assert.doesNotThrow(() => validateModelDictionary(settings, 'mai-transcribe-2-streaming', terms));
  assert.throws(() => validateModelDictionary(settings, 'grok-voice-transcribe-2-streaming', terms), /100/);
  assert.throws(() => definition(settings, 'unknown-model'), /Invalid/);
});
