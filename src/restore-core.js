const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');
const tar = require('tar-stream');
const {
  createBackup, getBackupFormat, getSourceFingerprint, isOwnedBackup,
  listOwnedBackups, runProcess, sevenZipPath,
} = require('./backup-core');
const { translate } = require('./i18n');

function sourceDisplayName(config, source) {
  const key = path.resolve(source).toLowerCase();
  return (config.sourceNames || []).find((entry) => path.resolve(entry.path).toLowerCase() === key)?.name || path.basename(source);
}

function listRestorePoints(config) {
  const backups = listOwnedBackups(config.destination);
  const paused = new Set((config.pausedSources || []).map((entry) => path.resolve(entry.path).toLowerCase()));
  return config.sources.map((source) => {
    const marker = `_${getSourceFingerprint(source)}_`;
    return {
      source,
      sourceName: sourceDisplayName(config, source),
      paused: paused.has(path.resolve(source).toLowerCase()),
      points: backups.filter((backup) => backup.name.includes(marker)).sort((a, b) => b.modifiedAt - a.modifiedAt),
    };
  });
}

function validateRestoreSelection(config, source, backupPath) {
  const language = config.language || 'pt-BR';
  const resolvedSource = path.resolve(source);
  const configured = config.sources.some((item) => path.resolve(item).toLowerCase() === resolvedSource.toLowerCase());
  if (!configured) throw new Error(translate(language, 'restoreSourceInvalid'));
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) throw new Error(translate(language, 'sourceMissing'));

  const resolvedBackup = path.resolve(backupPath);
  const destination = path.resolve(config.destination);
  const format = getBackupFormat(resolvedBackup);
  const existsWithExpectedType = fs.existsSync(resolvedBackup)
    && (format === 'mirror' ? fs.statSync(resolvedBackup).isDirectory() : fs.statSync(resolvedBackup).isFile());
  if (path.dirname(resolvedBackup).toLowerCase() !== destination.toLowerCase()
    || !isOwnedBackup(path.basename(resolvedBackup)) || !existsWithExpectedType) {
    throw new Error(translate(language, 'restorePointInvalid'));
  }
  if (!path.basename(resolvedBackup).includes(`_${getSourceFingerprint(resolvedSource)}_`)) {
    throw new Error(translate(language, 'restorePointWrongSource'));
  }
  return { source: resolvedSource, backupPath: resolvedBackup, format };
}

function safeTarget(stagingRoot, entryName, language) {
  const normalized = entryName.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!normalized || normalized.startsWith('/') || segments.some((segment) => segment === '..' || segment.includes(':'))) {
    throw new Error(translate(language, 'restoreArchiveUnsafe'));
  }
  const target = path.resolve(stagingRoot, ...segments);
  const relative = path.relative(stagingRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(translate(language, 'restoreArchiveUnsafe'));
  return target;
}

function validatedEntries(backupPath, language) {
  const zip = new AdmZip(backupPath);
  const entries = zip.getEntries();
  entries.forEach((entry) => safeTarget(path.dirname(backupPath), entry.entryName, language));
  return entries;
}

function extractZip(backupPath, stagingPath, language) {
  const entries = validatedEntries(backupPath, language);
  fs.mkdirSync(stagingPath, { recursive: true });
  for (const entry of entries) {
    const target = safeTarget(stagingPath, entry.entryName, language);
    if (entry.isDirectory) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }
  }
}

async function extractTarZstd(backupPath, stagingPath, language) {
  fs.mkdirSync(stagingPath, { recursive: true });
  const extract = tar.extract();
  let extractionError = null;
  extract.on('entry', (header, stream, next) => {
    (async () => {
      if (!['file', 'directory'].includes(header.type)) throw new Error(translate(language, 'restoreArchiveUnsafe'));
      const target = safeTarget(stagingPath, header.name, language);
      if (header.type === 'directory') {
        fs.mkdirSync(target, { recursive: true });
        stream.resume();
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await pipeline(stream, fs.createWriteStream(target, { flags: 'wx' }));
      }
      next();
    })().catch((error) => {
      extractionError = error;
      extract.destroy(error);
    });
  });
  await pipeline(fs.createReadStream(backupPath), zlib.createZstdDecompress(), extract);
  if (extractionError) throw extractionError;
}

function validateTree(directory, language) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error(translate(language, 'restoreArchiveUnsafe'));
    if (item.isDirectory()) validateTree(path.join(directory, item.name), language);
  }
}

async function copyTreeContents(source, destination, language) {
  validateTree(source, language);
  fs.mkdirSync(destination, { recursive: true });
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    await fs.promises.cp(path.join(source, item.name), path.join(destination, item.name), { recursive: true, errorOnExist: true });
  }
}

async function extractBackup(backupPath, stagingPath, format, language) {
  if (format === 'zip') extractZip(backupPath, stagingPath, language);
  else if (format === 'tar.zst') await extractTarZstd(backupPath, stagingPath, language);
  else if (format === '7z') {
    fs.mkdirSync(stagingPath, { recursive: true });
    const listing = await runProcess(sevenZipPath(), ['l', '-slt', backupPath]);
    const entryListing = listing.output.split('----------').slice(1).join('----------');
    const paths = [...entryListing.matchAll(/^Path = (.+)$/gm)].map((match) => match[1].trim());
    paths.forEach((entryPath) => safeTarget(stagingPath, entryPath, language));
    await runProcess(sevenZipPath(), ['x', backupPath, `-o${stagingPath}`, '-y']);
    validateTree(stagingPath, language);
  } else await copyTreeContents(backupPath, stagingPath, language);
}

function uniqueSibling(source, label) {
  const parent = path.dirname(source);
  const name = path.basename(source);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = path.join(parent, `.BackupLocal-${label}-${name}-${Date.now()}-${process.pid}-${attempt}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Não foi possível criar uma pasta temporária para a restauração.');
}

async function restoreBackup(config, sourceInput, backupPathInput, onProgress = () => {}) {
  const language = config.language || 'pt-BR';
  const { source, backupPath, format } = validateRestoreSelection(config, sourceInput, backupPathInput);
  const sourceName = sourceDisplayName(config, source);
  const startedAt = new Date().toISOString();
  const stagingPath = uniqueSibling(source, 'restore');
  const previousPath = uniqueSibling(source, 'previous');
  let safetyArchive = null;
  let originalMoved = false;
  let restoredInstalled = false;
  let cleanupWarning = null;

  fs.mkdirSync(config.destination, { recursive: true });
  onProgress({ type: 'restore-safety-backup', source, message: translate(language, 'restoreSavingCurrent', { name: sourceName }) });
  safetyArchive = await createBackup(source, config.destination, onProgress, new Date(), language, sourceName, {
    respectGitignore: false,
    archiveFormat: config.archiveFormat,
    compressionLevel: config.compressionLevel,
  });

  try {
    onProgress({ type: 'restore-extract', source, message: translate(language, 'restorePreparingPoint') });
    await extractBackup(backupPath, stagingPath, format, language);
    onProgress({ type: 'restore-swap', source, message: translate(language, 'restoreReplacing', { name: sourceName }) });
    fs.renameSync(source, previousPath);
    originalMoved = true;
    try {
      fs.renameSync(stagingPath, source);
      restoredInstalled = true;
    } catch (error) {
      fs.renameSync(previousPath, source);
      originalMoved = false;
      throw error;
    }
    try {
      fs.rmSync(previousPath, { recursive: true, force: true });
      originalMoved = false;
    } catch (error) {
      cleanupWarning = error.message;
    }
  } catch (error) {
    if (!restoredInstalled && fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true });
    if (originalMoved && !fs.existsSync(source) && fs.existsSync(previousPath)) fs.renameSync(previousPath, source);
    throw error;
  }

  const finishedAt = new Date().toISOString();
  return {
    trigger: 'restore', startedAt, finishedAt, status: cleanupWarning ? 'partial' : 'success', destination: config.destination,
    created: [safetyArchive], removed: [], errors: cleanupWarning ? [{ source, message: cleanupWarning }] : [],
    restore: { source, sourceName, backupPath, backupName: path.basename(backupPath), safetyArchive },
  };
}

module.exports = {
  copyTreeContents, extractBackup, extractTarZstd, extractZip, listRestorePoints,
  restoreBackup, safeTarget, validateRestoreSelection, validatedEntries, validateTree,
};
