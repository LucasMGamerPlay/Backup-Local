const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { BACKUP_PREFIX, buildBackupFilename, cleanupBackups, isOwnedBackup, parseSevenZipWarnings, runBackup } = require('../src/backup-core');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-local-core-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'Documentos');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(source, 'exemplo.txt'), 'conteúdo protegido', 'utf8');
  return { root, source, destination };
}

test('reconhece somente backups pertencentes ao aplicativo', () => {
  assert.equal(isOwnedBackup(`${BACKUP_PREFIX}Documentos_abc123_2026-01-01_00-00-00.zip`), true);
  assert.equal(isOwnedBackup(`${BACKUP_PREFIX}Documentos_abc123_2026-01-01_00-00-00.7z`), true);
  assert.equal(isOwnedBackup(`${BACKUP_PREFIX}Documentos_abc123_2026-01-01_00-00-00.tar.zst`), true);
  assert.equal(isOwnedBackup(`${BACKUP_PREFIX}Documentos_abc123_2026-01-01_00-00-00.mirror`), true);
  assert.equal(isOwnedBackup('arquivo-pessoal.zip'), false);
  assert.equal(isOwnedBackup('Backup_Teste_2026.zip'), false);
});

test('cria um ZIP válido com o conteúdo da pasta', async (t) => {
  const { source, destination } = createFixture(t);
  const result = await runBackup({
    sources: [source],
    destination,
    retentionDays: 4,
    minFreeSpaceGB: 0,
  });

  assert.equal(result.status, 'success');
  assert.equal(result.created.length, 1);
  assert.ok(fs.existsSync(result.created[0].path));
  const zip = new AdmZip(result.created[0].path);
  assert.equal(zip.readAsText('exemplo.txt'), 'conteúdo protegido');
});

test('respeita as regras do .gitignore quando a opção está ativa', async (t) => {
  const { source, destination } = createFixture(t);
  fs.mkdirSync(path.join(source, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(source, 'cache', 'temporario.bin'), 'ignorar', 'utf8');
  fs.writeFileSync(path.join(source, 'segredo.log'), 'ignorar', 'utf8');
  fs.writeFileSync(path.join(source, '.gitignore'), 'cache/\n*.log\n', 'utf8');

  const result = await runBackup({
    sources: [source],
    destination,
    retentionDays: 4,
    minFreeSpaceGB: 0,
    respectGitignore: true,
  });

  const zip = new AdmZip(result.created[0].path);
  assert.equal(zip.getEntry('exemplo.txt') !== null, true);
  assert.equal(zip.getEntry('.gitignore') !== null, true);
  assert.equal(zip.getEntry('cache/temporario.bin'), null);
  assert.equal(zip.getEntry('segredo.log'), null);
  assert.equal(result.created[0].ignoredCount, 2);
});

test('usa o nome personalizado no ZIP sem alterar a identidade da origem', async (t) => {
  const { source, destination } = createFixture(t);
  const defaultName = buildBackupFilename(source, new Date('2026-01-01T00:00:00Z'));
  const customName = buildBackupFilename(source, new Date('2026-01-01T00:00:00Z'), 'Projetos importantes');
  const defaultFingerprint = defaultName.match(/_([a-f0-9]{6})_/)[1];
  const customFingerprint = customName.match(/_([a-f0-9]{6})_/)[1];

  const result = await runBackup({
    sources: [source],
    sourceNames: [{ path: source, name: 'Projetos importantes' }],
    destination,
    retentionDays: 4,
    minFreeSpaceGB: 0,
  });

  assert.equal(defaultFingerprint, customFingerprint);
  assert.match(result.created[0].filename, /^BackupLocal_Projetos_importantes_/);
  assert.equal(result.created[0].sourceName, 'Projetos importantes');
});

test('a retenção remove backup antigo e preserva ZIP alheio', (t) => {
  const { destination } = createFixture(t);
  const owned = path.join(destination, `${BACKUP_PREFIX}Antigo_abc123_2020-01-01_00-00-00.zip`);
  const unrelated = path.join(destination, 'fotos-da-familia.zip');
  fs.writeFileSync(owned, 'backup', 'utf8');
  fs.writeFileSync(unrelated, 'pessoal', 'utf8');
  const oldDate = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(owned, oldDate, oldDate);
  fs.utimesSync(unrelated, oldDate, oldDate);

  const result = cleanupBackups(destination, { retentionDays: 4, minFreeSpaceGB: 0, now: new Date('2026-01-01T00:00:00Z') });

  assert.equal(result.removed.length, 1);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(unrelated), true);
});

test('retorna mensagens do backup em inglês', async (t) => {
  const { root, destination } = createFixture(t);
  const result = await runBackup({
    sources: [path.join(root, 'missing-folder')],
    destination,
    retentionDays: 4,
    minFreeSpaceGB: 0,
    language: 'en',
  });

  assert.equal(result.status, 'error');
  assert.equal(result.errors[0].message, 'The folder does not exist.');
});

test('pasta pausada não cria um novo backup', async (t) => {
  const { source, destination } = createFixture(t);
  const result = await runBackup({
    sources: [source],
    pausedSources: [{ path: source, pausedAt: '2026-01-01T00:00:00Z' }],
    destination,
    retentionDays: 4,
    minFreeSpaceGB: 0,
  });

  assert.equal(result.status, 'success');
  assert.equal(result.created.length, 0);
  assert.deepEqual(result.skipped, [{ source, reason: 'paused' }]);
});

test('retenção preserva somente o backup mais recente da pasta pausada', (t) => {
  const { source, destination } = createFixture(t);
  const olderName = buildBackupFilename(source, new Date('2020-01-01T00:00:00Z'));
  const latestName = buildBackupFilename(source, new Date('2020-01-02T00:00:00Z'));
  const olderPath = path.join(destination, olderName);
  const latestPath = path.join(destination, latestName);
  fs.writeFileSync(olderPath, 'older');
  fs.writeFileSync(latestPath, 'latest');
  fs.utimesSync(olderPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  fs.utimesSync(latestPath, new Date('2020-01-02T00:00:00Z'), new Date('2020-01-02T00:00:00Z'));

  const result = cleanupBackups(destination, {
    retentionDays: 4,
    minFreeSpaceGB: 0,
    now: new Date('2026-01-01T00:00:00Z'),
    pausedSources: [{ path: source, pausedAt: '2020-01-03T00:00:00Z' }],
  });

  assert.equal(fs.existsSync(olderPath), false);
  assert.equal(fs.existsSync(latestPath), true);
  assert.equal(result.removed.length, 1);
  assert.deepEqual(result.protected, [latestPath.toLowerCase()]);
});

test('limpeza por espaço também preserva o último backup pausado', (t) => {
  const { root, source, destination } = createFixture(t);
  const otherSource = path.join(root, 'Fotos');
  fs.mkdirSync(otherSource);
  const protectedPath = path.join(destination, buildBackupFilename(source, new Date('2020-01-01T00:00:00Z')));
  const removablePath = path.join(destination, buildBackupFilename(otherSource, new Date('2020-01-02T00:00:00Z')));
  fs.writeFileSync(protectedPath, 'protected');
  fs.writeFileSync(removablePath, 'removable');
  fs.utimesSync(protectedPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  fs.utimesSync(removablePath, new Date('2020-01-02T00:00:00Z'), new Date('2020-01-02T00:00:00Z'));

  const result = cleanupBackups(destination, {
    retentionDays: 0,
    minFreeSpaceGB: 1,
    pausedSources: [{ path: source, pausedAt: '2020-01-03T00:00:00Z' }],
    getFreeSpace: () => 0,
  });

  assert.equal(fs.existsSync(protectedPath), true);
  assert.equal(fs.existsSync(removablePath), false);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].reason, 'space');
});

test('ao continuar, preserva o backup anterior se a nova cópia falhar', async (t) => {
  const { root, destination } = createFixture(t);
  const missingSource = path.join(root, 'OrigemRemovida');
  const previousPath = path.join(destination, buildBackupFilename(missingSource, new Date('2020-01-01T00:00:00Z')));
  fs.writeFileSync(previousPath, 'last-known-good');
  fs.utimesSync(previousPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));

  const result = await runBackup({
    sources: [missingSource],
    pausedSources: [],
    destination,
    retentionDays: 4,
    minFreeSpaceGB: 0,
  }, { now: new Date('2026-01-01T00:00:00Z') });

  assert.equal(result.status, 'error');
  assert.equal(fs.existsSync(previousPath), true);
});

test('preserva o 7z e conclui com avisos quando um arquivo em uso é omitido', async (t) => {
  const { source, destination } = createFixture(t);
  const runSevenZip = async (_executable, args) => {
    const outputPath = args.find((argument) => String(argument).endsWith('.partial'));
    fs.writeFileSync(outputPath, 'arquivo 7z simulado', 'utf8');
    return {
      code: 1,
      output: 'WARNING: O arquivo já está sendo usado por outro processo.\r\nLog\\ShooterGame.log\r\nFiles read from disk: 67\r\nWarnings: 1',
    };
  };

  const result = await runBackup({
    sources: [source], destination, archiveFormat: '7z', compressionLevel: 'balanced', retentionDays: 4, minFreeSpaceGB: 0,
  }, { runSevenZip, sevenZipExecutable: '7za-simulado' });

  assert.equal(result.status, 'partial');
  assert.equal(result.created.length, 1);
  assert.equal(fs.existsSync(result.created[0].path), true);
  assert.equal(fs.existsSync(`${result.created[0].path}.partial`), false);
  assert.match(result.created[0].warnings[0], /ShooterGame\.log/);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(parseSevenZipWarnings('WARNING: bloqueado\nserver.log\nWarnings: 1'), ['bloqueado — server.log']);
});
