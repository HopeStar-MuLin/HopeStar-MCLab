'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  profiles: [],
  nodes: [],
  status: { state: 'idle' },
  env: null,
  peersTimer: null,
  logTimer: null,
};

// ---------- 基础请求 ----------

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json' };
  // 写请求带自定义头，服务端据此拒绝跨站调用。
  if (method !== 'GET') headers['X-MCLab'] = '1';

  const res = await fetch(path, { ...options, method, headers });
  let data = {};
  try { data = await res.json(); } catch (_) { /* 空响应 */ }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, kind = 'info') {
  const meta = $('roomMeta');
  meta.textContent = msg;
  meta.style.color = kind === 'error' ? 'var(--danger)' : 'var(--muted)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { meta.textContent = ''; }, 6000);
}

// ---------- 渲染 ----------

const STATE_TEXT = {
  idle: ['未连接', 'badge-muted'],
  starting: ['正在建立连接', 'badge-warn'],
  running: ['已连接', 'badge-ok'],
  stopping: ['正在断开', 'badge-warn'],
  failed: ['连接失败', 'badge-err'],
};

function renderStatus(st) {
  state.status = st;

  const [text, cls] = STATE_TEXT[st.state] || STATE_TEXT.idle;
  const badge = $('stateBadge');
  badge.textContent = text;
  badge.className = `badge ${cls}`;

  const connected = st.state === 'running' || st.state === 'starting';
  $('btnLeave').hidden = !connected;
  $('btnHost').disabled = connected;
  $('btnJoin').disabled = connected;

  $('mcAddr').textContent = st.mc_address || '—';
  $('selfIp').textContent = st.self_ip || '—';
  $('uptime').textContent = st.uptime_sec ? formatDuration(st.uptime_sec) : '—';
  $('lanDiscover').textContent = st.state === 'idle' ? '—' : (st.lan_discover ? '已开启' : '未开启');

  if (st.state === 'failed' && st.error) {
    toast(`连接失败: ${st.error}`, 'error');
  }

  syncPeersPolling(connected);
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function renderPeers(list) {
  const ul = $('peerList');
  $('peerCount').textContent = String(list.length);
  if (!list.length) {
    ul.innerHTML = '<li class="empty">暂无连接</li>';
    return;
  }
  ul.innerHTML = list.map((p) => {
    if ((p.cost || '').toLowerCase() === 'local') {
      const name = p.hostname || '本机';
      const nat = p.nat_type ? `<span class="peer-tag">${escapeHtml(p.nat_type)}</span>` : '';
      return `<li><span class="peer-name">${escapeHtml(name)}（本机）</span>
        <span>${nat}</span></li>`;
    }
    const direct = (p.cost || '').toLowerCase() === 'p2p';
    const tag = direct ? '<span class="peer-tag tag-p2p">直连</span>'
                       : '<span class="peer-tag tag-relay">中继</span>';
    const lat = p.latency_ms ? `${Math.round(p.latency_ms)}ms` : '';
    const name = p.hostname || p.ip || 'unknown';
    return `<li><span class="peer-name">${escapeHtml(name)}</span>
      <span>${lat} ${tag}</span></li>`;
  }).join('');
}

function renderProfiles() {
  const sel = $('profileSelect');
  const groups = {};
  for (const p of state.profiles) {
    (groups[p.group] ||= []).push(p);
  }
  sel.innerHTML = Object.entries(groups).map(([g, items]) => `
    <optgroup label="${escapeHtml(g)}">
      ${items.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} — ${escapeHtml(p.desc)}</option>`).join('')}
    </optgroup>`).join('');

  if (state.config) sel.value = state.config.profile || 'auto';
  updateAdvice();
}

function updateAdvice() {
  const id = $('profileSelect').value;
  const p = state.profiles.find((x) => x.id === id);
  $('profileAdvice').textContent = p ? p.advise : '';
  if (p && !p.need_tun) {
    $('profileAdvice').textContent += '（该方案不创建虚拟网卡，MC 连 127.0.0.1:25565）';
  }
}

function renderNodes() {
  const ul = $('nodeList');
  if (!state.nodes.length) {
    ul.innerHTML = '<li class="empty">没有可用节点</li>';
    return;
  }
  ul.innerHTML = state.nodes.map((n) => `
    <li class="${n.enabled ? '' : 'disabled'}" data-id="${n.id}">
      <div class="node-main">
        <div class="node-title">
          ${escapeHtml(n.name)}
          ${n.builtin ? '<span class="pill">官方</span>' : ''}
          <span class="pill ${n.enabled ? 'on' : ''}">${n.enabled ? '启用' : '停用'}</span>
        </div>
        <div class="node-addr">${escapeHtml(n.addr)}</div>
        ${n.note ? `<div class="node-note">${escapeHtml(n.note)}</div>` : ''}
      </div>
      <button class="btn ghost small" data-act="test">测速</button>
      <button class="btn ghost small" data-act="toggle">${n.enabled ? '停用' : '启用'}</button>
      ${n.builtin ? '' : '<button class="btn ghost small" data-act="del">删除</button>'}
    </li>`).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------- 数据加载 ----------

async function loadAll() {
  const [cfg, profiles, nodes, env] = await Promise.all([
    api('/api/config'), api('/api/profiles'), api('/api/nodes'), api('/api/nodeinfo'),
  ]);
  state.config = cfg;
  state.profiles = profiles;
  state.nodes = nodes;
  state.env = env;

  renderProfiles();
  renderNodes();

  if (!$('roomInput').value && cfg.last_room) $('roomInput').value = cfg.last_room;

  const badge = $('envBadge');
  if (env.admin) {
    badge.textContent = '管理员权限';
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = '普通权限';
    badge.className = 'badge badge-warn';
  }
  $('verInfo').textContent =
    `EasyTier ${env.easytier_version || '未检测到'} · ${env.platform} · 虚拟网段 ${env.virtual_cidr}`;

  if (!env.wintun) {
    toast('未找到 wintun.dll，虚拟网卡方案不可用', 'error');
  }
}

async function refreshPeers() {
  if (state.status.state !== 'running' && state.status.state !== 'starting') return;
  try {
    const data = await api('/api/peers');
    renderPeers(data.peers || []);
  } catch (_) { /* 进程切换中，忽略 */ }
}

function syncPeersPolling(on) {
  if (on && !state.peersTimer) {
    state.peersTimer = setInterval(refreshPeers, 3000);
    refreshPeers();
  } else if (!on && state.peersTimer) {
    clearInterval(state.peersTimer);
    state.peersTimer = null;
    renderPeers([]);
  }
}

async function refreshLogs() {
  try {
    const data = await api('/api/logs?tail=300');
    const box = $('logBox');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = (data.lines || []).join('\n');
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch (_) { /* 忽略 */ }
}

// ---------- 操作 ----------

async function join(host) {
  const room = $('roomInput').value.trim();
  const password = $('passInput').value;
  const profile = $('profileSelect').value;

  if (!room) { toast('请填写房间号', 'error'); return; }
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(room)) {
    toast('房间号需为 4-32 位字母、数字、下划线或短横线', 'error');
    return;
  }

  try {
    await api('/api/join', {
      method: 'POST',
      body: JSON.stringify({ room, password, host, profile }),
    });
    toast(host ? '正在创建房间…' : '正在加入房间…');
    setTimeout(refreshLogs, 1200);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function leave() {
  try {
    await api('/api/leave', { method: 'POST', body: '{}' });
    toast('已断开');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 事件绑定 ----------

function bind() {
  $('genRoom').onclick = async () => {
    try {
      const r = await api('/api/room/new');
      $('roomInput').value = r.room;
      toast('已生成房间号，把它发给朋友');
    } catch (e) { toast(e.message, 'error'); }
  };

  $('btnHost').onclick = () => join(true);
  $('btnJoin').onclick = () => join(false);
  $('btnLeave').onclick = leave;

  $('profileSelect').onchange = async () => {
    updateAdvice();
    try {
      await api('/api/config', {
        method: 'PATCH',
        body: JSON.stringify({ profile: $('profileSelect').value }),
      });
    } catch (e) { toast(e.message, 'error'); }
  };

  $('addNode').onclick = async () => {
    const name = $('nodeName').value.trim();
    const addr = $('nodeAddr').value.trim();
    if (!addr) { toast('请填写节点地址', 'error'); return; }
    try {
      state.nodes = await api('/api/nodes', {
        method: 'POST',
        body: JSON.stringify({ name, addr, note: '' }),
      });
      renderNodes();
      $('nodeName').value = '';
      $('nodeAddr').value = '';
      toast('节点已添加');
    } catch (e) { toast(e.message, 'error'); }
  };

  $('nodeList').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const li = btn.closest('li');
    const id = li.dataset.id;
    const act = btn.dataset.act;

    try {
      if (act === 'del') {
        state.nodes = await api(`/api/nodes/${id}`, { method: 'DELETE' });
        renderNodes();
        toast('节点已删除');
      } else if (act === 'toggle') {
        state.nodes = await api(`/api/nodes/${id}/toggle`, { method: 'POST', body: '{}' });
        renderNodes();
      } else if (act === 'test') {
        const node = state.nodes.find((n) => n.id === id);
        btn.disabled = true;
        btn.textContent = '测试中';
        const r = await api('/api/nodes/test', {
          method: 'POST',
          body: JSON.stringify({ addr: node.addr }),
        });
        btn.disabled = false;
        btn.textContent = '测速';
        $('nodeMeta').textContent = r.ok
          ? `${node.addr} 可达，TCP 握手 ${r.latency_ms}ms`
          : `${node.addr} 不可达：${r.error}`;
      }
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = '测速';
    }
  });

  $('btnDiag').onclick = async () => {
    const btn = $('btnDiag');
    btn.disabled = true;
    btn.textContent = '诊断中…';
    try {
      const d = await api('/api/diagnostics');
      $('natType').textContent = d.nat_type || '未知';
      $('tcpNat').textContent = d.tcp_nat_type || '—';
      $('publicIp').textContent = d.public_ip || '—';
      $('natHint').textContent = d.hint || '—';
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '开始诊断';
    }
  };

  $('btnLogRefresh').onclick = refreshLogs;
  $('btnCopyLog').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('logBox').textContent);
      toast('日志已复制');
    } catch (_) { toast('复制失败', 'error'); }
  };

  $('logAuto').onchange = (e) => {
    if (e.target.checked) {
      refreshLogs();
      state.logTimer = setInterval(refreshLogs, 2000);
    } else if (state.logTimer) {
      clearInterval(state.logTimer);
      state.logTimer = null;
    }
  };
}

// ---------- 启动 ----------

async function boot() {
  bind();
  try {
    await loadAll();
  } catch (e) {
    toast('初始化失败: ' + e.message, 'error');
  }

  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => {
    try { renderStatus(JSON.parse(e.data)); } catch (_) { /* 忽略坏帧 */ }
  });
  es.onerror = () => {
    // EventSource 会自动重连，这里只更新徽章避免误导。
    const b = $('stateBadge');
    b.textContent = '服务重连中';
    b.className = 'badge badge-warn';
  };

  refreshLogs();
  state.logTimer = setInterval(refreshLogs, 2000);
}

boot();
