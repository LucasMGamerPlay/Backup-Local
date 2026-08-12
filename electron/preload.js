const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('backupAPI', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  selectSources: () => ipcRenderer.invoke('dialog:sources'),
  selectDestination: () => ipcRenderer.invoke('dialog:destination'),
  startBackup: () => ipcRenderer.invoke('backup:start'),
  cancelBackup: () => ipcRenderer.invoke('backup:cancel'),
  getState: () => ipcRenderer.invoke('backup:state'),
  getHistory: () => ipcRenderer.invoke('history:get'),
  getRestorePoints: () => ipcRenderer.invoke('restore-points:get'),
  getRestoreState: () => ipcRenderer.invoke('restore:state'),
  startRestore: (source, backupPath) => ipcRenderer.invoke('restore:start', { source, backupPath }),
  openDestination: () => ipcRenderer.invoke('destination:open'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  onState: (callback) => subscribe('backup:state-changed', callback),
  onProgress: (callback) => subscribe('backup:progress', callback),
  onComplete: (callback) => subscribe('backup:complete', callback),
  onHistoryChanged: (callback) => subscribe('history:changed', callback),
  onConfigChanged: (callback) => subscribe('config:changed', callback),
  onRestoreState: (callback) => subscribe('restore:state-changed', callback),
  onRestoreProgress: (callback) => subscribe('restore:progress', callback),
  onRestoreComplete: (callback) => subscribe('restore:complete', callback),
  onRestoreFailed: (callback) => subscribe('restore:failed', callback),
  onRestorePointsChanged: (callback) => subscribe('restore-points:changed', callback),
});
