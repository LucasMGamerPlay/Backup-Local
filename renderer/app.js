const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));

const PRESET_KEYS = {
  '*/30 * * * *': 'every30Minutes',
  '0 * * * *': 'everyHour',
  '0 0 * * *': 'everyDay',
  '0 0 * * 0': 'everySunday',
};

let config = null;
let history = [];
let restorePoints = [];
let dirty = false;
let toastTimer = null;
let lastState = null;
let lastRestoreState = null;
let sourceBeingRenamed = null;

function currentLanguage() {
  return window.backupI18n.normalize(config?.language);
}

function t(key, values) {
  return window.backupI18n.translate(currentLanguage(), key, values);
}

function applyLanguage() {
  window.backupI18n.apply(currentLanguage());
}

function fileName(filePath) {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function formatDate(value, includeTime = true) {
  if (!value) return '—';
  const options = includeTime
    ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat(currentLanguage() === 'en' ? 'en-US' : 'pt-BR', options).format(new Date(value));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index > 2 ? 2 : 1)} ${units[index]}`;
}

function cleanError(error) {
  const message = error?.message || String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function showToast(message, type = 'success') {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.className = `toast visible${type === 'error' ? ' error' : ''}`;
  toastTimer = setTimeout(() => { ui.toast.className = 'toast'; }, 3200);
}

function markDirty() {
  dirty = true;
  ui.unsavedBadge.classList.remove('hidden');
}

function scheduleLabel(value) {
  return t(PRESET_KEYS[value] || 'customSchedule');
}

function getPausedEntry(source) {
  return (config.pausedSources || []).find((entry) => entry.path.toLowerCase() === source.toLowerCase());
}

function getSourceNameEntry(source) {
  return (config.sourceNames || []).find((entry) => entry.path.toLowerCase() === source.toLowerCase());
}

function getSourceDisplayName(source) {
  return getSourceNameEntry(source)?.name || fileName(source);
}

function openRenameModal(source) {
  sourceBeingRenamed = source;
  ui.renameInput.value = getSourceNameEntry(source)?.name || '';
  ui.renameOriginalName.textContent = `${t('originalName', { name: fileName(source) })} • ${source}`;
  ui.renameModal.classList.remove('hidden');
  setTimeout(() => { ui.renameInput.focus(); ui.renameInput.select(); }, 0);
}

function closeRenameModal() {
  sourceBeingRenamed = null;
  ui.renameModal.classList.add('hidden');
}

async function saveSourceName(name) {
  if (!sourceBeingRenamed) return;
  const source = sourceBeingRenamed;
  const normalizedName = name.trim().replace(/\s+/g, ' ').slice(0, 80);
  config.sourceNames = (config.sourceNames || []).filter((entry) => entry.path.toLowerCase() !== source.toLowerCase());
  if (normalizedName) config.sourceNames.push({ path: source, name: normalizedName });
  closeRenameModal();
  markDirty();
  renderConfig();
  if (await saveConfiguration(true)) showToast(t('nameSaved'));
}

function formatPausedDuration(pausedAt) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(pausedAt).getTime()) / 60000));
  if (elapsedMinutes < 1) return t('pausedNow');
  if (elapsedMinutes < 60) return t('pausedFor', { duration: t('minuteShort', { count: elapsedMinutes }) });
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return t('pausedFor', { duration: t('hourShort', { count: elapsedHours }) });
  return t('pausedFor', { duration: t('dayShort', { count: Math.floor(elapsedHours / 24) }) });
}

function refreshPausedDurations() {
  document.querySelectorAll('[data-paused-at]').forEach((element) => {
    element.textContent = formatPausedDuration(element.dataset.pausedAt);
  });
}

async function toggleSourcePause(source) {
  const pausedEntry = getPausedEntry(source);
  if (pausedEntry) {
    config.pausedSources = config.pausedSources.filter((entry) => entry.path.toLowerCase() !== source.toLowerCase());
  } else {
    config.pausedSources = [...(config.pausedSources || []), { path: source, pausedAt: new Date().toISOString() }];
  }
  markDirty();
  renderConfig();
  if (await saveConfiguration(true)) showToast(t(pausedEntry ? 'resumeSaved' : 'pauseSaved'));
}

function renderConfig() {
  config.language = window.backupI18n.normalize(config.language);
  ui.language.value = config.language;
  applyLanguage();
  ui.destinationPath.value = config.destination;
  ui.scheduleEnabled.checked = config.scheduleEnabled;
  ui.retentionDays.value = config.retentionDays;
  ui.minFreeSpaceGB.value = config.minFreeSpaceGB;
  ui.backupOnStartup.checked = config.backupOnStartup;
  ui.launchAtLogin.checked = config.launchAtLogin;
  ui.respectGitignore.checked = config.respectGitignore === true;

  if (PRESET_KEYS[config.schedule]) {
    ui.schedulePreset.value = config.schedule;
    ui.customScheduleGroup.classList.add('hidden');
  } else {
    ui.schedulePreset.value = 'custom';
    ui.customSchedule.value = config.schedule;
    ui.customScheduleGroup.classList.remove('hidden');
  }

  ui.sourceList.replaceChildren();
  if (!config.sources.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-sources';
    empty.textContent = t('noSources');
    ui.sourceList.append(empty);
  } else {
    config.sources.forEach((source, index) => {
      const pausedEntry = getPausedEntry(source);
      const customName = getSourceNameEntry(source);
      const row = document.createElement('div');
      row.className = `source-item${pausedEntry ? ' paused' : ''}`;
      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      const copy = document.createElement('div');
      copy.className = 'source-copy';
      const title = document.createElement('strong');
      title.textContent = getSourceDisplayName(source);
      if (pausedEntry) {
        const badge = document.createElement('span');
        badge.className = 'paused-badge';
        badge.textContent = t('paused');
        title.append(' ', badge);
      }
      const pathText = document.createElement('small');
      pathText.textContent = source;
      copy.append(title, pathText);
      if (customName) {
        const originalName = document.createElement('small');
        originalName.className = 'original-name';
        originalName.textContent = t('originalName', { name: fileName(source) });
        copy.append(originalName);
      }
      if (pausedEntry) {
        const pausedTime = document.createElement('small');
        pausedTime.className = 'paused-duration';
        pausedTime.dataset.pausedAt = pausedEntry.pausedAt;
        pausedTime.textContent = formatPausedDuration(pausedEntry.pausedAt);
        copy.append(pausedTime);
      }
      const actions = document.createElement('div');
      actions.className = 'source-actions';
      const rename = document.createElement('button');
      rename.className = 'rename-source';
      rename.type = 'button';
      rename.title = t('rename');
      rename.setAttribute('aria-label', t('rename'));
      rename.textContent = '✎';
      rename.addEventListener('click', () => openRenameModal(source));
      const pause = document.createElement('button');
      pause.className = `pause-source${pausedEntry ? ' resume' : ''}`;
      pause.type = 'button';
      pause.textContent = pausedEntry ? t('resume') : t('pause');
      pause.addEventListener('click', () => toggleSourcePause(source).catch((error) => showToast(cleanError(error), 'error')));
      const remove = document.createElement('button');
      remove.className = 'remove-source';
      remove.type = 'button';
      remove.title = t('removeFolder');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        config.sources.splice(index, 1);
        config.pausedSources = (config.pausedSources || []).filter((entry) => entry.path.toLowerCase() !== source.toLowerCase());
        config.sourceNames = (config.sourceNames || []).filter((entry) => entry.path.toLowerCase() !== source.toLowerCase());
        markDirty();
        renderConfig();
      });
      actions.append(rename, pause, remove);
      row.append(icon, copy, actions);
      ui.sourceList.append(row);
    });
  }

  ui.sourceMetric.textContent = config.sources.length;
  ui.scheduleMetric.textContent = config.scheduleEnabled ? scheduleLabel(config.schedule) : t('disabled');
  ui.sidebarSchedule.textContent = config.scheduleEnabled ? scheduleLabel(config.schedule) : t('disabled');
  if (lastState?.running || lastRestoreState?.running) document.querySelectorAll('.pause-source').forEach((button) => { button.disabled = true; });
}

function readForm() {
  const preset = ui.schedulePreset.value;
  return {
    ...config,
    language: ui.language.value,
    destination: ui.destinationPath.value,
    scheduleEnabled: ui.scheduleEnabled.checked,
    schedule: preset === 'custom' ? ui.customSchedule.value.trim() : preset,
    retentionDays: Number(ui.retentionDays.value),
    minFreeSpaceGB: Number(ui.minFreeSpaceGB.value),
    backupOnStartup: ui.backupOnStartup.checked,
    launchAtLogin: ui.launchAtLogin.checked,
    respectGitignore: ui.respectGitignore.checked,
    pausedSources: config.pausedSources || [],
    sourceNames: config.sourceNames || [],
  };
}

async function saveConfiguration(silent = false) {
  try {
    config = await window.backupAPI.saveConfig(readForm());
    dirty = false;
    ui.unsavedBadge.classList.add('hidden');
    renderConfig();
    renderHistory();
    await refreshRestorePoints();
    if (!silent) showToast(t('configSaved'));
    return true;
  } catch (error) {
    showToast(cleanError(error), 'error');
    return false;
  }
}

function renderState(state) {
  lastState = state;
  const running = state.running;
  const restoreRunning = lastRestoreState?.running === true;
  ui.runBackupBtn.disabled = running || restoreRunning;
  ui.cancelBackupBtn.classList.toggle('hidden', !running);
  document.querySelectorAll('.pause-source, .restore-action').forEach((button) => { button.disabled = running || restoreRunning; });
  if (restoreRunning) {
    ui.sidebarStatus.textContent = t('restoring');
    ui.statusPill.className = 'status-pill';
    ui.statusPill.querySelector('b').textContent = t('restoring');
    ui.statusTitle.textContent = t('restoreInProgress');
    ui.statusDescription.textContent = lastRestoreState.message || t('currentSavedFirst');
    ui.progressFill.style.width = '45%';
    ui.progressLabel.textContent = lastRestoreState.message || t('preparing');
    return;
  }
  ui.sidebarStatus.textContent = running ? t('inProgress') : state.message === t('idle') ? t('ready') : state.message || t('ready');

  if (running) {
    ui.statusPill.className = 'status-pill';
    ui.statusPill.querySelector('b').textContent = state.phase === 'cancelling' ? t('cancelling') : t('inProgress');
    ui.statusTitle.textContent = state.phase === 'cancelling' ? t('closingSafely') : t('creatingCopy');
    ui.statusDescription.textContent = state.message;
    const percentage = state.total ? Math.min(100, Math.round((state.current / state.total) * 100)) : 8;
    ui.progressFill.style.width = `${percentage}%`;
    ui.progressLabel.textContent = state.total ? t('foldersCompleted', { current: state.current, total: state.total }) : t('preparing');
  } else {
    const failed = state.message === t('failed') || ['Falha no backup', 'Backup failed'].includes(state.message);
    const completed = state.message === t('completed') || ['Backup concluído', 'Backup completed'].includes(state.message);
    const idle = state.message === t('idle') || ['Aguardando', 'Waiting'].includes(state.message);
    ui.statusPill.className = `status-pill${failed ? ' error' : ''}`;
    ui.statusPill.querySelector('b').textContent = failed ? t('attention') : t('statusReady');
    ui.statusTitle.textContent = failed ? t('lastFailed') : t('protectedTitle');
    ui.statusDescription.textContent = idle ? t('protectedDescription') : state.message;
    ui.progressFill.style.width = completed ? '100%' : '0%';
    ui.progressLabel.textContent = state.message || t('idle');
  }
}

function renderRestoreState(state) {
  lastRestoreState = state;
  renderState(lastState || { running: false, message: t('idle') });
}

function addActivity(event) {
  const empty = ui.activityList.querySelector('.empty-state');
  if (empty) empty.remove();
  const item = document.createElement('div');
  item.className = `activity-item${event.type === 'source-error' || event.type === 'fatal' ? ' error' : ''}`;
  const dot = document.createElement('span');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString(currentLanguage() === 'en' ? 'en-US' : 'pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const message = document.createElement('span');
  message.textContent = event.message || t('currentUpdate');
  item.append(dot, time, message);
  ui.activityList.prepend(item);
}

function createEmptyActivity() {
  ui.activityList.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const check = document.createElement('span');
  check.textContent = '✓';
  const message = document.createElement('p');
  message.textContent = t('noActivity');
  empty.append(check, message);
  ui.activityList.append(empty);
}

function renderHistory() {
  ui.historyList.replaceChildren();
  const latest = history[0];
  ui.lastBackupMetric.textContent = latest ? formatDate(latest.finishedAt) : t('notYet');
  ui.spaceMetric.textContent = latest && Number.isFinite(latest.freeSpaceBytes) ? formatBytes(latest.freeSpaceBytes) : '—';

  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('span');
    icon.textContent = '↻';
    const message = document.createElement('p');
    message.textContent = t('historyEmpty');
    empty.append(icon, message);
    ui.historyList.append(empty);
    return;
  }

  history.slice(0, 20).forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'history-item';
    const badge = document.createElement('span');
    badge.className = `history-badge ${entry.status}`;
    badge.textContent = entry.status === 'success' ? '✓' : entry.status === 'partial' ? '!' : '×';
    const main = document.createElement('div');
    main.className = 'history-main';
    const title = document.createElement('strong');
    title.textContent = entry.status === 'success' ? t('completed') : entry.status === 'partial' ? t('folderCompleted') : t('failed');
    const subtitle = document.createElement('small');
    subtitle.textContent = `${formatDate(entry.finishedAt)} • ${entry.trigger === 'restore' ? t('restore') : entry.trigger === 'manual' ? t('manual') : t('automatic')}`;
    main.append(title, subtitle);
    const created = document.createElement('div');
    created.className = 'history-stat';
    created.textContent = t('createdFiles');
    const createdValue = document.createElement('strong');
    createdValue.textContent = entry.created?.length || 0;
    created.append(createdValue);
    const size = document.createElement('div');
    size.className = 'history-stat';
    size.textContent = t('totalSize');
    const sizeValue = document.createElement('strong');
    sizeValue.textContent = formatBytes((entry.created || []).reduce((total, file) => total + (file.size || 0), 0));
    size.append(sizeValue);
    row.append(badge, main, created, size);
    ui.historyList.append(row);
  });
}

function renderRestorePoints() {
  ui.restorePointList.replaceChildren();
  if (!restorePoints.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('span');
    icon.textContent = '◴';
    const message = document.createElement('p');
    message.textContent = t('noSources');
    empty.append(icon, message);
    ui.restorePointList.append(empty);
    return;
  }

  restorePoints.forEach((group) => {
    const card = document.createElement('article');
    card.className = 'restore-source';
    const heading = document.createElement('div');
    heading.className = 'restore-source-heading';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = group.sourceName;
    const sourcePath = document.createElement('small');
    sourcePath.textContent = group.source;
    copy.append(title, sourcePath);
    const count = document.createElement('span');
    count.textContent = t('pointCount', { count: group.points.length });
    heading.append(copy, count);
    card.append(heading);

    if (!group.points.length) {
      const empty = document.createElement('p');
      empty.className = 'restore-empty';
      empty.textContent = t('noRestorePoints');
      card.append(empty);
    } else {
      const controls = document.createElement('div');
      controls.className = 'restore-controls';
      const select = document.createElement('select');
      select.setAttribute('aria-label', t('restorePoints'));
      group.points.forEach((point) => {
        const option = document.createElement('option');
        option.value = point.path;
        option.textContent = `${formatDate(point.modifiedAt)} — ${formatBytes(point.size)}`;
        select.append(option);
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button restore-action';
      button.textContent = t('restore');
      button.disabled = lastState?.running || lastRestoreState?.running;
      button.addEventListener('click', async () => {
        if (dirty && !(await saveConfiguration(true))) return;
        addActivity({ type: 'restore-start', message: t('currentSavedFirst') });
        try {
          const result = await window.backupAPI.startRestore(group.source, select.value);
          if (result?.cancelled) showToast(t('restoreCancelled'));
        } catch (error) {
          showToast(`${t('restoreFailed')} ${cleanError(error)}`, 'error');
        }
      });
      controls.append(select, button);
      card.append(controls);
    }
    ui.restorePointList.append(card);
  });
}

async function refreshRestorePoints() {
  restorePoints = await window.backupAPI.getRestorePoints();
  renderRestorePoints();
}

async function chooseSources() {
  const selected = await window.backupAPI.selectSources();
  if (!selected.length) return;
  config.sources = [...new Set([...config.sources, ...selected])];
  markDirty();
  renderConfig();
}

async function initialize() {
  if (!window.backupAPI) return;
  try {
    [config, history, restorePoints] = await Promise.all([
      window.backupAPI.getConfig(),
      window.backupAPI.getHistory(),
      window.backupAPI.getRestorePoints(),
    ]);
    renderConfig();
    renderHistory();
    renderRestorePoints();
    renderState(await window.backupAPI.getState());
    renderRestoreState(await window.backupAPI.getRestoreState());
  } catch (error) {
    showToast(cleanError(error), 'error');
  }
}

ui.addSourcesBtn.addEventListener('click', () => chooseSources().catch((error) => showToast(cleanError(error), 'error')));
ui.addSourcesSecondaryBtn.addEventListener('click', () => chooseSources().catch((error) => showToast(cleanError(error), 'error')));
ui.selectDestinationBtn.addEventListener('click', async () => {
  try {
    const selected = await window.backupAPI.selectDestination();
    if (selected) { config.destination = selected; ui.destinationPath.value = selected; markDirty(); }
  } catch (error) { showToast(cleanError(error), 'error'); }
});
ui.openDestinationBtn.addEventListener('click', () => window.backupAPI.openDestination().catch((error) => showToast(cleanError(error), 'error')));
ui.saveConfigBtn.addEventListener('click', () => saveConfiguration());
ui.runBackupBtn.addEventListener('click', async () => {
  if (dirty && !(await saveConfiguration(true))) return;
  addActivity({ type: 'start', message: t('manualRequested') });
  window.backupAPI.startBackup().catch((error) => showToast(cleanError(error), 'error'));
});
ui.cancelBackupBtn.addEventListener('click', () => window.backupAPI.cancelBackup().catch((error) => showToast(cleanError(error), 'error')));
ui.clearActivityBtn.addEventListener('click', createEmptyActivity);
ui.schedulePreset.addEventListener('change', () => {
  ui.customScheduleGroup.classList.toggle('hidden', ui.schedulePreset.value !== 'custom');
  if (ui.schedulePreset.value === 'custom' && !ui.customSchedule.value) ui.customSchedule.value = config.schedule;
  markDirty();
});
ui.language.addEventListener('change', () => {
  config.language = ui.language.value;
  markDirty();
  renderConfig();
  renderHistory();
  renderRestorePoints();
  if (lastState) renderState(lastState);
  if (ui.activityList.querySelector('.empty-state')) createEmptyActivity();
});
[ui.scheduleEnabled, ui.retentionDays, ui.minFreeSpaceGB, ui.backupOnStartup, ui.launchAtLogin, ui.respectGitignore, ui.customSchedule].forEach((element) => element.addEventListener('change', markDirty));
ui.refreshRestorePointsBtn.addEventListener('click', () => refreshRestorePoints().catch((error) => showToast(cleanError(error), 'error')));
ui.quitAppBtn.addEventListener('click', () => window.backupAPI.quitApp().catch((error) => showToast(cleanError(error), 'error')));
ui.renameCloseBtn.addEventListener('click', closeRenameModal);
ui.renameModal.addEventListener('click', (event) => { if (event.target === ui.renameModal) closeRenameModal(); });
ui.renameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveSourceName(ui.renameInput.value).catch((error) => showToast(cleanError(error), 'error'));
});
ui.restoreNameBtn.addEventListener('click', () => saveSourceName('').catch((error) => showToast(cleanError(error), 'error')));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !ui.renameModal.classList.contains('hidden')) closeRenameModal(); });

window.backupAPI?.onState(renderState);
window.backupAPI?.onProgress(addActivity);
window.backupAPI?.onComplete((result) => {
  showToast(result.status === 'success' ? t('completeSuccess') : t('completedWarnings'), result.status === 'error' ? 'error' : 'success');
  refreshRestorePoints().catch((error) => showToast(cleanError(error), 'error'));
});
window.backupAPI?.onHistoryChanged((value) => { history = value; renderHistory(); });
window.backupAPI?.onConfigChanged((value) => { if (!dirty) { config = value; renderConfig(); renderHistory(); refreshRestorePoints().catch(() => {}); } });
window.backupAPI?.onRestoreState(renderRestoreState);
window.backupAPI?.onRestoreComplete((result) => showToast(result.status === 'success' ? t('restoreComplete') : t('completedWarnings')));
window.backupAPI?.onRestoreFailed((error) => addActivity({ type: 'fatal', message: error.message }));
window.backupAPI?.onRestorePointsChanged((value) => { restorePoints = value; renderRestorePoints(); });

document.querySelectorAll('.nav-item').forEach((link) => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
  link.classList.add('active');
}));

initialize();
setInterval(refreshPausedDurations, 60000);
