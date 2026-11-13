import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync, constants } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const upgradeVersion = '3.2.0';

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { chmodSync(directory, 0o700); return; }
  // Windows ignores POSIX modes; inherit a DACL restricted to the running service identity.
  const script = `$ErrorActionPreference='Stop'
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($identity.User)
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($env:PICKCODE_UPGRADE_BACKUP_DIRECTORY,$acl)`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, PICKCODE_UPGRADE_BACKUP_DIRECTORY: directory }, windowsHide: true, stdio: 'pipe', timeout: 30000 });
}

// Run before any schema or data migration, including changes made by companion stores.
export function prepareUpgradeBackup(db, filename) {
  if (filename === ':memory:') return null;
  const marked = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='upgrade_meta'").get();
  if (marked && db.prepare('SELECT 1 FROM upgrade_meta WHERE version=?').get(upgradeVersion)) return null;
  const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'upgrade_meta' LIMIT 1").get();
  let backup = '';
  if (existing) {
    const directory = join(dirname(resolve(filename)), 'upgrade-backups');
    privateDirectory(directory);
    backup = join(directory, `${basename(filename)}.before-${upgradeVersion}.${randomUUID()}.sqlite`);
    // VACUUM INTO includes committed WAL contents and refuses an existing nonempty destination.
    db.prepare('VACUUM INTO ?').run(backup);
    chmodSync(backup, 0o600);
    const managedConfig = join(dirname(resolve(filename)), 'service-config.json');
    if (existsSync(managedConfig)) {
      copyFileSync(managedConfig, `${backup}.service-config.json`, constants.COPYFILE_EXCL);
      chmodSync(`${backup}.service-config.json`, 0o600);
    }
    writeFileSync(`${backup}.restore.txt`, [
      `Upgrade backup before ${upgradeVersion}.`,
      'Manual restore: stop every service using this database, preserve the current database and its -wal/-shm files,',
      'then copy this backup to the configured database path without reusing the current -wal/-shm files.',
      'Start the previous matching application version with the original environment encryption key.',
      'Encrypted cookies and AI credentials still require that original key; this backup contains no replacement key.',
      'If a matching .service-config.json copy exists beside this backup, restore it with private permissions too.',
      'Otherwise preserve the original environment configuration and encryption key separately.',
      'Keep this backup private. Verify account access and data before resuming collection.'
    ].join('\n'), { flag: 'wx', mode: 0o600 });
  }
  db.exec('CREATE TABLE IF NOT EXISTS upgrade_meta (version TEXT PRIMARY KEY, backup_path TEXT NOT NULL)');
  db.prepare('INSERT INTO upgrade_meta VALUES(?,?)').run(upgradeVersion, backup);
  return backup || null;
}
