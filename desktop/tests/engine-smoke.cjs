const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const assert = require('node:assert/strict');
const child = spawn(path.join(__dirname, '../../dist/engine/LocalWhisper.exe'), ['--engine', '--no-hook'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const timer = setTimeout(() => { child.kill(); console.error('Engine protocol timed out'); process.exitCode = 1; }, 10000);
let ready = false, settings = false, idle = false;
createInterface({ input: child.stdout }).on('line', line => {
  try {
    const event = JSON.parse(line);
    if (event.type === 'ready') { ready = true; child.stdin.write('{"id":1,"method":"settings"}\n{"id":2,"method":"state"}\n'); }
    if (event.type === 'reply' && event.id === 1) {
      assert.equal(typeof event.result.hasKey, 'boolean'); assert(!('apiKey' in event.result)); settings = true;
      assert(['gpt-transcribe', 'mai-transcribe-2-verbatim', 'mai-transcribe-2-clean'].includes(event.result.transcriptionModel));
      assert(['off', 'luna', 'luna-fast'].includes(event.result.cleanupMode));
      assert.equal(typeof event.result.lockMode, 'boolean');
      assert(Array.isArray(event.result.dictionaryTerms));
    }
    if (event.type === 'state') { assert.equal(event.mode, 'Idle'); idle = true; }
    if (ready && settings && idle) child.stdin.write('{"id":3,"method":"shutdown"}\n');
  } catch (error) { clearTimeout(timer); child.kill(); console.error(error); process.exitCode = 1; }
});
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); if (code !== 0 || !ready || !settings || !idle) process.exitCode = 1; else console.log('PASS: native engine IPC, hidden idle state, settings without secrets, shutdown'); });
