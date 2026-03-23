const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut } = require('electron')
const path = require('path')
const fs   = require('fs')
const { v4: uuidv4 } = require('uuid')

app.setName('mango')
app.setAppUserModelId('com.mango.stickynotes')

// ── 数据路径 ──────────────────────────────────────────────────
const DATA_DIR      = path.join(app.getPath('userData'), 'mango-notes')
const NOTES_FILE    = path.join(DATA_DIR, 'notes.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// ── 状态 ─────────────────────────────────────────────────────
// noteWindows  : noteId  → BrowserWindow  （note 当前由哪个窗口承载）
// windowCurNote: win.id  → noteId          （窗口当前正在显示的 note）
// windowNotes  : win.id  → Set<noteId>     （窗口侧边栏里拥有的全部 notes）
let noteWindows    = new Map()
let windowCurNote  = new Map()
let windowNotes    = new Map()   // ← 关键：每窗口独立的 note 集合
let lastFocusedWin = null

let tray = null
let notes = []
let settings = { globalOpacity: 0.92, alwaysOnTop: false }

// ── 防抖 ─────────────────────────────────────────────────────
const debounceTimers = new Map()
function debounce(key, fn, delay) {
  clearTimeout(debounceTimers.get(key))
  debounceTimers.set(key, setTimeout(() => { debounceTimers.delete(key); fn() }, delay))
}

// ── 持久化 ───────────────────────────────────────────────────
function loadNotes() {
  try { if (fs.existsSync(NOTES_FILE)) notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')) }
  catch (e) { notes = [] }
}
function saveNotes() {
  try { fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), 'utf8') }
  catch (e) { console.error(e) }
}
function loadSettings() {
  try { if (fs.existsSync(SETTINGS_FILE)) settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } }
  catch (e) {}
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8') }
  catch (e) { console.error(e) }
}

// ── 颜色主题 ─────────────────────────────────────────────────
const NOTE_THEMES = [
  { id: 'yellow', bg: '#FFF9C4', header: '#F9A825', accent: '#F57F17' },
  { id: 'pink',   bg: '#FCE4EC', header: '#E91E63', accent: '#880E4F' },
  { id: 'blue',   bg: '#E3F2FD', header: '#1976D2', accent: '#0D47A1' },
  { id: 'green',  bg: '#E8F5E9', header: '#388E3C', accent: '#1B5E20' },
  { id: 'purple', bg: '#F3E5F5', header: '#8E24AA', accent: '#4A148C' },
  { id: 'orange', bg: '#FFF3E0', header: '#E65100', accent: '#BF360C' },
  { id: 'teal',   bg: '#E0F2F1', header: '#00796B', accent: '#004D40' },
  { id: 'dark',   bg: '#263238', header: '#37474F', accent: '#B0BEC5' },
]

// ── 工具 ─────────────────────────────────────────────────────
function getActiveNoteWindows() {
  const wins = new Set()
  noteWindows.forEach(win => { if (!win.isDestroyed()) wins.add(win) })
  return [...wins]
}

// 获取某个窗口「拥有」的 notes 列表（未删除）
function getWinNotes(win) {
  const ids = windowNotes.get(win.id) || new Set()
  return notes.filter(n => !n.deleted && ids.has(n.id))
}

// ── 推送数据 ─────────────────────────────────────────────────
function sendPanelData() {
  if (panelWindow && !panelWindow.isDestroyed())
    panelWindow.webContents.send('panel-data', { notes, themes: NOTE_THEMES, settings })
}

// 向特定窗口推送它自己的 notes 列表
function sendNotesUpdateToWin(win) {
  if (!win || win.isDestroyed()) return
  const winNotes = getWinNotes(win)
  win.webContents.send('notes-update', { notes: winNotes, themes: NOTE_THEMES })
}

// 向所有便签窗口各自推送各自的 notes
function sendNotesUpdate() {
  getActiveNoteWindows().forEach(win => sendNotesUpdateToWin(win))
}

// ── 创建便签窗口 ──────────────────────────────────────────────
function createNoteWindow(note, opts = {}) {
  if (note.deleted) return null
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    x: opts.x ?? note.x ?? Math.floor(Math.random() * (sw - 348) * 0.6 + sw * 0.1),
    y: opts.y ?? note.y ?? Math.floor(Math.random() * (sh - 360) * 0.6 + sh * 0.1),
    width: note.width ?? 348, height: note.height ?? 380,
    minWidth: 240, minHeight: 200,
    frame: false, transparent: true, hasShadow: true,
    alwaysOnTop: note.pinned ?? false,
    skipTaskbar: true, resizable: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  })

  // 初始化该窗口的 notes 集合（由调用方传入，默认只有这一条）
  const initIds = opts.noteIds || [note.id]
  windowNotes.set(win.id, new Set(initIds))

  win.loadFile(path.join(__dirname, 'renderer', 'note.html'))
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('note-data', { note, themes: NOTE_THEMES, settings })
    setTimeout(() => {
      if (!win.isDestroyed()) sendNotesUpdateToWin(win)
    }, 150)
  })
  win.on('focus', () => { lastFocusedWin = win })
  win.on('moved', () => {
    const curId = windowCurNote.get(win.id)
    if (curId) debounce(`move-${curId}`, () => {
      const [x, y] = win.getPosition(); updateNote(curId, { x, y }, true)
    }, 300)

    // 检测是否与其他便签窗口重叠 → 通知渲染层 / 自动合并
    debounce(`merge-check-${win.id}`, () => {
      if (win.isDestroyed()) return
      // 只有「独立窗口」（只有1条note）才需要检测合并
      const myNotes = windowNotes.get(win.id) || new Set()
      if (myNotes.size > 1) return   // 多条note的窗口不参与合并

      const [wx, wy] = win.getPosition()
      const [ww, wh] = win.getSize()

      let foundNoteId = null, targetWin = null
      for (const [nid, tw] of noteWindows) {
        if (tw === win || tw.isDestroyed()) continue
        const [tx, ty] = tw.getPosition()
        const [tww, twh] = tw.getSize()
        const overlapX = wx < tx + tww && wx + ww > tx
        const overlapY = wy < ty + twh && wy + wh > ty
        if (overlapX && overlapY) { foundNoteId = nid; targetWin = tw; break }
      }

      if (!win.isDestroyed()) {
        win.webContents.send('merge-candidate',
          foundNoteId ? { found: true, targetNoteId: foundNoteId } : { found: false })
      }

      // 窗口静止且重叠 → 延迟 500ms 自动合并（如果没有新的 moved 事件打断）
      if (foundNoteId && targetWin) {
        clearTimeout(win._autoMergeTimer)
        win._autoMergeTimer = setTimeout(() => {
          if (win.isDestroyed() || targetWin.isDestroyed()) return
          // 再次确认还在重叠
          const [wx2, wy2] = win.getPosition()
          const [ww2, wh2] = win.getSize()
          const [tx2, ty2] = targetWin.getPosition()
          const [tw2, th2] = targetWin.getSize()
          const stillOverlap = wx2 < tx2 + tw2 && wx2 + ww2 > tx2 &&
                                wy2 < ty2 + th2 && wy2 + wh2 > ty2
          if (!stillOverlap) return

          // 执行合并：把 win 里的 note 合并到 targetWin
          const srcNotes = [...(windowNotes.get(win.id) || [])]
          if (srcNotes.length === 0) return
          const noteIdToMerge = srcNotes[0]
          const noteToMerge = notes.find(n => n.id === noteIdToMerge)
          if (!noteToMerge) return

          windowNotes.get(win.id)?.delete(noteIdToMerge)
          noteWindows.delete(noteIdToMerge)

          if (!windowNotes.has(targetWin.id)) windowNotes.set(targetWin.id, new Set())
          windowNotes.get(targetWin.id).add(noteIdToMerge)
          noteWindows.set(noteIdToMerge, targetWin)
          sendNotesUpdateToWin(targetWin)
          targetWin.focus()
          if (!win.isDestroyed()) win.close()
        }, 500)
      } else {
        clearTimeout(win._autoMergeTimer)
        win._autoMergeTimer = null
      }
    }, 60)
  })
  win.on('resized', () => {
    const curId = windowCurNote.get(win.id)
    if (curId) debounce(`resize-${curId}`, () => {
      const [w, h] = win.getSize(); updateNote(curId, { width: w, height: h }, true)
    }, 300)
  })
  win.on('closed', () => {
    clearTimeout(win._autoMergeTimer)
    noteWindows.forEach((w, id) => { if (w === win) noteWindows.delete(id) })
    windowCurNote.delete(win.id)
    windowNotes.delete(win.id)
  })

  windowCurNote.set(win.id, note.id)
  noteWindows.set(note.id, win)
  if (!lastFocusedWin || lastFocusedWin.isDestroyed()) lastFocusedWin = win
  return win
}

// ── 主面板 ───────────────────────────────────────────────────
let panelWindow = null
function createPanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) { panelWindow.focus(); return }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  panelWindow = new BrowserWindow({
    x: Math.floor((sw - 480) / 2), y: Math.floor((sh - 640) / 2),
    width: 480, height: 640, minWidth: 420, minHeight: 520,
    frame: false, transparent: true, hasShadow: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  })
  panelWindow.loadFile(path.join(__dirname, 'renderer', 'panel.html'))
  panelWindow.webContents.on('did-finish-load', () => sendPanelData())
  panelWindow.on('closed', () => { panelWindow = null })
}

// ── 标签 ─────────────────────────────────────────────────────
function getAllTags() {
  const s = new Set()
  notes.filter(n => !n.deleted).forEach(n => (n.tags || []).forEach(t => s.add(t)))
  return [...s].sort()
}

// ── CRUD ─────────────────────────────────────────────────────
function createNote(partial = {}) {
  const note = {
    id: uuidv4(), content: '',
    themeId: NOTE_THEMES[Math.floor(Math.random() * (NOTE_THEMES.length - 1))].id,
    opacity: settings.globalOpacity, pinned: false, tags: [],
    deleted: false, deletedAt: null,
    createdAt: Date.now(), updatedAt: Date.now(),
    x: null, y: null, width: 348, height: 380,
    ...partial
  }
  notes.unshift(note)
  saveNotes()
  sendPanelData()
  return note
}

function updateNote(id, changes, silent = false) {
  const idx = notes.findIndex(n => n.id === id)
  if (idx === -1) return
  notes[idx] = { ...notes[idx], ...changes, updatedAt: Date.now() }
  saveNotes()
  if (!silent) { sendPanelData(); sendNotesUpdate() }
}

function trashNote(id) {
  updateNote(id, { deleted: true, deletedAt: Date.now() })
  noteWindows.delete(id)
  // 从所有窗口的 notes 集合中移除
  windowNotes.forEach(set => set.delete(id))
  sendPanelData(); sendNotesUpdate()
}

function restoreNote(id) {
  updateNote(id, { deleted: false, deletedAt: null })
  sendPanelData(); sendNotesUpdate()
}

function deleteNotePermanent(id) {
  notes = notes.filter(n => n.id !== id)
  saveNotes()
  noteWindows.delete(id)
  windowNotes.forEach(set => set.delete(id))
  sendPanelData(); sendNotesUpdate()
}

function emptyTrash() {
  const trashed = notes.filter(n => n.deleted).map(n => n.id)
  trashed.forEach(id => {
    noteWindows.delete(id)
    windowNotes.forEach(set => set.delete(id))
  })
  notes = notes.filter(n => !n.deleted)
  saveNotes(); sendPanelData(); sendNotesUpdate()
}

// ── 托盘 ─────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon_32.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYGD4z8BAAoxUGhgYGP4TaRkpWkbSAFLcRLJHSHEbyR4ixW0kewQAHiQEAT9eThMAAAAASUVORK5CYII='
  )
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('mango')
  const menu = Menu.buildFromTemplate([
    { label: '🥭 新建便签', click: () => {
      const note = createNote()
      const win = lastFocusedWin && !lastFocusedWin.isDestroyed() ? lastFocusedWin : null
      if (win) {
        windowNotes.get(win.id)?.add(note.id)
        noteWindows.set(note.id, win)
        const oldId = windowCurNote.get(win.id)
        if (oldId) noteWindows.set(oldId, win)
        windowCurNote.set(win.id, note.id)
        win.webContents.send('note-data', { note, themes: NOTE_THEMES, settings })
        sendNotesUpdateToWin(win)
      } else {
        createNoteWindow(note)
      }
    }},
    { label: '☰  打开面板', click: () => createPanelWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', () => createPanelWindow())
}

// ── IPC ──────────────────────────────────────────────────────

// 新建便签 → 加入当前窗口侧边栏，不新开窗口
ipcMain.handle('create-note', (event, partial) => {
  const note = createNote(partial)
  const win  = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    // 把新 note 加入该窗口的 notes 集合
    if (!windowNotes.has(win.id)) windowNotes.set(win.id, new Set())
    windowNotes.get(win.id).add(note.id)
    noteWindows.set(note.id, win)
    // 切换到新便签
    windowCurNote.set(win.id, note.id)
    win.webContents.send('note-data', { note, themes: NOTE_THEMES, settings })
    sendNotesUpdateToWin(win)
  }
  return note
})

ipcMain.handle('update-note', (_, { id, changes }) => {
  updateNote(id, changes)
  const win = noteWindows.get(id)
  if (win && !win.isDestroyed() && changes.pinned !== undefined)
    win.setAlwaysOnTop(changes.pinned)
})

ipcMain.handle('trash-note',            (_, id) => trashNote(id))
ipcMain.handle('restore-note',          (_, id) => restoreNote(id))
ipcMain.handle('delete-note-permanent', (_, id) => deleteNotePermanent(id))
ipcMain.handle('empty-trash',           ()      => emptyTrash())

ipcMain.handle('open-note', (event, id) => {
  const note = notes.find(n => n.id === id)
  if (!note || note.deleted) return
  const existing = noteWindows.get(id)
  if (existing && !existing.isDestroyed()) { existing.focus(); return }
  const win = BrowserWindow.fromWebContents(event.sender) ||
              (lastFocusedWin && !lastFocusedWin.isDestroyed() ? lastFocusedWin : null)
  if (win && !win.isDestroyed()) {
    windowNotes.get(win.id)?.add(id)
    noteWindows.set(id, win)
    windowCurNote.set(win.id, id)
    win.webContents.send('note-data', { note, themes: NOTE_THEMES, settings })
    sendNotesUpdateToWin(win)
  } else {
    createNoteWindow(note)
  }
})

ipcMain.handle('close-note-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) win.close()
})
ipcMain.handle('minimize-note', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) win.minimize()
})
ipcMain.handle('toggle-pin', (_, id) => {
  const note = notes.find(n => n.id === id); if (!note) return
  const pinned = !note.pinned
  updateNote(id, { pinned })
  const win = noteWindows.get(id)
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned)
})
ipcMain.handle('set-opacity',   (_, { id, opacity }) => updateNote(id, { opacity }))
ipcMain.handle('add-tag', (_, { id, tag }) => {
  const note = notes.find(n => n.id === id); if (!note) return
  updateNote(id, { tags: [...new Set([...(note.tags || []), tag.trim()])] })
})
ipcMain.handle('remove-tag', (_, { id, tag }) => {
  const note = notes.find(n => n.id === id); if (!note) return
  updateNote(id, { tags: (note.tags || []).filter(t => t !== tag) })
})
ipcMain.handle('get-all-tags',    ()     => getAllTags())
ipcMain.handle('update-settings', (_, s) => { settings = { ...settings, ...s }; saveSettings() })
ipcMain.handle('open-panel',      ()     => createPanelWindow())
ipcMain.handle('new-note-from-panel', () => {
  const note = createNote()
  const win = lastFocusedWin && !lastFocusedWin.isDestroyed() ? lastFocusedWin : null
  if (win) {
    windowNotes.get(win.id)?.add(note.id)
    noteWindows.set(note.id, win)
    windowCurNote.set(win.id, note.id)
    win.webContents.send('note-data', { note, themes: NOTE_THEMES, settings })
    sendNotesUpdateToWin(win)
  } else {
    createNoteWindow(note)
  }
})

// 查询当前窗口拥有的 note 数量（用于前端判断是否禁止 detach）
ipcMain.handle('get-win-note-count', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return 0
  return (windowNotes.get(win.id) || new Set()).size
})

// 检测当前窗口附近是否有其他便签窗口可以合并进去
// 返回 { found: true, targetNoteId } 或 { found: false }
ipcMain.handle('check-merge-target', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return { found: false }

  const [wx, wy] = win.getPosition()
  const [ww, wh] = win.getSize()
  const wCx = wx + ww / 2
  const wCy = wy + wh / 2
  const THRESHOLD = 120  // 像素，两窗口中心距离阈值

  for (const [noteId, targetWin] of noteWindows) {
    if (targetWin === win || targetWin.isDestroyed()) continue
    const [tx, ty] = targetWin.getPosition()
    const [tw, th] = targetWin.getSize()
    const tCx = tx + tw / 2
    const tCy = ty + th / 2
    const dist = Math.sqrt((wCx - tCx) ** 2 + (wCy - tCy) ** 2)
    if (dist < THRESHOLD) {
      return { found: true, targetNoteId: noteId }
    }
  }
  return { found: false }
})

// 重命名
ipcMain.handle('rename-note', (_, { id, title }) => {
  const note = notes.find(n => n.id === id); if (!note) return
  updateNote(id, { title: title.trim().slice(0, 20) })
})

// 原地切换（同窗口换 note）
ipcMain.handle('switch-note', (event, { fromId, toId }) => {
  const toNote = notes.find(n => n.id === toId)
  if (!toNote || toNote.deleted) return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  // fromId 仍归该窗口，只是切换显示
  noteWindows.set(toId, win)
  windowCurNote.set(win.id, toId)
  win.webContents.send('note-data', { note: toNote, themes: NOTE_THEMES, settings, silent: true })
})

// 拖出侧边栏 → 智能判断：鼠标落在另一便签窗口内则合并，否则新建独立窗口
ipcMain.handle('detach-or-merge', (event, { noteId, sx, sy }) => {
  const note = notes.find(n => n.id === noteId)
  if (!note || note.deleted) return

  const srcWin = BrowserWindow.fromWebContents(event.sender)

  // 用实时鼠标位置判断落点（比传入坐标更准）
  const cursor = screen.getCursorScreenPoint()
  const px = cursor.x, py = cursor.y

  // 检查是否落在某个其他便签窗口的 bounds 内
  let targetWin = null, targetNoteId = null
  for (const [nid, win] of noteWindows) {
    if (!win || win.isDestroyed() || win === srcWin) continue
    const [wx, wy] = win.getPosition()
    const [ww, wh] = win.getSize()
    if (px >= wx && px <= wx + ww && py >= wy && py <= wy + wh) {
      targetWin = win; targetNoteId = nid; break
    }
  }

  if (targetWin) {
    // ── 直接合并到目标窗口 ────────────────────────────────────
    // 1. 从原窗口移除
    if (srcWin && !srcWin.isDestroyed()) {
      const srcSet = windowNotes.get(srcWin.id)
      if (srcSet) srcSet.delete(noteId)
      // 若原窗口当前显示的是被拖走的那条，切换到下一条
      const curId = windowCurNote.get(srcWin.id)
      if (curId === noteId) {
        const remaining = [...(windowNotes.get(srcWin.id) || [])]
        const nextNote = remaining.length > 0 ? notes.find(n => n.id === remaining[0] && !n.deleted) : null
        if (nextNote) {
          noteWindows.set(nextNote.id, srcWin)
          windowCurNote.set(srcWin.id, nextNote.id)
          srcWin.webContents.send('note-data', { note: nextNote, themes: NOTE_THEMES, settings })
        }
      }
      sendNotesUpdateToWin(srcWin)
    }
    noteWindows.delete(noteId)

    // 2. 加入目标窗口的 notes 集合，但不切换当前显示
    if (!windowNotes.has(targetWin.id)) windowNotes.set(targetWin.id, new Set())
    windowNotes.get(targetWin.id).add(noteId)
    noteWindows.set(noteId, targetWin)
    sendNotesUpdateToWin(targetWin)
    targetWin.focus()
    return { ok: true, merged: true }
  }

  // ── 没有落在任何窗口内 → 正常 detach 新建独立窗口 ────────────
  if (srcWin && !srcWin.isDestroyed()) {
    const srcSet = windowNotes.get(srcWin.id)
    if (srcSet) srcSet.delete(noteId)
    const curId = windowCurNote.get(srcWin.id)
    if (curId === noteId) {
      const remaining = [...(windowNotes.get(srcWin.id) || [])]
      const nextNote = remaining.length > 0 ? notes.find(n => n.id === remaining[0] && !n.deleted) : null
      if (nextNote) {
        noteWindows.set(nextNote.id, srcWin)
        windowCurNote.set(srcWin.id, nextNote.id)
        srcWin.webContents.send('note-data', { note: nextNote, themes: NOTE_THEMES, settings })
      }
    }
    sendNotesUpdateToWin(srcWin)
  }
  noteWindows.delete(noteId)
  const nx = (sx != null && sx > 0) ? sx - 174 : Math.floor(screen.getPrimaryDisplay().workAreaSize.width * 0.5)
  const ny = (sy != null && sy > 0) ? sy - 22  : Math.floor(screen.getPrimaryDisplay().workAreaSize.height * 0.3)
  createNoteWindow(note, { x: nx, y: ny, noteIds: [noteId] })
  return { ok: true, merged: false }
})

// 拖出侧边栏 → 新独立窗口，只包含这一条 note
ipcMain.handle('detach-note', (event, { noteId, x, y }) => {
  const note = notes.find(n => n.id === noteId)
  if (!note || note.deleted) return

  const srcWin = BrowserWindow.fromWebContents(event.sender)

  // 1. 从原窗口的 notes 集合中移除
  if (srcWin && !srcWin.isDestroyed()) {
    const srcSet = windowNotes.get(srcWin.id)
    if (srcSet) srcSet.delete(noteId)

    // 如果原窗口当前显示的就是被拖走的 note，切换到侧边栏第一条
    const curId = windowCurNote.get(srcWin.id)
    if (curId === noteId) {
      const remaining = [...(windowNotes.get(srcWin.id) || [])]
      if (remaining.length > 0) {
        const nextNote = notes.find(n => n.id === remaining[0] && !n.deleted)
        if (nextNote) {
          noteWindows.set(nextNote.id, srcWin)
          windowCurNote.set(srcWin.id, nextNote.id)
          srcWin.webContents.send('note-data', { note: nextNote, themes: NOTE_THEMES, settings })
        }
      }
      // 若已没有 note，srcWin 变空（不强制关闭，让用户手动关）
    }
    // 通知原窗口刷新侧边栏
    sendNotesUpdateToWin(srcWin)
  }

  // 2. 解除 note 与原窗口的 noteWindows 映射
  noteWindows.delete(noteId)

  // 3. 新建独立窗口，只包含这一条 note
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const nx = (x != null && x > 0) ? x : Math.floor(sw * 0.5)
  const ny = (y != null && y > 0) ? y : Math.floor(sh * 0.3)
  createNoteWindow(note, { x: nx, y: ny, noteIds: [noteId] })

  return { ok: true }
})

// 合并独立窗口 → 目标窗口
ipcMain.handle('merge-note', (event, { noteId, targetWinNoteId }) => {
  const note = notes.find(n => n.id === noteId)
  if (!note || note.deleted) return
  const targetWin = noteWindows.get(targetWinNoteId)
  if (!targetWin || targetWin.isDestroyed()) return
  const srcWin = noteWindows.get(noteId)
  if (srcWin && !srcWin.isDestroyed() && srcWin !== targetWin) {
    windowNotes.get(srcWin.id)?.delete(noteId)
    noteWindows.delete(noteId)
    srcWin.close()
  }
  windowNotes.get(targetWin.id)?.add(noteId)
  noteWindows.set(noteId, targetWin)
  sendNotesUpdateToWin(targetWin)
})

// ── 生命周期 ─────────────────────────────────────────────────
app.whenReady().then(() => {
  loadSettings(); loadNotes(); createTray()
  globalShortcut.register('CommandOrControl+Shift+N', () => {
    const note = createNote()
    const win  = lastFocusedWin && !lastFocusedWin.isDestroyed() ? lastFocusedWin : null
    if (win) {
      windowNotes.get(win.id)?.add(note.id)
      noteWindows.set(note.id, win)
      windowCurNote.set(win.id, note.id)
      win.webContents.send('note-data', { note, themes: NOTE_THEMES, settings })
      sendNotesUpdateToWin(win)
    } else {
      createNoteWindow(note)
    }
  })

  const activeNotes = notes.filter(n => !n.deleted)
  if (activeNotes.length === 0) {
    const note = createNote({
      content: '🥭 欢迎使用 mango 便签！\n\n• 左侧栏点击切换便签\n• 拖动侧边栏项到窗口外 → 独立窗口\n• 右键侧边栏项 → 重命名/删除\n• 🗑 长按删除图标移入回收站',
      themeId: 'yellow', tags: ['入门']
    })
    // 所有便签都放进第一个窗口
    createNoteWindow(note, { noteIds: [note.id] })
  } else {
    // 启动只开 1 个窗口，包含所有便签
    const sorted = [...activeNotes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    const first  = sorted[0]
    const allIds = sorted.map(n => n.id)
    createNoteWindow(first, { noteIds: allIds })
  }
})

app.on('window-all-closed', () => {})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('activate', () => {
  if (getActiveNoteWindows().length === 0) {
    const active = notes.filter(n => !n.deleted)
    if (active.length > 0) {
      const sorted = [...active].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      createNoteWindow(sorted[0], { noteIds: sorted.map(n => n.id) })
    }
  }
})
