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
  statusData: null,
  healthData: null,
  heartbeatData: null,
  currentView: 'chat',
  chatStreaming: false,
  streamingText: '',
  agentIdentities: {},
};

const GATEWAY_HOST = location.hostname || 'pc1.taildb1204.ts.net';
const GATEWAY_PORT = 18789;
const WS_URL = `wss://${GATEWAY_HOST}:${GATEWAY_PORT}`;

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
        id: 'openclaw-mobile',
        version: 'dev',
        platform: navigator.platform || 'web',
        mode: 'WEBCHAT',
        instanceId: 'mobile-' + Math.random().toString(36).slice(2, 10),
      },
      role: 'operator',
      scopes: ['operator', 'operator.control', 'operator.pairing'],
      device: null,
      caps: [],
      auth: { password: state.password },
      userAgent: navigator.userAgent,
      locale: navigator.language,
    }).then(hello => {
      state.connected = true;
      setConnState('connected');
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
      if (msg.type === 'err' || msg.error) {
        p.reject(new Error(msg.error?.message || msg.message || 'request failed'));
      } else {
        p.resolve(msg.result ?? msg);
      }
    }
  } else if (msg.type === 'event') {
    handleEvent(msg);
  } else if (msg.type === 'stream') {
    handleStream(msg);
  }
}

function handleEvent(msg) {
  // Handle real-time events if needed
  const evt = msg.event;
  if (evt === 'session.message' || evt === 'chat.message') {
    // A new message arrived for current session
    if (msg.data?.sessionKey === state.selectedSessionKey) {
      appendMessageFromEvent(msg.data);
    }
  }
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
    
    if (agentsRes?.agents) {
      state.agents = agentsRes.agents;
      state.defaultAgentId = agentsRes.defaultId || agentsRes.agents[0]?.id;
      state.selectedAgentId = state.defaultAgentId;
      renderAgentSelector();
      
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
    const name = identity?.name || a.id;
    const active = a.id === state.selectedAgentId ? ' active' : '';
    return `<button class="agent-chip${active}" data-agent="${a.id}">${name}</button>`;
  }).join('');
  
  agentSelector.querySelectorAll('.agent-chip').forEach(chip => {
    chip.addEventListener('click', () => selectAgent(chip.dataset.agent));
  });
}

function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  state.selectedSessionKey = null;
  state.chatHistory = [];
  renderAgentSelector();
  chatThread.innerHTML = '<div class="chat-empty">Send a message to start chatting</div>';
  
  // Find or create session for this agent
  loadAgentChat(agentId);
}

async function loadAgentChat(agentId) {
  try {
    // List sessions for this agent
    const res = await wsRequest('sessions.list', { includeGlobal: false });
    if (res?.sessions) {
      // Find recent session for this agent
      const agentSessions = res.sessions.filter(s => 
        s.agentId === agentId && s.channel === 'control'
      );
      
      if (agentSessions.length > 0) {
        // Use most recent
        const session = agentSessions[0];
        state.selectedSessionKey = session.key;
        await loadChatHistory(session.key);
        return;
      }
    }
    // No existing session - ready for new chat
    state.selectedSessionKey = `control:${agentId}:mobile-${Date.now()}`;
  } catch (e) {
    console.error('loadAgentChat', e);
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
    const params = {
      agentId: state.selectedAgentId,
      message: text,
    };
    if (state.selectedSessionKey) {
      params.sessionKey = state.selectedSessionKey;
    }
    
    const res = await wsRequest('chat.send', params);
    
    // If we get a direct response (non-streaming)
    if (res) {
      removeTypingIndicator();
      state.chatStreaming = false;
      
      // The response might contain the session key
      if (res.sessionKey) {
        state.selectedSessionKey = res.sessionKey;
      }
      
      // Response might have message directly
      if (res.text || res.content || res.message) {
        const content = res.text || res.content || (typeof res.message === 'string' ? res.message : res.message?.content || '');
        if (content) {
          const assistantMsg = { role: 'assistant', content, timestamp: Date.now() };
          state.chatHistory.push(assistantMsg);
          // Remove streaming msg if any
          const streamEl = chatThread.querySelector('.streaming-msg');
          if (streamEl) streamEl.remove();
          
          const d = document.createElement('div');
          d.innerHTML = renderMessage(assistantMsg);
          chatThread.appendChild(d.firstElementChild);
          scrollChatToBottom();
        }
      }
      
      // If response has messages array, render the assistant reply
      if (res.messages) {
        for (const m of res.messages) {
          if (m.role === 'assistant') {
            state.chatHistory.push(m);
            const d = document.createElement('div');
            d.innerHTML = renderMessage(m);
            chatThread.appendChild(d.firstElementChild);
          }
        }
        scrollChatToBottom();
      }
    }
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
    const name = identity?.name || a.id;
    const model = a.model || identity?.model || '?';
    const color = AGENT_COLORS[a.id] || 'var(--accent)';
    const status = a.status || 'idle';
    const statusColor = status === 'busy' ? 'orange' : status === 'error' ? 'red' : 'green';
    
    return `
      <div class="list-card" data-agent-id="${escapeHtml(a.id)}">
        <div class="list-card-title" style="color:${color}">${escapeHtml(name)}</div>
        <div class="list-card-sub">${escapeHtml(model)}</div>
        <div class="list-card-meta">
          <span class="list-card-tag ${statusColor}">${escapeHtml(status)}</span>
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
  
  let html = '';
  
  // Gateway info
  html += `<div class="status-card">
    <h3>⚡ Gateway</h3>
    ${statusRow('Version', s.version || '?')}
    ${statusRow('Uptime', s.uptime ? formatDuration(s.uptime) : '?')}
    ${statusRow('Mode', s.mode || '?')}
    ${statusRow('Agents', s.agents?.length || state.agents.length || '?')}
  </div>`;
  
  // Health
  if (h) {
    html += `<div class="status-card">
      <h3>💚 Health</h3>
      ${statusRow('Status', h.status || h.ok ? '✅ OK' : '⚠️ Issues')}
      ${h.memory ? statusRow('Memory', formatBytes(h.memory.rss || h.memory.heapUsed || 0)) : ''}
      ${h.cpu ? statusRow('CPU', (h.cpu.usage || 0).toFixed(1) + '%') : ''}
    </div>`;
  }
  
  // Heartbeat
  if (state.heartbeatData) {
    const hb = state.heartbeatData;
    html += `<div class="status-card">
      <h3>💓 Last Heartbeat</h3>
      ${statusRow('Agent', hb.agentId || '?')}
      ${statusRow('Time', hb.at ? timeAgo(hb.at) : '?')}
    </div>`;
  }
  
  // Agents summary
  html += `<div class="status-card">
    <h3>🤖 Agents</h3>
    ${state.agents.map(a => {
      const identity = state.agentIdentities[a.id];
      const name = identity?.name || a.id;
      const status = a.status || 'idle';
      return statusRow(name, `<span class="list-card-tag ${status === 'busy' ? 'orange' : 'green'}" style="display:inline-block">${status}</span>`);
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
