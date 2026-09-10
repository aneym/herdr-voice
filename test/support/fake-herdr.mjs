/**
 * A herdr the tools can be tested against.
 *
 * The tool layer talks to herdr through a single `request(method, params)`
 * call, so that — not the socket underneath it — is what a test needs to
 * double. This keeps a small mutable workspace, answers the requests the tools
 * make, and records every call so a test can assert what was asked for as well
 * as what came back.
 *
 * Agent status can be scripted over time, because the interesting question for
 * `prompt_agent` is whether it waits for a turn to finish rather than returning
 * the moment the prompt is delivered.
 */
export function fakeHerdr({ workspaces = [], panes = [], agents = [], focused = {}, screens = {} } = {}) {
  const calls = []
  const state = {
    workspaces: workspaces.length
      ? workspaces
      : [{ workspace_id: 'w1', label: 'main', number: 1, pane_count: 1, tab_count: 1 }],
    panes: panes.length ? panes : [{ pane_id: 'p1', workspace_id: 'w1', foreground_cwd: process.cwd() }],
    agents,
    focused_workspace_id: focused.workspace_id ?? 'w1',
    focused_pane_id: focused.pane_id ?? 'p1',
    // Per-agent screen text; a function is called each time, so a test can make
    // the screen change as a turn progresses.
    screens,
  }

  const read = (target) => {
    const s = state.screens[target]
    return typeof s === 'function' ? s() : (s ?? '')
  }

  return {
    calls,
    state,
    /** Every method the tool layer asks for, and nothing it does not. */
    async request(method, params = {}) {
      calls.push({ method, params })
      switch (method) {
        case 'session.snapshot':
          return {
            snapshot: {
              workspaces: state.workspaces,
              panes: state.panes,
              focused_workspace_id: state.focused_workspace_id,
              focused_pane_id: state.focused_pane_id,
            },
          }
        case 'agent.list':
          return { agents: state.agents }
        case 'pane.list':
          return { panes: state.panes.filter((p) => p.workspace_id === params.workspace_id) }
        case 'agent.read':
          return { read: { text: read(params.target) } }
        case 'agent.prompt':
        case 'agent.start':
        case 'agent.focus':
        case 'pane.send_text':
        case 'pane.split':
        case 'pane.zoom':
        case 'pane.focus_direction':
        case 'layout.apply':
        case 'notification.show':
        case 'tab.create':
        case 'tab.close':
        case 'tab.rename':
        case 'workspace.create':
        case 'workspace.close':
        case 'workspace.focus':
        case 'workspace.rename':
          return { ok: true }
        default:
          throw new Error(`fake herdr got an unexpected request: ${method}`)
      }
    },
    /** Requests of one kind, for asserting what the tool actually did. */
    sent(method) {
      return calls.filter((c) => c.method === method).map((c) => c.params)
    },
  }
}
