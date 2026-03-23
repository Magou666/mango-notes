const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('stickyAPI', {
  createNote:          (partial)       => ipcRenderer.invoke('create-note', partial),
  updateNote:          (id, changes)   => ipcRenderer.invoke('update-note', { id, changes }),
  trashNote:           (id)            => ipcRenderer.invoke('trash-note', id),
  restoreNote:         (id)            => ipcRenderer.invoke('restore-note', id),
  deleteNotePermanent: (id)            => ipcRenderer.invoke('delete-note-permanent', id),
  emptyTrash:          ()              => ipcRenderer.invoke('empty-trash'),
  openNote:            (id)            => ipcRenderer.invoke('open-note', id),
  closeNoteWindow:     (id)            => ipcRenderer.invoke('close-note-window', id),
  minimizeNote:        (id)            => ipcRenderer.invoke('minimize-note', id),
  togglePin:           (id)            => ipcRenderer.invoke('toggle-pin', id),
  setOpacity:          (id, opacity)   => ipcRenderer.invoke('set-opacity', { id, opacity }),
  addTag:              (id, tag)       => ipcRenderer.invoke('add-tag', { id, tag }),
  removeTag:           (id, tag)       => ipcRenderer.invoke('remove-tag', { id, tag }),
  getAllTags:           ()              => ipcRenderer.invoke('get-all-tags'),
  updateSettings:      (s)             => ipcRenderer.invoke('update-settings', s),
  openPanel:           ()              => ipcRenderer.invoke('open-panel'),
  newNoteFromPanel:    ()              => ipcRenderer.invoke('new-note-from-panel'),
  switchNote:          (fromId, toId)  => ipcRenderer.invoke('switch-note', { fromId, toId }),
  renameNote:          (id, title)     => ipcRenderer.invoke('rename-note', { id, title }),
  // 拖出侧边栏 → 新建独立窗口
  detachNote:          (noteId, x, y)  => ipcRenderer.invoke('detach-note', { noteId, x, y }),
  // 独立窗口拖入另一窗口 → 合并
  mergeNote:           (noteId, targetWinNoteId) => ipcRenderer.invoke('merge-note', { noteId, targetWinNoteId }),
  // 当前窗口有几条 note（决定是否允许 detach）
  getWinNoteCount:     ()              => ipcRenderer.invoke('get-win-note-count'),
  // 检测当前窗口附近是否有可合并的目标窗口
  checkMergeTarget:    ()              => ipcRenderer.invoke('check-merge-target'),
  // 拖出时：如鼠标落在另一便签窗口内则合并，否则新建独立窗口
  detachOrMerge:       (noteId, sx, sy) => ipcRenderer.invoke('detach-or-merge', { noteId, sx, sy }),

  onNoteData:       cb => ipcRenderer.on('note-data',        (_, d) => cb(d)),
  onPanelData:      cb => ipcRenderer.on('panel-data',       (_, d) => cb(d)),
  onNotesUpdate:    cb => ipcRenderer.on('notes-update',     (_, d) => cb(d)),
  onMergeCandidate: cb => ipcRenderer.on('merge-candidate',  (_, d) => cb(d)),
})
