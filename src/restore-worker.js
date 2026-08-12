const { parentPort, workerData } = require('worker_threads');
const { restoreBackup } = require('./restore-core');

try {
  const result = restoreBackup(
    workerData.config,
    workerData.source,
    workerData.backupPath,
    (event) => parentPort.postMessage({ type: 'progress', event }),
  );
  parentPort.postMessage({ type: 'complete', result });
} catch (error) {
  parentPort.postMessage({ type: 'fatal', error: { message: error.message, stack: error.stack } });
}
