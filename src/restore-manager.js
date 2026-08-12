const { EventEmitter } = require('events');
const path = require('path');
const { Worker } = require('worker_threads');
const { appendHistory } = require('./history');
const { translate } = require('./i18n');

class RestoreManager extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this.state = { running: false, phase: 'idle', message: '', source: null, startedAt: null };
  }

  getState() { return { ...this.state }; }

  updateState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  start(config, source, backupPath) {
    if (this.worker) throw new Error(translate(config.language, 'operationInProgress'));
    this.updateState({ running: true, phase: 'preparing', message: '', source, startedAt: new Date().toISOString() });
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(path.join(__dirname, 'restore-worker.js'), { workerData: { config, source, backupPath } });
      this.worker = worker;
      worker.on('message', (message) => {
        if (message.type === 'progress') {
          this.updateState({ phase: message.event.type, message: message.event.message || this.state.message });
          this.emit('progress', message.event);
        } else if (message.type === 'complete') {
          settled = true;
          appendHistory(message.result);
          this.updateState({ running: false, phase: 'complete', message: '', source: null, startedAt: null });
          this.emit('complete', message.result);
          resolve(message.result);
        } else if (message.type === 'fatal') {
          settled = true;
          const error = new Error(message.error.message);
          this.finishWithError(error, config, source, backupPath);
          reject(error);
        }
      });
      worker.on('error', (error) => {
        if (settled) return;
        settled = true;
        this.finishWithError(error, config, source, backupPath);
        reject(error);
      });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.worker = null;
        if (code !== 0 && !settled) {
          const error = new Error(`O processo de restauração terminou com o código ${code}.`);
          this.finishWithError(error, config, source, backupPath);
          reject(error);
        }
      });
    });
  }

  finishWithError(error, config, source, backupPath) {
    const now = new Date().toISOString();
    appendHistory({
      trigger: 'restore',
      startedAt: this.state.startedAt || now,
      finishedAt: now,
      status: 'error',
      destination: config.destination,
      created: [],
      removed: [],
      errors: [{ source, message: error.message }],
      restore: { source, backupPath },
    });
    this.updateState({ running: false, phase: 'failed', message: error.message, source: null, startedAt: null });
    this.emit('failed', error);
  }
}

module.exports = { RestoreManager };
