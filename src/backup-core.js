const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const ignore = require('ignore');
const { translate } = require('./i18n');

const BACKUP_PREFIX = 'BackupLocal_';
const GIGABYTE = 1024 ** 3;

function isOwnedBackup(filename) {
  return filename.startsWith(BACKUP_PREFIX) && filename.toLowerCase().endsWith('.zip');
}

function safeName(value) {
  return value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Pasta';
}

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
}

function buildBackupFilename(source, date = new Date(), displayName = '') {
  const name = safeName(displayName || path.basename(source));
  const fingerprint = getSourceFingerprint(source);
  return `${BACKUP_PREFIX}${name}_${fingerprint}_${formatTimestamp(date)}.zip`;
}

function getSourceFingerprint(source) {
  return crypto.createHash('sha1').update(path.resolve(source).toLowerCase()).digest('hex').slice(0, 6);
}

function getFreeSpace(destination) {
  if (typeof fs.statfsSync !== 'function') return null;
  const stats = fs.statfsSync(destination);
  return stats.bavail * stats.bsize;
}

function listOwnedBackups(destination) {
  if (!fs.existsSync(destination)) return [];
  return fs.readdirSync(destination, { withFileTypes: true })
    .filter((item) => item.isFile() && isOwnedBackup(item.name))
    .map((item) => {
      const filePath = path.join(destination, item.name);
      const stats = fs.statSync(filePath);
      return { name: item.name, path: filePath, modifiedAt: stats.mtimeMs, size: stats.size };
    })
    .sort((a, b) => a.modifiedAt - b.modifiedAt);
}

function cleanupBackups(destination, options = {}, onProgress = () => {}) {
  const language = options.language || 'pt-BR';
  const retentionDays = Math.max(0, Number(options.retentionDays) || 0);
  const minFreeSpaceBytes = Math.max(0, Number(options.minFreeSpaceGB) || 0) * GIGABYTE;
  const readFreeSpace = typeof options.getFreeSpace === 'function' ? options.getFreeSpace : getFreeSpace;
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  const removed = [];
  const backups = listOwnedBackups(destination);
  const protectedPaths = new Set();
  const pausedSources = Array.isArray(options.pausedSources) ? options.pausedSources : [];
  const protectedSources = Array.isArray(options.protectedSources) ? options.protectedSources : pausedSources;
  const pausedKeys = new Set(pausedSources.map((entry) => path.resolve(typeof entry === 'string' ? entry : entry.path).toLowerCase()));

  for (const protectedSource of protectedSources) {
    const source = typeof protectedSource === 'string' ? protectedSource : protectedSource?.path;
    if (!source) continue;
    const marker = `_${getSourceFingerprint(source)}_`;
    const latest = backups.filter((backup) => backup.name.includes(marker)).at(-1);
    if (!latest) continue;
    protectedPaths.add(latest.path.toLowerCase());
    if (pausedKeys.has(path.resolve(source).toLowerCase())) {
      onProgress({ type: 'protected', source, backup: latest, message: translate(language, 'pausedBackupProtected', { name: latest.name }) });
    }
  }

  if (retentionDays > 0) {
    const cutoff = now - (retentionDays * 24 * 60 * 60 * 1000);
    for (const backup of listOwnedBackups(destination)) {
      if (backup.modifiedAt >= cutoff) continue;
      if (protectedPaths.has(backup.path.toLowerCase())) continue;
      fs.unlinkSync(backup.path);
      removed.push({ ...backup, reason: 'retention' });
      onProgress({ type: 'cleanup', message: translate(language, 'cleanupOld', { name: backup.name }) });
    }
  }

  let freeSpaceBytes = readFreeSpace(destination);
  while (freeSpaceBytes !== null && freeSpaceBytes < minFreeSpaceBytes) {
    const oldest = listOwnedBackups(destination)
      .find((backup) => !protectedPaths.has(backup.path.toLowerCase()));
    if (!oldest) break;
    fs.unlinkSync(oldest.path);
    removed.push({ ...oldest, reason: 'space' });
    onProgress({ type: 'cleanup', message: translate(language, 'cleanupSpace', { name: oldest.name }) });
    freeSpaceBytes = readFreeSpace(destination);
  }

  return { removed, freeSpaceBytes, protected: [...protectedPaths] };
}

function validateSource(source, language = 'pt-BR') {
  if (!fs.existsSync(source)) return translate(language, 'sourceMissing');
  if (!fs.statSync(source).isDirectory()) return translate(language, 'sourceNotDirectory');
  return null;
}

function createIgnoreMatcher(source, enabled) {
  if (!enabled) return null;
  const ignoreFile = path.join(source, '.gitignore');
  if (!fs.existsSync(ignoreFile) || !fs.statSync(ignoreFile).isFile()) return null;
  return ignore().add(fs.readFileSync(ignoreFile, 'utf8'));
}

function addSourceToZip(zip, source, matcher) {
  let ignoredCount = 0;

  function visit(directory, relativeDirectory = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (!entries.length && relativeDirectory) zip.addFile(`${relativeDirectory}/`, Buffer.alloc(0));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const matchPath = entry.isDirectory() ? `${relativePath}/` : relativePath;
      if (matcher?.ignores(matchPath)) {
        ignoredCount += 1;
        continue;
      }
      if (entry.isSymbolicLink()) {
        ignoredCount += 1;
        continue;
      }
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile()) zip.addLocalFile(absolutePath, relativeDirectory);
    }
  }

  visit(source);
  return ignoredCount;
}

function createUniqueBackupPath(destination, filename) {
  const extension = path.extname(filename);
  const base = path.basename(filename, extension);
  let candidate = path.join(destination, filename);
  let suffix = 2;
  while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.partial`)) {
    candidate = path.join(destination, `${base}_${suffix}${extension}`);
    suffix += 1;
  }
  return candidate;
}

function createBackup(source, destination, onProgress = () => {}, date = new Date(), language = 'pt-BR', displayName = '', options = {}) {
  const sourceName = displayName || path.basename(source);
  const requestedFilename = buildBackupFilename(source, date, sourceName);
  const finalPath = createUniqueBackupPath(destination, requestedFilename);
  const filename = path.basename(finalPath);
  const partialPath = `${finalPath}.partial`;

  onProgress({ type: 'archive-start', source, sourceName, filename, partialPath, message: translate(language, 'archiving', { name: sourceName }) });

  try {
    const zip = new AdmZip();
    const matcher = createIgnoreMatcher(source, options.respectGitignore === true);
    const ignoredCount = addSourceToZip(zip, source, matcher);
    zip.writeZip(partialPath);
    fs.renameSync(partialPath, finalPath);
    const stats = fs.statSync(finalPath);
    return { source, sourceName, filename, path: finalPath, size: stats.size, ignoredCount };
  } catch (error) {
    if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    throw error;
  }
}

function runBackup(config, options = {}) {
  const language = config.language || 'pt-BR';
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const startedAt = new Date();
  const result = {
    trigger: options.trigger || 'manual',
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    status: 'success',
    destination: config.destination,
    created: [],
    errors: [],
    removed: [],
    skipped: [],
    freeSpaceBytes: null,
  };

  fs.mkdirSync(config.destination, { recursive: true });
  const pausedKeys = new Set((config.pausedSources || []).map((entry) => path.resolve(entry.path).toLowerCase()));
  const sourceNameMap = new Map((config.sourceNames || []).map((entry) => [path.resolve(entry.path).toLowerCase(), entry.name]));
  const getDisplayName = (source) => sourceNameMap.get(path.resolve(source).toLowerCase()) || path.basename(source);
  const activeSources = config.sources.filter((source) => !pausedKeys.has(path.resolve(source).toLowerCase()));
  const pausedSources = config.sources.filter((source) => pausedKeys.has(path.resolve(source).toLowerCase()));
  result.skipped = pausedSources.map((source) => ({ source, reason: 'paused' }));
  pausedSources.forEach((source) => onProgress({ type: 'source-paused', source, sourceName: getDisplayName(source), message: translate(language, 'pausedSourceSkipped', { name: getDisplayName(source) }) }));

  onProgress({ type: 'start', total: activeSources.length, message: translate(language, 'preparing') });

  const preliminaryCleanup = cleanupBackups(config.destination, {
    ...config,
    protectedSources: config.sources,
  }, onProgress);
  result.removed = preliminaryCleanup.removed;
  result.freeSpaceBytes = preliminaryCleanup.freeSpaceBytes;

  activeSources.forEach((source, index) => {
    const sourceName = getDisplayName(source);
    const validationError = validateSource(source, language);
    if (validationError) {
      result.errors.push({ source, sourceName, message: validationError });
      onProgress({ type: 'source-error', source, sourceName, index, total: activeSources.length, message: `${sourceName}: ${validationError}` });
      return;
    }

    try {
      const archive = createBackup(source, config.destination, onProgress, new Date(), language, sourceName, {
        respectGitignore: config.respectGitignore === true,
      });
      result.created.push(archive);
      onProgress({ type: 'source-complete', source, sourceName, index: index + 1, total: activeSources.length, archive, message: translate(language, 'sourceComplete', { name: sourceName }) });
    } catch (error) {
      result.errors.push({ source, sourceName, message: error.message });
      onProgress({ type: 'source-error', source, sourceName, index: index + 1, total: activeSources.length, message: `${sourceName}: ${error.message}` });
    }
  });

  const finalCleanup = cleanupBackups(config.destination, {
    ...config,
    protectedSources: config.sources,
  }, onProgress);
  result.removed.push(...finalCleanup.removed);

  result.freeSpaceBytes = getFreeSpace(config.destination);
  result.finishedAt = new Date().toISOString();
  if (result.errors.length && result.created.length) result.status = 'partial';
  if (result.errors.length && !result.created.length) result.status = 'error';
  if (!config.sources.length) {
    result.status = 'error';
    result.errors.push({ source: null, message: translate(language, 'noSources') });
  }
  return result;
}

module.exports = {
  BACKUP_PREFIX,
  buildBackupFilename,
  addSourceToZip,
  cleanupBackups,
  createIgnoreMatcher,
  createBackup,
  formatTimestamp,
  getFreeSpace,
  getSourceFingerprint,
  isOwnedBackup,
  listOwnedBackups,
  runBackup,
  safeName,
  validateSource,
};
