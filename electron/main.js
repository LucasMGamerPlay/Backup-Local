const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } = require('electron');
const cron = require('node-cron');
const smokeTest = process.argv.includes('--smoke-test');
const integrationTest = process.argv.includes('--integration-test');
const loginTest = process.argv.includes('--login-test');
const uiTest = process.argv.includes('--ui-test');
const startHidden = process.argv.includes('--hidden');
let integrationDataRoot = null;

if (integrationTest || uiTest) {
  integrationDataRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'backup-local-test-data-'));
}

if (app.isPackaged || integrationDataRoot) {
  process.env.BACKUP_LOCAL_DATA_DIR = integrationDataRoot || app.getPath('userData');
  process.env.BACKUP_LOCAL_DEFAULT_DESTINATION = integrationDataRoot
    ? path.join(integrationDataRoot, 'backups')
    : path.join(app.getPath('documents'), 'Backup Local');
}

const { BackupManager } = require('../src/backup-manager');
const { RestoreManager } = require('../src/restore-manager');
const { listRestorePoints, validateRestoreSelection } = require('../src/restore-core');
const { createBackup } = require('../src/backup-core');
const { loadConfig, normalizeConfig, saveConfig, validateConfig } = require('../src/config');
const { readHistory } = require('../src/history');
const { translate } = require('../src/i18n');

let mainWindow = null;
let scheduler = null;
let tray = null;
let trayMenu = null;
let quitting = false;
let trayHintShown = false;
const backupManager = new BackupManager();
const restoreManager = new RestoreManager();
const hasInstanceLock = app.requestSingleInstanceLock();

if (!hasInstanceLock) app.quit();

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function displayTrayMessage(title, content) {
  if (!tray || process.platform !== 'win32') return;
  tray.displayBalloon({ title, content, iconType: 'info' });
}

function applyLaunchAtLogin(config) {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({
    openAtLogin: config.launchAtLogin,
    path: process.execPath,
    args: ['--hidden'],
  });
}

function requestQuit() {
  if (quitting) return;
  if (restoreManager.getState().running) {
    const language = loadConfig().language;
    displayTrayMessage(translate(language, 'restoreConfirmTitle'), translate(language, 'restoreInProgress'));
    showMainWindow();
    return;
  }
  quitting = true;
  if (scheduler) scheduler.destroy();

  const finish = () => app.quit();
  if (backupManager.getState().running) backupManager.cancel().finally(finish);
  else finish();
}

function updateTrayMenu(config) {
  if (!tray) return;
  const currentConfig = config || loadConfig();
  const language = currentConfig.language;
  trayMenu = Menu.buildFromTemplate([
    { label: translate(language, 'trayOpen'), click: showMainWindow },
    {
      label: translate(language, 'trayBackupNow'),
      enabled: !backupManager.getState().running && !restoreManager.getState().running,
      click: () => startBackup('manual').catch((error) => displayTrayMessage(translate(language, 'failed'), error.message)),
    },
    { type: 'separator' },
    {
      label: translate(language, 'trayLaunchWindows'),
      type: 'checkbox',
      checked: currentConfig.launchAtLogin,
      click: (menuItem) => {
        const updated = saveConfig({ ...loadConfig(), launchAtLogin: menuItem.checked });
        applyLaunchAtLogin(updated);
        send('config:changed', updated);
        updateTrayMenu(updated);
      },
    },
    { type: 'separator' },
    { label: translate(language, 'trayQuit'), click: requestQuit },
  ]);
  tray.setContextMenu(trayMenu);
}

async function createTray(config) {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray-icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty() && app.isPackaged) throw new Error(`Ícone da bandeja inválido: ${iconPath}`);
  if (icon.isEmpty()) icon = await app.getFileIcon(process.execPath, { size: 'small' });
  tray = new Tray(icon);
  tray.setToolTip('Backup Local');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  updateTrayMenu(config);
}

function configureScheduler(config) {
  if (scheduler) {
    scheduler.destroy();
    scheduler = null;
  }

  if (!config.scheduleEnabled || !cron.validate(config.schedule)) return;
  scheduler = cron.schedule(config.schedule, () => {
    if (backupManager.getState().running || restoreManager.getState().running) return;
    startBackup('scheduled').catch((error) => send('backup:progress', { type: 'fatal', message: error.message }));
  });
}

async function startBackup(trigger = 'manual') {
  const config = loadConfig();
  if (restoreManager.getState().running) throw new Error(translate(config.language, 'operationInProgress'));
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors[0]);
  return backupManager.start(config, trigger);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 850,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f4f7f6',
    title: 'Backup Local',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!smokeTest && !uiTest && !startHidden) mainWindow.show();
    else {
      if (smokeTest) {
        console.log('BACKUP_LOCAL_WINDOW_READY');
        setTimeout(requestQuit, 250);
      }
    }
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      const language = loadConfig().language;
      displayTrayMessage(translate(language, 'trayRunningTitle'), translate(language, 'trayRunningBody'));
    }
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function runPackagedIntegrationTest() {
  const testRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'backup-local-package-test-'));
  const source = path.join(testRoot, 'origem');
  const destination = path.join(testRoot, 'destino');

  try {
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'teste.txt'), 'Backup Local', 'utf8');
    const result = await backupManager.start({
      sources: [source],
      destination,
      retentionDays: 4,
      minFreeSpaceGB: 0,
      language: 'pt-BR',
    }, 'integration-test');
    const archive = result.created[0];
    if (result.status !== 'success' || !archive || !fs.existsSync(archive.path)) {
      throw new Error('O teste empacotado não criou o arquivo ZIP esperado.');
    }
    fs.writeFileSync(path.join(source, 'teste.txt'), 'Estado atual antes da restauração', 'utf8');
    fs.writeFileSync(path.join(source, 'novo.txt'), 'Arquivo novo', 'utf8');
    const restored = await restoreManager.start({
      sources: [source],
      destination,
      retentionDays: 4,
      minFreeSpaceGB: 0,
      language: 'pt-BR',
    }, source, archive.path);
    if (restored.status !== 'success'
      || fs.readFileSync(path.join(source, 'teste.txt'), 'utf8') !== 'Backup Local'
      || fs.existsSync(path.join(source, 'novo.txt'))
      || !fs.existsSync(restored.restore.safetyArchive.path)) {
      throw new Error('O teste empacotado não concluiu a restauração protegida esperada.');
    }
    console.log('BACKUP_LOCAL_INTEGRATION_OK');
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (integrationDataRoot) fs.rmSync(integrationDataRoot, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (integrationDataRoot) fs.rmSync(integrationDataRoot, { recursive: true, force: true });
    app.exit(1);
  }
}

function runLoginItemTest() {
  if (!app.isPackaged || process.platform !== 'win32') {
    app.exit(0);
    return;
  }

  const options = { path: process.execPath, args: ['--hidden'] };
  const original = app.getLoginItemSettings(options).openAtLogin;
  app.setLoginItemSettings({ ...options, openAtLogin: true });
  const enabled = app.getLoginItemSettings(options).openAtLogin;
  app.setLoginItemSettings({ ...options, openAtLogin: false });
  const disabled = !app.getLoginItemSettings(options).openAtLogin;
  app.setLoginItemSettings({ ...options, openAtLogin: original });
  console.log(enabled && disabled ? 'BACKUP_LOCAL_LOGIN_OK' : 'BACKUP_LOCAL_LOGIN_FAILED');
  app.exit(enabled && disabled ? 0 : 1);
}

async function runEnglishUiTest() {
  if (mainWindow.webContents.isLoadingMainFrame()) {
    await new Promise((resolve) => mainWindow.webContents.once('did-finish-load', resolve));
  }
  const result = await mainWindow.webContents.executeJavaScript(`({
    language: document.documentElement.lang,
    selected: document.querySelector('#language')?.value,
    settings: document.querySelector('[data-i18n="settings"]')?.textContent,
    background: document.querySelector('[data-i18n="backgroundExecution"]')?.textContent,
    pauseButton: document.querySelector('.pause-source')?.textContent,
    pausedBadge: document.querySelector('.paused-badge')?.textContent,
    sourceTitle: document.querySelector('.source-copy strong')?.childNodes[0]?.textContent?.trim(),
    renameTitle: document.querySelector('.rename-source')?.title,
    gitignoreChecked: document.querySelector('#respectGitignore')?.checked,
    restoreHeading: document.querySelector('[data-i18n="restorePoints"]')?.textContent,
    restoreSourceTitle: document.querySelector('.restore-source-heading strong')?.textContent
  })`);
  let valid = result.language === 'en'
    && result.selected === 'en'
    && result.settings === 'Settings'
    && result.background === 'Background operation'
    && result.pauseButton === 'Resume'
    && result.pausedBadge === 'PAUSED'
    && result.sourceTitle === 'Work documents'
    && result.renameTitle === 'Customize name'
    && result.gitignoreChecked === true
    && result.restoreHeading === 'Points in time'
    && result.restoreSourceTitle === 'Work documents'
    && trayMenu?.items[0]?.label === 'Open Local Backup'
    && trayMenu?.items.at(-1)?.label === 'Quit completely';

  await mainWindow.webContents.executeJavaScript("document.querySelector('.pause-source').click()");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const resumed = loadConfig().pausedSources.length === 0
    && await mainWindow.webContents.executeJavaScript("document.querySelector('.pause-source')?.textContent === 'Pause'");
  await mainWindow.webContents.executeJavaScript("document.querySelector('.pause-source').click()");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const pausedAgain = loadConfig().pausedSources.length === 1
    && await mainWindow.webContents.executeJavaScript("document.querySelector('.pause-source')?.textContent === 'Resume'");
  valid = valid && resumed && pausedAgain;

  await mainWindow.webContents.executeJavaScript("document.querySelector('.rename-source').click()");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const modalOpen = await mainWindow.webContents.executeJavaScript("!document.querySelector('#renameModal').classList.contains('hidden') && document.querySelector('#renameInput').value === 'Work documents'");
  await mainWindow.webContents.executeJavaScript("document.querySelector('#renameInput').value = 'Financial records'; document.querySelector('#renameForm').requestSubmit()");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const renamed = loadConfig().sourceNames[0]?.name === 'Financial records'
    && await mainWindow.webContents.executeJavaScript("document.querySelector('.source-copy strong')?.childNodes[0]?.textContent?.trim() === 'Financial records'");
  valid = valid && modalOpen && renamed;
  console.log(valid ? 'BACKUP_LOCAL_ENGLISH_UI_OK' : JSON.stringify(result));
  if (integrationDataRoot) fs.rmSync(integrationDataRoot, { recursive: true, force: true });
  app.exit(valid ? 0 : 1);
}

backupManager.on('state', (state) => {
  send('backup:state-changed', state);
  updateTrayMenu();
});
backupManager.on('progress', (event) => send('backup:progress', event));
backupManager.on('complete', (result) => {
  send('backup:complete', result);
  send('history:changed', readHistory());
  updateTrayMenu();
  if (!mainWindow?.isVisible()) {
    const language = loadConfig().language;
    const title = translate(language, result.status === 'success' ? 'completed' : 'completedWarnings');
    displayTrayMessage(title, translate(language, 'filesCreated', { count: result.created.length }));
  }
});
backupManager.on('failed', (error) => {
  send('backup:progress', { type: 'fatal', message: error.message });
  send('history:changed', readHistory());
  updateTrayMenu();
  if (!mainWindow?.isVisible()) displayTrayMessage(translate(loadConfig().language, 'failed'), error.message);
});
backupManager.on('cancelled', () => {
  send('backup:progress', { type: 'cancelled', message: 'Backup cancelado.' });
  updateTrayMenu();
});

restoreManager.on('state', (state) => {
  send('restore:state-changed', state);
  updateTrayMenu();
});
restoreManager.on('progress', (event) => {
  send('restore:progress', event);
  send('backup:progress', event);
});
restoreManager.on('complete', (result) => {
  send('restore:complete', result);
  send('history:changed', readHistory());
  send('restore-points:changed', listRestorePoints(loadConfig()));
  updateTrayMenu();
  if (!mainWindow?.isVisible()) {
    const language = loadConfig().language;
    displayTrayMessage(translate(language, 'restoreConfirmTitle'), translate(language, 'completed'));
  }
});
restoreManager.on('failed', (error) => {
  send('restore:failed', { message: error.message });
  send('history:changed', readHistory());
  send('restore-points:changed', listRestorePoints(loadConfig()));
  updateTrayMenu();
  if (!mainWindow?.isVisible()) displayTrayMessage(translate(loadConfig().language, 'failed'), error.message);
});

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_event, value) => {
  const normalized = normalizeConfig(value);
  if (!cron.validate(normalized.schedule)) throw new Error(translate(normalized.language, 'cronInvalid'));
  const config = saveConfig(normalized);
  backupManager.setLanguage(config.language);
  configureScheduler(config);
  applyLaunchAtLogin(config);
  updateTrayMenu(config);
  send('config:changed', config);
  return config;
});
ipcMain.handle('dialog:sources', async () => {
  const language = loadConfig().language;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: translate(language, 'sourcesDialogTitle'),
    buttonLabel: translate(language, 'sourcesDialogButton'),
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle('dialog:destination', async () => {
  const language = loadConfig().language;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: translate(language, 'destinationDialogTitle'),
    buttonLabel: translate(language, 'destinationDialogButton'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('backup:start', () => startBackup('manual'));
ipcMain.handle('backup:cancel', () => backupManager.cancel());
ipcMain.handle('backup:state', () => backupManager.getState());
ipcMain.handle('history:get', () => readHistory());
ipcMain.handle('restore-points:get', () => listRestorePoints(loadConfig()));
ipcMain.handle('restore:state', () => restoreManager.getState());
ipcMain.handle('restore:start', async (_event, value) => {
  const config = loadConfig();
  if (backupManager.getState().running || restoreManager.getState().running) {
    throw new Error(translate(config.language, 'operationInProgress'));
  }
  const selection = validateRestoreSelection(config, value?.source, value?.backupPath);
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: translate(config.language, 'restoreConfirmTitle'),
    message: translate(config.language, 'restoreConfirmQuestion'),
    detail: `${path.basename(selection.backupPath)}\n\n${translate(config.language, 'restoreConfirmDetail')}`,
    buttons: [translate(config.language, 'cancelButton'), translate(config.language, 'restoreButton')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response !== 1) return { cancelled: true };
  return restoreManager.start(config, selection.source, selection.backupPath);
});
ipcMain.handle('destination:open', async () => {
  const config = loadConfig();
  fs.mkdirSync(config.destination, { recursive: true });
  const error = await shell.openPath(config.destination);
  if (error) throw new Error(error);
  return true;
});
ipcMain.handle('app:quit', async () => {
  const language = loadConfig().language;
  if (restoreManager.getState().running) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: translate(language, 'restoreConfirmTitle'),
      message: translate(language, 'restoreInProgress'),
      buttons: ['OK'],
    });
    return false;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: translate(language, 'quitTitle'),
    message: translate(language, 'quitQuestion'),
    detail: backupManager.getState().running
      ? translate(language, 'quitRunningDetail')
      : translate(language, 'quitIdleDetail'),
    buttons: [translate(language, 'cancelButton'), translate(language, 'quitButton')],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  if (response !== 1) return false;
  requestQuit();
  return true;
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.lucas.backuplocal');
  if (integrationTest) {
    runPackagedIntegrationTest();
    return;
  }
  if (loginTest) {
    runLoginItemTest();
    return;
  }
  let config = loadConfig();
  if (uiTest) {
    const uiSource = path.join(integrationDataRoot, 'source');
    fs.mkdirSync(uiSource, { recursive: true });
    fs.writeFileSync(path.join(uiSource, 'example.txt'), 'UI test', 'utf8');
    config = saveConfig({
      ...config,
      language: 'en',
      sources: [uiSource],
      pausedSources: [{ path: uiSource, pausedAt: '2026-01-01T00:00:00.000Z' }],
      sourceNames: [{ path: uiSource, name: 'Work documents' }],
      respectGitignore: true,
    });
    fs.mkdirSync(config.destination, { recursive: true });
    createBackup(uiSource, config.destination, () => {}, new Date(), 'en', 'Work documents');
  }
  backupManager.setLanguage(config.language);
  configureScheduler(config);
  applyLaunchAtLogin(config);
  createWindow();
  await createTray(config);
  if (uiTest) {
    await runEnglishUiTest();
    return;
  }
  if (config.backupOnStartup) setTimeout(() => startBackup('startup').catch((error) => send('backup:progress', { type: 'fatal', message: error.message })), 1000);
});

app.on('window-all-closed', () => {});

app.on('activate', showMainWindow);

app.on('second-instance', (_event, argv) => {
  if (argv.includes('--quit-existing')) requestQuit();
  else showMainWindow();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  requestQuit();
});
