const { parentPort, workerData } = require('worker_threads');
const { runBackup } = require('./backup-core');

try {
  const result = runBackup(workerData.config, {
    trigger: workerData.trigger,
    onProgress: (event) => parentPort.postMessage({ type: 'progress', event }),
  });
  parentPort.postMessage({ type: 'complete', result });
} catch (error) {
  parentPort.postMessage({
    type: 'fatal',
    error: { message: error.message, stack: error.stack },
  });
}
