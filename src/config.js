const fs = require('fs');
const path = require('path');
const { normalizeLanguage, translate } = require('./i18n');

const APPLICATION_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = process.env.BACKUP_LOCAL_DATA_DIR
  ? path.resolve(process.env.BACKUP_LOCAL_DATA_DIR)
  : APPLICATION_ROOT;
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config.json');
const DEFAULT_DESTINATION = process.env.BACKUP_LOCAL_DEFAULT_DESTINATION
  ? path.resolve(process.env.BACKUP_LOCAL_DEFAULT_DESTINATION)
  : path.join(PROJECT_ROOT, 'meus_backups');

const DEFAULT_CONFIG = Object.freeze({
  sources: [],
  destination: DEFAULT_DESTINATION,
  scheduleEnabled: true,
  schedule: '0 * * * *',
  retentionDays: 4,
  minFreeSpaceGB: 1,
  backupOnStartup: false,
  launchAtLogin: false,
  respectGitignore: false,
  language: 'pt-BR',
  pausedSources: [],
  sourceNames: [],
});

function readFirstLine(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/)[0].trim();
}

function readLegacyConfig(root = PROJECT_ROOT, fallbackDestination = path.join(root, 'meus_backups')) {
  const sourceFile = path.join(root, 'pastas.txt');
  const destinationFile = path.join(root, 'destino.txt');
  const sources = fs.existsSync(sourceFile)
    ? fs.readFileSync(sourceFile, 'utf8').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : [];

  return {
    sources,
    destination: readFirstLine(destinationFile) || fallbackDestination,
  };
}

function normalizeConfig(value = {}, root = PROJECT_ROOT) {
  const sourceList = Array.isArray(value.sources) ? value.sources : [];
  const sources = [...new Set(sourceList
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => path.resolve(item.trim())))]
    .filter((item) => item !== path.parse(item).root);

  const destinationInput = typeof value.destination === 'string' && value.destination.trim()
    ? value.destination.trim()
    : path.join(root, 'meus_backups');

  const retention = Number(value.retentionDays);
  const freeSpace = Number(value.minFreeSpaceGB);
  const sourceKeys = new Set(sources.map((source) => source.toLowerCase()));
  const pausedInput = Array.isArray(value.pausedSources) ? value.pausedSources : [];
  const pausedSources = [];
  const pausedKeys = new Set();

  for (const entry of pausedInput) {
    const sourcePath = typeof entry === 'string' ? entry : entry?.path;
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) continue;
    const resolvedPath = path.resolve(sourcePath.trim());
    const sourceKey = resolvedPath.toLowerCase();
    if (!sourceKeys.has(sourceKey) || pausedKeys.has(sourceKey)) continue;
    const pausedDate = new Date(typeof entry === 'object' ? entry.pausedAt : '');
    pausedSources.push({
      path: resolvedPath,
      pausedAt: Number.isNaN(pausedDate.getTime()) ? new Date().toISOString() : pausedDate.toISOString(),
    });
    pausedKeys.add(sourceKey);
  }

  const sourceNamesInput = Array.isArray(value.sourceNames) ? value.sourceNames : [];
  const sourceNames = [];
  const namedKeys = new Set();
  for (const entry of sourceNamesInput) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.name !== 'string') continue;
    const resolvedPath = path.resolve(entry.path.trim());
    const sourceKey = resolvedPath.toLowerCase();
    const name = entry.name.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!sourceKeys.has(sourceKey) || namedKeys.has(sourceKey) || !name) continue;
    sourceNames.push({ path: resolvedPath, name });
    namedKeys.add(sourceKey);
  }

  return {
    sources,
    destination: path.resolve(destinationInput),
    scheduleEnabled: value.scheduleEnabled !== false,
    schedule: typeof value.schedule === 'string' && value.schedule.trim()
      ? value.schedule.trim()
      : DEFAULT_CONFIG.schedule,
    retentionDays: Number.isFinite(retention) ? Math.min(3650, Math.max(0, Math.round(retention))) : DEFAULT_CONFIG.retentionDays,
    minFreeSpaceGB: Number.isFinite(freeSpace) ? Math.min(10000, Math.max(0, freeSpace)) : DEFAULT_CONFIG.minFreeSpaceGB,
    backupOnStartup: value.backupOnStartup === true,
    launchAtLogin: value.launchAtLogin === true,
    respectGitignore: value.respectGitignore === true,
    language: normalizeLanguage(value.language),
    pausedSources,
    sourceNames,
  };
}

function saveConfig(config, filePath = CONFIG_FILE) {
  const normalized = normalizeConfig(config, path.dirname(filePath));
  const errors = validateConfig(normalized);
  if (errors.length) throw new Error(errors[0]);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function validateConfig(config) {
  const errors = [];
  const destination = path.resolve(config.destination);
  const destinationRoot = path.parse(destination).root;

  if (destination === destinationRoot) {
    errors.push(translate(config.language, 'destinationRoot'));
  }

  for (const source of config.sources) {
    const relative = path.relative(source, destination);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      errors.push(translate(config.language, 'destinationInsideSource', { source }));
    }
  }

  return errors;
}

function loadConfig(filePath = CONFIG_FILE) {
  if (fs.existsSync(filePath)) {
    try {
      return normalizeConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')), path.dirname(filePath));
    } catch (error) {
      error.message = `Não foi possível ler a configuração: ${error.message}`;
      throw error;
    }
  }

  const configDirectory = path.dirname(filePath);
  const fallbackDestination = filePath === CONFIG_FILE
    ? DEFAULT_DESTINATION
    : path.join(configDirectory, 'meus_backups');
  const legacy = readLegacyConfig(configDirectory, fallbackDestination);
  return saveConfig({ ...DEFAULT_CONFIG, ...legacy }, filePath);
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  PROJECT_ROOT,
  loadConfig,
  normalizeConfig,
  readLegacyConfig,
  saveConfig,
  validateConfig,
};
