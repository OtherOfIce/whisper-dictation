const { test } = require('node:test');
const assert = require('node:assert/strict');
const vault = require('../vault.cjs');

// The same vectors are asserted by VaultCryptoTest.kt on Android. Change one side and the other must follow.
const vector = {
  passphrase: '  correct horse Ａ battery  ', salt: 'AAECAwQFBgcICQoLDA0ODw==',
  key: '7c2970c29d1bc08f5a224ef541f346aa5addc83a324b52cd15d94af49939e521',
  nonce: Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex'),
  envelope: 'v1.oKGio6Slpqeoqaqr.F/CGK5eGYE7T/1iGQXPx3ceFsoibx2pT4mOLQtA=',
  unicode: 'v1.oKGio6Slpqeoqaqr.D1gCPchoqlIOFKlk0fE0+WcKY7LVMpEanw1WeA==',
  // account and pairing derivations
  username: ' Me@Example.com ',
  authKey: 'GLHrglZtkHK2UycowgDZiHqjj5F0/TVm84ybNTzIBic=',
  wrapKey: 'b97a3984ddeb7335706d4e74eac4dec26e342df89d8a5988fdc1642e1672bb10',
  pairCode: '7k3m-q9xz-04ab',
  pairId: '552b3fb0263a87d952ba66d4fac15d00ea10b8d96a725d845ae380f5626f38ce',
  pairKey: 'cf2a993e37b4b2a15878b330bbb2f23d00fddc53e0f7ee4e12cc0c0ec9ff7e8d',
  pairPayload: 'v1.oKGio6Slpqeoqaqr.6UMglo0VqWH52jJRDPHzpI2sG77PkAavngTcwlwSHFtPpyvrureSLD/LqtfJ2/t8ACCivDgD3grP87W3pLBXSN8Dg2DkR91U549y5NnZuAbDJlpuiByskw08LWUmhudrEzg=',
  secretsKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
};

test('seals to the shared envelope', () => {
  const key = Buffer.from(vector.key, 'hex');
  assert.equal(vault.seal(key, 'secrets.openrouter', 'sk-or-v1-test', vector.nonce), vector.envelope);
  assert.equal(vault.seal(key, 'secrets.xai', 'kéy-ü-🔑', vector.nonce), vector.unicode);
  assert.equal(vault.open(key, 'secrets.openrouter', vector.envelope), 'sk-or-v1-test');
  assert.equal(vault.open(key, 'secrets.xai', vector.unicode), 'kéy-ü-🔑');
});

test('derives the account keys and pairing keys the same way everywhere', async () => {
  const account = await vault.deriveAccount(vector.username, vector.passphrase);
  assert.deepEqual([account.authKey, account.wrapKey.toString('hex')], [vector.authKey, vector.wrapKey]);
  const pairing = await vault.derivePairing(vector.pairCode);
  assert.deepEqual([pairing.pairId, pairing.key.toString('hex')], [vector.pairId, vector.pairKey]);
  assert.equal(vault.seal(pairing.key, 'pairing', JSON.stringify({ v: 1, keyring: { v: 1, secrets: vector.secretsKey } }), vector.nonce), vector.pairPayload);
});

test('usernames and pairing codes are normalised and checked', () => {
  assert.equal(vault.normalizeUsername('  Me@X.CO '), 'me@x.co');
  for (const bad of ['', 'me', 'a b@c.co']) assert.throws(() => vault.normalizeUsername(bad));
  assert.equal(vault.normalizePairCode(' 7k3m q9xz-04ab '), '7K3MQ9XZ04AB');
  assert.equal(vault.normalizePairCode('o1il-0000-0000'), '011100000000', 'O, I and L read as 0 and 1');
  for (const bad of ['', '7K3M-Q9XZ-04A', '7K3M-Q9XZ-04ABC', 'UUUU-UUUU-UUUU']) assert.equal(vault.normalizePairCode(bad), null);
  for (let index = 0; index < 20; index++) assert.match(vault.generatePairCode(), /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
});

test('the keyring opens only with the passphrase that sealed it', async () => {
  const { wrapKey } = await vault.deriveAccount('me@x.co', 'open sesame please', 1000);
  const keyring = vault.newKeyring();
  assert.equal(Buffer.from(keyring.secrets, 'base64').length, 32);
  assert.notEqual(keyring.secrets, keyring.history);
  const sealed = vault.sealKeyring(wrapKey, keyring);
  assert.deepEqual(vault.openKeyring(wrapKey, sealed), keyring);
  const other = await vault.deriveAccount('me@x.co', 'open sesame please!', 1000);
  assert.throws(() => vault.openKeyring(other.wrapKey, sealed), /does not open/);
});

test('passphrases are normalised the same way everywhere', () => {
  assert.equal(vault.normalizePassphrase('  Ａb c \n'), 'Ab c');
  assert.equal(vault.normalizePassphrase(' x'), 'x', 'compatibility spaces become ASCII spaces before trimming');
  assert.equal(vault.normalizePassphrase('​x'), '​x', 'other invisible characters are kept');
});

test('a sealed value only opens with its key and its own item name', async () => {
  const key = Buffer.from(vector.key, 'hex');
  assert.throws(() => vault.open(key, 'secrets.xai', vector.envelope), 'moved to another item');
  assert.throws(() => vault.open(Buffer.alloc(32, 1), 'secrets.openrouter', vector.envelope), 'wrong key');
  const damaged = vector.envelope.replace(/.$/, character => character === 'A' ? 'B' : 'A');
  assert.throws(() => vault.open(key, 'secrets.openrouter', damaged), 'tampered');
  for (const bad of ['', 'v2.a.b', 'v1.a', 'v1..b', 'v1.a.AAAA']) assert.throws(() => vault.open(key, 'secrets.openrouter', bad));
  assert.notEqual(vault.seal(key, 'secrets.openrouter', 'x'), vault.seal(key, 'secrets.openrouter', 'x'), 'a fresh nonce each time');
});

test('reconcile decides what to send, take or leave for each item', () => {
  const now = 10_000;
  const d = value => vault.digest('x', value);
  const remote = (value, updatedAt) => ({ digest: d(value), updatedAt });
  const base = (value, updatedAt) => ({ digest: d(value), updatedAt });
  const cases = [
    // first contact: the account wins, otherwise this device's value is sent
    ['first contact, account has a value', d('A'), remote('B', 500), undefined, { pull: true, base: base('B', 500) }],
    ['first contact, same value', d('A'), remote('A', 500), undefined, { pull: false, base: base('A', 500) }],
    ['first contact, nothing in the account', d('A'), undefined, undefined, { push: { updatedAt: now } }],
    ['first contact, account value was deleted', d('A'), remote(null, 500), undefined, { push: { updatedAt: now } }],
    ['first contact, nothing anywhere', null, undefined, undefined, { base: base(null, 0) }],
    ['first contact, empty here, account deleted', null, remote(null, 500), undefined, { base: base(null, 500) }],
    // afterwards the side that changed wins
    ['nothing changed', d('A'), remote('A', 500), base('A', 500), { base: base('A', 500) }],
    ['edited here', d('B'), remote('A', 500), base('A', 500), { push: { updatedAt: now } }],
    ['deleted here', null, remote('A', 500), base('A', 500), { push: { updatedAt: now } }],
    ['edited elsewhere', d('A'), remote('B', 800), base('A', 500), { pull: true, base: base('B', 800) }],
    ['deleted elsewhere', d('A'), remote(null, 800), base('A', 500), { pull: true, base: base(null, 800) }],
    ['both edited, this device wins', d('C'), remote('B', 800), base('A', 500), { push: { updatedAt: now } }],
    ['both reached the same value', d('B'), remote('B', 800), base('A', 500), { base: base('B', 800) }],
    ['edited here with a clock behind the account', d('B'), remote('A', 99_999), base('A', 500), { push: { updatedAt: 100_000 } }],
    ['nothing changed, no remote record', d('A'), undefined, base('A', 500), { base: base('A', 500) }]
  ];
  for (const [label, local, remoteState, baseState, expected] of cases) assert.deepEqual(vault.reconcile(local, remoteState, baseState, now), expected, label);
});

test('digests keep values out of bookkeeping and differ per item', () => {
  assert.equal(vault.digest('a', null), null);
  assert.notEqual(vault.digest('a', 'k'), vault.digest('b', 'k'));
  assert.ok(!vault.digest('a', 'sk-secret').includes('secret'));
});
