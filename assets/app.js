// OpenClaw Mobile Dashboard v2
(function() {
'use strict';

// ─── State ───
const state = {
  password: localStorage.getItem('oc-password') || '',
  ws: null,
  connected: false,
  reqId: 0,
  pending: {},
  agents: [],
  defaultAgentId: null,
  selectedAgentId: null,
  selectedSessionKey: null,
  sessions: [],
  chatHistory: [],
  hello: null,
  currentView: 'chat',
  chatStreaming: false,
  streamingText: '',
  agentIdentities: {},
  agentChatCache: {},
  cronJobs: [],
  usageData: null,
  models: [],
  logLines: [],
  logSubscribed: false,
};

function agentSessionKey(agentId) {
  if (agentId === state.defaultAgentId) return 'main';
  return `agent:${agentId}:main`;
}

const GATEWAY_HOST = location.hostname || 'pc1.taildb1204.ts.net';
const WS_URL = `wss://${GATEWAY_HOST}`;

// ─── DOM refs ───
const $ = id => document.getElementById(id);
const loginScreen = $('login-screen');
const mainScreen = $('main-screen');
const loginForm = $('login-form');
const loginPassword = $('login-password');
const loginError = $('login-error');
const connStatus = $('conn-status');
const topbarTitle = $('topbar-title');
const agentSelector = $('agent-selector');
const chatThread = $('chat-thread');
const chatInput = $('chat-input');
const btnSend = $('btn-send');
const btnRefresh = $('btn-refresh');

// ─── WebSocket ───
function connect() {
  if (state.ws) { state.ws.close(); state.ws = null; }
  setConnState('connecting');
  
  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  
  ws.addEventListener('open', () => {
    wsRequest('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'openclaw-control-ui',
        version: 'dev',
        platform: navigator.platform || 'web',
        mode: 'webchat',
        instanceId: 'mobile-' + Math.random().toString(36).slice(2, 10),
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
      caps: [],
      auth: { password: state.password },
      userAgent: navigator.userAgent,
      locale: navigator.language,
    }).then(hello => {
      state.connected = true;
      state.hello = hello;
      setConnState('connected');
      state.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'req', id: `ping${Date.now()}`, method: 'ping', params: {} }));
        }
      }, 15000);
      showMain();
      loadInitial();
    }).catch(err => {
      console.error('connect failed', err);
      setConnState('disconnected');
      showLogin('Connection rejected: ' + (err.message || 'unknown'));
    });
  });

  ws.addEventListener('message', evt => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
    setConnState('disconnected');
    setTimeout(() => { if (state.password) connect(); }, 3000);
  });

  ws.addEventListener('error', () => {});
}

function handleMessage(msg) {
  if (msg.type === 'res' || msg.type === 'err') {
    const p = state.pending[msg.id];
    if (p) {
      delete state.pending[msg.id];
      if (msg.type === 'err' || msg.error || msg.ok === false) {
        p.reject(new Error(msg.error?.message || msg.message || 'request failed'));
      } else {
        p.resolve(msg.payload ?? msg.result ?? msg);
      }
    }
  } else if (msg.type === 'event') {
    if (msg.event === 'connect.challenge') return;
    handleEvent(msg);
  } else if (msg.type === 'stream') {
    handleStream(msg);
  }
}

function handleEvent(msg) {
  const evt = msg.event;
  const data = msg.payload || msg.data;
  
  if (evt === 'chat') { handleChatEvent(data); return; }
  
  if (evt === 'logs.entry' && state.currentView === 'logs') {
    appendLogLine(data);
    return;
  }
  
  if (evt === 'session.message' || evt === 'chat.message') {
    if (data?.sessionKey === state.selectedSessionKey) {
      appendMessageFromEvent(data);
    }
  }
}

function handleChatEvent(data) {
  if (!data) return;
  
  if (data.sessionKey && state.chatStreaming) {
    state.selectedSessionKey = data.sessionKey;
  }
  
  if (data.sessionKey && state.selectedSessionKey && 
      data.sessionKey !== state.selectedSessionKey) {
    const selected = state.selectedSessionKey;
    const incoming = data.sessionKey;
    const isMatch = (selected === 'main' && incoming === `agent:${state.defaultAgentId || 'main'}:main`) ||
                    (incoming.startsWith('agent:') && selected.startsWith('agent:') && 
                    incoming.split(':')[1] === selected.split(':')[1]);
    if (!isMatch) return;
    state.selectedSessionKey = incoming;
  }
  
  if (data.runId && state.chatRunId && data.runId !== state.chatRunId) {
    if (data.state === 'final') return;
    return;
  }
  
  if (data.state === 'delta') {
    const text = extractMessageText(data.message);
    if (typeof text === 'string') {
      if (!state.streamingText || text.length >= state.streamingText.length) {
        state.streamingText = text;
      }
      updateStreamingMessage();
    }
  } else if (data.state === 'final') {
    state.chatStreaming = false;
    state.chatRunId = null;
    finalizeStreamingMessage();
    if (state.selectedSessionKey) loadChatHistory(state.selectedSessionKey);
  } else if (data.state === 'error') {
    state.chatStreaming = false;
    state.chatRunId = null;
    removeTypingIndicator();
    const streamEl = chatThread.querySelector('.streaming-msg');
    if (streamEl) streamEl.remove();
    appendSystemMsg(`Error: ${data.errorMessage || 'chat error'}`);
  } else if (data.state === 'aborted') {
    state.chatStreaming = false;
    state.chatRunId = null;
    finalizeStreamingMessage();
  }
}

function extractMessageText(msg) {
  if (!msg) return null;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') || null;
  }
  return null;
}

function handleStream(msg) {
  if (msg.event === 'chat.delta' || msg.delta) {
    const delta = msg.delta || msg.data?.delta || '';
    if (delta) { state.streamingText += delta; updateStreamingMessage(); }
  }
  if (msg.event === 'chat.done' || msg.done) {
    state.chatStreaming = false;
    finalizeStreamingMessage();
  }
}

function wsRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Not connected'));
    }
    const id = `m${++state.reqId}`;
    state.pending[id] = { resolve, reject };
    state.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    setTimeout(() => {
      if (state.pending[id]) { delete state.pending[id]; reject(new Error('Request timeout')); }
    }, 30000);
  });
}

// ─── Connection State UI ───
function setConnState(s) {
  connStatus.className = 'topbar-status ' + s;
  const label = $('conn-label');
  if (label) {
    label.textContent = s === 'connected' ? 'Connected' : s === 'connecting' ? 'Connecting...' : 'Disconnected';
    label.className = 'conn-label ' + s;
  }
}

// ─── Screen Management ───
function showLogin(error) {
  loginScreen.classList.add('active');
  mainScreen.classList.remove('active');
  loginError.textContent = error || '';
  if (state.password) loginPassword.value = state.password;
}

function showMain() {
  loginScreen.classList.remove('active');
  mainScreen.classList.add('active');
}

// ─── Navigation ───
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(view) {
  state.currentView = view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  
  if (view === 'sessions') loadSessions();
  else if (view === 'agents') loadAgents();
  else if (view === 'status') loadStatus();
}

// ─── Initial Load ───
async function loadInitial() {
  try {
    const agentsRes = await wsRequest('agents.list', {});
    if (agentsRes?.agents) {
      state.agents = agentsRes.agents;
      state.defaultAgentId = agentsRes.defaultId || agentsRes.agents[0]?.id;
      state.selectedAgentId = state.defaultAgentId;
      state.selectedSessionKey = agentSessionKey(state.selectedAgentId);
      renderAgentSelector();
      loadChatHistory(state.selectedSessionKey);
      
      for (const a of state.agents) {
        wsRequest('agent.identity.get', { agentId: a.id }).then(identity => {
          if (identity) { state.agentIdentities[a.id] = identity; renderAgentSelector(); }
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('loadInitial', e);
  }
}

// ─── Agent Selector ───
const AGENT_COLORS = {
  main: 'var(--accent)', trading: 'var(--green)', 'it-support': 'var(--blue)',
  dev: 'var(--orange)', voice: 'var(--pink)', troubleshoot: 'var(--red)',
};

function getAgentName(a) {
  const identity = state.agentIdentities[a.id];
  return a.name || identity?.name || a.identity?.name || a.id;
}

function renderAgentSelector() {
  agentSelector.innerHTML = state.agents.map(a => {
    const name = getAgentName(a);
    const active = a.id === state.selectedAgentId ? ' active' : '';
    const color = AGENT_COLORS[a.id] || 'var(--accent)';
    return `<button class="agent-chip${active}" data-agent="${a.id}" style="${active ? `background:${color};color:#fff` : ''}">${esc(name)}</button>`;
  }).join('');
  
  agentSelector.querySelectorAll('.agent-chip').forEach(chip => {
    chip.addEventListener('click', () => selectAgent(chip.dataset.agent));
  });
}

function selectAgent(agentId) {
  if (state.selectedAgentId && state.selectedSessionKey) {
    state.agentChatCache[state.selectedAgentId] = {
      sessionKey: state.selectedSessionKey,
      history: [...state.chatHistory],
    };
  }
  
  state.selectedAgentId = agentId;
  state.selectedSessionKey = agentSessionKey(agentId);
  renderAgentSelector();
  
  const cached = state.agentChatCache[agentId];
  if (cached && cached.sessionKey === state.selectedSessionKey && cached.history.length > 0) {
    state.chatHistory = cached.history;
    renderChat();
  } else {
    state.chatHistory = [];
    chatThread.innerHTML = '<div class="chat-empty"><div class="loading-spinner"></div>Loading...</div>';
    loadChatHistory(state.selectedSessionKey);
  }
}

// ─── Chat ───
async function loadChatHistory(sessionKey) {
  try {
    const res = await wsRequest('chat.history', { sessionKey, limit: 50 });
    if (res?.messages) {
      state.chatHistory = res.messages;
      renderChat();
    }
  } catch (e) {
    console.error('loadChatHistory', e);
  }
}

function renderChat() {
  if (state.chatHistory.length === 0) {
    chatThread.innerHTML = '<div class="chat-empty">Send a message to start chatting</div>';
    return;
  }
  chatThread.innerHTML = state.chatHistory.map(m => renderMessage(m)).join('');
  scrollChatToBottom();
}

function renderMessage(msg) {
  const role = msg.role || 'assistant';
  if (role === 'system') {
    return `<div class="chat-msg system">${esc(truncate(msg.content || '', 200))}</div>`;
  }
  const content = formatContent(msg.content || '');
  const time = msg.timestamp ? formatTime(msg.timestamp) : '';
  const meta = time ? `<div class="msg-meta">${time}</div>` : '';
  return `<div class="chat-msg ${role}">${content}${meta}</div>`;
}

function formatContent(text) {
  text = text.replace(/<\/?(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi, '');
  text = text.trim();
  if (!text) return '<em>thinking...</em>';
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${esc(code.trim())}</code></pre>`);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/\n/g, '<br>');
  return text;
}

function appendMessageFromEvent(data) {
  if (!data?.message) return;
  state.chatHistory.push(data.message);
  const div = document.createElement('div');
  div.innerHTML = renderMessage(data.message);
  chatThread.appendChild(div.firstElementChild);
  scrollChatToBottom();
}

function appendSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  chatThread.appendChild(div);
  scrollChatToBottom();
}

function updateStreamingMessage() {
  let el = chatThread.querySelector('.streaming-msg');
  if (!el) {
    el = document.createElement('div');
    el.className = 'chat-msg assistant streaming-msg';
    chatThread.appendChild(el);
  }
  el.innerHTML = formatContent(state.streamingText);
  scrollChatToBottom();
}

function finalizeStreamingMessage() {
  const el = chatThread.querySelector('.streaming-msg');
  if (el) {
    el.classList.remove('streaming-msg');
    if (state.streamingText.trim()) {
      state.chatHistory.push({ role: 'assistant', content: state.streamingText });
    }
  }
  state.streamingText = '';
  removeTypingIndicator();
}

function addTypingIndicator() {
  removeTypingIndicator();
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.id = 'typing';
  el.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  chatThread.appendChild(el);
  scrollChatToBottom();
}

function removeTypingIndicator() {
  const el = $('typing');
  if (el) el.remove();
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !state.connected || !state.selectedAgentId) return;
  
  chatInput.value = '';
  autoResize();
  btnSend.disabled = true;
  
  const userMsg = { role: 'user', content: text, timestamp: Date.now() };
  state.chatHistory.push(userMsg);
  
  const empty = chatThread.querySelector('.chat-empty');
  if (empty) empty.remove();
  
  const div = document.createElement('div');
  div.innerHTML = renderMessage(userMsg);
  chatThread.appendChild(div.firstElementChild);
  scrollChatToBottom();
  
  addTypingIndicator();
  state.chatStreaming = true;
  state.streamingText = '';
  
  try {
    const idempotencyKey = `mob-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    state.chatRunId = idempotencyKey;
    
    const res = await wsRequest('chat.send', {
      message: text,
      deliver: false,
      idempotencyKey,
      sessionKey: state.selectedSessionKey || agentSessionKey(state.selectedAgentId || 'main'),
    });
    
    if (res?.sessionKey) state.selectedSessionKey = res.sessionKey;
  } catch (e) {
    removeTypingIndicator();
    state.chatStreaming = false;
    appendSystemMsg(`Failed to send: ${e.message}`);
  }
  updateSendButton();
}

function scrollChatToBottom() {
  requestAnimationFrame(() => { chatThread.scrollTop = chatThread.scrollHeight; });
}

// ─── Sessions ───
async function loadSessions() {
  const el = $('sessions-list');
  el.innerHTML = '<div class="list-empty"><div class="loading-spinner"></div>Loading sessions...</div>';
  try {
    const res = await wsRequest('sessions.list', { includeGlobal: true, limit: 100 });
    if (res?.sessions) {
      state.sessions = res.sessions;
      renderSessions();
    } else {
      el.innerHTML = '<div class="list-empty">No sessions data</div>';
    }
  } catch (e) {
    el.innerHTML = `<div class="list-empty">Error: ${esc(e.message)}</div>`;
  }
}

function renderSessions() {
  const el = $('sessions-list');
  if (state.sessions.length === 0) {
    el.innerHTML = '<div class="list-empty">No sessions found</div>';
    return;
  }
  
  // Sort by last activity (most recent first)
  const sorted = [...state.sessions].sort((a, b) => {
    const ta = a.lastActiveAt || a.updatedAt || a.createdAt || 0;
    const tb = b.lastActiveAt || b.updatedAt || b.createdAt || 0;
    return new Date(tb) - new Date(ta);
  });
  
  el.innerHTML = sorted.map(s => {
    const key = s.key || '';
    const label = s.label || key;
    const agent = s.agentId || key.split(':')[1] || '?';
    const channel = s.channel || '?';
    const lastActive = s.lastActiveAt || s.updatedAt;
    const lastStr = lastActive ? timeAgo(lastActive) : 'unknown';
    const turns = s.turns ?? s.messageCount ?? '?';
    const tokens = s.tokenCount ?? s.totalTokens;
    const tokenStr = tokens ? formatNumber(tokens) + ' tok' : '';
    const agentColor = AGENT_COLORS[agent] || 'var(--accent)';
    const isActive = key === state.selectedSessionKey;
    
    return `
      <div class="list-card${isActive ? ' active-card' : ''}" data-session-key="${esc(key)}">
        <div class="list-card-title">${esc(truncate(label, 60))}</div>
        <div class="list-card-sub">${esc(channel)} · ${lastStr}</div>
        <div class="list-card-meta">
          <span class="list-card-tag" style="background:${agentColor}20;color:${agentColor}">${esc(agent)}</span>
          ${turns !== '?' ? `<span class="list-card-tag blue">${turns} turns</span>` : ''}
          ${tokenStr ? `<span class="list-card-tag orange">${tokenStr}</span>` : ''}
        </div>
      </div>`;
  }).join('');
  
  el.querySelectorAll('.list-card').forEach(card => {
    card.addEventListener('click', () => {
      const key = card.dataset.sessionKey;
      const session = state.sessions.find(s => s.key === key);
      if (session) {
        state.selectedSessionKey = key;
        if (session.agentId) state.selectedAgentId = session.agentId;
        renderAgentSelector();
        loadChatHistory(key);
        switchView('chat');
      }
    });
  });
}

// ─── Agents ───
async function loadAgents() {
  const el = $('agents-list');
  el.innerHTML = '<div class="list-empty"><div class="loading-spinner"></div>Loading agents...</div>';
  try {
    const [agentsRes, modelsRes] = await Promise.all([
      wsRequest('agents.list', {}),
      wsRequest('models.list', {}).catch(() => null),
    ]);
    
    if (agentsRes?.agents) {
      state.agents = agentsRes.agents;
      if (modelsRes?.models) state.models = modelsRes.models;
      renderAgentsList();
    }
  } catch (e) {
    el.innerHTML = `<div class="list-empty">Error: ${esc(e.message)}</div>`;
  }
}

function renderAgentsList() {
  const el = $('agents-list');
  
  el.innerHTML = state.agents.map(a => {
    const identity = state.agentIdentities[a.id];
    const name = getAgentName(a);
    const about = identity?.about || identity?.description || '';
    const model = a.model || 'default';
    const modelShort = model.split('/').pop().replace(/-\d{8}$/, '');
    const color = AGENT_COLORS[a.id] || 'var(--accent)';
    
    return `
      <div class="list-card" data-agent-id="${esc(a.id)}">
        <div class="list-card-header">
          <div class="agent-avatar" style="background:${color}">${name.charAt(0).toUpperCase()}</div>
          <div class="list-card-header-text">
            <div class="list-card-title">${esc(name)}</div>
            <div class="list-card-sub">${esc(about || a.id)}</div>
          </div>
        </div>
        <div class="list-card-meta">
          <span class="list-card-tag green">ready</span>
          <span class="list-card-tag" style="background:${color}20;color:${color}">${esc(modelShort)}</span>
        </div>
      </div>`;
  }).join('');
  
  el.querySelectorAll('.list-card').forEach(card => {
    card.addEventListener('click', () => {
      selectAgent(card.dataset.agentId);
      switchView('chat');
    });
  });
}

// ─── Status ───
async function loadStatus() {
  const el = $('status-content');
  el.innerHTML = '<div class="list-empty"><div class="loading-spinner"></div>Loading status...</div>';
  
  try {
    const [sessionsRes, cronRes, usageRes, channelsRes] = await Promise.all([
      wsRequest('sessions.list', { includeGlobal: true, limit: 200 }).catch(() => null),
      wsRequest('cron.status', {}).catch(() => null),
      wsRequest('sessions.usage', {}).catch(() => null),
      wsRequest('channels.status', {}).catch(() => null),
    ]);
    
    renderStatusPage({
      sessions: sessionsRes,
      cron: cronRes,
      usage: usageRes,
      channels: channelsRes,
    });
  } catch (e) {
    el.innerHTML = `<div class="list-empty">Error: ${esc(e.message)}</div>`;
  }
}

function renderStatusPage(data) {
  const el = $('status-content');
  const hello = state.hello || {};
  const snapshot = hello.snapshot || {};
  
  // Gateway info from hello/snapshot
  const selfPresence = (snapshot.presence || []).find(p => p.mode === 'gateway');
  const version = hello.version || selfPresence?.version || snapshot.version || '?';
  const uptimeMs = snapshot.uptimeMs || hello.uptimeMs;
  
  // Session stats
  const sessions = data.sessions?.sessions || [];
  const activeSessions = sessions.filter(s => {
    const lastActive = s.lastActiveAt || s.updatedAt;
    if (!lastActive) return false;
    return (Date.now() - new Date(lastActive).getTime()) < 24 * 60 * 60 * 1000;
  });
  
  // Usage stats
  const usage = data.usage || {};
  const totalTokens = usage.totalTokens || usage.tokens || 0;
  const totalCost = usage.totalCost || usage.cost || 0;
  
  // Cron
  const cron = data.cron || {};
  const cronJobs = cron.jobs || cron.entries || [];
  const cronActive = Array.isArray(cronJobs) ? cronJobs.length : 0;
  
  // Channels
  const channels = data.channels;
  
  let html = '';
  
  // Gateway card
  html += `<div class="status-card">
    <h3>⚡ Gateway</h3>
    ${sRow('Version', version)}
    ${sRow('Uptime', uptimeMs ? formatDuration(uptimeMs) : (snapshot.startedAt ? timeAgo(snapshot.startedAt) : '?'))}
    ${sRow('Agents', state.agents.length)}
    ${sRow('Sessions', sessions.length + ' total')}
    ${sRow('Active (24h)', activeSessions.length)}
  </div>`;
  
  // Usage card
  if (totalTokens || totalCost) {
    html += `<div class="status-card">
      <h3>📊 Usage</h3>
      ${totalTokens ? sRow('Tokens', formatNumber(totalTokens)) : ''}
      ${totalCost ? sRow('Cost', '$' + totalCost.toFixed(2)) : ''}
    </div>`;
  }
  
  // Channels card
  if (channels) {
    html += `<div class="status-card">
      <h3>📡 Channels</h3>`;
    if (Array.isArray(channels)) {
      channels.forEach(ch => {
        const statusIcon = ch.connected || ch.status === 'connected' ? '🟢' : '🔴';
        html += sRow(ch.type || ch.name || ch.id || 'unknown', statusIcon + ' ' + (ch.status || 'unknown'));
      });
    } else if (typeof channels === 'object') {
      Object.entries(channels).forEach(([k, v]) => {
        const status = typeof v === 'object' ? (v.connected ? '🟢 connected' : v.status || '?') : v;
        html += sRow(k, status);
      });
    }
    html += '</div>';
  }
  
  // Cron card
  if (cronActive > 0 || cron.nextRun) {
    html += `<div class="status-card">
      <h3>⏰ Cron</h3>
      ${sRow('Active Jobs', cronActive)}
      ${cron.nextRun ? sRow('Next Run', timeAgo(cron.nextRun)) : ''}
    </div>`;
    
    if (Array.isArray(cronJobs) && cronJobs.length > 0) {
      html += `<div class="status-card"><h3>📋 Cron Jobs</h3>`;
      cronJobs.forEach(job => {
        const name = job.name || job.id || 'unnamed';
        const schedule = job.schedule || job.cron || '';
        const lastRun = job.lastRun || job.lastRunAt;
        html += `<div class="cron-job">
          <div class="cron-job-name">${esc(name)}</div>
          <div class="cron-job-detail">${esc(schedule)}${lastRun ? ' · last: ' + timeAgo(lastRun) : ''}</div>
        </div>`;
      });
      html += '</div>';
    }
  }
  
  // Agents card
  html += `<div class="status-card">
    <h3>🤖 Agents</h3>
    ${state.agents.map(a => {
      const name = getAgentName(a);
      const model = (a.model || 'default').split('/').pop().replace(/-\d{8}$/, '');
      const color = AGENT_COLORS[a.id] || 'var(--accent)';
      return sRow(
        `<span style="color:${color}">${esc(name)}</span>`,
        `<span class="list-card-tag green" style="display:inline-block;font-size:0.7rem">ready</span> <span style="color:var(--muted);font-size:0.75rem">${esc(model)}</span>`
      );
    }).join('')}
  </div>`;
  
  // Connection info
  html += `<div class="status-card">
    <h3>🔌 Connection</h3>
    ${sRow('Protocol', hello.protocol || '?')}
    ${sRow('Client', 'Mobile Dashboard')}
    ${sRow('Gateway', GATEWAY_HOST)}
  </div>`;
  
  el.innerHTML = html;
}

function sRow(label, value) {
  return `<div class="status-row"><span class="status-label">${label}</span><span class="status-value">${value}</span></div>`;
}

// ─── Log viewer ───
function appendLogLine(data) {
  if (!data) return;
  const line = typeof data === 'string' ? data : (data.message || data.line || JSON.stringify(data));
  state.logLines.push({ text: line, ts: Date.now(), level: data.level });
  if (state.logLines.length > 500) state.logLines.shift();
  if (state.currentView === 'logs') renderLogs();
}

function renderLogs() {
  const el = $('logs-content');
  if (!el) return;
  el.innerHTML = state.logLines.slice(-100).map(l => {
    const lvl = l.level || 'info';
    const cls = lvl === 'error' ? 'log-error' : lvl === 'warn' ? 'log-warn' : '';
    return `<div class="log-line ${cls}">${esc(l.text)}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

// ─── Helpers ───
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const secs = Math.floor(Math.abs(diff) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(ms) {
  if (typeof ms === 'string') return ms;
  const secs = Math.floor(ms / 1000);
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatBytes(b) {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
  return (b / 1048576).toFixed(1) + 'MB';
}

// ─── Input Handling ───
function autoResize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

function updateSendButton() {
  btnSend.disabled = !chatInput.value.trim() || !state.connected;
}

chatInput.addEventListener('input', () => { autoResize(); updateSendButton(); });
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

btnSend.addEventListener('click', sendMessage);

btnRefresh.addEventListener('click', () => {
  if (state.currentView === 'sessions') loadSessions();
  else if (state.currentView === 'agents') loadAgents();
  else if (state.currentView === 'status') loadStatus();
  else if (state.selectedSessionKey) loadChatHistory(state.selectedSessionKey);
});

// ─── Login ───
loginForm.addEventListener('submit', e => {
  e.preventDefault();
  state.password = loginPassword.value.trim();
  if (!state.password) { loginError.textContent = 'Password required'; return; }
  localStorage.setItem('oc-password', state.password);
  loginError.textContent = '';
  connect();
});

// ─── Init ───
if (state.password) connect();
else showLogin();

})();
