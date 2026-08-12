const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, normalizeConfig, saveConfig, validateConfig } = require('../src/config');

function createTemporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-local-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('normaliza valores e remove origens duplicadas', () => {
  const root = path.join(os.tmpdir(), 'backup-local-normalize');
  const source = path.join(root, 'origem');
  const config = normalizeConfig({
    sources: [source, ` ${source} `, ''],
    destination: path.join(root, 'destino'),
    retentionDays: 4.6,
    minFreeSpaceGB: -2,
    launchAtLogin: true,
    respectGitignore: true,
    language: 'en',
    pausedSources: [{ path: source, pausedAt: '2026-01-02T03:04:05.000Z' }],
    sourceNames: [{ path: source, name: '  Documentos   importantes  ' }],
  }, root);

  assert.deepEqual(config.sources, [path.resolve(source)]);
  assert.equal(config.retentionDays, 5);
  assert.equal(config.minFreeSpaceGB, 0);
  assert.equal(config.launchAtLogin, true);
  assert.equal(config.respectGitignore, true);
  assert.equal(config.language, 'en');
  assert.deepEqual(config.pausedSources, [{ path: path.resolve(source), pausedAt: '2026-01-02T03:04:05.000Z' }]);
  assert.deepEqual(config.sourceNames, [{ path: path.resolve(source), name: 'Documentos importantes' }]);
});

test('descarta pausas de pastas que não estão mais nas origens', () => {
  const root = path.join(os.tmpdir(), 'backup-local-stale-pause');
  const config = normalizeConfig({
    sources: [path.join(root, 'ativa')],
    destination: path.join(root, 'destino'),
    pausedSources: [{ path: path.join(root, 'removida'), pausedAt: '2026-01-01T00:00:00Z' }],
  });
  assert.deepEqual(config.pausedSources, []);
});

test('descarta nomes de origens removidas e nomes vazios', () => {
  const root = path.join(os.tmpdir(), 'backup-local-stale-name');
  const active = path.join(root, 'ativa');
  const config = normalizeConfig({
    sources: [active],
    destination: path.join(root, 'destino'),
    sourceNames: [
      { path: active, name: '   ' },
      { path: path.join(root, 'removida'), name: 'Antiga' },
    ],
  });
  assert.deepEqual(config.sourceNames, []);
});

test('impede que o destino fique dentro da origem', () => {
  const source = path.join(os.tmpdir(), 'backup-local-source');
  const config = normalizeConfig({
    sources: [source],
    destination: path.join(source, 'backups'),
  });
  assert.equal(validateConfig(config).length, 1);
});

test('traduz erros de configuração para inglês', () => {
  const root = path.parse(process.cwd()).root;
  const config = normalizeConfig({ destination: root, language: 'en' });
  assert.equal(validateConfig(config)[0], 'Choose a subfolder as the destination; the disk root is not allowed.');
});

test('migra os arquivos de configuração antigos', (t) => {
  const directory = createTemporaryDirectory(t);
  const source = path.join(directory, 'origem');
  const destination = path.join(directory, 'destino');
  fs.writeFileSync(path.join(directory, 'pastas.txt'), `${source}\n`, 'utf8');
  fs.writeFileSync(path.join(directory, 'destino.txt'), destination, 'utf8');

  const filePath = path.join(directory, 'config.json');
  const config = loadConfig(filePath);

  assert.deepEqual(config.sources, [source]);
  assert.equal(config.destination, destination);
  assert.ok(fs.existsSync(filePath));
});

test('salva e recarrega a configuração', (t) => {
  const directory = createTemporaryDirectory(t);
  const filePath = path.join(directory, 'config.json');
  const saved = saveConfig({
    sources: [path.join(directory, 'origem')],
    destination: path.join(directory, 'destino'),
    schedule: '*/30 * * * *',
  }, filePath);
  assert.deepEqual(loadConfig(filePath), saved);
});
