import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

function formatBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`
}

function formatModified(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function fileIcon(entry) {
  if (entry.isDirectory) return '▰'
  if (entry.isSymlink) return '↗'
  const extension = entry.name.split('.').pop()?.toLowerCase()
  if (['js', 'jsx', 'ts', 'tsx', 'json', 'css', 'html', 'md'].includes(extension)) return '◇'
  return '▤'
}

function gitStatusLabel(status) {
  if (status === '??') return 'new'
  if (status.includes('M')) return 'modified'
  if (status.includes('A')) return 'added'
  if (status.includes('D')) return 'deleted'
  if (status.includes('R')) return 'renamed'
  return status.trim() || 'changed'
}

function branchOptions(git) {
  if (!git) return []
  const local = git.branches.map((branch) => ({ value: branch.name, label: branch.name, kind: 'local' }))
  const remote = git.remoteBranches.map((name) => ({ value: name, label: name, kind: 'remote' }))
  return [...local, ...remote]
}

function terminalTheme(isLight) {
  if (isLight) {
    return {
      background: '#fbfbfc',
      foreground: '#242426',
      cursor: '#0a84ff',
      selectionBackground: '#0a84ff33',
      black: '#2c2c2e',
      brightBlack: '#6e6e73',
      red: '#d70015',
      brightRed: '#ff3b30',
      green: '#248a3d',
      brightGreen: '#34c759',
      yellow: '#a05a00',
      brightYellow: '#ff9f0a',
      blue: '#0064d2',
      brightBlue: '#0a84ff',
      magenta: '#8944ab',
      brightMagenta: '#af52de',
      cyan: '#00788a',
      brightCyan: '#32ade6',
      white: '#e5e5ea',
      brightWhite: '#ffffff'
    }
  }

  return {
    background: '#171719',
    foreground: '#e4e4e7',
    cursor: '#0a84ff',
    selectionBackground: '#0a84ff44',
    black: '#202024',
    brightBlack: '#73737a',
    red: '#ff6961',
    brightRed: '#ff817a',
    green: '#5bd36f',
    brightGreen: '#72e184',
    yellow: '#ffb340',
    brightYellow: '#ffc55c',
    blue: '#64a8ef',
    brightBlue: '#7bb8f5',
    magenta: '#c89aeb',
    brightMagenta: '#d6acf3',
    cyan: '#63d2e5',
    brightCyan: '#7cdeed',
    white: '#d8d8dc',
    brightWhite: '#ffffff'
  }
}

export default function WorkspaceView({ workspaceId, active, onMetaChange }) {
  const terminalHost = useRef(null)
  const terminalRef = useRef(null)
  const fitRef = useRef(null)
  const activeTerminalIdRef = useRef(null)
  const historyRef = useRef([])
  const historyIndexRef = useRef(-1)

  const [workspace, setWorkspace] = useState(null)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [historyLength, setHistoryLength] = useState(0)
  const [showHidden, setShowHidden] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [gitPanelOpen, setGitPanelOpen] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [sortKey, setSortKey] = useState('name')
  const [sortDirection, setSortDirection] = useState('asc')
  const [runMenuOpen, setRunMenuOpen] = useState(false)
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [gitTab, setGitTab] = useState('changes')
  const [branchFilter, setBranchFilter] = useState('')
  const [branchName, setBranchName] = useState('')
  const [branchBase, setBranchBase] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [newBranchFormOpen, setNewBranchFormOpen] = useState(false)
  const [terminals, setTerminals] = useState([])
  const [activeTerminalId, setActiveTerminalId] = useState(null)
  const [terminalHeight, setTerminalHeight] = useState(290)
  const [gitPanelWidth, setGitPanelWidth] = useState(370)

  const directory = workspace?.directory
  const git = workspace?.git
  const packageInfo = workspace?.packageInfo

  useEffect(() => {
    if (!directory) return
    onMetaChange?.(workspaceId, {
      title: directory.name || directory.path,
      path: directory.path,
      branch: git?.branch || null
    })
  }, [workspaceId, directory?.path, directory?.name, git?.branch, onMetaChange])

  useEffect(() => {
    if (!terminalOpen || !terminalHost.current) return

    const appearance = window.matchMedia('(prefers-color-scheme: light)')
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.3,
      scrollback: 10000,
      theme: terminalTheme(appearance.matches)
    })

    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(terminalHost.current)
    terminalRef.current = terminal
    fitRef.current = fit

    const inputDisposable = terminal.onData((data) => {
      const terminalId = activeTerminalIdRef.current
      if (terminalId) window.gitspace.terminal.write(workspaceId, terminalId, data)
    })

    const syncSize = () => {
      const terminalId = activeTerminalIdRef.current
      if (!terminalId || !terminalHost.current?.clientHeight) return
      fit.fit()
      window.gitspace.terminal.resize(workspaceId, terminalId, terminal.cols, terminal.rows)
    }

    const observer = new ResizeObserver(syncSize)
    observer.observe(terminalHost.current)

    const syncAppearance = (event) => {
      terminal.options.theme = terminalTheme(event.matches)
    }

    const initialFrame = requestAnimationFrame(syncSize)
    const initialTimer = setTimeout(syncSize, 100)

    appearance.addEventListener('change', syncAppearance)
    window.addEventListener('resize', syncSize)

    return () => {
      cancelAnimationFrame(initialFrame)
      clearTimeout(initialTimer)
      inputDisposable.dispose()
      observer.disconnect()
      appearance.removeEventListener('change', syncAppearance)
      window.removeEventListener('resize', syncSize)
      terminal.dispose()
      if (terminalRef.current === terminal) terminalRef.current = null
      if (fitRef.current === fit) fitRef.current = null
    }
  }, [workspaceId, terminalOpen])

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId
    const terminal = terminalRef.current
    const fit = fitRef.current

    if (!terminalOpen || !activeTerminalId || !terminal || !fit) return

    terminal.reset()

    const unsubscribeReset = window.gitspace.terminal.onReset(
      workspaceId,
      activeTerminalId,
      (cwd) => {
        terminal.reset()
        terminal.writeln(`\x1b[2m${cwd}\x1b[0m`)
        requestAnimationFrame(() => {
          if (!terminalHost.current?.clientHeight) return
          fit.fit()
          window.gitspace.terminal.resize(workspaceId, activeTerminalId, terminal.cols, terminal.rows)
        })
      }
    )

    const unsubscribeData = window.gitspace.terminal.onData(
      workspaceId,
      activeTerminalId,
      (data) => terminal.write(data)
    )

    return () => {
      unsubscribeData()
      unsubscribeReset()
    }
  }, [workspaceId, activeTerminalId, terminalOpen])

  useEffect(() => {
    loadInitialWorkspace()
  }, [workspaceId])

  useEffect(() => {
    if (!active || !directory?.path) return
    const timer = setInterval(() => refreshWorkspace(true), 3000)
    return () => clearInterval(timer)
  }, [active, directory?.path])

  useEffect(() => {
    if (!git) {
      setBranchBase('')
      return
    }
    const options = branchOptions(git)
    if (!options.some((option) => option.value === branchBase)) {
      setBranchBase(git.branch)
    }
  }, [git?.root, git?.branch, git?.branches?.length, git?.remoteBranches?.length])

  useEffect(() => {
    if (!active || !terminalOpen || !activeTerminalId) return

    let cancelled = false

    const fitVisibleTerminal = () => {
      if (cancelled) return

      const host = terminalHost.current
      const fit = fitRef.current
      const terminal = terminalRef.current

      if (!host?.clientHeight || !fit || !terminal) return

      const dimensions = fit.proposeDimensions?.()
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return

      fit.fit()

      window.gitspace.terminal.resize(
        workspaceId,
        activeTerminalId,
        terminal.cols,
        terminal.rows
      )
    }

    const frame = requestAnimationFrame(fitVisibleTerminal)
    const timers = [50, 150, 300].map((delay) => setTimeout(fitVisibleTerminal, delay))

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      timers.forEach(clearTimeout)
    }
  }, [active, terminalOpen, terminalHeight, activeTerminalId, workspaceId])

  useEffect(() => {
    if (!active) return

    const onKeyDown = (event) => {
      if (event.metaKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        chooseFolder()
      }
      if (event.metaKey && event.key === '[') {
        event.preventDefault()
        goBack()
      }
      if (event.metaKey && event.key === ']') {
        event.preventDefault()
        goForward()
      }
      if (event.metaKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setTerminalOpen((value) => !value)
      }
      if (event.key === 'Escape') {
        setRunMenuOpen(false)
        setOverflowMenuOpen(false)
        setContextMenu(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, workspaceId, terminalOpen])

  async function loadInitialWorkspace() {
    setBusy('loading')
    try {
      const next = await window.gitspace.workspace.state(workspaceId)
      setWorkspace(next)
      setTerminals(next.terminals || [])
      setActiveTerminalId((current) => current || next.terminals?.[0]?.id || null)
      historyRef.current = [next.directory.path]
      historyIndexRef.current = 0
      setHistoryIndex(0)
      setHistoryLength(1)
      setBranchBase(next.git?.branch || '')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  function commitHistory(nextPath) {
    const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1)
    if (nextHistory[nextHistory.length - 1] !== nextPath) nextHistory.push(nextPath)
    historyRef.current = nextHistory
    historyIndexRef.current = nextHistory.length - 1
    setHistoryIndex(historyIndexRef.current)
    setHistoryLength(nextHistory.length)
  }

  async function navigate(target, record = true) {
    if (!target || busy === 'navigate') return
    setBusy('navigate')
    setError('')
    try {
      const next = await window.gitspace.workspace.navigate(workspaceId, target)
      setWorkspace(next)
      setTerminals(next.terminals || terminals)
      setSelectedPath('')
      if (record) commitHistory(next.directory.path)
      setBranchBase(next.git?.branch || '')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  async function refreshWorkspace(quiet = false) {
    if (!quiet) setBusy('refresh')
    try {
      const next = await window.gitspace.workspace.state(workspaceId)
      setWorkspace(next)
      setTerminals(next.terminals || terminals)
    } catch (err) {
      if (!quiet) setError(err.message)
    } finally {
      if (!quiet) setBusy('')
    }
  }

  async function chooseFolder() {
    if (busy) return
    setBusy('choose')
    setError('')
    try {
      const next = await window.gitspace.workspace.choose(workspaceId)
      if (!next) return
      setWorkspace(next)
      setTerminals(next.terminals || terminals)
      setSelectedPath('')
      commitHistory(next.directory.path)
      setBranchBase(next.git?.branch || '')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  async function goBack() {
    const targetIndex = historyIndexRef.current - 1
    if (targetIndex < 0 || busy) return
    const target = historyRef.current[targetIndex]
    await navigate(target, false)
    historyIndexRef.current = targetIndex
    setHistoryIndex(targetIndex)
  }

  async function goForward() {
    const targetIndex = historyIndexRef.current + 1
    if (targetIndex >= historyRef.current.length || busy) return
    const target = historyRef.current[targetIndex]
    await navigate(target, false)
    historyIndexRef.current = targetIndex
    setHistoryIndex(targetIndex)
  }

  async function openEntry(entry) {
    if (entry.isDirectory) {
      await navigate(entry.path)
      return
    }
    setError('')
    try {
      await window.gitspace.workspace.openItem(entry.path)
    } catch (err) {
      setError(err.message)
    }
  }

  async function runGitAction(label, action) {
    if (!git || busy) return
    setBusy(label)
    setError('')
    try {
      const previousPath = directory?.path
      await action()
      const next = await window.gitspace.workspace.state(workspaceId)
      setWorkspace(next)
      setTerminals(next.terminals || terminals)
      if (previousPath && next.directory.path !== previousPath) {
        setSelectedPath('')
        commitHistory(next.directory.path)
      }
      return next
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setBusy('')
    }
  }

  async function switchBranch(branch) {
    if (branch === git?.branch) return
    await runGitAction('switch', () => window.gitspace.git.switchBranch(workspaceId, branch))
  }

  async function createBranch() {
    const cleanName = branchName.trim()
    if (!cleanName || !branchBase) return
    const next = await runGitAction('create-branch', () =>
      window.gitspace.git.createBranch(workspaceId, cleanName, branchBase)
    )
    if (next) {
      setBranchName('')
      setBranchBase(next.git?.branch || '')
      setNewBranchFormOpen(false)
    }
  }

  async function commit() {
    const message = commitMessage.trim()
    if (!message) return
    const next = await runGitAction('commit', () => window.gitspace.git.commit(workspaceId, message))
    if (next) setCommitMessage('')
  }

  function changeSort(nextKey) {
    if (sortKey === nextKey) {
      setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc')
      return
    }

    setSortKey(nextKey)
    setSortDirection(nextKey === 'name' ? 'asc' : 'desc')
  }

  async function ensureActiveTerminal() {
    if (activeTerminalId) return activeTerminalId

    const created = await window.gitspace.terminal.create(workspaceId)
    setTerminals((current) => [...current, created])
    setActiveTerminalId(created.id)
    return created.id
  }

  async function addTerminal() {
    setError('')
    try {
      const created = await window.gitspace.terminal.create(workspaceId)
      setTerminals((current) => [...current, created])
      setActiveTerminalId(created.id)
      setTerminalOpen(true)
    } catch (err) {
      setError(err.message)
    }
  }

  async function closeTerminalTab(terminalId, event) {
    event?.stopPropagation()
    setError('')

    try {
      const result = await window.gitspace.terminal.close(workspaceId, terminalId)
      setTerminals(result.terminals)
      if (activeTerminalId === terminalId) {
        setActiveTerminalId(result.nextTerminalId)
      }
    } catch (err) {
      setError(err.message)
    }
  }

  function beginTerminalResize(event) {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = terminalHeight

    const onMove = (moveEvent) => {
      const nextHeight = Math.max(
        150,
        Math.min(window.innerHeight * 0.72, startHeight + (startY - moveEvent.clientY))
      )
      setTerminalHeight(Math.round(nextHeight))
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function beginGitResize(event) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = gitPanelWidth

    const onMove = (moveEvent) => {
      const nextWidth = Math.max(
        300,
        Math.min(window.innerWidth * 0.58, startWidth + (startX - moveEvent.clientX))
      )
      setGitPanelWidth(Math.round(nextWidth))
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  async function runPackageScript(scriptName) {
    setRunMenuOpen(false)
    setTerminalOpen(true)
    setError('')
    try {
      const terminalId = await ensureActiveTerminal()
      await window.gitspace.terminal.runPackageScript(workspaceId, terminalId, scriptName)
    } catch (err) {
      setError(err.message)
    }
  }

  async function runEntry(entry) {
    if (!entry?.runnable) return
    setRunMenuOpen(false)
    setContextMenu(null)
    setTerminalOpen(true)
    setError('')
    try {
      const terminalId = await ensureActiveTerminal()
      await window.gitspace.terminal.runEntry(workspaceId, terminalId, entry.path)
    } catch (err) {
      setError(err.message)
    }
  }

  async function insertPath(entry) {
    if (!entry) return
    setRunMenuOpen(false)
    setContextMenu(null)
    setTerminalOpen(true)
    setError('')
    try {
      const terminalId = await ensureActiveTerminal()
      await window.gitspace.terminal.insertPath(workspaceId, terminalId, entry.path)
    } catch (err) {
      setError(err.message)
    }
  }

  async function terminalHere(entry) {
    if (!entry?.isDirectory) return
    setRunMenuOpen(false)
    setContextMenu(null)
    setTerminalOpen(true)
    await navigate(entry.path)
  }

  const visibleEntries = useMemo(() => {
    if (!directory) return []

    const entries = (showHidden
      ? directory.entries
      : directory.entries.filter((entry) => !entry.hidden)
    ).slice()

    const direction = sortDirection === 'asc' ? 1 : -1

    entries.sort((a, b) => {
      if (sortKey === 'name') {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * direction
      }

      if (sortKey === 'modified') {
        return ((a.modifiedMs || 0) - (b.modifiedMs || 0)) * direction
      }

      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return ((a.size || 0) - (b.size || 0)) * direction
    })

    return entries
  }, [directory, showHidden, sortKey, sortDirection])

  const filteredBranches = useMemo(() => {
    if (!git) return []
    const query = branchFilter.trim().toLowerCase()
    if (!query) return git.branches
    return git.branches.filter((branch) => branch.name.toLowerCase().includes(query))
  }, [git, branchFilter])

  const filteredRemoteBranches = useMemo(() => {
    if (!git) return []
    const query = branchFilter.trim().toLowerCase()
    if (!query) return git.remoteBranches
    return git.remoteBranches.filter((branch) => branch.toLowerCase().includes(query))
  }, [git, branchFilter])

  const stagedCount = git?.changes.filter((change) => change.staged).length || 0
  const selectedEntry = directory?.entries.find((entry) => entry.path === selectedPath) || null
  const hasPackageScripts = Boolean(packageInfo?.scripts?.length)
  const hasRunActions = hasPackageScripts || Boolean(selectedEntry)
  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex >= 0 && historyIndex < historyLength - 1
  const favoriteItems = workspace ? [
    { label: 'Home', path: workspace.favorites.home, icon: '⌂' },
    { label: 'Desktop', path: workspace.favorites.desktop, icon: '▧' },
    { label: 'Documents', path: workspace.favorites.documents, icon: '▤' },
    { label: 'Downloads', path: workspace.favorites.downloads, icon: '⇩' },
    { label: 'Work', path: workspace.favorites.work, icon: '◇' },
    { label: 'Computer', path: workspace.favorites.root, icon: '▣' }
  ] : []

  return (
    <main
      data-workspace-id={workspaceId}
      className={`app-shell ${terminalOpen ? 'terminal-open' : 'terminal-closed'}`}
      style={{
        '--terminal-height': `${terminalHeight}px`,
        '--git-panel-width': `${gitPanelWidth}px`
      }}
    >
      <header className="topbar">
        <div className="nav-controls">
          <button className="icon-button" disabled={!canGoBack || Boolean(busy)} onClick={goBack} title="Back ⌘[">‹</button>
          <button className="icon-button" disabled={!canGoForward || Boolean(busy)} onClick={goForward} title="Forward ⌘]">›</button>
          <button
            className="icon-button"
            disabled={!directory?.canGoUp || Boolean(busy)}
            onClick={() => directory?.parent && navigate(directory.parent)}
            title="Up one folder"
          >
            ↑
          </button>
        </div>

        <div className="breadcrumbs" aria-label="Current location">
          {directory?.breadcrumbs.map((part, index) => (
            <span className="crumb-wrap" key={part.path}>
              {index > 0 && <span className="crumb-separator">›</span>}
              <button
                className={index === directory.breadcrumbs.length - 1 ? 'crumb active' : 'crumb'}
                onClick={() => navigate(part.path)}
                disabled={Boolean(busy)}
                title={part.path}
              >
                {part.name}
              </button>
            </span>
          ))}
        </div>

        <div className="topbar-actions">
          {git && (
            <button
              className={gitPanelOpen ? 'repo-indicator active' : 'repo-indicator'}
              title="Git inspector"
              onClick={() => setGitPanelOpen((value) => !value)}
            >
              <span className="branch-toolbar-symbol">⑂</span>
              <strong>{git.branch}</strong>
              {git.changes.length > 0 && <span className="toolbar-count">{git.changes.length}</span>}
              <span className="sync-count">↑{git.ahead} ↓{git.behind}</span>
            </button>
          )}

          {hasRunActions && (
            <div className="toolbar-menu-wrap">
              <button
                className={runMenuOpen ? 'toolbar-button active' : 'toolbar-button'}
                onClick={() => {
                  setRunMenuOpen((value) => !value)
                  setOverflowMenuOpen(false)
                }}
                title="Run in Terminal"
              >
                <span className="play-symbol">▶</span>
                Run
              </button>

              {runMenuOpen && (
                <div className="toolbar-popover run-popover">
                  {selectedEntry && (
                    <>
                      <div className="menu-section-title">Selected item</div>
                      {selectedEntry.runnable && (
                        <button onClick={() => runEntry(selectedEntry)}>
                          <span>▶</span>
                          <div>
                            <strong>Run {selectedEntry.name}</strong>
                            <small>in Terminal</small>
                          </div>
                        </button>
                      )}
                      {selectedEntry.isDirectory && (
                        <button onClick={() => terminalHere(selectedEntry)}>
                          <span>⌘_</span>
                          <div>
                            <strong>Terminal Here</strong>
                            <small>{selectedEntry.name}</small>
                          </div>
                        </button>
                      )}
                      <button onClick={() => insertPath(selectedEntry)}>
                        <span>↳</span>
                        <div>
                          <strong>Insert Path</strong>
                          <small>into Terminal</small>
                        </div>
                      </button>
                    </>
                  )}

                  {hasPackageScripts && (
                    <>
                      <div className="menu-section-title package-section">
                        {packageInfo.packageManager} scripts
                      </div>
                      <div className="script-menu-list">
                        {packageInfo.scripts.map((script) => (
                          <button key={script.name} onClick={() => runPackageScript(script.name)}>
                            <span className="script-play">▶</span>
                            <div>
                              <strong>{script.name}</strong>
                              <small>{script.command}</small>
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <button
            className={terminalOpen ? 'toolbar-icon-button active' : 'toolbar-icon-button'}
            onClick={() => setTerminalOpen((value) => !value)}
            title="Terminal ⌘J"
          >
            ⌘_
          </button>

          <div className="toolbar-menu-wrap">
            <button
              className={overflowMenuOpen ? 'toolbar-icon-button active' : 'toolbar-icon-button'}
              onClick={() => {
                setOverflowMenuOpen((value) => !value)
                setRunMenuOpen(false)
              }}
              title="More"
            >
              •••
            </button>

            {overflowMenuOpen && (
              <div className="toolbar-popover overflow-popover">
                <button onClick={() => { setOverflowMenuOpen(false); chooseFolder() }}>
                  <span>⌘O</span>
                  <strong>Open Folder…</strong>
                </button>
                <button onClick={() => { setShowHidden((value) => !value); setOverflowMenuOpen(false) }}>
                  <span>{showHidden ? '✓' : ''}</span>
                  <strong>Show Hidden Files</strong>
                </button>
                <button onClick={() => { setTerminalOpen((value) => !value); setOverflowMenuOpen(false) }}>
                  <span>⌘J</span>
                  <strong>{terminalOpen ? 'Hide Terminal' : 'Show Terminal'}</strong>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <section className={git && gitPanelOpen ? 'browser-shell has-git' : 'browser-shell'}>
        <aside className="finder-sidebar">
          <div className="sidebar-title">Favorites</div>
          <nav>
            {favoriteItems.map((item) => (
              <button
                key={item.label}
                className={directory?.path === item.path ? 'sidebar-item active' : 'sidebar-item'}
                onClick={() => navigate(item.path)}
                disabled={Boolean(busy)}
              >
                <span className="sidebar-icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-spacer" />
        </aside>

        <section className="file-browser">
          <div className="file-header">
            <button
              className={sortKey === 'name' ? 'column-header active' : 'column-header'}
              onClick={() => changeSort('name')}
            >
              <span>Name</span>
              {sortKey === 'name' && <span className="sort-arrow">{sortDirection === 'asc' ? '↑' : '↓'}</span>}
            </button>
            <button
              className={sortKey === 'modified' ? 'column-header active' : 'column-header'}
              onClick={() => changeSort('modified')}
            >
              <span>Modified</span>
              {sortKey === 'modified' && <span className="sort-arrow">{sortDirection === 'asc' ? '↑' : '↓'}</span>}
            </button>
            <button
              className={sortKey === 'size' ? 'column-header active align-right' : 'column-header align-right'}
              onClick={() => changeSort('size')}
            >
              <span>Size</span>
              {sortKey === 'size' && <span className="sort-arrow">{sortDirection === 'asc' ? '↑' : '↓'}</span>}
            </button>
          </div>

          <div className="file-list" role="list">
            {busy === 'loading' && <div className="browser-message">Loading…</div>}
            {!busy && visibleEntries.length === 0 && (
              <div className="browser-message">This folder is empty.</div>
            )}
            {visibleEntries.map((entry) => (
              <button
                key={entry.path}
                className={selectedPath === entry.path ? 'file-row selected' : 'file-row'}
                onClick={() => {
                  setSelectedPath(entry.path)
                  setContextMenu(null)
                }}
                onDoubleClick={() => openEntry(entry)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setSelectedPath(entry.path)
                  setRunMenuOpen(false)
                  setOverflowMenuOpen(false)
                  setContextMenu({ entry, x: event.clientX, y: event.clientY })
                }}
                title={entry.path}
              >
                <div className="file-name-cell">
                  <span className={entry.isDirectory ? 'file-icon folder' : 'file-icon'}>{fileIcon(entry)}</span>
                  <span className="file-name">{entry.name}</span>
                  {entry.isSymlink && <span className="symlink-badge">alias</span>}
                </div>
                <div className="file-modified">{formatModified(entry.modifiedMs)}</div>
                <div className="file-size">{entry.isDirectory ? '—' : formatBytes(entry.size)}</div>
              </button>
            ))}
          </div>
        </section>

        {git && gitPanelOpen && (
          <>
            <div
              className="git-resizer"
              onPointerDown={beginGitResize}
              title="Drag to resize Git inspector"
            />
            <aside className="git-panel">
            <div className="git-panel-header">
              <div className="git-repo-title">
                <span className="repo-dot large" />
                <div>
                  <strong>{git.name}</strong>
                  <span className="git-root" title={git.root}>{git.root}</span>
                </div>
              </div>
              <button className="small-icon-button" onClick={() => refreshWorkspace()} disabled={Boolean(busy)} title="Refresh">
                ↻
              </button>
            </div>

            <div className="current-branch-card">
              <span className="branch-symbol">⑂</span>
              <div>
                <span className="eyebrow">Branch</span>
                <strong>{git.branch}</strong>
              </div>
              <span className="branch-sync">↑{git.ahead} ↓{git.behind}</span>
            </div>

            <div className="git-actions">
              <button onClick={() => runGitAction('fetch', () => window.gitspace.git.fetch(workspaceId))} disabled={Boolean(busy)}>
                {busy === 'fetch' ? 'Fetching…' : 'Fetch'}
              </button>
              <button onClick={() => runGitAction('pull', () => window.gitspace.git.pull(workspaceId))} disabled={Boolean(busy)}>
                {busy === 'pull' ? 'Pulling…' : 'Pull'}
              </button>
              <button onClick={() => runGitAction('push', () => window.gitspace.git.push(workspaceId))} disabled={Boolean(busy)}>
                {busy === 'push' ? 'Pushing…' : 'Push'}
              </button>
            </div>

            <div className="git-tabs">
              <button className={gitTab === 'changes' ? 'active' : ''} onClick={() => setGitTab('changes')}>
                Changes <span>{git.changes.length}</span>
              </button>
              <button className={gitTab === 'branches' ? 'active' : ''} onClick={() => setGitTab('branches')}>
                Branches <span>{git.branches.length}</span>
              </button>
              <button className={gitTab === 'remotes' ? 'active' : ''} onClick={() => setGitTab('remotes')}>
                Remotes <span>{git.remotes.length}</span>
              </button>
            </div>

            <div className="git-tab-body">
              {gitTab === 'changes' && (
                <div className="changes-pane">
                  <div className="pane-toolbar">
                    <span>
                      {git.changes.length} changes
                      {stagedCount > 0 ? ` · ${stagedCount} staged` : ''}
                    </span>
                    <div>
                      {stagedCount > 0 && (
                        <button
                          onClick={() => runGitAction('unstage-all', () => window.gitspace.git.unstageAll(workspaceId))}
                          disabled={Boolean(busy)}
                        >
                          Unstage all
                        </button>
                      )}
                      {git.changes.some((change) => change.unstaged) && (
                        <button
                          onClick={() => runGitAction('stage-all', () => window.gitspace.git.stageAll(workspaceId))}
                          disabled={Boolean(busy)}
                        >
                          Stage all
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="git-change-list">
                    {git.changes.length === 0 ? (
                      <div className="git-empty">
                        <span className="clean-check">✓</span>
                        <strong>Working tree clean</strong>
                        <span>No uncommitted changes.</span>
                      </div>
                    ) : git.changes.map((change, index) => (
                      <div className="git-change-row" key={`${change.path}-${index}`}>
                        <span className={`change-code ${change.staged ? 'staged' : ''}`}>{change.status.trim() || '?'}</span>
                        <div className="git-change-name">
                          <strong title={`${gitStatusLabel(change.status)} · ${change.path}`}>{change.path}</strong>
                        </div>
                        <div className="change-actions">
                          {change.staged && (
                            <button
                              title="Unstage"
                              disabled={Boolean(busy)}
                              onClick={() => runGitAction('unstage', () => window.gitspace.git.unstage(workspaceId, change.path, change.originalPath))}
                            >
                              −
                            </button>
                          )}
                          {change.unstaged && (
                            <button
                              title="Stage"
                              disabled={Boolean(busy)}
                              onClick={() => runGitAction('stage', () => window.gitspace.git.stage(workspaceId, change.path, change.originalPath))}
                            >
                              +
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {stagedCount > 0 && (
                    <div className="commit-box">
                      <textarea
                        value={commitMessage}
                        onChange={(event) => setCommitMessage(event.target.value)}
                        placeholder="Commit message"
                        disabled={Boolean(busy)}
                        rows={3}
                      />
                      <button
                        className="commit-button"
                        onClick={commit}
                        disabled={!commitMessage.trim() || Boolean(busy)}
                      >
                        {busy === 'commit' ? 'Committing…' : `Commit ${stagedCount} staged`}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {gitTab === 'branches' && (
                <div className="branches-pane">
                  {!newBranchFormOpen ? (
                    <button
                      className="new-branch-trigger"
                      onClick={() => setNewBranchFormOpen(true)}
                    >
                      <span>＋</span>
                      <span>New Branch</span>
                    </button>
                  ) : (
                    <div className="new-branch-card">
                      <div className="new-branch-card-header">
                        <span className="eyebrow">New Branch</span>
                        <button
                          className="new-branch-cancel"
                          onClick={() => {
                            setNewBranchFormOpen(false)
                            setBranchName('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                      <input
                        value={branchName}
                        onChange={(event) => setBranchName(event.target.value)}
                        placeholder="feature/my-branch"
                        spellCheck="false"
                        autoFocus
                      />
                      <label>
                        <span>From</span>
                        <select value={branchBase} onChange={(event) => setBranchBase(event.target.value)}>
                          {branchOptions(git).map((option) => (
                            <option key={`${option.kind}-${option.value}`} value={option.value}>
                              {option.kind === 'remote' ? 'remote · ' : ''}{option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="create-branch-button"
                        disabled={!branchName.trim() || !branchBase || Boolean(busy)}
                        onClick={createBranch}
                      >
                        {busy === 'create-branch' ? 'Creating…' : 'Create & switch'}
                      </button>
                    </div>
                  )}

                  <div className="branch-search-wrap">
                    <input
                      value={branchFilter}
                      onChange={(event) => setBranchFilter(event.target.value)}
                      placeholder="Filter branches"
                      spellCheck="false"
                    />
                  </div>

                  <div className="branch-section-title">Local</div>
                  <div className="git-branch-list">
                    {filteredBranches.map((branch) => (
                      <button
                        key={branch.name}
                        className={branch.current ? 'git-branch-row current' : 'git-branch-row'}
                        onClick={() => switchBranch(branch.name)}
                        disabled={Boolean(busy)}
                      >
                        <span className="branch-state">{branch.current ? '●' : '○'}</span>
                        <span className="branch-row-name">{branch.name}</span>
                        <span className="branch-track">{branch.track}</span>
                      </button>
                    ))}
                  </div>

                  <div className="branch-section-title">Remote</div>
                  <div className="remote-branch-list">
                    {filteredRemoteBranches.length === 0 ? (
                      <div className="small-empty">No remote branches.</div>
                    ) : filteredRemoteBranches.map((branch) => (
                      <button key={branch} className="remote-branch-row" onClick={() => setBranchBase(branch)}>
                        <span>↗</span>
                        <span>{branch}</span>
                        <span className="use-base">use as base</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {gitTab === 'remotes' && (
                <div className="remotes-pane">
                  <div className="repo-summary-card">
                    <span className="eyebrow">Repository</span>
                    <div className="summary-row"><span>Root</span><strong title={git.root}>{git.root}</strong></div>
                    <div className="summary-row"><span>Upstream</span><strong>{git.upstream || 'not configured'}</strong></div>
                    <div className="summary-row"><span>Last commit</span><strong>{git.lastCommit.hash || '—'} {git.lastCommit.subject}</strong></div>
                  </div>

                  <div className="branch-section-title">Remotes</div>
                  {git.remotes.length === 0 ? (
                    <div className="git-empty compact">
                      <strong>No remotes configured</strong>
                      <span>Add one from the terminal with git remote add.</span>
                    </div>
                  ) : git.remotes.map((remote) => (
                    <div className="remote-card" key={remote.name}>
                      <div className="remote-name">
                        <span className="remote-dot">●</span>
                        <strong>{remote.name}</strong>
                      </div>
                      <div className="remote-url">
                        <span>fetch</span>
                        <code title={remote.fetchUrl}>{remote.fetchUrl}</code>
                      </div>
                      <div className="remote-url">
                        <span>push</span>
                        <code title={remote.pushUrl}>{remote.pushUrl}</code>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
          </>
        )}
      </section>

      <section className="terminal-drawer">
        <div
          className="terminal-resizer"
          onPointerDown={beginTerminalResize}
          title="Drag to resize Terminal"
        />
        <div className="terminal-bar">
          <span className="terminal-mark">⌘_</span>
          <div className="terminal-tabs" role="tablist">
            {terminals.map((terminal) => (
              <button
                key={terminal.id}
                data-terminal-id={terminal.id}
                className={terminal.id === activeTerminalId ? 'terminal-tab active' : 'terminal-tab'}
                onClick={() => setActiveTerminalId(terminal.id)}
                title={terminal.cwd}
              >
                <span>{terminal.label}</span>
                {terminals.length > 1 && (
                  <span
                    className="terminal-tab-close"
                    role="button"
                    onClick={(event) => closeTerminalTab(terminal.id, event)}
                    title="Close terminal"
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
            <button className="terminal-add-button" onClick={addTerminal} title="New terminal">+</button>
          </div>
          <span className="terminal-cwd" title={directory?.path}>{directory?.path || ''}</span>
          <button className="terminal-close-button" onClick={() => setTerminalOpen(false)} title="Hide Terminal ⌘J">×</button>
        </div>
        <div className="terminal-host">
          <div className="terminal-frame" ref={terminalHost} />
        </div>
      </section>

      {contextMenu && (
        <div
          className="file-context-menu"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 224),
            top: Math.min(contextMenu.y, window.innerHeight - 170)
          }}
        >
          {contextMenu.entry.runnable && (
            <button onClick={() => runEntry(contextMenu.entry)}>
              <span>▶</span>
              <strong>Run in Terminal</strong>
            </button>
          )}
          {contextMenu.entry.isDirectory && (
            <button onClick={() => terminalHere(contextMenu.entry)}>
              <span>⌘_</span>
              <strong>Terminal Here</strong>
            </button>
          )}
          <button onClick={() => insertPath(contextMenu.entry)}>
            <span>↳</span>
            <strong>Insert Path in Terminal</strong>
          </button>
          <div className="context-separator" />
          <button onClick={() => {
            const entry = contextMenu.entry
            setContextMenu(null)
            openEntry(entry)
          }}>
            <span>↗</span>
            <strong>{contextMenu.entry.isDirectory ? 'Open Folder' : 'Open'}</strong>
          </button>
        </div>
      )}

      {error && (
        <div className="error-banner">
          <span className="error-icon">!</span>
          <span>{error}</span>
          <button onClick={() => setError('')}>×</button>
        </div>
      )}
    </main>
  )
}
