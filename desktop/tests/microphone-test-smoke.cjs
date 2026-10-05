// Optional hardware check. Captures the system-default input locally; no API calls or files.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const assert = require('node:assert/strict');
const child = spawn(process.env.LOCAL_WHISPER_ENGINE || path.join(__dirname, '../../dist/engine/LocalWhisper.exe'), ['--engine', '--no-hook'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(), events = [];
let nextId = 0, readyResolve;
const ready = new Promise(resolve => { readyResolve = resolve; });
const timeout = setTimeout(() => { child.kill(); console.error('Microphone test timed out'); process.exitCode = 1; }, 20000);
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
createInterface({ input: child.stdout }).on('line', line => {
  const event = JSON.parse(line);
  if (event.type === 'ready') readyResolve();
  if (event.type === 'reply') {
    const request = pending.get(event.id); pending.delete(event.id);
    if (request) event.error ? request.reject(new Error(event.error)) : request.resolve(event.result);
  } else events.push(event);
});
child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timeout); if (code !== 0) process.exitCode = 1; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await ready;
  await assert.rejects(call('startMicrophoneTest', { microphoneDeviceId: 'nonexistent-test-device' }), /unavailable|connected|found/i);
  await call('startMicrophoneTest', { microphoneDeviceId: '' });
  await assert.rejects(call('startMicrophoneTest', { microphoneDeviceId: '' }), /Finish/);
  await assert.rejects(call('saveSettings', {}), /Stop the microphone test/);
  await wait(250);
  await call('stopMicrophoneTest', { playback: true });
  const first = events.find(event => event.type === 'microphoneTestStopped');
  assert(first && !first.error, first?.error || 'Missing microphone test result');
  const wav = Buffer.from(first.audio, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert(wav.length > 44, 'Microphone test should contain captured samples');
  assert(events.some(event => event.type === 'microphoneTestLevel' && event.seconds > 0));
  events.length = 0;
  await call('startMicrophoneTest', { microphoneDeviceId: '' });
  await wait(150);
  await call('stopMicrophoneTest', { playback: false });
  assert.equal(events.find(event => event.type === 'microphoneTestStopped').audio, null);
  events.length = 0;
  await call('startMicrophoneTest', { microphoneDeviceId: '' });
  await wait(5500);
  const autoStopped = events.find(event => event.type === 'microphoneTestStopped');
  assert(autoStopped?.audio && !autoStopped.error, 'Five-second test should stop automatically');
  assert(!events.some(event => event.type === 'transcript'), 'Test audio must never enter dictation history');
  await call('state');
  await wait(50);
  assert(events.filter(event => event.type === 'state').every(event => event.mode === 'Idle'));
  child.stdin.write(JSON.stringify({ id: ++nextId, method: 'shutdown' }) + '\n');
  console.log('PASS: microphone samples, levels, playback WAV, cancellation, automatic stop, and recording guards');
})().catch(error => { console.error(error); process.exitCode = 1; child.kill(); });
