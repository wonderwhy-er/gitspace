const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const pty = require('node-pty')

let mainWindow
const workspaces = new Map()

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr
        error.stdout = stdout
        reject(error)
        return
      }
      resolve(stdout.trimEnd())
    })
  })
}

function gitAt(cwd, args) {
  if (!cwd) throw new Error('No Git repository is active.')
  return run('git', args, cwd)
}

function cleanError(error, fallback = 'Operation failed.') {
  const text = String(error?.stderr || error?.stdout || error?.message || fallback).trim()
  return text.replace(/^fatal:\s*/i, '').replace(/^error:\s*/i, '') || fallback
}

function defaultStartPath() {
  return process.env.GITSPACE_PATH || process.env.GITSPACE_REPO || app.getPath('home')
}

async function ensureDirectory(candidate, fallback = null) {
  const resolved = path.resolve(candidate || fallback || app.getPath('home'))
  const stat = await fs.promises.stat(resolved)
  if (!stat.isDirectory()) throw new Error('That location is not a folder.')
  return resolved
}

async function resolveRepoRoot(candidate) {
  try {
    return await gitAt(candidate, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

function breadcrumbParts(directory) {
  const parsed = path.parse(directory)
  const relative = directory.slice(parsed.root.length)
  const names = relative.split(path.sep).filter(Boolean)
  const parts = [{ name: parsed.root, path: parsed.root }]

  let cursor = parsed.root
  for (const name of names) {
    cursor = path.join(cursor, name)
    parts.push({ name, path: cursor })
  }
  return parts
}

function formatEntryType(dirent, stat) {
  if (stat?.isDirectory()) return 'folder'
  if (dirent.isSymbolicLink()) return 'symlink'
  if (stat?.isFile()) return 'file'
  return 'other'
}

const RUNNERS_BY_EXTENSION = new Map([
  ['.sh', 'bash'],
  ['.bash', 'bash'],
  ['.zsh', 'zsh'],
  ['.py', 'python3'],
  ['.js', 'node'],
  ['.mjs', 'node'],
  ['.cjs', 'node'],
  ['.ts', 'npx tsx'],
  ['.tsx', 'npx tsx'],
  ['.rb', 'ruby'],
  ['.php', 'php'],
  ['.pl', 'perl'],
  ['.lua', 'lua']
])

function isRunnableFile(fileName, stat) {
  if (!stat?.isFile()) return false
  if ((stat.mode & 0o111) !== 0) return true
  return RUNNERS_BY_EXTENSION.has(path.extname(fileName).toLowerCase())
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function runnerCommand(filePath, stat = null) {
  const extension = path.extname(filePath).toLowerCase()
  const runner = RUNNERS_BY_EXTENSION.get(extension)

  if (runner) return `${runner} ${shellQuote(filePath)}`
  if (stat && (stat.mode & 0o111) !== 0) return shellQuote(filePath)
  return null
}

async function getPackageScripts(directory) {
  const packagePath = path.join(directory, 'package.json')

  try {
    const raw = await fs.promises.readFile(packagePath, 'utf8')
    const parsed = JSON.parse(raw)
    const scripts = parsed?.scripts && typeof parsed.scripts === 'object'
      ? Object.entries(parsed.scripts)
          .filter(([name, command]) => typeof name === 'string' && typeof command === 'string')
          .map(([name, command]) => ({ name, command }))
      : []

    let packageManager = 'npm'
    if (fs.existsSync(path.join(directory, 'pnpm-lock.yaml'))) packageManager = 'pnpm'
    else if (fs.existsSync(path.join(directory, 'yarn.lock'))) packageManager = 'yarn'
    else if (
      fs.existsSync(path.join(directory, 'bun.lock')) ||
      fs.existsSync(path.join(directory, 'bun.lockb'))
    ) packageManager = 'bun'

    return {
      packagePath,
      packageName: typeof parsed?.name === 'string' ? parsed.name : path.basename(directory),
      packageManager,
      scripts
    }
  } catch {
    return null
  }
}

async function listDirectory(directory) {
  const resolved = await ensureDirectory(directory)
  const dirents = await fs.promises.readdir(resolved, { withFileTypes: true })

  const entries = await Promise.all(dirents.map(async (dirent) => {
    const fullPath = path.join(resolved, dirent.name)
    let stat = null
    try {
      stat = await fs.promises.stat(fullPath)
    } catch {
      try {
        stat = await fs.promises.lstat(fullPath)
      } catch {}
    }

    return {
      name: dirent.name,
      path: fullPath,
      type: formatEntryType(dirent, stat),
      isDirectory: Boolean(stat?.isDirectory()),
      isSymlink: dirent.isSymbolicLink(),
      hidden: dirent.name.startsWith('.'),
      size: stat?.isFile() ? stat.size : null,
      modifiedMs: stat?.mtimeMs || null,
      runnable: isRunnableFile(dirent.name, stat)
    }
  }))

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  return {
    path: resolved,
    name: path.basename(resolved) || resolved,
    parent: path.dirname(resolved),
    canGoUp: path.dirname(resolved) !== resolved,
    breadcrumbs: breadcrumbParts(resolved),
    entries
  }
}

async function getAheadBehind(root) {
  try {
    const upstream = await gitAt(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    const counts = await gitAt(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    const [ahead = 0, behind = 0] = counts.split(/\s+/).map(Number)
    return { upstream, ahead, behind }
  } catch {
    return { upstream: null, ahead: 0, behind: 0 }
  }
}

function parseChanges(output) {
  const fields = output.split('\0')
  const changes = []

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || field.length < 3) continue

    const status = field.slice(0, 2)
    const filePath = field.slice(3)
    const indexStatus = status[0]
    const worktreeStatus = status[1]
    let originalPath = null

    if (indexStatus === 'R' || indexStatus === 'C') {
      originalPath = fields[index + 1] || null
      index += 1
    }

    changes.push({
      status,
      path: filePath,
      originalPath,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: worktreeStatus !== ' ' || status === '??'
    })
  }

  return changes
}

function parseRemotes(output) {
  const remotes = new Map()
  for (const line of output.split('\n').filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/)
    if (!match) continue
    const [, name, url, kind] = match
    const remote = remotes.get(name) || { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') remote.fetchUrl = url
    if (kind === 'push') remote.pushUrl = url
    remotes.set(name, remote)
  }
  return [...remotes.values()]
}

async function getRepoState(root) {
  if (!root) return null

  const [currentBranch, locals, remotesOutput, statusOutput, tracking, lastCommit, remoteBranchesOutput] =
    await Promise.all([
      gitAt(root, ['branch', '--show-current']),
      gitAt(root, [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:trackshort)',
        'refs/heads/'
      ]),
      gitAt(root, ['remote', '-v']).catch(() => ''),
      gitAt(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      getAheadBehind(root),
      gitAt(root, ['log', '-1', '--pretty=format:%h%x09%s']).catch(() => ''),
      gitAt(root, [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)',
        'refs/remotes/'
      ]).catch(() => '')
    ])

  const branches = locals.split('\n').filter(Boolean).map((line) => {
    const [name, head, upstream = '', track = ''] = line.split('\t')
    return { name, current: head === '*', upstream, track }
  })

  const remoteBranches = remoteBranchesOutput
    .split('\n')
    .filter(Boolean)
    .filter((name) => !name.endsWith('/HEAD'))

  const [lastCommitHash = '', lastCommitSubject = ''] = lastCommit.split('\t')

  return {
    root,
    name: path.basename(root),
    branch: currentBranch || '(detached)',
    branches,
    remoteBranches,
    remotes: parseRemotes(remotesOutput),
    changes: parseChanges(statusOutput),
    lastCommit: { hash: lastCommitHash, subject: lastCommitSubject },
    ...tracking
  }
}

function getWorkspace(workspaceId) {
  const workspace = workspaces.get(workspaceId)
  if (!workspace) throw new Error('Workspace tab no longer exists.')
  return workspace
}

function terminalMeta(terminal) {
  return {
    id: terminal.id,
    label: terminal.label,
    cwd: terminal.cwd,
    running: Boolean(terminal.process)
  }
}

function listTerminalMeta(workspace) {
  return [...workspace.terminals.values()].map(terminalMeta)
}

function sendTerminal(channel, workspace, terminal, extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, {
    workspaceId: workspace.id,
    terminalId: terminal.id,
    ...extra
  })
}

function createTerminalRecord(workspace) {
  workspace.terminalCounter += 1
  const terminal = {
    id: `terminal-${workspace.terminalCounter}-${randomUUID().slice(0, 8)}`,
    label: `Terminal ${workspace.terminalCounter}`,
    cwd: workspace.currentPath,
    process: null
  }
  workspace.terminals.set(terminal.id, terminal)
  sendTerminal('terminal:reset', workspace, terminal, { cwd: terminal.cwd })
  return terminal
}

function stopTerminalRecord(terminal) {
  if (!terminal?.process) return
  const processToKill = terminal.process
  terminal.process = null
  try {
    processToKill.kill()
  } catch {}
}

function startTerminal(workspace, terminal) {
  stopTerminalRecord(terminal)
  terminal.cwd = workspace.currentPath
  sendTerminal('terminal:reset', workspace, terminal, { cwd: terminal.cwd })

  const shellPath = process.env.SHELL || '/bin/zsh'
  const spawned = pty.spawn(shellPath, ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 26,
    cwd: terminal.cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
  })

  terminal.process = spawned

  spawned.onData((data) => {
    sendTerminal('terminal:data', workspace, terminal, { data })
  })

  spawned.onExit(({ exitCode }) => {
    if (terminal.process !== spawned) return
    terminal.process = null
    sendTerminal('terminal:data', workspace, terminal, {
      data: `\r\n\x1b[2m[terminal exited with code ${exitCode}]\x1b[0m\r\n`
    })
  })

  return spawned
}

function ensureTerminal(workspace, terminalId) {
  let terminal = terminalId ? workspace.terminals.get(terminalId) : null
  if (!terminal) terminal = workspace.terminals.values().next().value
  if (!terminal) terminal = createTerminalRecord(workspace)
  if (!terminal.process) startTerminal(workspace, terminal)
  return terminal.process
}

function restartWorkspaceTerminals(workspace) {
  for (const terminal of workspace.terminals.values()) {
    if (terminal.process) {
      startTerminal(workspace, terminal)
    } else {
      terminal.cwd = workspace.currentPath
      sendTerminal('terminal:reset', workspace, terminal, { cwd: terminal.cwd })
    }
  }
}

async function getWorkspaceState(workspace) {
  let directory

  try {
    directory = await listDirectory(workspace.currentPath)
  } catch {
    const fallback = workspace.repoPath || app.getPath('home')
    workspace.currentPath = await ensureDirectory(fallback)
    restartWorkspaceTerminals(workspace)
    directory = await listDirectory(workspace.currentPath)
  }

  workspace.repoPath = await resolveRepoRoot(directory.path)
  const [git, packageInfo] = await Promise.all([
    workspace.repoPath ? getRepoState(workspace.repoPath) : null,
    getPackageScripts(directory.path)
  ])

  return {
    workspaceId: workspace.id,
    directory,
    git,
    packageInfo,
    terminals: listTerminalMeta(workspace),
    favorites: {
      home: app.getPath('home'),
      desktop: app.getPath('desktop'),
      downloads: app.getPath('downloads'),
      documents: app.getPath('documents'),
      work: path.join(app.getPath('home'), 'work'),
      root: path.parse(app.getPath('home')).root
    }
  }
}

async function createWorkspace(initialPath = null) {
  let currentPath
  try {
    currentPath = await ensureDirectory(initialPath || defaultStartPath())
  } catch {
    currentPath = app.getPath('home')
  }

  const workspace = {
    id: `workspace-${randomUUID()}`,
    currentPath,
    repoPath: await resolveRepoRoot(currentPath),
    terminals: new Map(),
    terminalCounter: 0
  }

  workspaces.set(workspace.id, workspace)
  createTerminalRecord(workspace)

  return getWorkspaceState(workspace)
}

function closeWorkspace(workspaceId) {
  const workspace = getWorkspace(workspaceId)
  for (const terminal of workspace.terminals.values()) stopTerminalRecord(terminal)
  workspaces.delete(workspaceId)
  return true
}

async function navigateTo(workspace, candidate) {
  workspace.currentPath = await ensureDirectory(candidate, workspace.currentPath)
  workspace.repoPath = await resolveRepoRoot(workspace.currentPath)
  restartWorkspaceTerminals(workspace)
  return getWorkspaceState(workspace)
}

async function chooseFolder(workspace) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open folder',
    defaultPath: workspace.currentPath || app.getPath('home'),
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return null
  return navigateTo(workspace, result.filePaths[0])
}

async function refreshGit(workspace) {
  workspace.repoPath = await resolveRepoRoot(workspace.currentPath)
  return workspace.repoPath ? getRepoState(workspace.repoPath) : null
}

async function switchBranch(workspace, branch) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  const state = await getRepoState(workspace.repoPath)
  if (!state.branches.some((item) => item.name === branch)) throw new Error('Unknown local branch.')

  try {
    await gitAt(workspace.repoPath, ['switch', branch])
    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Could not switch branch.'))
  }
}

async function createBranch(workspace, name, base) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  const cleanName = String(name || '').trim()
  const cleanBase = String(base || '').trim()
  if (!cleanName) throw new Error('Enter a branch name.')
  if (!cleanBase) throw new Error('Choose a base branch.')

  try {
    await gitAt(workspace.repoPath, ['check-ref-format', '--branch', cleanName])
    await gitAt(workspace.repoPath, ['switch', '--no-track', '-c', cleanName, cleanBase])
    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Could not create branch.'))
  }
}

async function fetchAll(workspace) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  try {
    await gitAt(workspace.repoPath, ['fetch', '--all', '--prune'])
    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Fetch failed.'))
  }
}

async function pullCurrent(workspace) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  try {
    await gitAt(workspace.repoPath, ['pull', '--ff-only'])
    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Pull failed.'))
  }
}

async function pushCurrent(workspace) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  const state = await getRepoState(workspace.repoPath)

  try {
    if (!state.branch || state.branch === '(detached)') throw new Error('Cannot push a detached HEAD.')

    const fallbackRemote = state.remotes.find((item) => item.name === 'origin') || state.remotes[0]
    if (!fallbackRemote) throw new Error('No Git remote is configured.')

    if (state.upstream) {
      const upstreamRemote = state.remotes.find((remote) => state.upstream.startsWith(`${remote.name}/`))
      const upstreamBranch = upstreamRemote
        ? state.upstream.slice(upstreamRemote.name.length + 1)
        : null

      if (upstreamRemote && upstreamBranch === state.branch) {
        await gitAt(workspace.repoPath, ['push'])
      } else {
        await gitAt(workspace.repoPath, ['push', '-u', (upstreamRemote || fallbackRemote).name, state.branch])
      }
    } else {
      await gitAt(workspace.repoPath, ['push', '-u', fallbackRemote.name, state.branch])
    }

    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Push failed.'))
  }
}

async function stagePath(workspace, filePath, originalPath = null) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  try {
    const paths = originalPath ? [originalPath, filePath] : [filePath]
    await gitAt(workspace.repoPath, ['add', '-A', '--', ...paths])
    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Could not stage file.'))
  }
}

async function unstagePath(workspace, filePath, originalPath = null) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  try {
    const paths = originalPath ? [originalPath, filePath] : [filePath]
    await gitAt(workspace.repoPath, ['restore', '--staged', '--', ...paths])
    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Could not unstage file.'))
  }
}

async function stageAll(workspace) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  try {
    await gitAt(workspace.repoPath, ['add', '-A'])
    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Could not stage changes.'))
  }
}

async function unstageAll(workspace) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  try {
    await gitAt(workspace.repoPath, ['restore', '--staged', ':/'])
    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Could not unstage changes.'))
  }
}

async function commitChanges(workspace, message) {
  if (!workspace.repoPath) throw new Error('The current folder is not inside a Git repository.')
  const cleanMessage = String(message || '').trim()
  if (!cleanMessage) throw new Error('Enter a commit message.')

  try {
    await gitAt(workspace.repoPath, ['commit', '-m', cleanMessage])
    return getRepoState(workspace.repoPath)
  } catch (error) {
    throw new Error(cleanError(error, 'Commit failed.'))
  }
}

async function openItem(itemPath) {
  const result = await shell.openPath(itemPath)
  if (result) throw new Error(result)
  return true
}

async function runPackageScript(workspace, terminalId, scriptName) {
  const packageInfo = await getPackageScripts(workspace.currentPath)
  if (!packageInfo) throw new Error('No package.json with scripts in this folder.')

  const script = packageInfo.scripts.find((item) => item.name === scriptName)
  if (!script) throw new Error('That package script no longer exists.')

  ensureTerminal(workspace, terminalId).write(`${packageInfo.packageManager} run ${shellQuote(script.name)}\r`)
  return true
}

async function runEntryInTerminal(workspace, terminalId, itemPath) {
  const resolved = path.resolve(itemPath)
  const stat = await fs.promises.stat(resolved)
  if (!stat.isFile()) throw new Error('Choose a runnable file.')

  const command = runnerCommand(resolved, stat)
  if (!command) throw new Error('No runner is configured for this file type.')

  ensureTerminal(workspace, terminalId).write(`${command}\r`)
  return true
}

function insertPathInTerminal(workspace, terminalId, itemPath) {
  ensureTerminal(workspace, terminalId).write(shellQuote(path.resolve(itemPath)))
  return true
}

function createTerminal(workspace) {
  return terminalMeta(createTerminalRecord(workspace))
}

function closeTerminal(workspace, terminalId) {
  const terminal = workspace.terminals.get(terminalId)
  if (!terminal) return { terminals: listTerminalMeta(workspace), nextTerminalId: null }

  stopTerminalRecord(terminal)
  workspace.terminals.delete(terminalId)

  if (workspace.terminals.size === 0) createTerminalRecord(workspace)

  const terminals = listTerminalMeta(workspace)
  return {
    terminals,
    nextTerminalId: terminals[0]?.id || null
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    title: 'Gitspace',
    icon: path.join(__dirname, 'assets', 'gitspace-icon.png'),
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin'
      ? { vibrancy: 'under-window', visualEffectState: 'active' }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('http://127.0.0.1:5173') || url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })

  const devServerUrl = process.env.GITSPACE_DEV_SERVER_URL
  if (devServerUrl) mainWindow.loadURL(devServerUrl)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

ipcMain.handle('workspace:create', (_event, initialPath) => createWorkspace(initialPath))
ipcMain.handle('workspace:close', (_event, workspaceId) => closeWorkspace(workspaceId))
ipcMain.handle('workspace:state', (_event, workspaceId) => getWorkspaceState(getWorkspace(workspaceId)))
ipcMain.handle('workspace:navigate', (_event, workspaceId, target) => navigateTo(getWorkspace(workspaceId), target))
ipcMain.handle('workspace:choose', (_event, workspaceId) => chooseFolder(getWorkspace(workspaceId)))
ipcMain.handle('workspace:open-item', (_event, target) => openItem(target))

ipcMain.handle('git:refresh', (_event, workspaceId) => refreshGit(getWorkspace(workspaceId)))
ipcMain.handle('git:switch', (_event, workspaceId, branch) => switchBranch(getWorkspace(workspaceId), branch))
ipcMain.handle('git:create-branch', (_event, workspaceId, name, base) => createBranch(getWorkspace(workspaceId), name, base))
ipcMain.handle('git:fetch', (_event, workspaceId) => fetchAll(getWorkspace(workspaceId)))
ipcMain.handle('git:pull', (_event, workspaceId) => pullCurrent(getWorkspace(workspaceId)))
ipcMain.handle('git:push', (_event, workspaceId) => pushCurrent(getWorkspace(workspaceId)))
ipcMain.handle('git:stage', (_event, workspaceId, filePath, originalPath) => stagePath(getWorkspace(workspaceId), filePath, originalPath))
ipcMain.handle('git:unstage', (_event, workspaceId, filePath, originalPath) => unstagePath(getWorkspace(workspaceId), filePath, originalPath))
ipcMain.handle('git:stage-all', (_event, workspaceId) => stageAll(getWorkspace(workspaceId)))
ipcMain.handle('git:unstage-all', (_event, workspaceId) => unstageAll(getWorkspace(workspaceId)))
ipcMain.handle('git:commit', (_event, workspaceId, message) => commitChanges(getWorkspace(workspaceId), message))

ipcMain.handle('terminal:list', (_event, workspaceId) => listTerminalMeta(getWorkspace(workspaceId)))
ipcMain.handle('terminal:create', (_event, workspaceId) => createTerminal(getWorkspace(workspaceId)))
ipcMain.handle('terminal:close', (_event, workspaceId, terminalId) => closeTerminal(getWorkspace(workspaceId), terminalId))
ipcMain.handle('terminal:run-package-script', (_event, workspaceId, terminalId, scriptName) => runPackageScript(getWorkspace(workspaceId), terminalId, scriptName))
ipcMain.handle('terminal:run-entry', (_event, workspaceId, terminalId, itemPath) => runEntryInTerminal(getWorkspace(workspaceId), terminalId, itemPath))
ipcMain.handle('terminal:insert-path', (_event, workspaceId, terminalId, itemPath) => insertPathInTerminal(getWorkspace(workspaceId), terminalId, itemPath))

ipcMain.on('terminal:write', (_event, { workspaceId, terminalId, data }) => {
  const workspace = workspaces.get(workspaceId)
  if (!workspace) return
  ensureTerminal(workspace, terminalId).write(data)
})

ipcMain.on('terminal:resize', (_event, { workspaceId, terminalId, cols, rows }) => {
  const workspace = workspaces.get(workspaceId)
  const terminal = workspace?.terminals.get(terminalId)
  if (!terminal?.process || !Number.isFinite(cols) || !Number.isFinite(rows)) return
  terminal.process.resize(Math.max(2, cols), Math.max(1, rows))
})

function closeAllWorkspaces() {
  for (const workspace of workspaces.values()) {
    for (const terminal of workspace.terminals.values()) stopTerminalRecord(terminal)
  }
  workspaces.clear()
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'assets', 'gitspace-icon.png'))
  }
  createWindow()
})

app.on('window-all-closed', () => {
  closeAllWorkspaces()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', closeAllWorkspaces)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
