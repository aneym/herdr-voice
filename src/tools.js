import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()
const REPO_ROOTS = [path.join(HOME, 'repos'), path.join(HOME, 'repos/personal')]

/** Agent kinds herdr can detect/start (from server.agent_manifests). */
export const AGENT_KINDS = [
  'claude', 'codex', 'gemini', 'cursor', 'pi', 'hermes', 'opencode', 'copilot',
  'amp', 'droid', 'kimi', 'grok', 'devin', 'cline', 'kilo', 'qodercli', 'maki',
  'agy', 'kiro',
]

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Fuzzy-resolve a spoken name to a workspace. Accepts label, number, or id. */
function resolveWorkspace(snapshot, spoken) {
  const spaces = snapshot.workspaces ?? []
  if (!spoken) {
    return spaces.find((w) => w.workspace_id === snapshot.focused_workspace_id) ?? spaces[0]
  }
  const q = norm(spoken)
  const byId = spaces.find((w) => w.workspace_id === spoken)
  if (byId) return byId
  if (/^\d+$/.test(q)) {
    const byNum = spaces.find((w) => String(w.number) === q)
    if (byNum) return byNum
  }
  const exact = spaces.find((w) => norm(w.label) === q)
  if (exact) return exact
  const starts = spaces.find((w) => norm(w.label).startsWith(q))
  if (starts) return starts
  const contains = spaces.find((w) => norm(w.label).includes(q) || q.includes(norm(w.label)))
  if (contains) return contains
  // token overlap fallback — "the billing one" -> "billing fix"
  const qt = q.split(' ').filter(Boolean)
  let best = null
  let bestScore = 0
  for (const w of spaces) {
    const wt = new Set(norm(w.label).split(' ').filter(Boolean))
    const score = qt.filter((t) => wt.has(t)).length
    if (score > bestScore) {
      bestScore = score
      best = w
    }
  }
  return bestScore > 0 ? best : null
}

function resolveAgent(agents, spoken) {
  if (!agents.length) return null
  if (!spoken) return agents[0]
  const q = norm(spoken)
  return (
    agents.find((a) => a.pane_id === spoken || a.agent_id === spoken) ??
    agents.find((a) => norm(a.name) === q) ??
    agents.find((a) => norm(a.name).startsWith(q)) ??
    agents.find((a) => norm(a.name).includes(q) || norm(a.kind) === q) ??
    null
  )
}

/** Resolve a spoken project name to a real directory under ~/repos. */
function resolveCwd(spoken) {
  if (!spoken) return null
  const raw = spoken.replace(/^~/, HOME)
  if (raw.startsWith('/') && fs.existsSync(raw)) return raw
  const q = norm(spoken).replace(/ /g, '-')
  for (const root of REPO_ROOTS) {
    if (!fs.existsSync(root)) continue
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
    const hit =
      entries.find((e) => e.name.toLowerCase() === q) ??
      entries.find((e) => e.name.toLowerCase().startsWith(q)) ??
      entries.find((e) => e.name.toLowerCase().includes(q))
    if (hit) return path.join(root, hit.name)
  }
  return null
}

const LAYOUT_PRESETS = {
  agent_and_logs: {
    type: 'split', direction: 'right', ratio: 0.62,
    first: { type: 'pane', label: 'agent' },
    second: { type: 'pane', label: 'logs' },
  },
  three_up: {
    type: 'split', direction: 'right', ratio: 0.34,
    first: { type: 'pane', label: 'agent' },
    second: {
      type: 'split', direction: 'right', ratio: 0.5,
      first: { type: 'pane', label: 'build' },
      second: { type: 'pane', label: 'logs' },
    },
  },
  agent_over_shell: {
    type: 'split', direction: 'down', ratio: 0.7,
    first: { type: 'pane', label: 'agent' },
    second: { type: 'pane', label: 'shell' },
  },
}

/**
 * Curated voice verbs. Deliberately ~15 high-level tools rather than the raw 89
 * API methods — realtime models pick far more reliably from a small named set.
 */
export const TOOL_SPECS = [
  {
    name: 'get_state',
    description:
      'Read the current terminal workspace state: all spaces, their panes, and running agents with status. Call this when you need to know what exists before acting, or when the user asks what is running.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'create_space',
    description:
      'Create a new workspace ("space") — the top-level container for a project or task. Optionally open it in a project directory and immediately start a coding agent in it.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Name for the space, e.g. "billing fix"' },
        project: {
          type: 'string',
          description: 'Optional project/repo name to open in, e.g. "iris" or "tempo". Resolved against ~/repos.',
        },
        agent: {
          type: 'string',
          description: `Optionally start this agent immediately. One of: ${AGENT_KINDS.join(', ')}`,
        },
        focus: { type: 'boolean', description: 'Switch to the new space (default true)' },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    name: 'focus_space',
    description: 'Switch to an existing space by name or number.',
    parameters: {
      type: 'object',
      properties: { space: { type: 'string', description: 'Space name or number' } },
      required: ['space'],
      additionalProperties: false,
    },
  },
  {
    name: 'rename_space',
    description: 'Rename an existing space.',
    parameters: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space to rename (name or number). Omit for current.' },
        label: { type: 'string', description: 'New name' },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_space',
    description:
      'Close a space and kill its panes. DESTRUCTIVE: this kills running processes. Always ask the user to confirm out loud first, then call again with confirm=true.',
    parameters: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space to close (name or number)' },
        confirm: { type: 'boolean', description: 'Set true only after the user verbally confirmed' },
      },
      required: ['space'],
      additionalProperties: false,
    },
  },
  {
    name: 'new_tab',
    description: 'Create a new tab (a separate layout) inside a space.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Tab name' },
        space: { type: 'string', description: 'Space to add it to. Omit for current.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'split_pane',
    description: 'Split the current pane to create another terminal beside or below it.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['right', 'down'], description: 'Where the new pane goes' },
        ratio: { type: 'number', description: 'Split ratio 0.1-0.9, default 0.5' },
        project: { type: 'string', description: 'Optional project dir for the new pane' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'focus_pane',
    description: 'Move focus to a neighbouring pane in a direction.',
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['left', 'right', 'up', 'down'] } },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'zoom_pane',
    description: 'Zoom the focused pane to fill the screen, or unzoom it.',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['toggle', 'on', 'off'] } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_layout',
    description:
      'Apply a preset pane layout to a space. Presets: agent_and_logs (agent left, logs right), three_up (agent, build, logs), agent_over_shell (agent on top, shell below).',
    parameters: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: Object.keys(LAYOUT_PRESETS) },
        space: { type: 'string', description: 'Space to lay out. Omit for current.' },
      },
      required: ['preset'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_agent',
    description:
      'Start a coding agent in a pane. Use split=true to put it in a new pane beside the current one, or give a space name to start it there.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: `Agent to start. One of: ${AGENT_KINDS.join(', ')}` },
        name: { type: 'string', description: 'Friendly name for this agent, e.g. "reviewer"' },
        space: { type: 'string', description: 'Space to start it in. Omit for current.' },
        project: { type: 'string', description: 'Project/repo to start it in, e.g. "iris"' },
        split: { type: 'boolean', description: 'Split the current pane first instead of reusing it' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'prompt_agent',
    description: 'Send a prompt/instruction to a running agent and submit it.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name. Omit to use the only/first agent.' },
        text: { type: 'string', description: 'The prompt to send' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_agent',
    description:
      'Read recent terminal output from an agent so you can tell the user what it said or what it is waiting on.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name. Omit for the first agent.' },
        lines: { type: 'number', description: 'How many lines to read, default 40' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: 'Type and run a shell command in a pane. Use for build/test/git commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command' },
        space: { type: 'string', description: 'Space whose pane to run in. Omit for current.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'notify',
    description: 'Show a desktop notification.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'focus_agent',
    description:
      'Jump to a running agent — focuses its pane wherever it is. Use when the user says "go to <agent>" or "show me what <agent> is doing".',
    parameters: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Agent name' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_worktree',
    description:
      'Create a git worktree for a branch as a new space — the standard way to start parallel work on a repo. Give the branch name and the project/repo.',
    parameters: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name, e.g. "feat-login". Created if missing.' },
        project: { type: 'string', description: 'Repo name resolved against ~/repos, e.g. "iris"' },
        base: { type: 'string', description: 'Base branch to fork from (default: repo default branch)' },
        agent: { type: 'string', description: `Optionally start this agent in it. One of: ${AGENT_KINDS.join(', ')}` },
      },
      required: ['branch', 'project'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_tab',
    description: 'Close a tab in a space (kills its panes). Confirmation flow like close_space.',
    parameters: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Tab label or number within the space' },
        space: { type: 'string', description: 'Space the tab is in. Omit for current.' },
        confirm: { type: 'boolean', description: 'Set true only after the user verbally confirmed' },
      },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'rename_tab',
    description: 'Rename a tab in the current space.',
    parameters: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Tab label or number. Omit for the active tab.' },
        label: { type: 'string', description: 'New name' },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
]

export const REALTIME_TOOLS = TOOL_SPECS.map((t) => ({ type: 'function', ...t }))

/** Compact state summary used both for grounding the model and for the TUI. */
export async function readState(herdr) {
  const [snapRes, agentsRes] = await Promise.all([
    herdr.request('session.snapshot'),
    herdr.request('agent.list'),
  ])
  const snapshot = snapRes.snapshot ?? snapRes
  const agents = agentsRes.agents ?? []
  return { snapshot, agents }
}

function summarize({ snapshot, agents }) {
  return {
    current_space:
      snapshot.workspaces?.find((w) => w.workspace_id === snapshot.focused_workspace_id)?.label ?? null,
    spaces: (snapshot.workspaces ?? []).map((w) => ({
      name: w.label,
      number: w.number,
      panes: w.pane_count,
      tabs: w.tab_count,
      agent_status: w.agent_status,
      current: w.workspace_id === snapshot.focused_workspace_id,
    })),
    agents: agents.map((a) => ({
      name: a.name,
      kind: a.kind,
      status: a.status,
      space: snapshot.panes?.find((p) => p.pane_id === a.pane_id)?.workspace_id ?? null,
    })),
  }
}

/**
 * Execute one voice tool against herdr.
 * Returns a plain object which is JSON-stringified back to the model.
 */
export function createExecutor(herdr, { onNotice } = {}) {
  const notice = (m) => onNotice?.(m)

  return async function execute(name, args = {}) {
    const state = await readState(herdr)
    const { snapshot, agents } = state

    const needSpace = (spoken, label = 'space') => {
      const w = resolveWorkspace(snapshot, spoken)
      if (!w) {
        const known = (snapshot.workspaces ?? []).map((s) => s.label).join(', ')
        throw new Error(`No ${label} matching "${spoken}". Known spaces: ${known || 'none'}`)
      }
      return w
    }

    switch (name) {
      case 'get_state':
        return { ok: true, ...summarize(state) }

      case 'create_space': {
        const cwd = resolveCwd(args.project)
        if (args.project && !cwd) {
          return { ok: false, error: `Could not find a project directory matching "${args.project}".` }
        }
        const res = await herdr.request('workspace.create', {
          label: args.label,
          focus: args.focus !== false,
          ...(cwd ? { cwd } : {}),
        })
        const out = {
          ok: true,
          created: res.workspace?.label,
          number: res.workspace?.number,
          cwd: cwd ?? undefined,
        }
        if (args.agent) {
          const paneId = res.root_pane?.pane_id
          const agentName = `${args.agent}-${res.workspace?.number ?? ''}`
          await herdr.request('agent.start', {
            kind: args.agent,
            name: agentName,
            pane_id: paneId,
          })
          out.agent_started = { kind: args.agent, name: agentName }
        }
        notice(`created space "${args.label}"`)
        return out
      }

      case 'focus_space': {
        const w = needSpace(args.space)
        await herdr.request('workspace.focus', { workspace_id: w.workspace_id })
        return { ok: true, focused: w.label, number: w.number }
      }

      case 'rename_space': {
        const w = needSpace(args.space)
        await herdr.request('workspace.rename', { workspace_id: w.workspace_id, label: args.label })
        return { ok: true, renamed_from: w.label, renamed_to: args.label }
      }

      case 'close_space': {
        const w = needSpace(args.space)
        if (!args.confirm) {
          return {
            ok: false,
            confirmation_required: true,
            message: `Closing "${w.label}" will kill ${w.pane_count} pane(s). Ask the user to confirm out loud, then call close_space again with confirm=true.`,
          }
        }
        await herdr.request('workspace.close', { workspace_id: w.workspace_id })
        notice(`closed space "${w.label}"`)
        return { ok: true, closed: w.label }
      }

      case 'new_tab': {
        const w = args.space ? needSpace(args.space) : null
        const res = await herdr.request('tab.create', {
          focus: true,
          ...(args.label ? { label: args.label } : {}),
          ...(w ? { workspace_id: w.workspace_id } : {}),
        })
        return { ok: true, tab: res.tab?.label ?? args.label ?? 'new tab' }
      }

      case 'split_pane': {
        const cwd = resolveCwd(args.project)
        const res = await herdr.request('pane.split', {
          direction: args.direction,
          focus: true,
          ...(args.ratio ? { ratio: args.ratio } : {}),
          ...(cwd ? { cwd } : {}),
        })
        return { ok: true, direction: args.direction, pane_id: res.pane?.pane_id ?? res.pane_id }
      }

      case 'focus_pane':
        await herdr.request('pane.focus_direction', { direction: args.direction })
        return { ok: true, moved: args.direction }

      case 'zoom_pane':
        await herdr.request('pane.zoom', { mode: args.mode ?? 'toggle' })
        return { ok: true, zoom: args.mode ?? 'toggle' }

      case 'apply_layout': {
        const root = LAYOUT_PRESETS[args.preset]
        if (!root) return { ok: false, error: `Unknown preset "${args.preset}"` }
        const w = args.space ? needSpace(args.space) : null
        await herdr.request('layout.apply', {
          root,
          focus: true,
          ...(w ? { workspace_id: w.workspace_id } : {}),
        })
        notice(`applied layout ${args.preset}`)
        return { ok: true, layout: args.preset, space: w?.label ?? 'current' }
      }

      case 'start_agent': {
        if (!AGENT_KINDS.includes(args.kind)) {
          return { ok: false, error: `Unknown agent "${args.kind}". Available: ${AGENT_KINDS.join(', ')}` }
        }
        const cwd = resolveCwd(args.project)
        let paneId
        if (args.space) {
          const w = needSpace(args.space)
          await herdr.request('workspace.focus', { workspace_id: w.workspace_id })
          const panes = await herdr.request('pane.list', { workspace_id: w.workspace_id })
          paneId = panes.panes?.[0]?.pane_id
        }
        if (args.split || !paneId) {
          if (args.split) {
            const res = await herdr.request('pane.split', {
              direction: 'right',
              focus: true,
              ...(cwd ? { cwd } : {}),
            })
            paneId = res.pane?.pane_id ?? res.pane_id
          } else if (!paneId) {
            paneId = snapshot.focused_pane_id
          }
        }
        const agentName = args.name || `${args.kind}-${(agents.length ?? 0) + 1}`
        await herdr.request('agent.start', { kind: args.kind, name: agentName, pane_id: paneId }, { timeoutMs: 30000 })
        notice(`started ${args.kind} as "${agentName}"`)
        return { ok: true, started: args.kind, name: agentName, pane_id: paneId }
      }

      case 'prompt_agent': {
        const a = resolveAgent(agents, args.agent)
        if (!a) {
          return { ok: false, error: agents.length ? `No agent matching "${args.agent}".` : 'No agents are running.' }
        }
        await herdr.request('agent.prompt', { target: a.name ?? a.pane_id, text: args.text })
        notice(`prompted ${a.name}`)
        return { ok: true, agent: a.name, sent: args.text }
      }

      case 'read_agent': {
        const a = resolveAgent(agents, args.agent)
        if (!a) return { ok: false, error: 'No agents are running.' }
        // `visible` = what is on screen now. `recent` only returns output since the
        // last read, so it comes back empty on a first read — wrong for "what is it doing?".
        const res = await herdr.request('agent.read', {
          target: a.name ?? a.pane_id,
          source: 'visible',
          format: 'text',
          strip_ansi: true,
          lines: args.lines ?? 40,
        })
        // payload is nested under `read` (pane_read/agent_read envelope)
        const text = (res.read?.text ?? res.text ?? res.content ?? '').toString()
        return { ok: true, agent: a.name, status: a.status, output: text.slice(-2500) }
      }

      case 'run_command': {
        let paneId = snapshot.focused_pane_id
        if (args.space) {
          const w = needSpace(args.space)
          const panes = await herdr.request('pane.list', { workspace_id: w.workspace_id })
          paneId = panes.panes?.[0]?.pane_id ?? paneId
        }
        await herdr.request('pane.send_text', { pane_id: paneId, text: args.command + '\n' })
        notice(`ran: ${args.command}`)
        return { ok: true, ran: args.command, pane_id: paneId }
      }

      case 'notify':
        await herdr.request('notification.show', {
          title: args.title,
          ...(args.body ? { body: args.body } : {}),
        })
        return { ok: true, notified: args.title }

      case 'focus_agent': {
        const a = resolveAgent(agents, args.agent)
        if (!a) {
          return { ok: false, error: agents.length ? `No agent matching "${args.agent}".` : 'No agents are running.' }
        }
        await herdr.request('agent.focus', { target: a.name ?? a.pane_id })
        return { ok: true, focused: a.name, status: a.status }
      }

      case 'create_worktree': {
        const cwd = resolveCwd(args.project)
        if (!cwd) return { ok: false, error: `Could not find a project matching "${args.project}".` }
        const res = await herdr.request(
          'worktree.create',
          {
            branch: args.branch,
            cwd,
            focus: true,
            ...(args.base ? { base: args.base } : {}),
          },
          { timeoutMs: 60000 } // git clone/checkout can be slow
        )
        const out = {
          ok: true,
          worktree: args.branch,
          space: res.workspace?.label,
          path: res.path ?? res.worktree?.path,
        }
        if (args.agent && res.workspace) {
          const panes = await herdr.request('pane.list', { workspace_id: res.workspace.workspace_id })
          const paneId = panes.panes?.[0]?.pane_id
          if (paneId) {
            const agentName = `${args.agent}-${args.branch}`.slice(0, 30)
            await herdr.request('agent.start', { kind: args.agent, name: agentName, pane_id: paneId }, { timeoutMs: 30000 })
            out.agent_started = agentName
          }
        }
        notice(`worktree ${args.branch}`)
        return out
      }

      case 'close_tab': {
        const w = args.space ? needSpace(args.space) : needSpace(undefined)
        const tabs = (snapshot.tabs ?? []).filter((t) => t.workspace_id === w.workspace_id)
        const q = norm(args.tab)
        const t =
          tabs.find((x) => norm(x.label) === q) ??
          tabs.find((x) => String(x.number) === q) ??
          tabs.find((x) => norm(x.label).includes(q))
        if (!t) return { ok: false, error: `No tab matching "${args.tab}" in ${w.label}.` }
        if (!args.confirm) {
          return {
            ok: false,
            confirmation_required: true,
            message: `Closing tab "${t.label}" kills ${t.pane_count} pane(s). Confirm out loud, then call again with confirm=true.`,
          }
        }
        await herdr.request('tab.close', { tab_id: t.tab_id })
        return { ok: true, closed_tab: t.label, space: w.label }
      }

      case 'rename_tab': {
        const w = needSpace(undefined)
        const tabs = (snapshot.tabs ?? []).filter((t) => t.workspace_id === w.workspace_id)
        const t = args.tab
          ? (tabs.find((x) => norm(x.label) === norm(args.tab)) ??
             tabs.find((x) => String(x.number) === norm(args.tab)))
          : tabs.find((x) => x.tab_id === w.active_tab_id) ?? tabs[0]
        if (!t) return { ok: false, error: `No tab matching "${args.tab ?? '(active)'}".` }
        await herdr.request('tab.rename', { tab_id: t.tab_id, label: args.label })
        return { ok: true, renamed_tab: t.label, to: args.label }
      }

      default:
        return { ok: false, error: `Unknown tool "${name}"` }
    }
  }
}

export const INSTRUCTIONS = `You are the voice control layer for herdr, a terminal workspace manager for AI coding agents.

You turn spoken requests into tool calls that configure the user's terminal: spaces (workspaces), tabs, panes, layouts, and coding agents.

Rules:
- Be terse. One short sentence confirming what you did. This is a heads-up display, not a conversation.
- Act immediately for reversible things (creating spaces, splitting panes, starting agents, applying layouts). Do not ask permission for those.
- Before closing a space or anything that kills running work, ask the user to confirm out loud, then call the tool again with confirm=true.
- If you are unsure which space or agent the user means, call get_state and match it yourself rather than asking, unless it is genuinely ambiguous between two similar names.
- Vocabulary: "space" = workspace, "pane" = a terminal split, "agent" = a coding agent like claude or codex.
- When the user asks what is running or what an agent is doing, use get_state and read_agent, then summarize in one or two sentences.
- Never invent space names, agent names, or statuses. Read them with get_state first.`
