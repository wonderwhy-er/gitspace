const { contextBridge, ipcRenderer } = require('electron')

const terminalDataSubscribers = new Map()
const terminalResetSubscribers = new Map()
const terminalBuffers = new Map()
const terminalResetState = new Map()

function terminalKey(workspaceId, terminalId) {
  return `${workspaceId}::${terminalId}`
}

function appendTerminalBuffer(key, data) {
  const current = terminalBuffers.get(key) || ''
  const next = (current + data).slice(-200000)
  terminalBuffers.set(key, next)
}

ipcRenderer.on('terminal:data', (_event, payload) => {
  const { workspaceId, terminalId, data } = payload
  const key = terminalKey(workspaceId, terminalId)

  appendTerminalBuffer(key, data)

  const subscriber = terminalDataSubscribers.get(key)
  if (subscriber) subscriber(data)
})

ipcRenderer.on('terminal:reset', (_event, payload) => {
  const { workspaceId, terminalId, cwd } = payload
  const key = terminalKey(workspaceId, terminalId)

  terminalBuffers.set(key, '')
  terminalResetState.set(key, cwd)

  const subscriber = terminalResetSubscribers.get(key)
  if (subscriber) subscriber(cwd)
})

contextBridge.exposeInMainWorld('gitspace', {
  workspace: {
    create: (initialPath = null) => ipcRenderer.invoke('workspace:create', initialPath),
    close: (workspaceId) => ipcRenderer.invoke('workspace:close', workspaceId),
    state: (workspaceId) => ipcRenderer.invoke('workspace:state', workspaceId),
    navigate: (workspaceId, target) => ipcRenderer.invoke('workspace:navigate', workspaceId, target),
    choose: (workspaceId) => ipcRenderer.invoke('workspace:choose', workspaceId),
    openItem: (target) => ipcRenderer.invoke('workspace:open-item', target)
  },
  git: {
    refresh: (workspaceId) => ipcRenderer.invoke('git:refresh', workspaceId),
    switchBranch: (workspaceId, branch) => ipcRenderer.invoke('git:switch', workspaceId, branch),
    createBranch: (workspaceId, name, base) => ipcRenderer.invoke('git:create-branch', workspaceId, name, base),
    fetch: (workspaceId) => ipcRenderer.invoke('git:fetch', workspaceId),
    pull: (workspaceId) => ipcRenderer.invoke('git:pull', workspaceId),
    push: (workspaceId) => ipcRenderer.invoke('git:push', workspaceId),
    stage: (workspaceId, filePath, originalPath = null) =>
      ipcRenderer.invoke('git:stage', workspaceId, filePath, originalPath),
    unstage: (workspaceId, filePath, originalPath = null) =>
      ipcRenderer.invoke('git:unstage', workspaceId, filePath, originalPath),
    stageAll: (workspaceId) => ipcRenderer.invoke('git:stage-all', workspaceId),
    unstageAll: (workspaceId) => ipcRenderer.invoke('git:unstage-all', workspaceId),
    commit: (workspaceId, message) => ipcRenderer.invoke('git:commit', workspaceId, message)
  },
  terminal: {
    list: (workspaceId) => ipcRenderer.invoke('terminal:list', workspaceId),
    create: (workspaceId) => ipcRenderer.invoke('terminal:create', workspaceId),
    close: (workspaceId, terminalId) => ipcRenderer.invoke('terminal:close', workspaceId, terminalId),
    write: (workspaceId, terminalId, data) =>
      ipcRenderer.send('terminal:write', { workspaceId, terminalId, data }),
    resize: (workspaceId, terminalId, cols, rows) =>
      ipcRenderer.send('terminal:resize', { workspaceId, terminalId, cols, rows }),
    runPackageScript: (workspaceId, terminalId, scriptName) =>
      ipcRenderer.invoke('terminal:run-package-script', workspaceId, terminalId, scriptName),
    runEntry: (workspaceId, terminalId, itemPath) =>
      ipcRenderer.invoke('terminal:run-entry', workspaceId, terminalId, itemPath),
    insertPath: (workspaceId, terminalId, itemPath) =>
      ipcRenderer.invoke('terminal:insert-path', workspaceId, terminalId, itemPath),
    onData: (workspaceId, terminalId, callback) => {
      const key = terminalKey(workspaceId, terminalId)
      terminalDataSubscribers.set(key, callback)

      const buffered = terminalBuffers.get(key)
      if (buffered) callback(buffered)

      return () => {
        if (terminalDataSubscribers.get(key) === callback) {
          terminalDataSubscribers.delete(key)
        }
      }
    },
    onReset: (workspaceId, terminalId, callback) => {
      const key = terminalKey(workspaceId, terminalId)
      terminalResetSubscribers.set(key, callback)

      const cwd = terminalResetState.get(key)
      if (cwd) callback(cwd)

      return () => {
        if (terminalResetSubscribers.get(key) === callback) {
          terminalResetSubscribers.delete(key)
        }
      }
    }
  }
})
