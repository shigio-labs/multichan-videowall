const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('multichanDownloads', {
  startBoardDownload(payload) {
    return ipcRenderer.invoke('downloads:start-board', payload);
  },

  cancelDownload() {
    return ipcRenderer.invoke('downloads:cancel-current');
  },

  onProgress(callback) {
    if (typeof callback !== 'function') return () => {};

    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('downloads:progress', listener);
    return () => ipcRenderer.removeListener('downloads:progress', listener);
  },
});
