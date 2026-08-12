const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./config');

const DATA_DIRECTORY = path.join(PROJECT_ROOT, '.backup-data');
const HISTORY_FILE = path.join(DATA_DIRECTORY, 'history.jsonl');

function appendHistory(entry, filePath = HISTORY_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function readHistory(limit = 50, filePath = HISTORY_FILE) {
  if (!fs.existsSync(filePath)) return [];

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-Math.max(1, limit))
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { HISTORY_FILE, appendHistory, readHistory };
