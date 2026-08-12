const cron = require('node-cron');
const { BackupManager } = require('./src/backup-manager');
const { loadConfig, validateConfig } = require('./src/config');

const manager = new BackupManager();
let scheduledTask = null;

manager.on('state', (state) => console.log(`[BACKUP] ${state.message}`));
manager.on('progress', (event) => console.log(`[INFO] ${event.message}`));
manager.on('complete', (result) => {
  console.log(`[CONCLUÍDO] ${result.created.length} arquivo(s) criado(s), ${result.errors.length} erro(s).`);
});
manager.on('failed', (error) => console.error(`[ERRO] ${error.message}`));

async function execute(trigger) {
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors[0]);
  if (manager.getState().running) return;
  await manager.start(config, trigger);
}

function startService() {
  const config = loadConfig();
  if (!config.scheduleEnabled) {
    console.log('[SISTEMA] Agendamento desativado. Ative-o na interface.');
    return;
  }
  if (!cron.validate(config.schedule)) throw new Error('A expressão de agendamento é inválida.');

  console.log(`[SISTEMA] Serviço iniciado com agendamento: ${config.schedule}`);
  scheduledTask = cron.schedule(config.schedule, () => execute('scheduled').catch((error) => console.error(`[ERRO] ${error.message}`)));
  if (config.backupOnStartup) execute('startup').catch((error) => console.error(`[ERRO] ${error.message}`));
}

async function shutdown() {
  if (scheduledTask) scheduledTask.destroy();
  await manager.cancel();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (process.argv.includes('--once')) {
  execute('manual').then(() => process.exit(0)).catch((error) => {
    console.error(`[ERRO] ${error.message}`);
    process.exit(1);
  });
} else {
  try {
    startService();
  } catch (error) {
    console.error(`[ERRO] ${error.message}`);
    process.exit(1);
  }
}
