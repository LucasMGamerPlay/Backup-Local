const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { ZipArchive } = require('archiver');
const ignore = require('ignore');
const tar = require('tar-stream');
const { translate } = require('./i18n');

const BACKUP_PREFIX = 'BackupLocal_';
const GIGABYTE = 1024 ** 3;
const ARCHIVE_FORMATS = Object.freeze(['zip', '7z', 'tar.zst', 'mirror']);
const COMPRESSION_LEVELS = Object.freeze(['fast', 'balanced', 'maximum']);
const FORMAT_EXTENSIONS = Object.freeze({ zip: '.zip', '7z': '.7z', 'tar.zst': '.tar.zst', mirror: '.mirror' });

function normalizeArchiveFormat(value) {
  return ARCHIVE_FORMATS.includes(value) ? value : 'zip';
}

function normalizeCompressionLevel(value) {
  return COMPRESSION_LEVELS.includes(value) ? value : 'balanced';
}

function getBackupFormat(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tar.zst')) return 'tar.zst';
  if (lower.endsWith('.mirror')) return 'mirror';
  if (lower.endsWith('.7z')) return '7z';
  if (lower.endsWith('.zip')) return 'zip';
  return null;
}

function isOwnedBackup(filename) {
  return filename.startsWith(BACKUP_PREFIX) && getBackupFormat(filename) !== null;
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

function buildBackupFilename(source, date = new Date(), displayName = '', archiveFormat = 'zip') {
  const name = safeName(displayName || path.basename(source));
  const fingerprint = getSourceFingerprint(source);
  const format = normalizeArchiveFormat(archiveFormat);
  return `${BACKUP_PREFIX}${name}_${fingerprint}_${formatTimestamp(date)}${FORMAT_EXTENSIONS[format]}`;
}

function getSourceFingerprint(source) {
  return crypto.createHash('sha1').update(path.resolve(source).toLowerCase()).digest('hex').slice(0, 6);
}

function getFreeSpace(destination) {
  if (typeof fs.statfsSync !== 'function') return null;
  const stats = fs.statfsSync(destination);
  return stats.bavail * stats.bsize;
}

function directorySize(directory) {
  let total = 0;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) total += directorySize(itemPath);
    else if (item.isFile()) total += fs.statSync(itemPath).size;
  }
  return total;
}

function listOwnedBackups(destination) {
  if (!fs.existsSync(destination)) return [];
  return fs.readdirSync(destination, { withFileTypes: true })
    .filter((item) => {
      const format = getBackupFormat(item.name);
      return item.name.startsWith(BACKUP_PREFIX)
        && ((format === 'mirror' && item.isDirectory()) || (format !== 'mirror' && format && item.isFile()));
    })
    .map((item) => {
      const filePath = path.join(destination, item.name);
      const stats = fs.statSync(filePath);
      return {
        name: item.name,
        path: filePath,
        format: getBackupFormat(item.name),
        modifiedAt: stats.mtimeMs,
        size: item.isDirectory() ? directorySize(filePath) : stats.size,
      };
    })
    .sort((a, b) => a.modifiedAt - b.modifiedAt);
}

function removeBackup(backupPath) {
  fs.rmSync(backupPath, { recursive: true, force: true });
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
      if (backup.modifiedAt >= cutoff || protectedPaths.has(backup.path.toLowerCase())) continue;
      removeBackup(backup.path);
      removed.push({ ...backup, reason: 'retention' });
      onProgress({ type: 'cleanup', message: translate(language, 'cleanupOld', { name: backup.name }) });
    }
  }

  let freeSpaceBytes = readFreeSpace(destination);
  while (freeSpaceBytes !== null && freeSpaceBytes < minFreeSpaceBytes) {
    const oldest = listOwnedBackups(destination).find((backup) => !protectedPaths.has(backup.path.toLowerCase()));
    if (!oldest) break;
    removeBackup(oldest.path);
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

function enumerateSource(source, matcher) {
  const entries = [];
  let ignoredCount = 0;

  function visit(directory, relativeDirectory = '') {
    const items = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (!items.length && relativeDirectory) {
      entries.push({ type: 'directory', absolutePath: directory, relativePath: relativeDirectory, stats: fs.statSync(directory) });
    }
    for (const item of items) {
      const absolutePath = path.join(directory, item.name);
      const relativePath = path.posix.join(relativeDirectory, item.name);
      const matchPath = item.isDirectory() ? `${relativePath}/` : relativePath;
      if (matcher?.ignores(matchPath) || item.isSymbolicLink()) {
        ignoredCount += 1;
        continue;
      }
      if (item.isDirectory()) visit(absolutePath, relativePath);
      else if (item.isFile()) entries.push({ type: 'file', absolutePath, relativePath, stats: fs.statSync(absolutePath) });
    }
  }

  visit(source);
  return { entries, ignoredCount };
}

function createUniqueBackupPath(destination, filename) {
  const format = getBackupFormat(filename);
  const extension = FORMAT_EXTENSIONS[format];
  const base = filename.slice(0, -extension.length);
  let candidate = path.join(destination, filename);
  let suffix = 2;
  while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.partial`)) {
    candidate = path.join(destination, `${base}_${suffix}${extension}`);
    suffix += 1;
  }
  return candidate;
}

function compressionValue(format, level) {
  const normalized = normalizeCompressionLevel(level);
  if (format === 'zip') return { fast: 1, balanced: 6, maximum: 9 }[normalized];
  if (format === '7z') return { fast: 1, balanced: 5, maximum: 9 }[normalized];
  return { fast: 1, balanced: 6, maximum: 15 }[normalized];
}

async function createZip(entries, outputPath, level) {
  const output = fs.createWriteStream(outputPath, { flags: 'wx' });
  const archive = new ZipArchive({ zlib: { level: compressionValue('zip', level) } });
  const complete = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);
  for (const entry of entries) {
    if (entry.type === 'directory') archive.append(Buffer.alloc(0), { name: `${entry.relativePath}/` });
    else archive.file(entry.absolutePath, { name: entry.relativePath });
  }
  await archive.finalize();
  await complete;
}

async function createTarZstd(entries, outputPath, level) {
  const pack = tar.pack();
  const compressor = zlib.createZstdCompress({
    params: { [zlib.constants.ZSTD_c_compressionLevel]: compressionValue('tar.zst', level) },
  });
  const writing = pipeline(pack, compressor, fs.createWriteStream(outputPath, { flags: 'wx' }));
  for (const entry of entries) {
    const header = {
      name: entry.relativePath,
      mode: entry.stats.mode,
      mtime: entry.stats.mtime,
      type: entry.type,
      size: entry.type === 'file' ? entry.stats.size : 0,
    };
    if (entry.type === 'directory') pack.entry(header);
    else await pipeline(fs.createReadStream(entry.absolutePath), pack.entry(header));
  }
  pack.finalize();
  await writing;
}

function sevenZipPath() {
  const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, '7za.exe') : null;
  if (packagedPath && fs.existsSync(packagedPath)) return packagedPath;
  return require('7zip-bin').path7za;
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { acceptableExitCodes = [0], ...spawnOptions } = options;
    const child = spawn(executable, args, { ...spawnOptions, windowsHide: true });
    let output = '';
    child.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-100000); });
    child.stderr?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-100000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (acceptableExitCodes.includes(code)) resolve({ code, output });
      else reject(new Error(`7-Zip terminou com o código ${code}. ${output.trim()}`));
    });
  });
}

function parseSevenZipWarnings(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim());
  const warnings = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^WARNING:/i.test(lines[index])) continue;
    const details = [];
    const inline = lines[index].replace(/^WARNING:\s*/i, '').trim();
    if (inline) details.push(inline);
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (!line) continue;
      if (/^(Files read from disk:|Archive size:|Scan WARNINGS:|Warnings:|Everything is Ok)/i.test(line)) break;
      if (/^WARNING:/i.test(line)) break;
      details.push(line);
      if (details.length >= 4) break;
    }
    const message = details.join(' — ').slice(0, 1000);
    if (message && !warnings.includes(message)) warnings.push(message);
  }
  return warnings;
}

async function createSevenZip(entries, source, outputPath, level, executable = sevenZipPath(), processRunner = runProcess) {
  const listPath = `${outputPath}.list`;
  try {
    if (!entries.length) {
      const emptyPath = path.join(path.dirname(outputPath), `.BackupLocal-empty-${process.pid}-${Date.now()}`);
      fs.mkdirSync(emptyPath);
      try {
        await processRunner(executable, ['a', '-t7z', '-ssw', `-mx=${compressionValue('7z', level)}`, outputPath, '.'], { cwd: emptyPath });
      } finally {
        fs.rmSync(emptyPath, { recursive: true, force: true });
      }
      return [];
    }
    fs.writeFileSync(listPath, entries.map((entry) => entry.relativePath.replace(/\//g, path.sep)).join('\r\n'), 'utf8');
    const processResult = await processRunner(executable, [
      'a', '-t7z', '-ssw', `-mx=${compressionValue('7z', level)}`, '-scsUTF-8', outputPath, `@${listPath}`,
    ], { cwd: source, acceptableExitCodes: [0, 1] });
    if (processResult.code === 1) {
      const parsed = parseSevenZipWarnings(processResult.output);
      return parsed.length ? parsed : ['O 7-Zip concluiu com avisos e pode ter omitido arquivos em uso.'];
    }
    return [];
  } finally {
    fs.rmSync(listPath, { force: true });
  }
}

async function createMirror(entries, outputPath) {
  fs.mkdirSync(outputPath, { recursive: true });
  for (const entry of entries) {
    const target = path.join(outputPath, ...entry.relativePath.split('/'));
    if (entry.type === 'directory') fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(entry.absolutePath, target);
    }
  }
}

async function createBackup(source, destination, onProgress = () => {}, date = new Date(), language = 'pt-BR', displayName = '', options = {}) {
  const sourceName = displayName || path.basename(source);
  const archiveFormat = normalizeArchiveFormat(options.archiveFormat);
  const compressionLevel = normalizeCompressionLevel(options.compressionLevel);
  const requestedFilename = buildBackupFilename(source, date, sourceName, archiveFormat);
  const finalPath = createUniqueBackupPath(destination, requestedFilename);
  const filename = path.basename(finalPath);
  const partialPath = `${finalPath}.partial`;
  onProgress({ type: 'archive-start', source, sourceName, filename, partialPath, message: translate(language, 'archiving', { name: sourceName }) });

  try {
    const matcher = createIgnoreMatcher(source, options.respectGitignore === true);
    const { entries, ignoredCount } = enumerateSource(source, matcher);
    let warnings = [];
    if (archiveFormat === 'zip') await createZip(entries, partialPath, compressionLevel);
    else if (archiveFormat === '7z') warnings = await createSevenZip(
      entries,
      source,
      partialPath,
      compressionLevel,
      options.sevenZipExecutable || sevenZipPath(),
      options.runSevenZip || runProcess,
    );
    else if (archiveFormat === 'tar.zst') await createTarZstd(entries, partialPath, compressionLevel);
    else await createMirror(entries, partialPath);
    fs.renameSync(partialPath, finalPath);
    const stats = fs.statSync(finalPath);
    return {
      source,
      sourceName,
      filename,
      path: finalPath,
      format: archiveFormat,
      compressionLevel,
      size: stats.isDirectory() ? directorySize(finalPath) : stats.size,
      ignoredCount,
      warnings,
    };
  } catch (error) {
    fs.rmSync(partialPath, { recursive: true, force: true });
    throw error;
  }
}

async function runBackup(config, options = {}) {
  const language = config.language || 'pt-BR';
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const startedAt = new Date();
  const result = {
    trigger: options.trigger || 'manual', startedAt: startedAt.toISOString(), finishedAt: null,
    status: 'success', destination: config.destination, created: [], errors: [], warnings: [], removed: [], skipped: [], freeSpaceBytes: null,
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

  const preliminaryCleanup = cleanupBackups(config.destination, { ...config, protectedSources: config.sources }, onProgress);
  result.removed = preliminaryCleanup.removed;
  result.freeSpaceBytes = preliminaryCleanup.freeSpaceBytes;

  for (let index = 0; index < activeSources.length; index += 1) {
    const source = activeSources[index];
    const sourceName = getDisplayName(source);
    const validationError = validateSource(source, language);
    if (validationError) {
      result.errors.push({ source, sourceName, message: validationError });
      onProgress({ type: 'source-error', source, sourceName, index, total: activeSources.length, message: `${sourceName}: ${validationError}` });
      continue;
    }
    try {
      const archive = await createBackup(source, config.destination, onProgress, new Date(), language, sourceName, {
        respectGitignore: config.respectGitignore === true,
        archiveFormat: config.archiveFormat,
        compressionLevel: config.compressionLevel,
        sevenZipExecutable: options.sevenZipExecutable,
        runSevenZip: options.runSevenZip,
      });
      result.created.push(archive);
      if (archive.warnings.length) {
        const warning = {
          source,
          sourceName,
          message: translate(language, 'archiveCompletedWithWarnings', { name: sourceName, count: archive.warnings.length }),
          details: archive.warnings,
        };
        result.warnings.push(warning);
        onProgress({ type: 'source-warning', index: index + 1, total: activeSources.length, archive, ...warning });
      } else {
        onProgress({ type: 'source-complete', source, sourceName, index: index + 1, total: activeSources.length, archive, message: translate(language, 'sourceComplete', { name: sourceName }) });
      }
    } catch (error) {
      result.errors.push({ source, sourceName, message: error.message });
      onProgress({ type: 'source-error', source, sourceName, index: index + 1, total: activeSources.length, message: `${sourceName}: ${error.message}` });
    }
  }

  const finalCleanup = cleanupBackups(config.destination, { ...config, protectedSources: config.sources }, onProgress);
  result.removed.push(...finalCleanup.removed);
  result.freeSpaceBytes = getFreeSpace(config.destination);
  result.finishedAt = new Date().toISOString();
  if ((result.errors.length && result.created.length) || result.warnings.length) result.status = 'partial';
  if (result.errors.length && !result.created.length) result.status = 'error';
  if (!config.sources.length) {
    result.status = 'error';
    result.errors.push({ source: null, message: translate(language, 'noSources') });
  }
  return result;
}

module.exports = {
  ARCHIVE_FORMATS, BACKUP_PREFIX, COMPRESSION_LEVELS, FORMAT_EXTENSIONS,
  buildBackupFilename, cleanupBackups, compressionValue, createBackup, createIgnoreMatcher, createSevenZip,
  directorySize, enumerateSource, formatTimestamp, getBackupFormat, getFreeSpace,
  getSourceFingerprint, isOwnedBackup, listOwnedBackups, normalizeArchiveFormat,
  normalizeCompressionLevel, parseSevenZipWarnings, removeBackup, runBackup, runProcess, safeName, sevenZipPath, validateSource,
};
