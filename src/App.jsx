import { useCallback, useEffect, useMemo, useState } from 'react'
import WorkspaceView from './WorkspaceView'

export default function App() {
  const [tabs, setTabs] = useState([])
  const [activeTabId, setActiveTabId] = useState(null)
  const [error, setError] = useState('')

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) || null,
    [tabs, activeTabId]
  )

  const addTab = useCallback(async (initialPath = null) => {
    setError('')
    try {
      const state = await window.gitspace.workspace.create(initialPath)
      const tab = {
        id: state.workspaceId,
        title: state.directory.name || state.directory.path,
        path: state.directory.path,
        branch: state.git?.branch || null
      }

      setTabs((current) => [...current, tab])
      setActiveTabId(tab.id)
      return tab
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [])

  useEffect(() => {
    addTab()
  }, [addTab])

  const updateTabMeta = useCallback((workspaceId, meta) => {
    setTabs((current) => current.map((tab) => (
      tab.id === workspaceId
        ? { ...tab, ...meta }
        : tab
    )))
  }, [])

  async function closeTab(workspaceId) {
    const index = tabs.findIndex((tab) => tab.id === workspaceId)
    if (index < 0) return

    try {
      await window.gitspace.workspace.close(workspaceId)
    } catch {}

    const remaining = tabs.filter((tab) => tab.id !== workspaceId)

    if (remaining.length === 0) {
      setTabs([])
      setActiveTabId(null)
      await addTab()
      return
    }

    setTabs(remaining)

    if (activeTabId === workspaceId) {
      const nextIndex = Math.min(index, remaining.length - 1)
      setActiveTabId(remaining[nextIndex].id)
    }
  }

  function cycleTab(direction = 1) {
    if (tabs.length < 2) return
    const index = tabs.findIndex((tab) => tab.id === activeTabId)
    const nextIndex = (index + direction + tabs.length) % tabs.length
    setActiveTabId(tabs[nextIndex].id)
  }

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.metaKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        addTab(activeTab?.path || null)
        return
      }

      if (event.metaKey && event.key.toLowerCase() === 'w' && tabs.length > 1) {
        event.preventDefault()
        closeTab(activeTabId)
        return
      }

      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        cycleTab(event.shiftKey ? -1 : 1)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTabId, activeTab?.path, tabs])

  return (
    <div className="window-shell">
      <header className="workspace-tabs-bar">
        <div className="traffic-spacer" />

        <div className="workspace-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={tab.id === activeTabId ? 'workspace-tab active' : 'workspace-tab'}
              onClick={() => setActiveTabId(tab.id)}
              title={tab.path}
              role="tab"
              aria-selected={tab.id === activeTabId}
            >
              <span className="workspace-tab-title">{tab.title}</span>
              {tab.branch && <span className="workspace-tab-branch">⑂ {tab.branch}</span>}
              {tabs.length > 1 && (
                <span
                  className="workspace-tab-close"
                  role="button"
                  title="Close tab"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
        </div>

        <button
          className="workspace-new-tab"
          onClick={() => addTab(activeTab?.path || null)}
          title="New tab ⌘T"
        >
          +
        </button>
      </header>

      <div className="workspace-stack">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === activeTabId ? 'workspace-pane active' : 'workspace-pane'}
          >
            <WorkspaceView
              workspaceId={tab.id}
              active={tab.id === activeTabId}
              onMetaChange={updateTabMeta}
            />
          </div>
        ))}

        {tabs.length === 0 && (
          <div className="workspace-loading">Opening workspace…</div>
        )}
      </div>

      {error && (
        <div className="error-banner app-error-banner">
          <span className="error-icon">!</span>
          <span>{error}</span>
          <button onClick={() => setError('')}>×</button>
        </div>
      )}
    </div>
  )
}
