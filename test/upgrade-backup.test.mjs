import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { prepareUpgradeBackup, upgradeVersion } from '../src/upgrade-backup.mjs';

const key = Buffer.alloc(32, 8);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, filename: join(directory, 'store.sqlite') };
}

test('old persistent DB receives one consistent pre-migration backup including WAL and managed key config', t => {
  const { directory, filename } = fixture(t), old = new DatabaseSync(filename);
  old.exec('PRAGMA journal_mode=WAL; CREATE TABLE historical(value TEXT); INSERT INTO historical VALUES (\'saved\')');
  writeFileSync(join(directory, 'service-config.json'), '{"encryptionKey":"synthetic-test-only"}');
  const store = new Store({ filename, key });
  const backups = readdirSync(join(directory, 'upgrade-backups')).filter(file => file.endsWith('.sqlite'));
  assert.equal(backups.length, 1);
  const backupPath = join(directory, 'upgrade-backups', backups[0]), backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(backup.prepare('SELECT value FROM historical').get().value, 'saved');
  assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_meta'").get(), undefined);
  assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='accounts'").get(), undefined);
  assert.equal(readFileSync(`${backupPath}.service-config.json`, 'utf8'), readFileSync(join(directory, 'service-config.json'), 'utf8'));
  assert.match(readFileSync(`${backupPath}.restore.txt`, 'utf8'), /original environment encryption key/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, 'upgrade-backups')).mode & 0o777, 0o700);
  }
  backup.close(); store.close(); old.close();
  const reopened = new Store({ filename, key });
  assert.equal(reopened.db.prepare('SELECT version FROM upgrade_meta').get().version, upgradeVersion);
  reopened.close();
  assert.equal(readdirSync(join(directory, 'upgrade-backups')).filter(file => file.endsWith('.sqlite')).length, 1);
});

test('fresh and in-memory databases do not create backup files, including after reopen', t => {
  const { directory, filename } = fixture(t);
  new Store({ filename, key }).close();
  new Store({ filename, key }).close();
  new Store({ key }).close();
  assert.equal(readdirSync(directory).includes('upgrade-backups'), false);
  const memory = new DatabaseSync(':memory:');
  assert.equal(prepareUpgradeBackup(memory, ':memory:'), null);
  memory.close();
});

test('backup failure aborts before migration and database remains available for repair', t => {
  const { directory, filename } = fixture(t), old = new DatabaseSync(filename);
  old.exec("CREATE TABLE historical(value TEXT); INSERT INTO historical VALUES ('original')");
  old.close();
  writeFileSync(join(directory, 'upgrade-backups'), 'deliberate path collision');
  assert.throws(() => new Store({ filename, key }));
  const inspect = new DatabaseSync(filename);
  assert.equal(inspect.prepare("SELECT 1 FROM sqlite_master WHERE name='accounts' OR name='upgrade_meta'").get(), undefined);
  assert.equal(inspect.prepare('SELECT value FROM historical').get().value, 'original');
  inspect.exec('BEGIN EXCLUSIVE; COMMIT');
  inspect.close();
});
