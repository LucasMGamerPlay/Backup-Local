const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { createBackup } = require('../src/backup-core');
const { listRestorePoints, restoreBackup, validateRestoreSelection } = require('../src/restore-core');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-local-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'Projetos');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  return { root, source, destination };
}

test('agrupa pontos no tempo pela identidade estável da origem', async (t) => {
  const { source, destination } = createFixture(t);
  fs.writeFileSync(path.join(source, 'arquivo.txt'), 'v1', 'utf8');
  await createBackup(source, destination, () => {}, new Date('2026-01-01T00:00:00Z'), 'pt-BR', 'Nome antigo');
  await createBackup(source, destination, () => {}, new Date('2026-01-02T00:00:00Z'), 'pt-BR', 'Nome novo');

  const groups = listRestorePoints({
    sources: [source],
    sourceNames: [{ path: source, name: 'Projetos importantes' }],
    destination,
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].sourceName, 'Projetos importantes');
  assert.equal(groups[0].points.length, 2);
  assert.ok(groups[0].points[0].modifiedAt >= groups[0].points[1].modifiedAt);
});

test('salva o estado atual integralmente antes de restaurar um ponto', async (t) => {
  const { source, destination } = createFixture(t);
  const file = path.join(source, 'arquivo.txt');
  fs.writeFileSync(file, 'versão antiga', 'utf8');
  const oldPoint = await createBackup(source, destination, () => {}, new Date('2026-01-01T00:00:00Z'));

  fs.writeFileSync(file, 'estado atual', 'utf8');
  fs.writeFileSync(path.join(source, 'novo.txt'), 'também deve ser salvo', 'utf8');
  fs.writeFileSync(path.join(source, '.gitignore'), 'novo.txt\n', 'utf8');

  const result = await restoreBackup({
    sources: [source],
    destination,
    language: 'pt-BR',
    respectGitignore: true,
  }, source, oldPoint.path);

  assert.equal(result.status, 'success');
  assert.equal(fs.readFileSync(file, 'utf8'), 'versão antiga');
  assert.equal(fs.existsSync(path.join(source, 'novo.txt')), false);
  const safetyZip = new AdmZip(result.restore.safetyArchive.path);
  assert.equal(safetyZip.readAsText('arquivo.txt'), 'estado atual');
  assert.equal(safetyZip.readAsText('novo.txt'), 'também deve ser salvo');
});

test('recusa um ponto pertencente a outra origem', async (t) => {
  const { root, source, destination } = createFixture(t);
  const other = path.join(root, 'Outra');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'arquivo.txt'), 'outra', 'utf8');
  const point = await createBackup(other, destination);
  const config = { sources: [source, other], destination, language: 'pt-BR' };

  assert.throws(
    () => validateRestoreSelection(config, source, point.path),
    /pertence a outra pasta/,
  );
});

test('cria e restaura ZIP, 7z, TAR.ZST e pasta espelho', async (t) => {
  const { root } = createFixture(t);
  for (const format of ['zip', '7z', 'tar.zst', 'mirror']) {
    const source = path.join(root, `source-${format.replace('.', '-')}`);
    const destination = path.join(root, `destination-${format.replace('.', '-')}`);
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(path.join(source, 'vazia'), { recursive: true });
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(source, 'versao.txt'), `antiga-${format}`, 'utf8');
    const point = await createBackup(source, destination, () => {}, new Date('2026-02-01T00:00:00Z'), 'pt-BR', '', {
      archiveFormat: format,
      compressionLevel: 'fast',
    });
    fs.writeFileSync(path.join(source, 'versao.txt'), `atual-${format}`, 'utf8');
    fs.writeFileSync(path.join(source, 'novo.txt'), 'novo', 'utf8');

    const result = await restoreBackup({
      sources: [source], destination, language: 'pt-BR', archiveFormat: format, compressionLevel: 'fast',
    }, source, point.path);

    assert.equal(result.status, 'success', format);
    assert.equal(fs.readFileSync(path.join(source, 'versao.txt'), 'utf8'), `antiga-${format}`, format);
    assert.equal(fs.existsSync(path.join(source, 'novo.txt')), false, format);
    assert.equal(fs.statSync(path.join(source, 'vazia')).isDirectory(), true, format);
    assert.equal(result.restore.safetyArchive.format, format);
    assert.equal(fs.existsSync(result.restore.safetyArchive.path), true);
  }
});
