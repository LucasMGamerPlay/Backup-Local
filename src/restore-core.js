const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { createBackup, getSourceFingerprint, isOwnedBackup, listOwnedBackups } = require('./backup-core');
const { translate } = require('./i18n');

function sourceDisplayName(config, source) {
  const key = path.resolve(source).toLowerCase();
  return (config.sourceNames || []).find((entry) => path.resolve(entry.path).toLowerCase() === key)?.name
    || path.basename(source);
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
      points: backups
        .filter((backup) => backup.name.includes(marker))
        .sort((a, b) => b.modifiedAt - a.modifiedAt),
    };
  });
}

function validateRestoreSelection(config, source, backupPath) {
  const language = config.language || 'pt-BR';
  const resolvedSource = path.resolve(source);
  const configured = config.sources.some((item) => path.resolve(item).toLowerCase() === resolvedSource.toLowerCase());
  if (!configured) throw new Error(translate(language, 'restoreSourceInvalid'));
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
    throw new Error(translate(language, 'sourceMissing'));
  }

  const resolvedBackup = path.resolve(backupPath);
  const destination = path.resolve(config.destination);
  if (path.dirname(resolvedBackup).toLowerCase() !== destination.toLowerCase()
    || !isOwnedBackup(path.basename(resolvedBackup))
    || !fs.existsSync(resolvedBackup)
    || !fs.statSync(resolvedBackup).isFile()) {
    throw new Error(translate(language, 'restorePointInvalid'));
  }
  if (!path.basename(resolvedBackup).includes(`_${getSourceFingerprint(resolvedSource)}_`)) {
    throw new Error(translate(language, 'restorePointWrongSource'));
  }
  return { source: resolvedSource, backupPath: resolvedBackup };
}

function validatedEntries(backupPath, language) {
  const zip = new AdmZip(backupPath);
  const entries = zip.getEntries();
  for (const entry of entries) {
    const entryName = entry.entryName.replace(/\\/g, '/');
    const segments = entryName.split('/').filter(Boolean);
    if (!entryName || entryName.startsWith('/') || segments.some((segment) => segment === '..' || segment.includes(':'))) {
      throw new Error(translate(language, 'restoreArchiveUnsafe'));
    }
  }
  return entries;
}

function extractEntries(entries, stagingPath, language) {
  const stagingRoot = path.resolve(stagingPath);
  fs.mkdirSync(stagingRoot, { recursive: true });
  for (const entry of entries) {
    const entryName = entry.entryName.replace(/\\/g, '/');
    const segments = entryName.split('/').filter(Boolean);
    const target = path.resolve(stagingRoot, ...segments);
    const relative = path.relative(stagingRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(translate(language, 'restoreArchiveUnsafe'));
    }
    if (entry.isDirectory) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }
  }
}

function uniqueSibling(source, label) {
  const parent = path.dirname(source);
  const name = path.basename(source);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const token = `${Date.now()}-${process.pid}-${attempt}`;
    const candidate = path.join(parent, `.BackupLocal-${label}-${name}-${token}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Não foi possível criar uma pasta temporária para a restauração.');
}

function restoreBackup(config, sourceInput, backupPathInput, onProgress = () => {}) {
  const language = config.language || 'pt-BR';
  const { source, backupPath } = validateRestoreSelection(config, sourceInput, backupPathInput);
  const entries = validatedEntries(backupPath, language);
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
  safetyArchive = createBackup(source, config.destination, onProgress, new Date(), language, sourceName, {
    respectGitignore: false,
  });

  try {
    onProgress({ type: 'restore-extract', source, message: translate(language, 'restorePreparingPoint') });
    extractEntries(entries, stagingPath, language);
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
    trigger: 'restore',
    startedAt,
    finishedAt,
    status: cleanupWarning ? 'partial' : 'success',
    destination: config.destination,
    created: [safetyArchive],
    removed: [],
    errors: cleanupWarning ? [{ source, message: cleanupWarning }] : [],
    restore: { source, sourceName, backupPath, backupName: path.basename(backupPath), safetyArchive },
  };
}

module.exports = {
  extractEntries,
  listRestorePoints,
  restoreBackup,
  validateRestoreSelection,
  validatedEntries,
};
