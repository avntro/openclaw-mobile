// OpenClaw Mobile Dashboard
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
  statusData: null,
  healthData: null,
  heartbeatData: null,
  currentView: 'chat',
  chatStreaming: false,
  streamingText: '',
  agentIdentities: {},
  // Per-agent chat history cache
  agentChatCache: {},
};

// Build the session key for an agent (matches gateway convention)
function agentSessionKey(agentId) {
  return `agent:${agentId}:mobile`;
}

const GATEWAY_HOST = location.hostname || 'pc1.taildb1204.ts.net';
const GATEWAY_PORT = 443;
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
    // Send connect/auth (must match gateway protocol schema)
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
      // Keepalive ping every 15s to prevent idle disconnect
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
      showLogin('Connection rejected');
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
    // Skip connect.challenge events (handled by protocol)
    if (msg.event === 'connect.challenge') return;
    handleEvent(msg);
  } else if (msg.type === 'stream') {
    handleStream(msg);
  }
}

function handleEvent(msg) {
  const evt = msg.event;
  const data = msg.payload || msg.data;
  
  if (evt === 'chat') {
    handleChatEvent(data);
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
  
  // Track session key from response
  if (data.sessionKey && state.chatStreaming) {
    state.selectedSessionKey = data.sessionKey;
  }
  
  // Check if this event is for our session
  // Allow if no session key filter or if it matches
  if (data.sessionKey && state.selectedSessionKey && 
      data.sessionKey !== state.selectedSessionKey) {
    return;
  }
  
  // Check runId if we have one
  if (data.runId && state.chatRunId && data.runId !== state.chatRunId) {
    if (data.state === 'final') return;
    return;
  }
  
  if (data.state === 'delta') {
    const text = extractMessageText(data.message);
    if (typeof text === 'string') {
      const current = state.streamingText || '';
      if (!current || text.length >= current.length) {
        state.streamingText = text;
      }
      updateStreamingMessage();
    }
  } else if (data.state === 'final') {
    state.chatStreaming = false;
    state.chatRunId = null;
    finalizeStreamingMessage();
    // Reload full history to get the complete message
    if (state.selectedSessionKey) {
      loadChatHistory(state.selectedSessionKey);
    }
  } else if (data.state === 'error') {
    state.chatStreaming = false;
    state.chatRunId = null;
    removeTypingIndicator();
    const streamEl = chatThread.querySelector('.streaming-msg');
    if (streamEl) streamEl.remove();
    const errDiv = document.createElement('div');
    errDiv.className = 'chat-msg system';
    errDiv.textContent = `Error: ${data.errorMessage || 'chat error'}`;
    chatThread.appendChild(errDiv);
    scrollChatToBottom();
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
    const texts = content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

function handleStream(msg) {
  // Handle streaming chat responses
  if (msg.event === 'chat.delta' || msg.delta) {
    const delta = msg.delta || msg.data?.delta || '';
    if (delta) {
      state.streamingText += delta;
      updateStreamingMessage();
    }
  }
  if (msg.event === 'chat.done' || msg.done) {
    state.chatStreaming = false;
    finalizeStreamingMessage();
  }
}

function wsRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('not connected'));
    }
    const id = `m${++state.reqId}`;
    state.pending[id] = { resolve, reject };
    state.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    // Timeout
    setTimeout(() => {
      if (state.pending[id]) {
        delete state.pending[id];
        reject(new Error('timeout'));
      }
    }, 30000);
  });
}

// ─── Connection State UI ───
function setConnState(s) {
  connStatus.className = 'topbar-status ' + (s === 'connected' ? '' : s);
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
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    switchView(view);
  });
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
    const [agentsRes] = await Promise.all([
      wsRequest('agents.list', {}),
    ]);
    
    console.log('[mobile] agents.list response:', JSON.stringify(agentsRes));
    if (agentsRes?.agents) {
      state.agents = agentsRes.agents;
      state.defaultAgentId = agentsRes.defaultId || agentsRes.agents[0]?.id;
      state.selectedAgentId = state.defaultAgentId;
      state.selectedSessionKey = agentSessionKey(state.selectedAgentId);
      renderAgentSelector();
      // Load chat history for the default agent
      loadChatHistory(state.selectedSessionKey);
      
      // Load identities
      for (const a of state.agents) {
        wsRequest('agent.identity.get', { agentId: a.id }).then(identity => {
          if (identity) {
            state.agentIdentities[a.id] = identity;
            renderAgentSelector();
          }
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

function renderAgentSelector() {
  agentSelector.innerHTML = state.agents.map(a => {
    const identity = state.agentIdentities[a.id];
    const name = a.name || identity?.name || a.identity?.name || a.id;
    const active = a.id === state.selectedAgentId ? ' active' : '';
    const color = AGENT_COLORS[a.id] || 'var(--accent)';
    return `<button class="agent-chip${active}" data-agent="${a.id}" style="${active ? `background:${color};color:#fff` : ''}">${escapeHtml(name)}</button>`;
  }).join('');
  
  agentSelector.querySelectorAll('.agent-chip').forEach(chip => {
    chip.addEventListener('click', () => selectAgent(chip.dataset.agent));
  });
}

function selectAgent(agentId) {
  // Save current chat to cache
  if (state.selectedAgentId && state.selectedSessionKey) {
    state.agentChatCache[state.selectedAgentId] = {
      sessionKey: state.selectedSessionKey,
      history: [...state.chatHistory],
    };
  }
  
  state.selectedAgentId = agentId;
  state.selectedSessionKey = agentSessionKey(agentId);
  renderAgentSelector();
  
  // Restore from cache if available
  const cached = state.agentChatCache[agentId];
  if (cached && cached.sessionKey === state.selectedSessionKey && cached.history.length > 0) {
    state.chatHistory = cached.history;
    renderChat();
  } else {
    state.chatHistory = [];
    chatThread.innerHTML = '<div class="chat-empty">Loading...</div>';
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
    // Session might not support history
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
    return `<div class="chat-msg system">${escapeHtml(truncateText(msg.content || '', 200))}</div>`;
  }
  
  const content = formatMessageContent(msg.content || '');
  const time = msg.timestamp ? formatTime(msg.timestamp) : '';
  const meta = time ? `<div class="msg-meta">${time}</div>` : '';
  
  return `<div class="chat-msg ${role}">${content}${meta}</div>`;
}

function formatMessageContent(text) {
  // Strip thinking tags
  text = text.replace(/<\/?(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi, '');
  text = text.trim();
  if (!text) return '<em>thinking...</em>';
  
  // Basic markdown: code blocks, inline code, bold, italic, links
  // Code blocks
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => 
    `<pre><code>${escapeHtml(code.trim())}</code></pre>`
  );
  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Line breaks (but not inside pre)
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

function updateStreamingMessage() {
  let el = chatThread.querySelector('.streaming-msg');
  if (!el) {
    el = document.createElement('div');
    el.className = 'chat-msg assistant streaming-msg';
    chatThread.appendChild(el);
  }
  el.innerHTML = formatMessageContent(state.streamingText);
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
  el.textContent = 'Thinking...';
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
  
  // Show user message immediately
  const userMsg = { role: 'user', content: text, timestamp: Date.now() };
  state.chatHistory.push(userMsg);
  
  // Clear empty state
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
    
    const params = {
      message: text,
      deliver: false,
      idempotencyKey,
      sessionKey: state.selectedSessionKey || agentSessionKey(state.selectedAgentId || 'main'),
    };
    
    const res = await wsRequest('chat.send', params);
    
    // chat.send returns an ack - the actual response comes via 'chat' events
    // Track the session key from the response
    if (res?.sessionKey) {
      state.selectedSessionKey = res.sessionKey;
    }
    
    // The response is just an ack; content arrives via handleChatEvent
    // If no streaming starts within 60s, the timeout in wsRequest handles it
  } catch (e) {
    removeTypingIndicator();
    state.chatStreaming = false;
    console.error('chat.send failed', e);
    // Show error
    const errDiv = document.createElement('div');
    errDiv.className = 'chat-msg system';
    errDiv.textContent = `Error: ${e.message}`;
    chatThread.appendChild(errDiv);
    scrollChatToBottom();
  }
  
  updateSendButton();
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    chatThread.scrollTop = chatThread.scrollHeight;
  });
}

// ─── Sessions ───
async function loadSessions() {
  try {
    const res = await wsRequest('sessions.list', { includeGlobal: true, limit: 50 });
    if (res?.sessions) {
      state.sessions = res.sessions;
      renderSessions();
    }
  } catch (e) {
    $('sessions-list').innerHTML = `<div class="list-empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderSessions() {
  const el = $('sessions-list');
  if (state.sessions.length === 0) {
    el.innerHTML = '<div class="list-empty">No sessions found</div>';
    return;
  }
  
  el.innerHTML = state.sessions.map(s => {
    const label = s.label || s.key || 'Unknown';
    const agent = s.agentId || '?';
    const channel = s.channel || '?';
    const lastActive = s.lastActiveAt ? timeAgo(s.lastActiveAt) : 'unknown';
    const msgs = s.messageCount ?? s.turns ?? '?';
    
    const agentColor = AGENT_COLORS[agent] || 'var(--accent)';
    
    return `
      <div class="list-card" data-session-key="${escapeHtml(s.key || '')}">
        <div class="list-card-title">${escapeHtml(truncateText(label, 60))}</div>
        <div class="list-card-sub">${escapeHtml(channel)} · ${lastActive}</div>
        <div class="list-card-meta">
          <span class="list-card-tag" style="background:${agentColor}20;color:${agentColor}">${escapeHtml(agent)}</span>
          <span class="list-card-tag blue">${msgs} msgs</span>
        </div>
      </div>
    `;
  }).join('');
  
  // Click to load session in chat
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
  try {
    const res = await wsRequest('agents.list', {});
    if (res?.agents) {
      state.agents = res.agents;
      renderAgentsList();
    }
  } catch (e) {
    $('agents-list').innerHTML = `<div class="list-empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderAgentsList() {
  const el = $('agents-list');
  el.innerHTML = state.agents.map(a => {
    const identity = state.agentIdentities[a.id];
    const name = a.name || identity?.name || a.id;
    const description = identity?.about || identity?.description || a.name || a.id;
    const color = AGENT_COLORS[a.id] || 'var(--accent)';
    
    return `
      <div class="list-card" data-agent-id="${escapeHtml(a.id)}">
        <div class="list-card-title" style="color:${color}">${escapeHtml(name)}</div>
        <div class="list-card-sub">${escapeHtml(description)}</div>
        <div class="list-card-meta">
          <span class="list-card-tag green">ready</span>
          <span class="list-card-tag" style="background:${color}20;color:${color}">${escapeHtml(a.id)}</span>
        </div>
      </div>
    `;
  }).join('');
  
  el.querySelectorAll('.list-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.agentId;
      selectAgent(id);
      switchView('chat');
    });
  });
}

// ─── Status ───
async function loadStatus() {
  try {
    const [status, health, heartbeat] = await Promise.all([
      wsRequest('status', {}),
      wsRequest('health', {}).catch(() => null),
      wsRequest('last-heartbeat', {}).catch(() => null),
    ]);
    
    state.statusData = status;
    state.healthData = health;
    state.heartbeatData = heartbeat;
    renderStatus();
  } catch (e) {
    $('status-content').innerHTML = `<div class="list-empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderStatus() {
  const el = $('status-content');
  const s = state.statusData || {};
  const h = state.healthData || {};
  const hello = state.hello || {};
  const snapshot = hello.snapshot || {};
  
  // Resolve version from presence entries or hello
  const selfPresence = (snapshot.presence || []).find(p => p.mode === 'gateway');
  const version = selfPresence?.version || hello.version || 'unknown';
  const uptimeMs = snapshot.uptimeMs;
  const mode = selfPresence?.mode || 'gateway';
  
  let html = '';
  
  // Gateway info
  html += `<div class="status-card">
    <h3>⚡ Gateway</h3>
    ${statusRow('Version', version)}
    ${statusRow('Uptime', uptimeMs ? formatDuration(uptimeMs) : 'n/a')}
    ${statusRow('Mode', mode)}
    ${statusRow('Agents', state.agents.length || '?')}
  </div>`;
  
  // Health
  if (h) {
    const isOk = h.status === 'ok' || h.ok || (h.memory && !h.error);
    html += `<div class="status-card">
      <h3>💚 Health</h3>
      ${statusRow('Status', isOk ? '✅ OK' : '⚠️ Issues')}
      ${h.memory ? statusRow('Memory', formatBytes(h.memory.rss || h.memory.heapUsed || 0)) : ''}
      ${h.cpu ? statusRow('CPU', (h.cpu.usage || 0).toFixed(1) + '%') : ''}
    </div>`;
  }
  
  // Heartbeat
  if (state.heartbeatData) {
    const hb = state.heartbeatData;
    html += `<div class="status-card">
      <h3>💓 Last Heartbeat</h3>
      ${statusRow('Agent', hb.agentId || 'n/a')}
      ${statusRow('Time', hb.at ? timeAgo(hb.at) : (hb.ts ? timeAgo(hb.ts) : 'n/a'))}
    </div>`;
  }
  
  // Agents summary
  html += `<div class="status-card">
    <h3>🤖 Agents</h3>
    ${state.agents.map(a => {
      const identity = state.agentIdentities[a.id];
      const name = a.name || identity?.name || a.id;
      return statusRow(name, `<span class="list-card-tag green" style="display:inline-block">ready</span>`);
    }).join('')}
  </div>`;
  
  el.innerHTML = html;
}

function statusRow(label, value) {
  return `<div class="status-row"><span class="status-label">${label}</span><span class="status-value">${value}</span></div>`;
}

// ─── Helpers ───
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function truncateText(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

chatInput.addEventListener('input', () => {
  autoResize();
  updateSendButton();
});

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
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
if (state.password) {
  connect();
} else {
  showLogin();
}

})();
