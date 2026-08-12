const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { appendHistory } = require('./history');
const { normalizeLanguage, translate } = require('./i18n');

class BackupManager extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this.partialPath = null;
    this.cancelRequested = false;
    this.language = 'pt-BR';
    this.state = this.createIdleState();
  }

  createIdleState() {
    return {
      running: false,
      phase: 'idle',
      current: 0,
      total: 0,
      message: translate(this.language, 'idle'),
      startedAt: null,
    };
  }

  getState() {
    return { ...this.state };
  }

  updateState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  setLanguage(language) {
    this.language = normalizeLanguage(language);
    if (!this.state.running) this.updateState({ message: translate(this.language, 'idle') });
  }

  start(config, trigger = 'manual') {
    this.language = normalizeLanguage(config.language);
    if (this.worker) throw new Error(translate(this.language, 'alreadyRunning'));

    this.cancelRequested = false;
    this.partialPath = null;
    this.updateState({
      running: true,
      phase: 'preparing',
      current: 0,
      total: config.sources.length,
      message: translate(this.language, 'preparing'),
      startedAt: new Date().toISOString(),
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(path.join(__dirname, 'backup-worker.js'), {
        workerData: { config, trigger },
      });
      this.worker = worker;

      worker.on('message', (message) => {
        if (message.type === 'progress') {
          const event = message.event;
          if (event.partialPath) this.partialPath = event.partialPath;
          const phase = event.type === 'cleanup' ? 'cleanup' : event.type.startsWith('source') || event.type === 'archive-start' ? 'archiving' : 'preparing';
          this.updateState({
            phase,
            current: Number.isFinite(event.index) ? event.index : this.state.current,
            total: Number.isFinite(event.total) ? event.total : this.state.total,
            message: event.message || this.state.message,
          });
          this.emit('progress', event);
          return;
        }

        if (message.type === 'complete') {
          settled = true;
          this.partialPath = null;
          appendHistory(message.result);
          this.updateState({ ...this.createIdleState(), message: translate(this.language, message.result.status === 'success' ? 'completed' : 'completedWarnings') });
          this.emit('complete', message.result);
          resolve(message.result);
          return;
        }

        if (message.type === 'fatal') {
          settled = true;
          const error = new Error(message.error.message);
          this.finishWithError(error, trigger);
          reject(error);
        }
      });

      worker.on('error', (error) => {
        if (settled || this.cancelRequested) return;
        settled = true;
        this.finishWithError(error, trigger);
        reject(error);
      });

      worker.on('exit', (code) => {
        if (this.worker === worker) this.worker = null;
        if (this.cancelRequested) {
          this.removePartialFile();
          this.updateState({ ...this.createIdleState(), message: translate(this.language, 'cancelled') });
          this.emit('cancelled');
          if (!settled) resolve({ status: 'cancelled' });
        } else if (code !== 0 && !settled) {
          const error = new Error(`O processo de backup terminou com o código ${code}.`);
          this.finishWithError(error, trigger);
          reject(error);
        }
      });
    });
  }

  finishWithError(error, trigger) {
    this.removePartialFile();
    const now = new Date().toISOString();
    const entry = {
      trigger,
      startedAt: this.state.startedAt || now,
      finishedAt: now,
      status: 'error',
      destination: null,
      created: [],
      removed: [],
      errors: [{ source: null, message: error.message }],
    };
    appendHistory(entry);
    this.updateState({ ...this.createIdleState(), message: translate(this.language, 'failed') });
    this.emit('failed', error);
  }

  removePartialFile() {
    if (!this.partialPath) return;
    try {
      if (fs.existsSync(this.partialPath)) fs.unlinkSync(this.partialPath);
    } catch {
      // O arquivo temporário poderá ser removido no próximo ciclo.
    }
    this.partialPath = null;
  }

  async cancel() {
    if (!this.worker) return false;
    this.cancelRequested = true;
    this.updateState({ phase: 'cancelling', message: translate(this.language, 'cancelling') });
    await this.worker.terminate();
    return true;
  }
}

module.exports = { BackupManager };
