import React, { useState, useEffect, useRef } from 'react';
import {
  Code2, Smartphone, Tablet, Monitor,
  ArrowUp, SlidersHorizontal, Check, Copy,
  Paperclip, Image as ImageIcon, Video, Network, X, Search as SearchIcon,
  Globe, SquareTerminal, ExternalLink, ChevronsLeft, ChevronsRight, Zap,
  ChevronDown, Lock, Plus, MessageSquare, Columns2, Swords, Bot,
  FileText, Folder, FolderPlus, MoreHorizontal, CornerDownLeft,
  Pin, PinOff, Pencil, Trash2, Palette, MessageSquarePlus,
  Sparkles, RotateCw, Square, LogOut
} from 'lucide-react';
import { isSupabaseConfigured } from '@/lib/supabase';
import { signInWithGoogle, signOut, getCurrentUser, onAuthChange, type AppUser } from '@/lib/auth';
import {
  loadProjects, createProject as dbCreateProject, updateProject as dbUpdateProject,
  deleteProject as dbDeleteProject, loadItems, setItemProject,
} from '@/lib/data';

/**
 * AIPlayground — "Instrument Panel" refined dark theme.
 *
 * Design language (see DESIGN TOKENS below):
 *  - True-neutral graphite surfaces, no blue-black, no gradients.
 *  - A single restrained signal-amber accent used ONLY for active/live state.
 *  - Hairline borders + one real shadow layer instead of glassmorphism.
 *  - Distinctive type pairing: 'Space Mono' for technical chrome,
 *    'Bricolage Grotesque' for display/labels. Loaded at runtime so the
 *    component is self-contained.
 *  - 4px spacing rhythm, instrumentation-style status dots + telemetry.
 */

// ----- structural types -----
interface PromptScript {
  id: string;
  name: string;
  category: string;
  description: string;
  snippet: string;
}

// ----- AUTO MODE: capability routing -----
// The capabilities the router can dispatch to. 'chat' is the default fallback.
export type Capability = 'code' | 'web_search' | 'image' | 'orchestrate' | 'chat';

interface RouteResult {
  capability: Capability;
  reason: string; // short, surfaced in UI / logs so routing is auditable
}

/**
 * Lightweight, dependency-free intent router. Pure function — easy to unit test.
 * Maps a raw prompt to a single capability using ordered keyword/heuristic rules.
 * Order matters: more specific intents are checked before general ones.
 * This is deterministic and runs client-side; swap in an LLM classifier later
 * behind the same signature if you want fuzzier routing.
 */
export function routePrompt(prompt: string): RouteResult {
  const p = prompt.toLowerCase().trim();
  if (!p) return { capability: 'chat', reason: 'empty prompt' };

  const has = (...words: string[]) => words.some(w => p.includes(w));
  // word-boundary match for short/ambiguous tokens to avoid false hits
  const hasWord = (...words: string[]) =>
    words.some(w => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(p));

  // 1. Image generation — explicit visual-creation intent.
  if (
    has('generate an image', 'generate image', 'create an image', 'make an image',
        'draw ', 'illustrate', 'render an image', 'logo', 'icon for', 'picture of',
        'photo of', 'wallpaper', 'design a poster') ||
    (has('image', 'picture', 'graphic') && has('generate', 'create', 'make'))
  ) {
    return { capability: 'image', reason: 'image-generation request' };
  }

  // 2. Multi-agent orchestration — complex, multi-step build/plan goals.
  if (
    has('orchestrate', 'multi-agent', 'multi agent', 'team of agents',
        'build the entire', 'build a full', 'full-stack app', 'full stack app',
        'end-to-end', 'plan and build', 'architect and') ||
    (has('build', 'create') && has('then deploy', 'and deploy', 'pipeline'))
  ) {
    return { capability: 'orchestrate', reason: 'complex multi-step build' };
  }

  // 3. Code / build — component, refactor, debugging, language tokens.
  if (
    has('component', 'function', 'refactor', 'debug', 'compile', 'typescript',
        'javascript', 'python', 'react', 'tailwind', 'css', 'html', 'api',
        'unit test', 'fix this', 'write code', 'snippet', 'class ', 'endpoint',
        'sql', 'query', 'regex', 'algorithm') ||
    hasWord('code', 'bug', 'build')
  ) {
    return { capability: 'code', reason: 'code/build request' };
  }

  // 4. Web search — current/factual/lookup intent.
  // Strong signals fire on their own; weak time-words ('today','current','now')
  // only count when paired with a lookup/question cue, so "how are you today"
  // stays general chat.
  const strongSearch = has(
    'latest', 'breaking news', 'price of', 'stock price', 'weather in', 'weather today',
    'look up', 'search for', 'find out', 'how much does', 'release date',
    'who is the', 'what is the current', 'when did', 'when was', 'what happened to'
  );
  const weakTime = has('today', 'current', 'right now', 'this week', 'recent', 'news');
  const lookupCue = has('what', 'who', 'when', 'where', 'how much', 'how many', 'price', 'cost', 'rate', 'score', 'result');
  if (strongSearch || (weakTime && lookupCue) || hasWord('2024', '2025', '2026')) {
    return { capability: 'web_search', reason: 'current/factual lookup' };
  }

  // 5. Default — general conversation.
  return { capability: 'chat', reason: 'general chat (default)' };
}

// ----- CAPABILITY (single-select composer group) -----
export type CapabilityId = 'auto' | 'code' | 'search' | 'image' | 'video';

// localStorage helpers that never throw (sandbox / privacy-mode safe).
const CAPABILITY_KEY = 'arena.capability';
function loadCapability(): CapabilityId {
  try {
    const v = window.localStorage.getItem(CAPABILITY_KEY) as CapabilityId | null;
    return v && ['auto', 'code', 'search', 'image', 'video'].includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}
function saveCapability(c: CapabilityId) {
  try { window.localStorage.setItem(CAPABILITY_KEY, c); } catch { /* ignore */ }
}

// A single message in a conversation thread (Direct Mode).
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  code?: string;
  streaming?: boolean;
  error?: boolean;
}

// ----- MODEL LAYER (single integration seam) -----
// This is the ONLY place the client "talks to a model". It POSTs to the app's own
// backend route (/api/chat), which holds the provider API key as a server-side
// environment variable and proxies a streaming response back. The key is NEVER in
// this file, NEVER in the browser, NEVER in a URL. Every mode calls through here.
export interface StreamHandle { cancel: () => void; }
export interface StreamCallbacks {
  onToken: (chunk: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}
export interface StreamRequest {
  prompt: string;
  model: string;
  capability?: CapabilityId;
}

// The backend endpoint that holds the API key and streams tokens (newline-delimited).
const CHAT_ENDPOINT = '/api/chat';
// If the backend isn't deployed yet (e.g. artifact preview), fall back to a local
// mock so the UI still demonstrates streaming. Set to false once the API is live.
const USE_MOCK_FALLBACK = true;

function streamCompletion(req: StreamRequest, cb: StreamCallbacks): StreamHandle {
  const controller = new AbortController();
  let cancelled = false;

  (async () => {
    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: req.prompt, model: req.model, capability: req.capability ?? 'auto' }),
        signal: controller.signal,
        credentials: 'same-origin', // send the session cookie; auth handled server-side
      });

      // No backend yet (404/501/etc.) -> use the mock so the demo still streams.
      if (!res.ok || !res.body) {
        if (USE_MOCK_FALLBACK && (res.status === 404 || res.status === 501)) {
          return runMock(req, cb, () => cancelled);
        }
        const msg = await safeErr(res);
        if (!cancelled) cb.onError(msg);
        return;
      }

      // Stream the response body as newline-delimited text chunks.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (cancelled) { reader.cancel().catch(() => {}); return; }
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) cb.onToken(text);
      }
      if (!cancelled) cb.onDone();
    } catch (err) {
      if (cancelled) return; // user-initiated abort: stay silent
      // Network failure with no backend at all -> fall back to mock for the demo.
      if (USE_MOCK_FALLBACK) { runMock(req, cb, () => cancelled); return; }
      cb.onError('Could not reach the model service. Please try again.');
    }
  })();

  return { cancel: () => { cancelled = true; controller.abort(); } };
}

async function safeErr(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return (data?.error ? String(data.error) : '').slice(0, 200) || `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

// ---- LOCAL MOCK (used only as a fallback when the backend isn't reachable) ----
function runMock(req: StreamRequest, cb: StreamCallbacks, isCancelled: () => boolean) {
  const canned = [
    `Here's how I'd approach "${req.prompt.slice(0, 40)}${req.prompt.length > 40 ? '…' : ''}".`,
    ` Drawing on ${req.model}'s strengths, I'd break the request into clear steps,`,
    ` validate each against the requirements, then compose the final answer.`,
    ` (Demo mode — the live model responds once /api/chat is deployed.)`,
  ].join('');
  const tokens = canned.split(/(\s+)/);
  let i = 0;
  const tick = () => {
    if (isCancelled()) return;
    if (i >= tokens.length) { cb.onDone(); return; }
    cb.onToken(tokens[i]);
    i++;
    setTimeout(tick, 28 + Math.random() * 46);
  };
  setTimeout(tick, 180);
  // ---- END MOCK ----
}

// Mock model catalog for Side by Side (named) + Battle (anonymous pool).
export interface ModelInfo { id: string; name: string; provider: string; glyph: string; category: 'Text' | 'Code' | 'Image' | 'Search'; }
const MODEL_CATALOG: ModelInfo[] = [
  { id: 'gemini-2.5-flash',                       name: 'Gemini 2.5 Flash', provider: 'Google',     glyph: '◆', category: 'Text' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B',    provider: 'Meta',       glyph: '∞', category: 'Text' },
  { id: 'openrouter/free',                        name: 'Auto (Free)',      provider: 'OpenRouter', glyph: '⌬', category: 'Text' },
  { id: 'qwen/qwen3-coder:free',                  name: 'Qwen3 Coder',      provider: 'Qwen',       glyph: '⬡', category: 'Code' },
];

// ----- BATTLE MODE types -----
export type BattleVote = 'A' | 'B' | 'tie' | 'bad';
export interface BattleState {
  submitting: boolean;
  respA: string;
  respB: string;
  doneA: boolean;
  doneB: boolean;
  errorA?: boolean;
  errorB?: boolean;
  modelA: ModelInfo;   // hidden until revealed
  modelB: ModelInfo;
  vote: BattleVote | null;
  revealed: boolean;
}
function freshBattle(): BattleState {
  // pick two distinct random models from the Text pool
  const pool = MODEL_CATALOG.filter(m => m.category === 'Text');
  const a = pool[Math.floor(Math.random() * pool.length)];
  let b = pool[Math.floor(Math.random() * pool.length)];
  while (b.id === a.id) b = pool[Math.floor(Math.random() * pool.length)];
  return { submitting: false, respA: '', respB: '', doneA: false, doneB: false, modelA: a, modelB: b, vote: null, revealed: false };
}

// ----- AGENT MODE types -----
export type AgentStatus = 'idle' | 'planning' | 'running' | 'awaiting-input' | 'done' | 'error';
export interface AgentStep { id: string; kind: 'plan' | 'action' | 'result'; text: string; }
export interface AgentArtifact { id: string; name: string; kind: 'file' | 'note' | 'data'; }
export interface AgentState { status: AgentStatus; thread: AgentStep[]; artifacts: AgentArtifact[]; }

// ----- INTERACTION MODES -----
// Each design/session is bound to exactly ONE mode for its entire life. The mode
// locks on the first message sent (see `modeLocked`). Direct is the only mode
// built so far; the other three render a "coming soon" placeholder.
export type Mode = 'direct' | 'sidebyside' | 'battle' | 'agent';

interface ModeMeta {
  id: Mode;
  label: string;
  blurb: string;
  built: boolean;
}

const MODES: ModeMeta[] = [
  { id: 'direct',     label: 'Direct',       blurb: 'Single-model conversation',         built: true  },
  { id: 'sidebyside', label: 'Side by Side', blurb: 'Compare models in parallel',         built: false },
  { id: 'battle',     label: 'Battle',       blurb: 'Blind A/B vote · leaderboard',       built: false },
  { id: 'agent',      label: 'Agent',        blurb: 'Autonomous tool-using agent',        built: false },
];

function modeIcon(m: Mode, cls = 'h-[18px] w-[18px]') {
  switch (m) {
    case 'direct':     return <MessageSquare className={cls} />;
    case 'sidebyside': return <Columns2 className={cls} />;
    case 'battle':     return <Swords className={cls} />;
    case 'agent':      return <Bot className={cls} />;
  }
}

// ----- SEARCH + WORK ITEMS -----
export type ItemType = 'project' | 'conversation' | 'file';

export interface WorkItem {
  id: string;
  title: string;
  type: ItemType;
  project: string | null;   // null = ungrouped
  modified: number;         // epoch ms
}

function itemTypeIcon(t: ItemType, cls = 'h-4 w-4') {
  switch (t) {
    case 'project':      return <Folder className={cls} />;
    case 'conversation': return <MessageSquare className={cls} />;
    case 'file':         return <FileText className={cls} />;
  }
}

const TYPE_LABEL: Record<ItemType, string> = {
  project: 'Projects', conversation: 'Conversations', file: 'Files',
};

// relative time formatter (no deps)
function relTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7); if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// Lightweight fuzzy/partial matcher: every query char appears in order.
function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const t = text.toLowerCase();
  if (t.includes(q)) return true; // fast path: substring
  let i = 0;
  for (const ch of t) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return false;
}

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const now = Date.now();

// Seed data — replace with real workspace/session queries.
const SEED_ITEMS: WorkItem[] = [
  { id: 'c1', title: 'SaaS pricing card component', type: 'conversation', project: 'Arena UI',         modified: now - 8 * MIN },
  { id: 'c2', title: 'Auto Mode routing rules',      type: 'conversation', project: 'Arena UI',         modified: now - 2 * HOUR },
  { id: 'f1', title: 'arena-design-spec.md',         type: 'file',         project: 'Arena UI',         modified: now - 5 * HOUR },
  { id: 'p1', title: 'Orchestrator Backend',         type: 'project',      project: null,                modified: now - 1 * DAY },
  { id: 'f2', title: 'fileTypes.ts',                 type: 'file',         project: 'File Pipeline',     modified: now - 3 * DAY },
  { id: 'c3', title: 'LangGraph checkpoint wiring',  type: 'conversation', project: 'Orchestrator',      modified: now - 6 * DAY },
];

// Items not assigned to any project (ungrouped), most-recent-first.
const SEED_UNGROUPED: WorkItem[] = [
  { id: 'u1', title: 'Untitled — battle mode notes',  type: 'conversation', project: null, modified: now - 12 * MIN },
  { id: 'u2', title: 'scratch-snippet.tsx',           type: 'file',         project: null, modified: now - 4 * HOUR },
  { id: 'u3', title: 'Model comparison ideas',        type: 'conversation', project: null, modified: now - 2 * DAY },
];

const PROJECTS = ['Arena UI', 'Orchestrator', 'File Pipeline', 'Trading Indicators'];

// ----- PROJECTS -----
export interface Project {
  id: string;
  name: string;
  description?: string;
  color: string;   // hex; one of PROJECT_COLORS
  pinned: boolean;
}

// Small fixed palette for project color tags.
const PROJECT_COLORS = ['#e0a542', '#7fae9a', '#c08457', '#8a7fae', '#ae7f93', '#6f8fae'];

const SEED_PROJECTS: Project[] = [
  { id: 'pr1', name: 'Arena UI',            color: '#e0a542', pinned: true,  description: 'Front-end playground & modes' },
  { id: 'pr2', name: 'Orchestrator',        color: '#7fae9a', pinned: true,  description: 'Multi-agent backend' },
  { id: 'pr3', name: 'File Pipeline',       color: '#8a7fae', pinned: false, description: 'Upload & validation' },
  { id: 'pr4', name: 'Trading Indicators',  color: '#6f8fae', pinned: false, description: 'Strategy scripts' },
];

// ----- DESIGN TOKENS (single source of truth) -----
const T = {
  // surfaces — true neutral graphite, lightest → darkest
  bg:        '#0c0d0c',  // app background
  surface:   '#131413',  // panels
  surfaceHi: '#1a1b1a',  // raised elements
  inset:     '#090a09',  // wells / code / inputs
  // lines
  line:      '#262826',  // hairline border
  lineHi:    '#343734',  // hover/active border
  // text
  ink:       '#e8e6e0',  // primary (warm off-white, not pure white)
  inkSoft:   '#a3a39c',  // secondary
  inkMute:   '#63645f',  // tertiary / placeholders
  inkFaint:  '#3e3f3b',  // line numbers / disabled
  // the one accent — warm signal amber, used sparingly
  signal:    '#e0a542',
  signalDim: 'rgba(224,165,66,0.12)',
  signalLin: 'rgba(224,165,66,0.35)',
  // a secondary cool readout for telemetry only
  read:      '#7fae9a',
  // fonts
  mono: "'Space Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  disp: "'Bricolage Grotesque', system-ui, sans-serif",
};

export default function AIPlayground() {
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');
  const [viewport, setViewport] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [copied, setCopied] = useState(false);
  const [splitWidth, setSplitWidth] = useState(46);
  const [railOpen, setRailOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('direct');     // active session mode
  const [modeLocked, setModeLocked] = useState(false);  // true after first message
  const [modeMenuOpen, setModeMenuOpen] = useState(false);

  // Auth + persistence. `live` = Supabase is configured (real login + DB).
  // When not live, the app runs in local demo mode with seed data (no login wall).
  const live = isSupabaseConfigured();
  const [user, setUser] = useState<AppUser | null>(null);
  const [authReady, setAuthReady] = useState(!live); // local mode is "ready" immediately

  // search + ungrouped list
  const [searchOpen, setSearchOpen] = useState(false);
  const [ungrouped, setUngrouped] = useState<WorkItem[]>(live ? [] : SEED_UNGROUPED);
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // projects
  const [projects, setProjects] = useState<Project[]>(live ? [] : SEED_PROJECTS);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projMenu, setProjMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingProject, setRenamingProject] = useState<Project | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);

  // composer — single-select capability group (Auto default), persisted.
  const [capability, setCapability] = useState<CapabilityId>('auto');
  const [showScriptPopover, setShowScriptPopover] = useState(false);
  const [scriptSearchQuery, setScriptSearchQuery] = useState('');
  const [activeScripts, setActiveScripts] = useState<PromptScript[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<{ id: string; name: string }[]>([]);

  // Battle Mode state
  const [battle, setBattle] = useState<BattleState>(freshBattle());
  // Side by Side Mode state
  const [leftModel, setLeftModel] = useState<ModelInfo>(MODEL_CATALOG[1]);
  const [rightModel, setRightModel] = useState<ModelInfo>(MODEL_CATALOG[0]);
  const [picker, setPicker] = useState<{ side: 'left' | 'right'; category: ModelInfo['category'] | 'All'; query: string } | null>(null);
  const [sbs, setSbs] = useState<{ submitting: boolean; left: string; right: string; done: boolean }>({ submitting: false, left: '', right: '', done: false });
  // Agent Mode state
  const [agent, setAgent] = useState<AgentState>({ status: 'idle', thread: [], artifacts: [] });
  const [workspaceOpen, setWorkspaceOpen] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Load the two display/mono webfonts once, at runtime, so the file is self-contained.
  useEffect(() => {
    const id = 'aip-fonts';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700&family=Space+Mono:wght@400;700&display=swap';
    document.head.appendChild(link);
  }, []);

  // Hydrate the persisted capability once on mount (default 'auto').
  useEffect(() => {
    setCapability(loadCapability());
  }, []);

  // Single-select: pick a capability and persist it.
  const selectCapability = (c: CapabilityId) => {
    setCapability(c);
    saveCapability(c);
  };

  // Cancel any in-flight streams when the component unmounts.
  useEffect(() => cancelAllStreams, []);
  // Cancel in-flight streams when the mode changes (prevents stale writes).
  useEffect(() => { cancelAllStreams(); }, [mode]);

  // Auth: read the current user once, then subscribe to login/logout.
  useEffect(() => {
    if (!live) return;
    let active = true;
    getCurrentUser().then(u => { if (active) { setUser(u); setAuthReady(true); } });
    const unsub = onAuthChange(u => { if (active) { setUser(u); setAuthReady(true); } });
    return () => { active = false; unsub(); };
  }, [live]);

  // Load this user's projects + items from the database whenever they sign in.
  useEffect(() => {
    if (!live || !user) { return; }
    let active = true;
    (async () => {
      const [projs, items] = await Promise.all([loadProjects(), loadItems()]);
      if (!active) return;
      setProjects(projs);
      setUngrouped(items.filter(i => i.project === null));
    })();
    return () => { active = false; };
  }, [live, user]);

  // Pick a mode from the dropdown. Blocked once the session has locked.
  const selectMode = (next: Mode) => {
    if (modeLocked) return;
    setMode(next);
    setModeMenuOpen(false);
  };

  // Start a fresh session: unlocks and lets the user pick a mode again.
  const newSession = () => {
    setModeLocked(false);
    setModeMenuOpen(false);
    setInput('');
  };

  // Move an ungrouped item into a project; it then leaves the ungrouped list.
  const moveToProject = (id: string, projectName: string) => {
    setUngrouped(prev => prev.filter(i => i.id !== id));
    setCtxMenu(null);
    if (live) {
      const target = projects.find(p => p.name === projectName);
      void setItemProject(id, target ? target.id : null);
    }
  };

  // New Chat — start a fresh blank session (also unlocks mode).
  const newChat = () => {
    cancelAllStreams();
    setModeLocked(false);
    setModeMenuOpen(false);
    setActiveProject(null);
    setInput('');
    setMessages([]);
    setDirectStatus('idle');
    setLastDirectPrompt('');
    setBattle(freshBattle());
    setSbs({ submitting: false, left: '', right: '', done: false });
    setAgent({ status: 'idle', thread: [], artifacts: [] });
  };

  // Create a project from the modal; new projects are unpinned (hidden) by default.
  const createProject = async (name: string, description: string, color: string) => {
    setCreateProjectOpen(false);
    if (live && user) {
      const created = await dbCreateProject(user.id, name, description, color);
      if (created) setProjects(prev => [...prev, created]);
      return;
    }
    const id = `pr_${Date.now()}`;
    setProjects(prev => [...prev, { id, name, description: description || undefined, color, pinned: false }]);
  };

  const togglePin = (id: string) => {
    const next = !projects.find(p => p.id === id)?.pinned;
    setProjects(prev => prev.map(p => p.id === id ? { ...p, pinned: next } : p));
    setProjMenu(null);
    if (live) void dbUpdateProject(id, { pinned: next });
  };
  const renameProject = (id: string, name: string) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, name } : p));
    setRenamingProject(null);
    if (live) void dbUpdateProject(id, { name });
  };
  const recolorProject = (id: string, color: string) => {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, color } : p));
    if (live) void dbUpdateProject(id, { color });
  };
  const deleteProject = (id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
    if (activeProject === id) setActiveProject(null);
    setConfirmDelete(null);
    setProjMenu(null);
    if (live) void dbDeleteProject(id);
  };

  const pinnedProjects = projects.filter(p => p.pinned);

  // Close any open context menu on outside click / Escape.
  useEffect(() => {
    if (!ctxMenu && !projMenu) return;
    const close = () => { setCtxMenu(null); setProjMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setCtxMenu(null); setProjMenu(null); } };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [ctxMenu, projMenu]);

  const promptScriptLibrary: PromptScript[] = [
    { id: 'ts', name: 'Convert to TypeScript', category: 'REFACTOR', description: 'Strict type annotations and interface mapping.', snippet: 'Refactor the following component to strict, production-ready TypeScript.' },
    { id: 'tw', name: 'Optimize Tailwind CSS', category: 'STYLING', description: 'Removes redundancy, applies layout best practices.', snippet: 'Optimize the Tailwind CSS utility classes for semantic structuring and performance.' },
    { id: 'test', name: 'Generate Unit Tests', category: 'QUALITY', description: 'Robust Vitest / React Testing Library specs.', snippet: 'Write comprehensive unit tests covering standard user interactions using Vitest.' },
    { id: 'dark', name: 'Add Dark Mode Toggles', category: 'FEATURE', description: 'Injects dynamic system theme detection classes.', snippet: 'Implement adaptive dark mode variations using Tailwind "dark:" variant modifiers.' },
  ];

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'seed-u', role: 'user',
      text: 'Create a modern premium SaaS pricing card component with a glassmorphism look, subtle purple gradients, and smooth hover animations.',
    },
    {
      id: 'seed-a', role: 'assistant',
      text: "Engineered a pricing layout with an isolated backdrop blur, color-shifting borders on the high-converting package, and fully responsive scaling.",
      code: `export default function PricingDemo() {
  return (
    <div className="p-8 flex flex-col items-center justify-center min-h-[400px] bg-gradient-to-br from-neutral-900 via-neutral-950 to-purple-950/20 text-white font-sans">
      <div className="relative group rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-8 shadow-2xl transition-all duration-300 hover:border-purple-500/50 hover:shadow-purple-500/10 w-80">
        <div className="absolute -top-3 right-4 rounded-full bg-gradient-to-r from-purple-500 to-indigo-500 px-3 py-0.5 text-xs font-semibold tracking-wide">POPULAR</div>
        <h3 className="text-xl font-medium tracking-tight text-neutral-200">Enterprise Core</h3>
        <div className="mt-4 flex items-baseline text-white">
          <span className="text-5xl font-extrabold tracking-tight">$49</span>
          <span className="ml-1 text-xl font-semibold text-neutral-400">/mo</span>
        </div>
        <p className="mt-4 text-sm text-neutral-400">Scale your automation pipeline with zero latency restrictions.</p>
        <button className="mt-8 w-full rounded-xl bg-white py-3 text-sm font-semibold text-black transition-all duration-200 hover:bg-neutral-200 hover:scale-[1.02] active:scale-[0.98]">
          Deploy Instantly
        </button>
      </div>
    </div>
  );
}`,
    },
  ]);
  // Direct Mode request lifecycle + the prompt of the last send (for retry).
  const [directStatus, setDirectStatus] = useState<'idle' | 'streaming' | 'error'>('idle');
  const [lastDirectPrompt, setLastDirectPrompt] = useState('');

  // Active stream handles, tracked so we can cancel on stop / mode-switch / unmount.
  const streamHandles = useRef<StreamHandle[]>([]);
  const cancelAllStreams = () => {
    streamHandles.current.forEach(h => h.cancel());
    streamHandles.current = [];
  };

  // Keep the newest message in view as it streams.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const startResize = (_e: React.MouseEvent) => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const w = ((e.clientX - rect.left) / rect.width) * 100;
      if (w > 28 && w < 72) setSplitWidth(w);
    };
    const onUp = () => {
      isResizing.current = false;
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAddFileMock = () => {
    const id = Math.random().toString();
    setAttachedFiles(prev => [...prev, { id, name: `schema-v${prev.length + 1}.json` }]);
  };

  const handleSelectScript = (script: PromptScript) => {
    if (!activeScripts.some(s => s.id === script.id)) {
      setActiveScripts(prev => [...prev, script]);
    }
    setShowScriptPopover(false);
  };

  // For Auto, resolve the concrete capability at send time via the router.
  const effectiveCapability = (prompt: string): CapabilityId => {
    if (capability !== 'auto') return capability;
    const routed = routePrompt(prompt).capability; // 'code'|'web_search'|'image'|'orchestrate'|'chat'
    if (routed === 'web_search') return 'search';
    if (routed === 'code') return 'code';
    if (routed === 'image') return 'image';
    return 'auto'; // chat/orchestrate fall back to general handling
  };

  const handleSend = () => {
    const prompt = input.trim();
    if (!prompt) return;
    if (!modeLocked) setModeLocked(true); // first message binds the mode for this session
    const cap = effectiveCapability(prompt);

    if (mode === 'battle')          startBattle(prompt);
    else if (mode === 'sidebyside') startSideBySide(prompt);
    else if (mode === 'agent')      startAgent(prompt);
    else                            startDirect(prompt, cap);
    setInput('');
  };

  // ----- Direct Mode send (real conversation thread) -----
  const startDirect = (prompt: string, cap: CapabilityId) => {
    cancelAllStreams();
    setLastDirectPrompt(prompt);
    const userMsg: ChatMessage = { id: `u_${Date.now()}`, role: 'user', text: prompt };
    const aId = `a_${Date.now()}`;
    const assistantMsg: ChatMessage = { id: aId, role: 'assistant', text: '', streaming: true };
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setDirectStatus('streaming');

    const handle = streamCompletion({ prompt, model: 'gemini-2.5-flash', capability: cap }, {
      onToken: (chunk) => setMessages(prev => prev.map(m => m.id === aId ? { ...m, text: m.text + chunk } : m)),
      onDone: () => {
        setMessages(prev => prev.map(m => m.id === aId ? { ...m, streaming: false } : m));
        setDirectStatus('idle');
        streamHandles.current = streamHandles.current.filter(h => h !== handle);
      },
      onError: (msg) => {
        setMessages(prev => prev.map(m => m.id === aId ? { ...m, streaming: false, error: true, text: msg } : m));
        setDirectStatus('error');
        streamHandles.current = streamHandles.current.filter(h => h !== handle);
      },
    });
    streamHandles.current.push(handle);
  };

  // Stop an in-flight Direct response; keep whatever streamed so far.
  const stopDirect = () => {
    cancelAllStreams();
    setMessages(prev => prev.map(m => m.streaming ? { ...m, streaming: false } : m));
    setDirectStatus('idle');
  };

  // Retry the last Direct prompt after an error.
  const retryDirect = () => {
    if (!lastDirectPrompt) return;
    // drop the trailing errored assistant message before re-sending
    setMessages(prev => {
      const copy = [...prev];
      if (copy.length && copy[copy.length - 1].error) copy.pop();
      return copy;
    });
    const cap = effectiveCapability(lastDirectPrompt);
    const aId = `a_${Date.now()}`;
    setMessages(prev => [...prev, { id: aId, role: 'assistant', text: '', streaming: true }]);
    setDirectStatus('streaming');
    const handle = streamCompletion({ prompt: lastDirectPrompt, model: 'gemini-2.5-flash', capability: cap }, {
      onToken: (chunk) => setMessages(prev => prev.map(m => m.id === aId ? { ...m, text: m.text + chunk } : m)),
      onDone: () => { setMessages(prev => prev.map(m => m.id === aId ? { ...m, streaming: false } : m)); setDirectStatus('idle'); streamHandles.current = streamHandles.current.filter(h => h !== handle); },
      onError: (msg) => { setMessages(prev => prev.map(m => m.id === aId ? { ...m, streaming: false, error: true, text: msg } : m)); setDirectStatus('error'); streamHandles.current = streamHandles.current.filter(h => h !== handle); },
    });
    streamHandles.current.push(handle);
  };

  // ----- Battle Mode send -----
  const startBattle = (prompt: string) => {
    cancelAllStreams();
    const fresh = freshBattle();
    setBattle({ ...fresh, submitting: true });
    const hA = streamCompletion({ prompt, model: fresh.modelA.id }, {
      onToken: (chunk) => setBattle(b => ({ ...b, respA: b.respA + chunk })),
      onDone: () => setBattle(b => ({ ...b, doneA: true })),
      onError: (msg) => setBattle(b => ({ ...b, doneA: true, respA: b.respA || msg, errorA: true })),
    });
    const hB = streamCompletion({ prompt, model: fresh.modelB.id }, {
      onToken: (chunk) => setBattle(b => ({ ...b, respB: b.respB + chunk })),
      onDone: () => setBattle(b => ({ ...b, doneB: true })),
      onError: (msg) => setBattle(b => ({ ...b, doneB: true, respB: b.respB || msg, errorB: true })),
    });
    streamHandles.current.push(hA, hB);
  };
  const castVote = (v: BattleVote) => {
    setBattle(b => ({ ...b, vote: v, revealed: true }));
    // eslint-disable-next-line no-console
    console.log('[battle:vote]', { vote: v, modelA: battle.modelA.id, modelB: battle.modelB.id });
  };

  // ----- Side by Side send -----
  const startSideBySide = (prompt: string) => {
    cancelAllStreams();
    setSbs({ submitting: true, left: '', right: '', done: false });
    let lDone = false, rDone = false;
    const checkDone = () => { if (lDone && rDone) setSbs(s => ({ ...s, submitting: false, done: true })); };
    const hL = streamCompletion({ prompt, model: leftModel.id }, {
      onToken: (chunk) => setSbs(s => ({ ...s, left: s.left + chunk })),
      onDone: () => { lDone = true; checkDone(); },
      onError: (msg) => { lDone = true; setSbs(s => ({ ...s, left: s.left || msg })); checkDone(); },
    });
    const hR = streamCompletion({ prompt, model: rightModel.id }, {
      onToken: (chunk) => setSbs(s => ({ ...s, right: s.right + chunk })),
      onDone: () => { rDone = true; checkDone(); },
      onError: (msg) => { rDone = true; setSbs(s => ({ ...s, right: s.right || msg })); checkDone(); },
    });
    streamHandles.current.push(hL, hR);
  };

  // ----- Agent Mode send (streams steps + deposits artifacts) -----
  const startAgent = (task: string) => {
    setAgent({ status: 'planning', thread: [{ id: 's0', kind: 'plan', text: `Planning approach for: ${task}` }], artifacts: [] });
    setWorkspaceOpen(true);
    const steps: AgentStep[] = [
      { id: 's1', kind: 'action', text: 'Breaking the task into subtasks and selecting tools.' },
      { id: 's2', kind: 'action', text: 'Executing step 1 — gathering context.' },
      { id: 's3', kind: 'action', text: 'Executing step 2 — composing the artifact.' },
      { id: 's4', kind: 'result', text: 'Task complete. Artifacts deposited to the workspace.' },
    ];
    let i = 0;
    setTimeout(function run() {
      if (i >= steps.length) {
        setAgent(a => ({ ...a, status: 'done' }));
        return;
      }
      const step = steps[i];
      setAgent(a => ({
        ...a,
        status: i === steps.length - 1 ? 'done' : 'running',
        thread: [...a.thread, step],
        artifacts: step.kind === 'result'
          ? [...a.artifacts, { id: 'a1', name: 'summary.md', kind: 'file' }, { id: 'a2', name: 'plan.json', kind: 'data' }]
          : a.artifacts,
      }));
      i++;
      setTimeout(run, 700);
    }, 500);
  };

  const filteredScripts = promptScriptLibrary.filter(s =>
    s.name.toLowerCase().includes(scriptSearchQuery.toLowerCase()) ||
    s.description.toLowerCase().includes(scriptSearchQuery.toLowerCase())
  );

  const currentCodeSnippet =
    [...messages].reverse().find(m => m.role === 'assistant' && m.code)?.code || '';

  const buildPreviewDoc = (snippet: string) => {
    const transpileSafe = snippet.replace(/export\s+default\s+function/, 'function');
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.2/babel.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <style> html, body, #root { margin: 0; height: 100%; min-height: 100%; } #root { display: flex; flex-direction: column; } #root > * { flex: 1 1 auto; } </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="text/babel" data-presets="react">
      const { useState, useEffect, useRef } = React;
      try {
        ${transpileSafe}
        const __mount = (typeof PricingDemo !== 'undefined')
          ? PricingDemo
          : (typeof GeneratedComponent !== 'undefined' ? GeneratedComponent : null);
        if (__mount) {
          ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(__mount));
        } else {
          document.getElementById('root').innerHTML =
            '<pre style="color:#e0a542;font-family:monospace;padding:16px">No renderable component found.</pre>';
        }
      } catch (err) {
        document.getElementById('root').innerHTML =
          '<pre style="color:#e0a542;font-family:monospace;padding:16px;white-space:pre-wrap">' + String(err) + '</pre>';
      }
    </script>
  </body>
</html>`;
  };

  // Pop the live preview into a standalone browser window so the user can
  // review the rendered design on a second monitor while iterating in-app.
  const openInNewWindow = () => {
    const win = window.open('', '_blank', 'noopener,noreferrer');
    if (!win) {
      // Popup blocked — fall back to a blob URL the user can open manually.
      const blob = new Blob([buildPreviewDoc(currentCodeSnippet)], { type: 'text/html' });
      window.open(URL.createObjectURL(blob), '_blank', 'noopener,noreferrer');
      return;
    }
    win.document.open();
    win.document.write(buildPreviewDoc(currentCodeSnippet));
    win.document.close();
    win.document.title = 'Arena — Live Preview';
  };

  // shared inline-style fragments
  const grain: React.CSSProperties = {
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.025'/%3E%3C/svg%3E\")",
  };

  // ----- AUTH GATE -----
  // In live mode, gate the app behind Google sign-in. In local/demo mode this is
  // skipped entirely so the preview keeps working with seed data.
  if (live && !authReady) {
    return (
      <div className="h-screen w-screen flex items-center justify-center" style={{ background: T.bg, color: T.inkMute, fontFamily: T.mono, fontSize: 12, letterSpacing: '0.08em' }}>
        loading…
      </div>
    );
  }
  if (live && !user) {
    return <SignInScreen onSignIn={signInWithGoogle} />;
  }

  return (
    <div
      ref={containerRef}
      className="flex h-screen w-screen overflow-hidden"
      style={{ background: T.bg, color: T.ink, fontFamily: T.disp }}
    >
      {/* grain overlay for atmosphere (non-interactive) */}
      <div className="pointer-events-none fixed inset-0 z-[1] mix-blend-soft-light" style={grain} />

      {/* ============ LEFT RAIL (collapsible) ============ */}
      <div
        className="flex flex-col py-5 shrink-0 relative z-10 transition-all duration-300 ease-out overflow-hidden"
        style={{ width: railOpen ? 200 : 56, background: T.inset, borderRight: `1px solid ${T.line}` }}
      >
        <div className="flex flex-col gap-1 shrink-0" style={{ paddingLeft: railOpen ? 12 : 0, paddingRight: railOpen ? 12 : 0, alignItems: railOpen ? 'stretch' : 'center' }}>
          {/* monogram + toggle row */}
          <div className="flex items-center mb-4" style={{ justifyContent: railOpen ? 'space-between' : 'center' }}>
            <div className="flex items-center gap-2 overflow-hidden">
              <div
                className="h-9 w-9 rounded-md flex items-center justify-center shrink-0"
                style={{ background: T.signal, color: T.bg, fontFamily: T.mono, fontWeight: 700, fontSize: 15 }}
              >
                A
              </div>
              {railOpen && (
                <span className="whitespace-nowrap" style={{ fontFamily: T.mono, fontSize: 13, letterSpacing: '0.04em', color: T.ink }}>
                  arena
                </span>
              )}
            </div>
            {railOpen && (
              <button
                onClick={() => setRailOpen(false)}
                title="Collapse panel"
                className="h-7 w-7 rounded-md flex items-center justify-center transition-colors shrink-0"
                style={{ color: T.inkMute }}
                onMouseEnter={(e) => (e.currentTarget.style.color = T.ink)}
                onMouseLeave={(e) => (e.currentTarget.style.color = T.inkMute)}
              >
                <ChevronsLeft className="h-[18px] w-[18px]" />
              </button>
            )}
          </div>

          {/* collapsed-state expand button */}
          {!railOpen && (
            <RailBtn icon={<ChevronsRight className="h-[18px] w-[18px]" />} label="Expand" open={false} onClick={() => setRailOpen(true)} />
          )}

          {/* ===== NEW CHAT (prominent, top of nav) ===== */}
          <button
            onClick={newChat}
            aria-label="Start new chat"
            title="Start new chat"
            className="rounded-md flex items-center transition-colors focus:outline-none focus-visible:ring-2"
            style={{
              background: T.signalDim,
              border: `1px solid ${T.signalLin}`,
              color: T.signal,
              height: 38, gap: 8, marginBottom: 4,
              justifyContent: railOpen ? 'flex-start' : 'center',
              paddingLeft: railOpen ? 9 : 0, paddingRight: railOpen ? 9 : 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(224,165,66,0.18)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = T.signalDim)}
          >
            <span className="shrink-0 flex items-center justify-center" style={{ width: 18 }}>
              <MessageSquarePlus className="h-[18px] w-[18px]" />
            </span>
            {railOpen && <span style={{ fontFamily: T.disp, fontSize: 13, fontWeight: 600 }}>New Chat</span>}
          </button>

          {/* ===== MODE SELECTOR ===== */}
          <div className="relative" style={{ marginBottom: 4 }}>
            <button
              onClick={() => { if (!modeLocked) setModeMenuOpen(o => !o); }}
              disabled={modeLocked}
              aria-haspopup="listbox"
              aria-expanded={modeMenuOpen}
              aria-label={modeLocked ? `Mode locked: ${MODES.find(m => m.id === mode)?.label}` : 'Select interaction mode'}
              title={modeLocked ? 'Mode is locked for this session' : 'Select interaction mode'}
              className="w-full rounded-md flex items-center transition-colors focus:outline-none focus-visible:ring-2"
              style={{
                background: T.surfaceHi,
                border: `1px solid ${modeMenuOpen ? T.signalLin : T.line}`,
                color: T.ink,
                height: 38,
                gap: 8,
                justifyContent: railOpen ? 'flex-start' : 'center',
                paddingLeft: railOpen ? 9 : 0,
                paddingRight: railOpen ? 9 : 0,
                cursor: modeLocked ? 'default' : 'pointer',
                opacity: modeLocked ? 0.85 : 1,
              }}
            >
              <span className="shrink-0 flex items-center justify-center" style={{ width: 18, color: T.signal }}>
                {modeIcon(mode)}
              </span>
              {railOpen && (
                <>
                  <span className="flex-1 text-left whitespace-nowrap overflow-hidden" style={{ fontFamily: T.disp, fontSize: 13, textOverflow: 'ellipsis' }}>
                    {MODES.find(m => m.id === mode)?.label}
                  </span>
                  {modeLocked
                    ? <Lock className="h-3.5 w-3.5 shrink-0" style={{ color: T.inkMute }} />
                    : <ChevronDown className="h-4 w-4 shrink-0" style={{ color: T.inkMute, transform: modeMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                  }
                </>
              )}
            </button>

            {/* dropdown list */}
            {modeMenuOpen && !modeLocked && (
              <div
                role="listbox"
                className="absolute z-50 rounded-lg overflow-hidden"
                style={{
                  top: railOpen ? 42 : 0,
                  left: railOpen ? 0 : 52,
                  width: railOpen ? '100%' : 240,
                  background: T.surface,
                  border: `1px solid ${T.lineHi}`,
                  boxShadow: '0 16px 40px -12px rgba(0,0,0,0.7)',
                }}
              >
                {MODES.map(m => {
                  const isActive = m.id === mode;
                  return (
                    <button
                      key={m.id}
                      role="option"
                      aria-selected={isActive}
                      onClick={() => selectMode(m.id)}
                      className="w-full text-left flex items-center gap-2.5 px-2.5 py-2 transition-colors"
                      style={{ background: isActive ? T.signalDim : 'transparent' }}
                      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = T.surfaceHi; }}
                      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = isActive ? T.signalDim : 'transparent'; }}
                    >
                      <span className="shrink-0 flex items-center justify-center" style={{ width: 18, color: isActive ? T.signal : T.inkSoft }}>
                        {modeIcon(m.id)}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2">
                          <span style={{ fontFamily: T.disp, fontSize: 13, color: T.ink }}>{m.label}</span>
                          {!m.built && (
                            <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: '0.08em', color: T.inkMute, border: `1px solid ${T.line}`, borderRadius: 3, padding: '1px 4px' }}>
                              SOON
                            </span>
                          )}
                        </span>
                        <span className="block truncate" style={{ fontFamily: T.disp, fontSize: 11, color: T.inkMute, marginTop: 1 }}>{m.blurb}</span>
                      </span>
                      {isActive && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: T.signal }} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* New session — unlocks mode selection */}
          {modeLocked && (
            <RailBtn icon={<Plus className="h-[18px] w-[18px]" />} label="New session" open={railOpen} onClick={newSession} />
          )}

          <div className="my-1" style={{ height: 1, background: T.line, marginLeft: railOpen ? 0 : 8, marginRight: railOpen ? 0 : 8 }} />

          {/* Projects row with create-project "+" */}
          <div
            className="group/proj rounded-md flex items-center transition-colors"
            style={{
              height: 36, gap: 10,
              paddingLeft: railOpen ? 9 : 0, paddingRight: railOpen ? 6 : 0,
              justifyContent: railOpen ? 'flex-start' : 'center',
              color: T.inkMute, cursor: 'pointer',
            }}
            role="button"
            tabIndex={0}
            aria-label="Projects"
            title={!railOpen ? 'Projects' : undefined}
            onClick={() => setActiveProject(null)}
            onMouseEnter={(e) => (e.currentTarget.style.background = T.surfaceHi)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span className="shrink-0 flex items-center justify-center" style={{ width: 18 }}>
              <Folder className="h-[18px] w-[18px]" />
            </span>
            {railOpen && (
              <>
                <span className="flex-1" style={{ fontFamily: T.disp, fontSize: 13 }}>Projects</span>
                <button
                  onClick={(e) => { e.stopPropagation(); setCreateProjectOpen(true); }}
                  aria-label="Create new project"
                  title="Create new project"
                  className="shrink-0 h-6 w-6 rounded flex items-center justify-center transition-colors"
                  style={{ color: T.inkMute }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = T.signal; e.currentTarget.style.background = T.signalDim; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = T.inkMute; e.currentTarget.style.background = 'transparent'; }}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
          <RailBtn icon={<SlidersHorizontal className="h-[18px] w-[18px]" />} label="Settings" open={railOpen} />
          <RailBtn icon={<SquareTerminal className="h-[18px] w-[18px]" />} label="Console" open={railOpen} />
          <RailBtn icon={<SearchIcon className="h-[18px] w-[18px]" />} label="Search" open={railOpen} onClick={() => setSearchOpen(true)} />
        </div>

        {/* divider below Search (presentational) */}
        <div role="separator" style={{ height: 1, background: T.line, margin: railOpen ? '8px 12px' : '8px' }} />

        {/* ===== PINNED PROJECTS (own scroll region) ===== */}
        <div
          className="overflow-y-auto shrink-0"
          style={{ paddingLeft: railOpen ? 12 : 0, paddingRight: railOpen ? 12 : 0, maxHeight: '38%' }}
        >
          {railOpen && (
            <div className="px-1 mb-1.5" style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.12em', color: T.inkMute }}>
              PINNED PROJECTS
            </div>
          )}
          {pinnedProjects.length === 0 ? (
            railOpen && (
              <div className="px-1 py-1.5" style={{ fontFamily: T.disp, fontSize: 12, lineHeight: 1.5, color: T.inkMute }}>
                No pinned projects. Pin one from its menu to keep it here.
              </div>
            )
          ) : (
            <div className="flex flex-col gap-0.5">
              {pinnedProjects.map(p => {
                const isActive = activeProject === p.id;
                return (
                  <div
                    key={p.id}
                    className="group/pin relative rounded-md flex items-center transition-colors"
                    style={{
                      height: 34, gap: 8,
                      paddingLeft: railOpen ? 8 : 0, paddingRight: railOpen ? 4 : 0,
                      justifyContent: railOpen ? 'flex-start' : 'center',
                      background: isActive ? T.signalDim : 'transparent',
                      border: `1px solid ${isActive ? T.signalLin : 'transparent'}`,
                      cursor: 'pointer',
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open project ${p.name}`}
                    aria-current={isActive ? 'true' : undefined}
                    title={!railOpen ? p.name : undefined}
                    onClick={() => setActiveProject(p.id)}
                    onContextMenu={(e) => { e.preventDefault(); setProjMenu({ id: p.id, x: e.clientX, y: e.clientY }); }}
                    onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = T.surfaceHi; }}
                    onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span className="shrink-0 h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
                    {railOpen && (
                      <>
                        <span className="flex-1 truncate" style={{ fontFamily: T.disp, fontSize: 13, color: isActive ? T.ink : T.inkSoft }}>{p.name}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setProjMenu({ id: p.id, x: r.left, y: r.bottom + 4 }); }}
                          className="shrink-0 h-6 w-6 rounded flex items-center justify-center opacity-0 group-hover/pin:opacity-100 transition-opacity"
                          style={{ color: T.inkMute }}
                          aria-label={`Actions for ${p.name}`}
                          title="Project actions"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* second divider below Pinned Projects (presentational) */}
        <div role="separator" style={{ height: 1, background: T.line, margin: railOpen ? '8px 12px' : '8px' }} />

        {/* ungrouped items — scrolls in its own region so account stays pinned */}
        <div
          className="flex-1 min-h-0 overflow-y-auto"
          style={{ paddingLeft: railOpen ? 12 : 0, paddingRight: railOpen ? 12 : 0 }}
        >
          {railOpen && (
            <div className="px-1 mb-1.5" style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.12em', color: T.inkMute }}>
              UNGROUPED
            </div>
          )}
          {ungrouped.length === 0 ? (
            railOpen && (
              <div className="px-1 py-2" style={{ fontFamily: T.disp, fontSize: 12, lineHeight: 1.5, color: T.inkMute }}>
                Nothing loose here — items not in a project will show up in this spot.
              </div>
            )
          ) : (
            <div className="flex flex-col gap-0.5">
              {ungrouped.map(item => (
                <div
                  key={item.id}
                  className="group/ung relative rounded-md flex items-center transition-colors"
                  style={{
                    height: 34, gap: 8,
                    paddingLeft: railOpen ? 8 : 0, paddingRight: railOpen ? 4 : 0,
                    justifyContent: railOpen ? 'flex-start' : 'center',
                    cursor: 'pointer',
                  }}
                  title={!railOpen ? item.title : undefined}
                  onClick={() => {/* reopen item — wire to session loader */}}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ id: item.id, x: e.clientX, y: e.clientY }); }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = T.surfaceHi)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  role="button"
                  tabIndex={0}
                  aria-label={`${item.title}, ${item.type}, ${relTime(item.modified)}. Right-click to add to a project.`}
                >
                  <span className="shrink-0 flex items-center justify-center" style={{ width: 18, color: T.inkMute }}>
                    {itemTypeIcon(item.type)}
                  </span>
                  {railOpen && (
                    <>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate" style={{ fontFamily: T.disp, fontSize: 13, color: T.inkSoft }}>{item.title}</span>
                        <span className="block" style={{ fontFamily: T.mono, fontSize: 9.5, color: T.inkFaint }}>{relTime(item.modified)}</span>
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCtxMenu({ id: item.id, x: r.left, y: r.bottom + 4 }); }}
                        className="shrink-0 h-6 w-6 rounded flex items-center justify-center opacity-0 group-hover/ung:opacity-100 transition-opacity"
                        style={{ color: T.inkMute }}
                        aria-label={`Add "${item.title}" to a project`}
                        title="Add to project"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-2" style={{ paddingLeft: railOpen ? 12 : 0, paddingRight: railOpen ? 12 : 0, display: 'flex', justifyContent: railOpen ? 'flex-start' : 'center' }}>
          {live && user ? (
            <button
              onClick={() => { void signOut(); }}
              className="h-7 rounded-md flex items-center text-[11px] cursor-pointer transition-colors gap-2 px-1.5"
              style={{ background: T.surfaceHi, border: `1px solid ${T.line}`, color: T.inkSoft, fontFamily: T.mono, width: railOpen ? '100%' : 28, justifyContent: railOpen ? 'flex-start' : 'center' }}
              title={`Signed in as ${user.email ?? user.name ?? 'user'} — click to sign out`}
              aria-label="Sign out"
            >
              {user.avatarUrl
                ? <img src={user.avatarUrl} alt="" className="h-5 w-5 rounded-full shrink-0" />
                : <span className="h-5 w-5 rounded-full shrink-0 flex items-center justify-center" style={{ background: T.signalDim, color: T.signal, fontSize: 10 }}>{(user.name ?? user.email ?? 'U').slice(0, 1).toUpperCase()}</span>}
              {railOpen && <span className="truncate flex-1 text-left" style={{ color: T.inkSoft }}>{user.name ?? user.email}</span>}
              {railOpen && <LogOut className="h-3.5 w-3.5 shrink-0" style={{ color: T.inkMute }} />}
            </button>
          ) : (
            <div
              className="h-7 rounded-md flex items-center justify-center text-[11px] transition-colors gap-2"
              style={{ background: T.surfaceHi, border: `1px solid ${T.line}`, color: T.inkSoft, fontFamily: T.mono, width: railOpen ? '100%' : 28 }}
            >
              AI{railOpen && <span style={{ color: T.inkMute }}>account</span>}
            </div>
          )}
        </div>
      </div>

      {/* ============ WORKSPACE (mode-gated) ============ */}
      {mode === 'direct' ? (
      <>
      {/* ============ LEFT PANEL: CHAT + COMPOSER ============ */}
      <div
        style={{ width: `${splitWidth}%`, background: T.surface }}
        className="flex flex-col h-full relative min-w-[340px] z-10 overflow-hidden"
      >
        {/* header */}
        <div
          className="h-12 px-5 flex items-center justify-between shrink-0"
          style={{ borderBottom: `1px solid ${T.line}` }}
        >
          <div className="flex items-center gap-3">
            <span style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: '0.08em', color: T.inkSoft }}>
              ENGINE
            </span>
            <span
              className="flex items-center gap-1.5 px-2 py-[3px] rounded"
              style={{ background: T.signalDim, border: `1px solid ${T.signalLin}`, fontFamily: T.mono, fontSize: 11, color: T.signal }}
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full animate-ping" style={{ background: T.signal, opacity: 0.6 }} />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: T.signal }} />
              </span>
              ollama · llama-3
            </span>
          </div>
          <div className="flex items-center gap-3" style={{ fontFamily: T.mono, fontSize: 11, color: T.inkMute }}>
            <span>14<span style={{ color: T.inkFaint }}>ms</span></span>
            <span style={{ color: T.read }}>62<span style={{ color: T.inkFaint }}> t/s</span></span>
          </div>
        </div>

        {/* message thread */}
        <div className="flex-1 overflow-y-auto px-5 py-6 flex flex-col gap-6 min-h-0 min-w-0">
          {messages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
              <Sparkles className="h-8 w-8 mb-4" style={{ color: T.signal }} />
              <h2 style={{ fontFamily: T.disp, fontSize: 22, fontWeight: 600, color: T.ink, marginBottom: 6 }}>Direct</h2>
              <p style={{ fontFamily: T.disp, fontSize: 14, color: T.inkSoft, maxWidth: 420 }}>
                Chat with one model. Type a prompt below to begin — responses stream in live and render in the workspace on the right.
              </p>
            </div>
          ) : messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col gap-2 min-w-0 ${msg.code ? 'flex-1 min-h-0' : ''}`}>
              {/* role label */}
              <div className="flex items-center gap-2">
                <span
                  style={{
                    fontFamily: T.mono, fontSize: 10, letterSpacing: '0.12em',
                    color: msg.role === 'user' ? T.inkMute : msg.error ? '#d98a7a' : T.signal,
                  }}
                >
                  {msg.role === 'user' ? 'USER' : msg.error ? 'ERROR' : 'ASSISTANT'}
                </span>
                <span className="flex-1 h-px" style={{ background: T.line }} />
                {msg.streaming && <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.signal }}>streaming…</span>}
              </div>

              {/* body */}
              <p style={{ fontSize: 14, lineHeight: 1.65, color: msg.error ? '#d98a7a' : msg.role === 'user' ? T.ink : T.inkSoft, whiteSpace: 'pre-wrap' }}>
                {msg.text}{msg.streaming && <span style={{ color: T.signal }}>▋</span>}
              </p>

              {/* retry on error */}
              {msg.error && (
                <button
                  onClick={retryDirect}
                  className="self-start mt-1 h-7 px-3 rounded-md flex items-center gap-1.5 transition-colors"
                  style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft, background: T.surfaceHi, border: `1px solid ${T.line}` }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = T.ink; e.currentTarget.style.borderColor = T.lineHi; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = T.inkSoft; e.currentTarget.style.borderColor = T.line; }}
                >
                  <RotateCw className="h-3.5 w-3.5" /> retry
                </button>
              )}

              {/* code block */}
              {msg.code && (
                <div className="rounded-lg overflow-hidden mt-1 flex flex-col flex-1 min-h-0 min-w-0 w-full" style={{ border: `1px solid ${T.line}`, background: T.inset }}>
                  <div
                    className="flex items-center justify-between px-3 h-9 shrink-0"
                    style={{ borderBottom: `1px solid ${T.line}`, background: T.surface }}
                  >
                    <span className="flex items-center gap-1.5" style={{ fontFamily: T.mono, fontSize: 11, color: T.inkMute }}>
                      <Code2 className="h-3.5 w-3.5" /> GeneratedComponent.jsx
                    </span>
                    <button
                      onClick={() => handleCopy(msg.code || '')}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:brightness-125"
                      style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft }}
                    >
                      {copied ? <Check className="h-3 w-3" style={{ color: T.read }} /> : <Copy className="h-3 w-3" />}
                      {copied ? 'copied' : 'copy'}
                    </button>
                  </div>
                  <pre className="p-3 overflow-y-auto flex-1 min-h-0" style={{ fontFamily: T.mono, fontSize: 11.5, lineHeight: 1.6, color: T.inkSoft, width: '100%', maxWidth: '100%', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                    <code style={{ display: 'block', width: '100%' }}>{msg.code}</code>
                  </pre>
                </div>
              )}
            </div>
          ))}
          <div ref={threadEndRef} />
        </div>

        {/* ============ COMPOSER ============ */}
        <div className="px-4 pb-4 pt-2 shrink-0" style={{ borderTop: `1px solid ${T.line}` }}>
          {/* context chips */}
          {(attachedFiles.length > 0 || activeScripts.length > 0) && (
            <div className="flex flex-wrap gap-1.5 mb-2.5">
              {attachedFiles.map(file => (
                <span
                  key={file.id}
                  className="flex items-center gap-1.5 px-2 py-1 rounded"
                  style={{ background: T.surfaceHi, border: `1px solid ${T.line}`, fontFamily: T.mono, fontSize: 11, color: T.inkSoft }}
                >
                  <Paperclip className="h-3 w-3" style={{ color: T.inkMute }} />
                  {file.name}
                  <button onClick={() => setAttachedFiles(prev => prev.filter(f => f.id !== file.id))} className="ml-0.5 transition-colors hover:brightness-150" style={{ color: T.inkMute }}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {activeScripts.map(script => (
                <span
                  key={script.id}
                  className="flex items-center gap-1.5 px-2 py-1 rounded"
                  style={{ background: T.signalDim, border: `1px solid ${T.signalLin}`, fontFamily: T.mono, fontSize: 11, color: T.signal }}
                >
                  <SquareTerminal className="h-3 w-3" />
                  {script.name}
                  <button onClick={() => setActiveScripts(prev => prev.filter(s => s.id !== script.id))} className="ml-0.5 transition-opacity hover:opacity-70" style={{ color: T.signal }}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* input well */}
          <div
            className="relative rounded-lg transition-colors"
            style={{ background: T.inset, border: `1px solid ${T.line}` }}
            onFocusCapture={(e) => (e.currentTarget.style.borderColor = T.signalLin)}
            onBlurCapture={(e) => (e.currentTarget.style.borderColor = T.line)}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Describe a component, or refine the current build…"
              className="w-full bg-transparent resize-none focus:outline-none p-3.5 pb-12"
              style={{ fontFamily: T.disp, fontSize: 14, lineHeight: 1.6, color: T.ink, height: 108 }}
            />

            {/* actions bar */}
            <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between">
              <div className="flex items-center gap-0.5">
                <ToolBtn title="Attach file context" onClick={handleAddFileMock}>
                  <Paperclip className="h-4 w-4" />
                </ToolBtn>

                <span className="h-5 w-px mx-1" style={{ background: T.line }} />

                {/* single-select capability group: exactly one active, all full-opacity */}
                <div role="radiogroup" aria-label="Capability" className="flex items-center gap-0.5">
                  <CapBtn id="auto"   label="Auto"   active={capability === 'auto'}   onClick={() => selectCapability('auto')}   icon={<Zap className="h-3.5 w-3.5" />} />
                  <CapBtn id="code"   label="Code"   active={capability === 'code'}   onClick={() => selectCapability('code')}   icon={<Code2 className="h-3.5 w-3.5" />} />
                  <CapBtn id="search" label="Search" active={capability === 'search'} onClick={() => selectCapability('search')} icon={<Globe className="h-3.5 w-3.5" />} />
                  <CapBtn id="image"  label="Image"  active={capability === 'image'}  onClick={() => selectCapability('image')}  icon={<ImageIcon className="h-3.5 w-3.5" />} />
                  <CapBtn id="video"  label="Video"  active={capability === 'video'}  onClick={() => selectCapability('video')}  icon={<Video className="h-3.5 w-3.5" />} />
                </div>

                <span className="h-5 w-px mx-1" style={{ background: T.line }} />

                {/* script macro popover */}
                <div className="relative">
                  <ToolBtn title="Inject prompt-script macro" armed={showScriptPopover} onClick={() => setShowScriptPopover(!showScriptPopover)}>
                    <SquareTerminal className="h-4 w-4" />
                  </ToolBtn>
                  {showScriptPopover && (
                    <div
                      className="absolute bottom-full mb-2 left-0 w-72 rounded-lg overflow-hidden z-50"
                      style={{ background: T.surface, border: `1px solid ${T.lineHi}`, boxShadow: '0 16px 40px -12px rgba(0,0,0,0.7)' }}
                    >
                      <div className="flex items-center gap-2 px-3 h-9" style={{ borderBottom: `1px solid ${T.line}` }}>
                        <SearchIcon className="h-3.5 w-3.5 shrink-0" style={{ color: T.inkMute }} />
                        <input
                          type="text"
                          value={scriptSearchQuery}
                          onChange={(e) => setScriptSearchQuery(e.target.value)}
                          placeholder="search macros…"
                          className="bg-transparent focus:outline-none w-full"
                          style={{ fontFamily: T.mono, fontSize: 12, color: T.ink }}
                        />
                      </div>
                      <div className="max-h-60 overflow-y-auto p-1">
                        {filteredScripts.length > 0 ? (
                          filteredScripts.map(script => (
                            <button
                              key={script.id}
                              onClick={() => handleSelectScript(script)}
                              className="w-full text-left p-2 rounded-md transition-colors group"
                              style={{ background: 'transparent' }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = T.surfaceHi)}
                              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                            >
                              <div className="flex items-center justify-between">
                                <span style={{ fontSize: 13, color: T.ink }}>{script.name}</span>
                                <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.1em', color: T.inkMute }}>{script.category}</span>
                              </div>
                              <p style={{ fontSize: 11.5, lineHeight: 1.4, color: T.inkMute, marginTop: 2 }}>{script.description}</p>
                            </button>
                          ))
                        ) : (
                          <div className="px-2 py-4 text-center" style={{ fontFamily: T.mono, fontSize: 11, color: T.inkMute }}>
                            no macros found
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* token meter + submit/stop */}
              <div className="flex items-center gap-2">
                <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', color: T.inkMute }}>8K CTX</span>
                {directStatus === 'streaming' ? (
                  <button
                    onClick={stopDirect}
                    aria-label="Stop generating"
                    className="h-7 w-7 rounded-md flex items-center justify-center transition-transform active:scale-90 focus:outline-none focus-visible:ring-2"
                    style={{ background: T.surfaceHi, color: T.ink, border: `1px solid ${T.lineHi}` }}
                    title="Stop"
                  >
                    <Square className="h-3 w-3" fill={T.ink} />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!input.trim()}
                    aria-label="Send message"
                    className="h-7 w-7 rounded-md flex items-center justify-center transition-transform active:scale-90 focus:outline-none focus-visible:ring-2"
                    style={{ background: T.signal, color: T.bg, opacity: input.trim() ? 1 : 0.4, cursor: input.trim() ? 'pointer' : 'not-allowed' }}
                    title="Send"
                  >
                    <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ============ RESIZER ============ */}
      <div
        onMouseDown={startResize}
        className="w-px cursor-col-resize flex items-center justify-center relative z-20 group shrink-0"
        style={{ background: T.line }}
      >
        <div className="absolute inset-y-0 -left-1 -right-1" />
        <div className="h-6 w-px transition-colors group-hover:h-10" style={{ background: T.lineHi }} />
      </div>

      {/* ============ RIGHT PANEL: PREVIEW / SOURCE ============ */}
      <div style={{ width: `${100 - splitWidth}%`, background: T.bg }} className="flex flex-col h-full min-w-[340px] relative z-10">
        {/* header */}
        <div className="h-12 px-3 flex items-center justify-between shrink-0" style={{ borderBottom: `1px solid ${T.line}` }}>
          <div className="flex items-center gap-0.5 p-0.5 rounded-md" style={{ background: T.inset, border: `1px solid ${T.line}` }}>
            <SegBtn active={activeTab === 'preview'} onClick={() => setActiveTab('preview')}>preview</SegBtn>
            <SegBtn active={activeTab === 'code'} onClick={() => setActiveTab('code')}>source</SegBtn>
          </div>

          {activeTab === 'preview' && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-0.5">
                <VpBtn active={viewport === 'desktop'} onClick={() => setViewport('desktop')}><Monitor className="h-4 w-4" /></VpBtn>
                <VpBtn active={viewport === 'tablet'} onClick={() => setViewport('tablet')}><Tablet className="h-4 w-4" /></VpBtn>
                <VpBtn active={viewport === 'mobile'} onClick={() => setViewport('mobile')}><Smartphone className="h-4 w-4" /></VpBtn>
              </div>
              <span className="h-4 w-px" style={{ background: T.line }} />
              <button
                onClick={openInNewWindow}
                title="Open preview in new window"
                className="flex items-center gap-1.5 h-7 px-2.5 rounded-md transition-colors"
                style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft, border: `1px solid ${T.line}`, background: T.inset }}
                onMouseEnter={(e) => { e.currentTarget.style.color = T.ink; e.currentTarget.style.borderColor = T.lineHi; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = T.inkSoft; e.currentTarget.style.borderColor = T.line; }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                open
              </button>
            </div>
          )}
        </div>

        {/* body */}
        <div
          className="flex-1 overflow-hidden flex items-center justify-center"
          style={{ padding: viewport === 'desktop' ? 0 : 24 }}
        >
          {activeTab === 'preview' ? (
            viewport === 'desktop' ? (
              // Desktop: fill the panel completely, like a real webpage.
              <iframe
                title="Live Preview"
                className="w-full h-full bg-white"
                sandbox="allow-scripts"
                srcDoc={buildPreviewDoc(currentCodeSnippet)}
              />
            ) : (
              // Tablet / mobile: centered device frame with browser chrome.
              <div
                className="transition-all duration-300 rounded-lg overflow-hidden flex flex-col"
                style={{
                  border: `1px solid ${T.line}`,
                  boxShadow: '0 24px 60px -20px rgba(0,0,0,0.8)',
                  width: viewport === 'tablet' ? 640 : 360,
                  height: viewport === 'tablet' ? 800 : 640,
                  maxHeight: '100%',
                }}
              >
                <div className="h-8 shrink-0 flex items-center px-3 gap-2" style={{ borderBottom: `1px solid ${T.line}`, background: T.surface }}>
                  <div className="flex gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: T.lineHi }} />
                    <span className="h-2 w-2 rounded-full" style={{ background: T.lineHi }} />
                    <span className="h-2 w-2 rounded-full" style={{ background: T.lineHi }} />
                  </div>
                  <div className="flex-1 mx-2 h-5 rounded flex items-center px-2" style={{ background: T.inset, border: `1px solid ${T.line}` }}>
                    <span style={{ fontFamily: T.mono, fontSize: 10, color: T.inkMute }}>localhost:3000</span>
                  </div>
                </div>
                <iframe
                  title="Live Preview"
                  className="flex-1 w-full bg-white"
                  sandbox="allow-scripts"
                  srcDoc={buildPreviewDoc(currentCodeSnippet)}
                />
              </div>
            )
          ) : (
            <div className="w-full rounded-lg overflow-hidden flex flex-col" style={{ border: `1px solid ${T.line}`, background: T.inset, maxWidth: '56rem', height: 'calc(100% - 48px)', margin: 24 }}>
              <div className="flex items-center justify-between px-3 h-9 shrink-0" style={{ borderBottom: `1px solid ${T.line}`, background: T.surface }}>
                <span className="flex items-center gap-1.5" style={{ fontFamily: T.mono, fontSize: 11, color: T.inkMute }}>
                  <Code2 className="h-3.5 w-3.5" /> GeneratedComponent.jsx
                </span>
                <button
                  onClick={() => handleCopy(currentCodeSnippet)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:brightness-125"
                  style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft }}
                >
                  {copied ? <Check className="h-3 w-3" style={{ color: T.read }} /> : <Copy className="h-3 w-3" />}
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
              <div className="flex-1 overflow-auto">
                <pre style={{ fontFamily: T.mono, fontSize: 12, lineHeight: 1.65 }}>
                  {currentCodeSnippet.split('\n').map((line, idx) => (
                    <div key={idx} className="flex" style={{ padding: 0 }}>
                      <span className="select-none text-right pr-4 pl-4 shrink-0" style={{ width: 52, color: T.inkFaint }}>{idx + 1}</span>
                      <span className="whitespace-pre pr-4" style={{ color: T.inkSoft }}>{line}</span>
                    </div>
                  ))}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
      </>
      ) : mode === 'battle' ? (
        <BattleMode
          battle={battle} input={input} setInput={setInput} onSend={handleSend} onVote={castVote}
          capability={capability} selectCapability={selectCapability}
        />
      ) : mode === 'sidebyside' ? (
        <SideBySideMode
          leftModel={leftModel} rightModel={rightModel} sbs={sbs}
          input={input} setInput={setInput} onSend={handleSend}
          capability={capability} selectCapability={selectCapability}
          picker={picker} setPicker={setPicker}
          onPick={(side, m) => { if (side === 'left') setLeftModel(m); else setRightModel(m); setPicker(null); }}
        />
      ) : mode === 'agent' ? (
        <AgentMode
          agent={agent} input={input} setInput={setInput} onSend={handleSend}
          workspaceOpen={workspaceOpen} setWorkspaceOpen={setWorkspaceOpen}
          onAttach={handleAddFileMock} attachedFiles={attachedFiles} setAttachedFiles={setAttachedFiles}
        />
      ) : (
        <ComingSoon mode={mode} onPickAnother={() => setModeMenuOpen(true)} />
      )}

      {/* context menu: add ungrouped item to a project */}
      {ctxMenu && (
        <div
          className="fixed z-[100] rounded-lg overflow-hidden py-1"
          style={{ top: ctxMenu.y, left: ctxMenu.x, width: 200, background: T.surface, border: `1px solid ${T.lineHi}`, boxShadow: '0 16px 40px -12px rgba(0,0,0,0.7)' }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <div className="px-3 py-1.5 flex items-center gap-1.5" style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.1em', color: T.inkMute, borderBottom: `1px solid ${T.line}` }}>
            <FolderPlus className="h-3 w-3" /> ADD TO PROJECT
          </div>
          {projects.map(p => (
            <button
              key={p.id}
              role="menuitem"
              onClick={() => moveToProject(ctxMenu.id, p.id)}
              className="w-full text-left flex items-center gap-2 px-3 py-1.5 transition-colors"
              style={{ fontFamily: T.disp, fontSize: 13, color: T.inkSoft, background: 'transparent' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = T.surfaceHi; e.currentTarget.style.color = T.ink; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.inkSoft; }}
            >
              <span className="shrink-0 h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* project overflow menu: rename / recolor / pin / delete */}
      {projMenu && (() => {
        const p = projects.find(x => x.id === projMenu.id);
        if (!p) return null;
        return (
          <div
            className="fixed z-[100] rounded-lg overflow-hidden py-1"
            style={{ top: projMenu.y, left: projMenu.x, width: 200, background: T.surface, border: `1px solid ${T.lineHi}`, boxShadow: '0 16px 40px -12px rgba(0,0,0,0.7)' }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
          >
            <MenuRow icon={<Pencil className="h-3.5 w-3.5" />} label="Rename" onClick={() => { setRenamingProject(p); setProjMenu(null); }} />
            <div className="px-3 py-1.5">
              <div className="flex items-center gap-1.5 mb-1.5" style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.1em', color: T.inkMute }}>
                <Palette className="h-3 w-3" /> COLOR
              </div>
              <div className="flex gap-1.5">
                {PROJECT_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => recolorProject(p.id, c)}
                    aria-label={`Set color ${c}`}
                    className="h-5 w-5 rounded-md transition-transform hover:scale-110"
                    style={{ background: c, border: `2px solid ${p.color === c ? T.ink : 'transparent'}` }}
                  />
                ))}
              </div>
            </div>
            <div style={{ height: 1, background: T.line, margin: '4px 0' }} />
            <MenuRow icon={p.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />} label={p.pinned ? 'Unpin' : 'Pin'} onClick={() => togglePin(p.id)} />
            <MenuRow icon={<Trash2 className="h-3.5 w-3.5" />} label="Delete" danger onClick={() => { setConfirmDelete(p); setProjMenu(null); }} />
          </div>
        );
      })()}

      {/* create-project modal */}
      {createProjectOpen && (
        <ProjectModal
          title="New project"
          confirmLabel="Create project"
          onCancel={() => setCreateProjectOpen(false)}
          onConfirm={(name, desc, color) => createProject(name, desc, color)}
        />
      )}

      {/* rename-project modal */}
      {renamingProject && (
        <ProjectModal
          title="Rename project"
          confirmLabel="Save"
          initialName={renamingProject.name}
          initialColor={renamingProject.color}
          nameOnly
          onCancel={() => setRenamingProject(null)}
          onConfirm={(name) => renameProject(renamingProject.id, name)}
        />
      )}

      {/* delete confirmation */}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${confirmDelete.name}"?`}
          body="This permanently deletes the project. Items inside it are not deleted — they become ungrouped. This cannot be undone."
          confirmLabel="Delete project"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => deleteProject(confirmDelete.id)}
        />
      )}

      {/* advanced search overlay */}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
    </div>
  );
}

/* ============ SUB-COMPONENTS (instrument-panel primitives) ============ */

// A single row inside a context/overflow menu.
function MenuRow({ icon, label, danger = false, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  const base = danger ? '#d98a7a' : T.inkSoft;
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full text-left flex items-center gap-2 px-3 py-1.5 transition-colors"
      style={{ fontFamily: T.disp, fontSize: 13, color: base, background: 'transparent' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = T.surfaceHi; e.currentTarget.style.color = danger ? '#e8a193' : T.ink; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = base; }}
    >
      <span className="shrink-0 flex items-center justify-center" style={{ width: 16, color: 'inherit' }}>{icon}</span>
      {label}
    </button>
  );
}

// Create / rename project modal. Prompts for name, optional description + color.
function ProjectModal({
  title, confirmLabel, initialName = '', initialColor = PROJECT_COLORS[0], nameOnly = false,
  onCancel, onConfirm,
}: {
  title: string; confirmLabel: string; initialName?: string; initialColor?: string; nameOnly?: boolean;
  onCancel: () => void; onConfirm: (name: string, description: string, color: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [desc, setDesc] = useState('');
  const [color, setColor] = useState(initialColor);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canSave = name.trim().length > 0;
  const submit = () => { if (canSave) onConfirm(name.trim(), desc.trim(), color); };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-start justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', paddingTop: '14vh' }}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="rounded-xl overflow-hidden"
        style={{ width: 'min(440px, 92vw)', background: T.surface, border: `1px solid ${T.lineHi}`, boxShadow: '0 32px 80px -24px rgba(0,0,0,0.85)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-1" style={{ fontFamily: T.disp, fontSize: 18, fontWeight: 600, color: T.ink }}>{title}</div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', color: T.inkMute }}>NAME</span>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="e.g. Client Portal"
              className="rounded-md px-3 h-10 focus:outline-none focus-visible:ring-2"
              style={{ fontFamily: T.disp, fontSize: 14, color: T.ink, background: T.inset, border: `1px solid ${T.line}` }}
            />
          </label>

          {!nameOnly && (
            <label className="flex flex-col gap-1.5">
              <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', color: T.inkMute }}>DESCRIPTION <span style={{ color: T.inkFaint }}>· optional</span></span>
              <input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder="A short line about this project"
                className="rounded-md px-3 h-10 focus:outline-none focus-visible:ring-2"
                style={{ fontFamily: T.disp, fontSize: 14, color: T.ink, background: T.inset, border: `1px solid ${T.line}` }}
              />
            </label>
          )}

          <div className="flex flex-col gap-1.5">
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', color: T.inkMute }}>COLOR</span>
            <div className="flex gap-2">
              {PROJECT_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  className="h-7 w-7 rounded-md transition-transform hover:scale-110"
                  style={{ background: c, border: `2px solid ${color === c ? T.ink : 'transparent'}` }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 flex items-center justify-end gap-2" style={{ borderTop: `1px solid ${T.line}` }}>
          <button
            onClick={onCancel}
            className="h-9 px-4 rounded-md transition-colors"
            style={{ fontFamily: T.mono, fontSize: 12, color: T.inkSoft, background: 'transparent', border: `1px solid ${T.line}` }}
          >
            cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSave}
            className="h-9 px-4 rounded-md transition-opacity"
            style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.bg, background: T.signal, opacity: canSave ? 1 : 0.4, cursor: canSave ? 'pointer' : 'not-allowed' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Generic destructive-action confirmation.
function ConfirmDialog({
  title, body, confirmLabel, onCancel, onConfirm,
}: { title: string; body: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div
      className="fixed inset-0 z-[95] flex items-start justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', paddingTop: '16vh' }}
      onClick={onCancel}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="rounded-xl overflow-hidden"
        style={{ width: 'min(420px, 92vw)', background: T.surface, border: `1px solid ${T.lineHi}`, boxShadow: '0 32px 80px -24px rgba(0,0,0,0.85)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-2" style={{ fontFamily: T.disp, fontSize: 17, fontWeight: 600, color: T.ink }}>{title}</div>
        <div className="px-5 pb-4" style={{ fontFamily: T.disp, fontSize: 13.5, lineHeight: 1.6, color: T.inkSoft }}>{body}</div>
        <div className="px-5 py-4 flex items-center justify-end gap-2" style={{ borderTop: `1px solid ${T.line}` }}>
          <button
            onClick={onCancel}
            className="h-9 px-4 rounded-md transition-colors"
            style={{ fontFamily: T.mono, fontSize: 12, color: T.inkSoft, background: 'transparent', border: `1px solid ${T.line}` }}
          >
            cancel
          </button>
          <button
            onClick={onConfirm}
            className="h-9 px-4 rounded-md transition-opacity hover:opacity-90"
            style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: '#fff', background: '#b4513f' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Advanced, filterable search. Live incremental results, type/project/date
// filters, sort, grouped results, fuzzy matching, keyboard navigation.
function SearchOverlay({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<Set<ItemType>>(new Set());
  const [project, setProject] = useState<string>('all');
  const [recency, setRecency] = useState<'any' | 'day' | 'week' | 'month'>('any');
  const [sort, setSort] = useState<'recent' | 'title'>('recent');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleType = (t: ItemType) =>
    setTypes(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  const clearFilters = () => { setTypes(new Set()); setProject('all'); setRecency('any'); setSort('recent'); };
  const hasFilters = types.size > 0 || project !== 'all' || recency !== 'any' || sort !== 'recent';

  const recencyCutoff = (r: typeof recency): number =>
    r === 'day' ? DAY : r === 'week' ? 7 * DAY : r === 'month' ? 30 * DAY : Infinity;

  // filter → sort → group
  const filtered = SEED_ITEMS
    .filter(i => fuzzyMatch(q, i.title) || fuzzyMatch(q, i.project ?? ''))
    .filter(i => types.size === 0 || types.has(i.type))
    .filter(i => project === 'all' || i.project === project)
    .filter(i => (now - i.modified) <= recencyCutoff(recency))
    .sort((a, b) => sort === 'recent' ? b.modified - a.modified : a.title.localeCompare(b.title));

  // flat list for keyboard nav, plus grouped view for render
  const flat = filtered;
  useEffect(() => { setActiveIdx(0); }, [q, types, project, recency, sort]);

  const grouped: Record<ItemType, WorkItem[]> = { project: [], conversation: [], file: [] };
  filtered.forEach(i => grouped[i.type].push(i));
  const groupOrder: ItemType[] = ['project', 'conversation', 'file'];

  const onKeyNav = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && flat[activeIdx]) { /* open flat[activeIdx] */ onClose(); }
  };

  const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="px-2.5 h-7 rounded-md transition-colors focus:outline-none focus-visible:ring-2"
      style={{
        fontFamily: T.mono, fontSize: 11, letterSpacing: '0.02em',
        color: on ? T.signal : T.inkSoft,
        background: on ? T.signalDim : T.surfaceHi,
        border: `1px solid ${on ? T.signalLin : T.line}`,
      }}
    >
      {children}
    </button>
  );

  let runningIdx = -1; // maps grouped render position back to flat index

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', paddingTop: '8vh' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
    >
      <div
        className="rounded-xl overflow-hidden flex flex-col"
        style={{ width: 'min(680px, 92vw)', maxHeight: '80vh', background: T.surface, border: `1px solid ${T.lineHi}`, boxShadow: '0 32px 80px -24px rgba(0,0,0,0.85)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* query input */}
        <div className="flex items-center gap-3 px-4 h-14 shrink-0" style={{ borderBottom: `1px solid ${T.line}` }}>
          <SearchIcon className="h-5 w-5 shrink-0" style={{ color: T.inkMute }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyNav}
            placeholder="Search projects, conversations, files…"
            aria-label="Search query"
            className="flex-1 bg-transparent focus:outline-none"
            style={{ fontFamily: T.disp, fontSize: 16, color: T.ink }}
          />
          <kbd style={{ fontFamily: T.mono, fontSize: 10, color: T.inkMute, border: `1px solid ${T.line}`, borderRadius: 4, padding: '2px 6px' }}>ESC</kbd>
        </div>

        {/* filters */}
        <div className="flex items-center flex-wrap gap-1.5 px-4 py-2.5 shrink-0" style={{ borderBottom: `1px solid ${T.line}` }}>
          <Chip on={types.has('project')} onClick={() => toggleType('project')}>projects</Chip>
          <Chip on={types.has('conversation')} onClick={() => toggleType('conversation')}>conversations</Chip>
          <Chip on={types.has('file')} onClick={() => toggleType('file')}>files</Chip>
          <span className="w-px h-5 mx-1" style={{ background: T.line }} />
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            aria-label="Filter by project"
            className="h-7 rounded-md px-2 focus:outline-none focus-visible:ring-2"
            style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft, background: T.surfaceHi, border: `1px solid ${T.line}` }}
          >
            <option value="all">all projects</option>
            {PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={recency}
            onChange={(e) => setRecency(e.target.value as typeof recency)}
            aria-label="Filter by recency"
            className="h-7 rounded-md px-2 focus:outline-none focus-visible:ring-2"
            style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft, background: T.surfaceHi, border: `1px solid ${T.line}` }}
          >
            <option value="any">any time</option>
            <option value="day">past day</option>
            <option value="week">past week</option>
            <option value="month">past month</option>
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            aria-label="Sort results"
            className="h-7 rounded-md px-2 focus:outline-none focus-visible:ring-2"
            style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft, background: T.surfaceHi, border: `1px solid ${T.line}` }}
          >
            <option value="recent">sort: recent</option>
            <option value="title">sort: title</option>
          </select>
          {hasFilters && (
            <button onClick={clearFilters} className="h-7 px-2 rounded-md transition-colors" style={{ fontFamily: T.mono, fontSize: 11, color: T.signal }}>
              clear
            </button>
          )}
        </div>

        {/* results */}
        <div className="flex-1 overflow-y-auto p-2" style={{ minHeight: 120 }}>
          {flat.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-12 px-6">
              <SearchIcon className="h-7 w-7 mb-3" style={{ color: T.inkFaint }} />
              <p style={{ fontFamily: T.disp, fontSize: 14, color: T.inkSoft }}>
                {q.trim() ? `No results for “${q.trim()}”` : 'Start typing to search'}
              </p>
              <p style={{ fontFamily: T.mono, fontSize: 11, color: T.inkMute, marginTop: 4 }}>
                {q.trim() ? 'Try fewer filters or a broader term.' : 'Projects, conversations, and files across your workspace.'}
              </p>
            </div>
          ) : (
            groupOrder.map(gt => grouped[gt].length > 0 && (
              <div key={gt} className="mb-2">
                <div className="px-2 py-1 flex items-center gap-1.5" style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.12em', color: T.inkMute }}>
                  {itemTypeIcon(gt, 'h-3 w-3')} {TYPE_LABEL[gt].toUpperCase()} · {grouped[gt].length}
                </div>
                {grouped[gt].map(item => {
                  runningIdx++;
                  const isActive = runningIdx === activeIdx;
                  return (
                    <button
                      key={item.id}
                      onClick={onClose}
                      aria-selected={isActive}
                      className="w-full text-left flex items-center gap-3 px-2.5 py-2 rounded-md transition-colors"
                      style={{ background: isActive ? T.signalDim : 'transparent', border: `1px solid ${isActive ? T.signalLin : 'transparent'}` }}
                    >
                      <span className="shrink-0 flex items-center justify-center" style={{ width: 18, color: isActive ? T.signal : T.inkMute }}>
                        {itemTypeIcon(item.type)}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate" style={{ fontFamily: T.disp, fontSize: 14, color: T.ink }}>{item.title}</span>
                        <span className="block truncate" style={{ fontFamily: T.mono, fontSize: 10.5, color: T.inkMute }}>
                          {item.project ?? 'ungrouped'} · {relTime(item.modified)}
                        </span>
                      </span>
                      {isActive && <CornerDownLeft className="h-3.5 w-3.5 shrink-0" style={{ color: T.signal }} />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Placeholder workspace for modes not yet built.
// Full-screen Google sign-in gate, shown in live mode when no user is present.
function SignInScreen({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="h-screen w-screen flex items-center justify-center" style={{ background: T.bg, fontFamily: T.disp }}>
      <div className="flex flex-col items-center text-center px-8" style={{ maxWidth: 380 }}>
        <div className="flex items-center justify-center rounded-xl mb-6" style={{ width: 52, height: 52, background: T.signalDim, border: `1px solid ${T.signalLin}` }}>
          <Sparkles className="h-6 w-6" style={{ color: T.signal }} />
        </div>
        <h1 style={{ fontFamily: T.disp, fontSize: 26, fontWeight: 700, color: T.ink, marginBottom: 8 }}>Arena</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: T.inkSoft, marginBottom: 28 }}>
          Chat with, compare, and orchestrate AI models. Sign in to continue.
        </p>
        <button
          onClick={onSignIn}
          className="h-11 w-full rounded-lg flex items-center justify-center gap-2.5 transition-colors focus:outline-none focus-visible:ring-2"
          style={{ background: T.ink, color: T.bg, fontFamily: T.disp, fontSize: 14, fontWeight: 600 }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.9')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z"/>
            <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 010-3.44V4.95H.96a9 9 0 000 8.1l3.01-2.33z"/>
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 00.96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
          </svg>
          Continue with Google
        </button>
        <p style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.04em', color: T.inkMute, marginTop: 20, lineHeight: 1.5 }}>
          Authentication is handled by Google. Arena never sees your password.
        </p>
      </div>
    </div>
  );
}

function ComingSoon({ mode, onPickAnother }: { mode: Mode; onPickAnother: () => void }) {
  const meta = MODES.find(m => m.id === mode)!;
  return (
    <div className="flex-1 h-full flex items-center justify-center relative z-10" style={{ background: T.bg }}>
      <div className="text-center px-8" style={{ maxWidth: 440 }}>
        <div
          className="mx-auto mb-5 flex items-center justify-center rounded-xl"
          style={{ width: 56, height: 56, background: T.surfaceHi, border: `1px solid ${T.line}`, color: T.signal }}
        >
          {modeIcon(mode, 'h-7 w-7')}
        </div>
        <h2 style={{ fontFamily: T.disp, fontSize: 22, fontWeight: 600, color: T.ink, marginBottom: 6 }}>
          {meta.label} Mode
        </h2>
        <p style={{ fontFamily: T.disp, fontSize: 14, lineHeight: 1.6, color: T.inkSoft, marginBottom: 4 }}>
          {meta.blurb}.
        </p>
        <p style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: '0.06em', color: T.inkMute, marginBottom: 24 }}>
          COMING SOON
        </p>
        <button
          onClick={onPickAnother}
          className="rounded-md transition-colors focus:outline-none focus-visible:ring-2"
          style={{ fontFamily: T.mono, fontSize: 12, color: T.inkSoft, background: T.surfaceHi, border: `1px solid ${T.line}`, padding: '8px 16px' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = T.ink; e.currentTarget.style.borderColor = T.lineHi; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = T.inkSoft; e.currentTarget.style.borderColor = T.line; }}
        >
          choose another mode
        </button>
      </div>
    </div>
  );
}

/* ============ MODE: shared capability composer ============ */
// Reused by Battle and Side by Side (Direct keeps its own inline composer).
function CapabilityComposer({
  input, setInput, onSend, capability, selectCapability, placeholder,
}: {
  input: string; setInput: (v: string) => void; onSend: () => void;
  capability: CapabilityId; selectCapability: (c: CapabilityId) => void; placeholder: string;
}) {
  return (
    <div className="px-4 pb-4 pt-2 shrink-0" style={{ borderTop: `1px solid ${T.line}` }}>
      <div
        className="relative rounded-lg transition-colors"
        style={{ background: T.inset, border: `1px solid ${T.line}` }}
        onFocusCapture={(e) => (e.currentTarget.style.borderColor = T.signalLin)}
        onBlurCapture={(e) => (e.currentTarget.style.borderColor = T.line)}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          placeholder={placeholder}
          className="w-full bg-transparent resize-none focus:outline-none p-3.5 pb-12"
          style={{ fontFamily: T.disp, fontSize: 14, lineHeight: 1.6, color: T.ink, height: 96 }}
        />
        <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between">
          <div className="flex items-center gap-0.5">
            <ToolBtn title="Attach file context"><Paperclip className="h-4 w-4" /></ToolBtn>
            <span className="h-5 w-px mx-1" style={{ background: T.line }} />
            <div role="radiogroup" aria-label="Capability" className="flex items-center gap-0.5">
              <CapBtn id="auto"   label="Auto"   active={capability === 'auto'}   onClick={() => selectCapability('auto')}   icon={<Zap className="h-3.5 w-3.5" />} />
              <CapBtn id="code"   label="Code"   active={capability === 'code'}   onClick={() => selectCapability('code')}   icon={<Code2 className="h-3.5 w-3.5" />} />
              <CapBtn id="search" label="Search" active={capability === 'search'} onClick={() => selectCapability('search')} icon={<Globe className="h-3.5 w-3.5" />} />
              <CapBtn id="image"  label="Image"  active={capability === 'image'}  onClick={() => selectCapability('image')}  icon={<ImageIcon className="h-3.5 w-3.5" />} />
              <CapBtn id="video"  label="Video"  active={capability === 'video'}  onClick={() => selectCapability('video')}  icon={<Video className="h-3.5 w-3.5" />} />
            </div>
          </div>
          <button
            onClick={onSend}
            disabled={!input.trim()}
            aria-label="Send message"
            className="h-7 w-7 rounded-md flex items-center justify-center transition-transform active:scale-90 focus:outline-none focus-visible:ring-2"
            style={{ background: T.signal, color: T.bg, opacity: input.trim() ? 1 : 0.4, cursor: input.trim() ? 'pointer' : 'not-allowed' }}
            title="Send"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Shared response column used by Battle (anonymous) and Side by Side (named).
function ResponseColumn({ label, sublabel, text, streaming, accent }: { label: string; sublabel?: string; text: string; streaming: boolean; accent?: boolean }) {
  return (
    <div className="flex-1 flex flex-col min-w-0 h-full" style={{ borderRight: `1px solid ${T.line}` }}>
      <div className="h-11 px-4 flex items-center gap-2 shrink-0" style={{ borderBottom: `1px solid ${T.line}`, background: T.surface }}>
        <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: accent ? T.signal : T.read }} />
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink }}>{label}</span>
        {sublabel && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.inkMute }}>{sublabel}</span>}
        {streaming && <span className="ml-auto" style={{ fontFamily: T.mono, fontSize: 10, color: T.signal }}>streaming…</span>}
      </div>
      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        {text
          ? <p style={{ fontFamily: T.disp, fontSize: 14, lineHeight: 1.7, color: T.inkSoft, whiteSpace: 'pre-wrap' }}>{text}{streaming && <span style={{ color: T.signal }}>▋</span>}</p>
          : <p style={{ fontFamily: T.mono, fontSize: 12, color: T.inkFaint }}>waiting for prompt…</p>}
      </div>
    </div>
  );
}

/* ============ MODE: Battle ============ */
function BattleMode({
  battle, input, setInput, onSend, onVote, capability, selectCapability,
}: {
  battle: BattleState; input: string; setInput: (v: string) => void; onSend: () => void;
  onVote: (v: BattleVote) => void; capability: CapabilityId; selectCapability: (c: CapabilityId) => void;
}) {
  const started = battle.submitting || battle.respA || battle.respB;
  const bothDone = battle.doneA && battle.doneB;
  const votes: { v: BattleVote; label: string }[] = [
    { v: 'A', label: 'A is better' }, { v: 'B', label: 'B is better' },
    { v: 'tie', label: 'Tie' }, { v: 'bad', label: 'Both are bad' },
  ];
  return (
    <div className="flex-1 flex flex-col h-full min-w-0 relative z-10" style={{ background: T.bg }}>
      {!started ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <Swords className="h-8 w-8 mb-4" style={{ color: T.signal }} />
          <h2 style={{ fontFamily: T.disp, fontSize: 22, fontWeight: 600, color: T.ink, marginBottom: 6 }}>Battle Mode</h2>
          <p style={{ fontFamily: T.disp, fontSize: 14, color: T.inkSoft, maxWidth: 420 }}>
            One prompt, two anonymous models. Read both answers, then vote — identities reveal only after you decide.
          </p>
        </div>
      ) : (
        <>
          <div className="flex-1 flex min-h-0">
            <ResponseColumn label="Model A" text={battle.respA} streaming={battle.submitting && !battle.doneA} accent
              sublabel={battle.revealed ? battle.modelA.name : undefined} />
            <div style={{ width: 0 }} />
            <ResponseColumn label="Model B" text={battle.respB} streaming={battle.submitting && !battle.doneB} accent
              sublabel={battle.revealed ? battle.modelB.name : undefined} />
          </div>
          {/* voting bar — only after both finish; locks once voted */}
          <div className="shrink-0 px-4 py-3 flex items-center justify-center gap-2" style={{ borderTop: `1px solid ${T.line}`, background: T.surface }}>
            {!bothDone ? (
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.inkMute }}>waiting for both responses to finish…</span>
            ) : battle.revealed ? (
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.signal }}>
                Vote recorded: {battle.vote === 'A' ? `A (${battle.modelA.name})` : battle.vote === 'B' ? `B (${battle.modelB.name})` : battle.vote === 'tie' ? 'Tie' : 'Both bad'} · {battle.modelA.name} vs {battle.modelB.name}
              </span>
            ) : (
              votes.map(({ v, label }) => (
                <button
                  key={v}
                  onClick={() => onVote(v)}
                  className="h-8 px-3 rounded-md transition-colors focus:outline-none focus-visible:ring-2"
                  style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft, background: T.surfaceHi, border: `1px solid ${T.line}` }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = T.signal; e.currentTarget.style.borderColor = T.signalLin; e.currentTarget.style.background = T.signalDim; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = T.inkSoft; e.currentTarget.style.borderColor = T.line; e.currentTarget.style.background = T.surfaceHi; }}
                >
                  {label}
                </button>
              ))
            )}
          </div>
        </>
      )}
      <CapabilityComposer input={input} setInput={setInput} onSend={onSend} capability={capability} selectCapability={selectCapability}
        placeholder="Enter one prompt to send to both anonymous models…" />
    </div>
  );
}

/* ============ MODE: Side by Side ============ */
function SideBySideMode({
  leftModel, rightModel, sbs, input, setInput, onSend, capability, selectCapability, picker, setPicker, onPick,
}: {
  leftModel: ModelInfo; rightModel: ModelInfo; sbs: { submitting: boolean; left: string; right: string; done: boolean };
  input: string; setInput: (v: string) => void; onSend: () => void;
  capability: CapabilityId; selectCapability: (c: CapabilityId) => void;
  picker: { side: 'left' | 'right'; category: ModelInfo['category'] | 'All'; query: string } | null;
  setPicker: (p: { side: 'left' | 'right'; category: ModelInfo['category'] | 'All'; query: string } | null) => void;
  onPick: (side: 'left' | 'right', m: ModelInfo) => void;
}) {
  const Selector = ({ side, model }: { side: 'left' | 'right'; model: ModelInfo }) => (
    <button
      onClick={() => setPicker({ side, category: 'All', query: '' })}
      className="flex-1 h-11 px-4 flex items-center gap-2 transition-colors"
      style={{ borderRight: side === 'left' ? `1px solid ${T.line}` : undefined, background: T.surface }}
      onMouseEnter={(e) => (e.currentTarget.style.background = T.surfaceHi)}
      onMouseLeave={(e) => (e.currentTarget.style.background = T.surface)}
      aria-label={`Choose ${side} model, current ${model.name}`}
    >
      <span className="flex items-center justify-center h-5 w-5 rounded" style={{ background: T.inset, color: T.signal, fontSize: 12 }}>{model.glyph}</span>
      <span className="flex flex-col items-start min-w-0">
        <span className="truncate" style={{ fontFamily: T.disp, fontSize: 13, color: T.ink }}>{model.name}</span>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.inkMute }}>{model.provider}</span>
      </span>
      <ChevronDown className="h-4 w-4 ml-auto" style={{ color: T.inkMute }} />
    </button>
  );

  const cats: (ModelInfo['category'] | 'All')[] = ['All', 'Text', 'Code', 'Image', 'Search'];
  const pickerList = picker
    ? MODEL_CATALOG
        .filter(m => picker.category === 'All' || m.category === picker.category)
        .filter(m => m.name.toLowerCase().includes(picker.query.toLowerCase()) || m.provider.toLowerCase().includes(picker.query.toLowerCase()))
    : [];
  const started = sbs.submitting || sbs.left || sbs.right;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 relative z-10" style={{ background: T.bg }}>
      {/* model selectors */}
      <div className="flex shrink-0" style={{ borderBottom: `1px solid ${T.line}` }}>
        <Selector side="left" model={leftModel} />
        <Selector side="right" model={rightModel} />
      </div>

      {/* picker panel */}
      {picker && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setPicker(null)} />
          <div
            className="absolute z-[61] rounded-lg overflow-hidden"
            style={{ top: 52, [picker.side === 'left' ? 'left' : 'right']: 16, width: 320, background: T.surface, border: `1px solid ${T.lineHi}`, boxShadow: '0 24px 60px -16px rgba(0,0,0,0.8)' } as React.CSSProperties}
          >
            <div className="flex items-center gap-2 px-3 h-10" style={{ borderBottom: `1px solid ${T.line}` }}>
              <SearchIcon className="h-4 w-4 shrink-0" style={{ color: T.inkMute }} />
              <input
                autoFocus value={picker.query} onChange={(e) => setPicker({ ...picker, query: e.target.value })}
                placeholder="search models…" aria-label="Search models"
                className="bg-transparent focus:outline-none w-full" style={{ fontFamily: T.mono, fontSize: 12, color: T.ink }}
              />
            </div>
            <div className="flex items-center gap-1 px-2 py-2" style={{ borderBottom: `1px solid ${T.line}` }}>
              {cats.map(c => (
                <button
                  key={c} onClick={() => setPicker({ ...picker, category: c })}
                  className="px-2 h-6 rounded transition-colors"
                  style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.04em',
                    color: picker.category === c ? T.signal : T.inkMute,
                    background: picker.category === c ? T.signalDim : 'transparent',
                    border: `1px solid ${picker.category === c ? T.signalLin : 'transparent'}` }}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {pickerList.length === 0 ? (
                <div className="px-2 py-6 text-center" style={{ fontFamily: T.mono, fontSize: 11, color: T.inkMute }}>no models match</div>
              ) : pickerList.map(m => {
                const current = (picker.side === 'left' ? leftModel : rightModel).id === m.id;
                return (
                  <button
                    key={m.id} onClick={() => onPick(picker.side, m)}
                    className="w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-md transition-colors"
                    style={{ background: current ? T.signalDim : 'transparent' }}
                    onMouseEnter={(e) => { if (!current) e.currentTarget.style.background = T.surfaceHi; }}
                    onMouseLeave={(e) => { if (!current) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span className="flex items-center justify-center h-6 w-6 rounded shrink-0" style={{ background: T.inset, color: T.signal, fontSize: 13 }}>{m.glyph}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate" style={{ fontFamily: T.disp, fontSize: 13, color: T.ink }}>{m.name}</span>
                      <span className="block" style={{ fontFamily: T.mono, fontSize: 9.5, color: T.inkMute }}>{m.provider} · {m.category}</span>
                    </span>
                    {current && <Check className="h-4 w-4 shrink-0" style={{ color: T.signal }} />}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* responses */}
      {!started ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <Columns2 className="h-8 w-8 mb-4" style={{ color: T.signal }} />
          <h2 style={{ fontFamily: T.disp, fontSize: 22, fontWeight: 600, color: T.ink, marginBottom: 6 }}>Side by Side</h2>
          <p style={{ fontFamily: T.disp, fontSize: 14, color: T.inkSoft, maxWidth: 420 }}>
            Pick two named models above, send one prompt, and compare their answers — identities always visible.
          </p>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          <ResponseColumn label={leftModel.name} sublabel={leftModel.provider} text={sbs.left} streaming={sbs.submitting && !sbs.done} />
          <ResponseColumn label={rightModel.name} sublabel={rightModel.provider} text={sbs.right} streaming={sbs.submitting && !sbs.done} accent />
        </div>
      )}

      <CapabilityComposer input={input} setInput={setInput} onSend={onSend} capability={capability} selectCapability={selectCapability}
        placeholder="Enter one prompt to send to both models…" />
    </div>
  );
}

/* ============ MODE: Agent ============ */
function AgentMode({
  agent, input, setInput, onSend, workspaceOpen, setWorkspaceOpen, onAttach, attachedFiles, setAttachedFiles,
}: {
  agent: AgentState; input: string; setInput: (v: string) => void; onSend: () => void;
  workspaceOpen: boolean; setWorkspaceOpen: (v: boolean) => void;
  onAttach: () => void; attachedFiles: { id: string; name: string }[]; setAttachedFiles: (fn: (p: { id: string; name: string }[]) => { id: string; name: string }[]) => void;
}) {
  const statusColor = agent.status === 'error' ? '#d98a7a' : agent.status === 'done' ? T.read : T.signal;
  const started = agent.thread.length > 0;
  return (
    <div className="flex-1 flex h-full min-w-0 relative z-10" style={{ background: T.bg }}>
      {/* conversation side */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* status bar */}
        <div className="h-11 px-4 flex items-center gap-2 shrink-0" style={{ borderBottom: `1px solid ${T.line}` }}>
          <Bot className="h-4 w-4" style={{ color: T.signal }} />
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink }}>Agent</span>
          <span className="flex items-center gap-1.5 ml-2" role="status" aria-live="polite">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor }} />
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', color: statusColor }}>{agent.status.toUpperCase()}</span>
          </span>
          <button
            onClick={() => setWorkspaceOpen(!workspaceOpen)}
            className="ml-auto h-7 px-2.5 rounded-md flex items-center gap-1.5 transition-colors"
            style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft, border: `1px solid ${T.line}`, background: T.inset }}
            aria-pressed={workspaceOpen} aria-label="Toggle workspace panel"
          >
            <PanelsTopLeftIcon />
            {workspaceOpen ? 'hide workspace' : 'show workspace'}
          </button>
        </div>

        {/* thread */}
        <div className="flex-1 overflow-y-auto p-5 min-h-0">
          {!started ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-8">
              <Bot className="h-8 w-8 mb-4" style={{ color: T.signal }} />
              <h2 style={{ fontFamily: T.disp, fontSize: 22, fontWeight: 600, color: T.ink, marginBottom: 6 }}>Agent Mode</h2>
              <p style={{ fontFamily: T.disp, fontSize: 14, color: T.inkSoft, maxWidth: 420 }}>
                Describe a multi-step task. The agent plans, works autonomously, streams its progress here, and collects outputs in the workspace.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3" style={{ maxWidth: 760, margin: '0 auto' }}>
              {agent.thread.map(step => (
                <div key={step.id} className="rounded-lg p-3" style={{ background: T.surface, border: `1px solid ${T.line}` }}>
                  <div className="flex items-center gap-1.5 mb-1" style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '0.1em', color: step.kind === 'result' ? T.read : T.signal }}>
                    {step.kind === 'plan' ? <Network className="h-3 w-3" /> : step.kind === 'result' ? <Check className="h-3 w-3" /> : <CornerDownLeft className="h-3 w-3" />}
                    {step.kind.toUpperCase()}
                  </div>
                  <p style={{ fontFamily: T.disp, fontSize: 13.5, lineHeight: 1.6, color: T.inkSoft }}>{step.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* minimal composer: text + attach + send only (no capability buttons) */}
        <div className="px-4 pb-4 pt-2 shrink-0" style={{ borderTop: `1px solid ${T.line}` }}>
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachedFiles.map(f => (
                <span key={f.id} className="flex items-center gap-1.5 px-2 py-1 rounded" style={{ background: T.surfaceHi, border: `1px solid ${T.line}`, fontFamily: T.mono, fontSize: 11, color: T.inkSoft }}>
                  <Paperclip className="h-3 w-3" style={{ color: T.inkMute }} />{f.name}
                  <button onClick={() => setAttachedFiles(prev => prev.filter(x => x.id !== f.id))} style={{ color: T.inkMute }}><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
          <div className="relative rounded-lg" style={{ background: T.inset, border: `1px solid ${T.line}` }}>
            <textarea
              value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
              placeholder="Describe a task for the agent to carry out autonomously…"
              className="w-full bg-transparent resize-none focus:outline-none p-3.5 pb-12"
              style={{ fontFamily: T.disp, fontSize: 14, lineHeight: 1.6, color: T.ink, height: 88 }}
            />
            <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between">
              <ToolBtn title="Attach file context" onClick={onAttach}><Paperclip className="h-4 w-4" /></ToolBtn>
              <button
                onClick={onSend} disabled={!input.trim()} aria-label="Send task"
                className="h-7 w-7 rounded-md flex items-center justify-center transition-transform active:scale-90"
                style={{ background: T.signal, color: T.bg, opacity: input.trim() ? 1 : 0.4, cursor: input.trim() ? 'pointer' : 'not-allowed' }}
              >
                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* workspace side panel */}
      {workspaceOpen && (
        <div className="shrink-0 flex flex-col h-full" style={{ width: 280, borderLeft: `1px solid ${T.line}`, background: T.surface }}>
          <div className="h-11 px-4 flex items-center justify-between shrink-0" style={{ borderBottom: `1px solid ${T.line}` }}>
            <span style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: '0.08em', color: T.inkSoft }}>WORKSPACE</span>
            <button onClick={() => setWorkspaceOpen(false)} aria-label="Close workspace" style={{ color: T.inkMute }}><X className="h-4 w-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 min-h-0">
            {agent.artifacts.length === 0 ? (
              <p style={{ fontFamily: T.disp, fontSize: 12, lineHeight: 1.5, color: T.inkMute }}>Artifacts the agent produces will collect here.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {agent.artifacts.map(a => (
                  <div key={a.id} className="flex items-center gap-2 p-2 rounded-md" style={{ background: T.inset, border: `1px solid ${T.line}` }}>
                    {a.kind === 'data' ? <FileText className="h-4 w-4" style={{ color: T.read }} /> : <FileText className="h-4 w-4" style={{ color: T.signal }} />}
                    <span className="truncate" style={{ fontFamily: T.mono, fontSize: 12, color: T.inkSoft }}>{a.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// tiny inline icon to avoid another import for the workspace toggle
function PanelsTopLeftIcon() {
  return <Columns2 className="h-3.5 w-3.5" />;
}

function RailBtn({ icon, label, open = false, active = false, onClick }: { icon: React.ReactNode; label?: string; open?: boolean; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="rounded-md flex items-center transition-colors"
      style={{
        color: active ? T.ink : T.inkMute,
        background: active ? T.surfaceHi : 'transparent',
        height: 36,
        width: open ? '100%' : 36,
        justifyContent: open ? 'flex-start' : 'center',
        gap: 10,
        paddingLeft: open ? 9 : 0,
        paddingRight: open ? 9 : 0,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = T.inkSoft; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = T.inkMute; }}
    >
      <span className="shrink-0 flex items-center justify-center" style={{ width: 18 }}>{icon}</span>
      {open && label && (
        <span className="whitespace-nowrap" style={{ fontFamily: T.disp, fontSize: 13 }}>{label}</span>
      )}
    </button>
  );
}

function ToolBtn({
  children, title, armed = false, disabled = false, onClick,
}: { children: React.ReactNode; title: string; armed?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? `${title} (managed by Auto Mode)` : title}
      aria-label={title}
      className="h-8 w-8 rounded-md flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2"
      style={{
        color: disabled ? T.inkFaint : armed ? T.signal : T.inkMute,
        background: armed && !disabled ? T.signalDim : 'transparent',
        border: `1px solid ${armed && !disabled ? T.signalLin : 'transparent'}`,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={(e) => { if (!armed && !disabled) { e.currentTarget.style.color = T.ink; e.currentTarget.style.background = T.surfaceHi; } }}
      onMouseLeave={(e) => { if (!armed && !disabled) { e.currentTarget.style.color = T.inkMute; e.currentTarget.style.background = 'transparent'; } }}
    >
      {children}
    </button>
  );
}

// Single-select capability chip. Always full-opacity and clickable; the active
// one is filled amber + bordered (distinguishable beyond color), others neutral.
function CapBtn({ id, label, icon, active, onClick }: { id: CapabilityId; label: string; icon: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      role="radio"
      aria-checked={active}
      aria-label={label}
      onClick={onClick}
      className="h-8 rounded-md flex items-center gap-1.5 px-2 transition-colors focus:outline-none focus-visible:ring-2"
      style={{
        color: active ? T.signal : T.inkSoft,
        background: active ? T.signalDim : 'transparent',
        border: `1px solid ${active ? T.signalLin : 'transparent'}`,
        fontFamily: T.mono, fontSize: 11, fontWeight: active ? 700 : 400,
      }}
      onMouseEnter={(e) => { if (!active) { e.currentTarget.style.color = T.ink; e.currentTarget.style.background = T.surfaceHi; } }}
      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.color = T.inkSoft; e.currentTarget.style.background = 'transparent'; } }}
    >
      {icon}
      {label}
    </button>
  );
}

function SegBtn({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-3 h-7 rounded flex items-center gap-1.5 transition-colors"
      style={{
        fontFamily: T.mono, fontSize: 11, letterSpacing: '0.04em',
        color: active ? T.ink : T.inkMute,
        background: active ? T.surfaceHi : 'transparent',
        border: `1px solid ${active ? T.line : 'transparent'}`,
      }}
    >
      {children}
    </button>
  );
}

function VpBtn({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="h-8 w-8 rounded-md flex items-center justify-center transition-colors"
      style={{ color: active ? T.ink : T.inkMute, background: active ? T.surfaceHi : 'transparent' }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = T.inkSoft; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = T.inkMute; }}
    >
      {children}
    </button>
  );
}
