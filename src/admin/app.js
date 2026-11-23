const root = document.getElementById('root');
const TOKEN_KEY = 'dshm.token';
const state = { token: localStorage.getItem(TOKEN_KEY) || '', user: null, view: 'overview', pending: 0, categories: [], labels: [] };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const zh = (meta) => meta?.title?.zh || meta?.title?.en || '';
const ACTION = {
  'release.publish': '发布', 'release.approve': '上架', 'release.reject': '拒绝', 'release.yank': '下架',
  'category.create': '新建分类', 'category.update': '改分类', 'category.archive': '归档分类',
  'plugin.recategorize': '改插件分类', 'plugin.label': '改标签',
  'user.create': '新建用户', 'user.update': '改用户', 'user.token': '签发 token', 'user.password': '重置密码',
  'token.revoke': '作废 token', 'settings.update': '改设置',
};
const fmtDetail = (v) => {
  if (!v) return '—';
  let text = v;
  try { text = JSON.stringify(JSON.parse(v)); } catch { /* 原样 */ }
  return text.length > 140 ? text.slice(0, 140) + '…' : text;
};

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && state.token) headers.authorization = 'Bearer ' + state.token;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && auth) { logout(); throw new Error('登录已失效，请重新登录'); }
    throw new Error((data && data.error) || 'HTTP ' + res.status);
  }
  return data;
}

/* ------------------------------ 登录与外壳 ------------------------------ */

function loginView(message = '') {
  root.innerHTML = `<div class="login"><form id="loginForm">
    <h1>DSH 插件市场 · 管理端</h1>
    <p>用市场账号登录</p>
    ${message ? `<div class="tag danger">${esc(message)}</div>` : ''}
    <label>用户名<input name="name" required autofocus autocomplete="username"></label>
    <label>密码<input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn primary" type="submit">登录</button>
  </form></div>`;
  root.querySelector('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const out = await api('/api/v1/auth/login', { method: 'POST', auth: false, body: { name: fd.get('name'), password: fd.get('password') } });
      state.token = out.token;
      state.user = out.user;
      localStorage.setItem(TOKEN_KEY, out.token);
      await boot();
    } catch (err) { loginView(err.message); }
  });
}

function logout() {
  state.token = ''; state.user = null;
  localStorage.removeItem(TOKEN_KEY);
  loginView();
}

const NAV = [['overview', '概览'], ['pending', '待审核'], ['plugins', '插件'], ['categories', '分类'], ['labels', '标签'], ['users', '用户'], ['tokens', 'Token'], ['audit', '审计'], ['settings', '设置']];
const TITLES = Object.fromEntries(NAV);

function shell() {
  root.innerHTML = `<div class="shell"><aside>
    <div class="brand">DSH 市场<small>一体化私有服务</small></div>
    <nav>${NAV.map(([k, label]) => `<button data-view="${k}" class="${state.view === k ? 'on' : ''}">${label}${k === 'pending' && state.pending ? `<span class="count">${state.pending}</span>` : ''}</button>`).join('')}</nav>
    </aside><main>
      <header class="top"><h1 id="pageTitle"></h1>
        <div class="who"><span>${esc(state.user?.name)} · ${esc(state.user?.role)}</span>
          <a href="/api/v1/index.json" target="_blank" rel="noreferrer">索引 JSON</a>
          <button class="btn sm" id="logout">退出</button></div>
      </header><div id="view"></div></main></div>`;
  root.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view; shell(); route();
  }));
  root.querySelector('#logout').addEventListener('click', logout);
}

async function route() {
  root.querySelector('#pageTitle').textContent = TITLES[state.view] ?? '';
  const box = root.querySelector('#view');
  box.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const fn = { overview: viewOverview, pending: viewPending, plugins: viewPlugins, categories: viewCategories, labels: viewLabels, users: viewUsers, tokens: viewTokens, audit: viewAudit, settings: viewSettings }[state.view];
    await fn(box);
  } catch (e) {
    box.innerHTML = `<div class="panel"><div class="empty">${esc(e.message)}</div></div>`;
  }
}

/* -------------------------------- 弹窗 -------------------------------- */

function modal({ title, fields, submitText = '保存', onSubmit }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><form class="body">
    ${fields.map((f) => `<label>${esc(f.label)}${f.type === 'select'
      ? `<select name="${f.name}" ${f.required ? 'required' : ''}>${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
      : `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`}</label>`).join('')}
    </form><div class="foot"><button class="btn" data-cancel>取消</button><button class="btn primary" data-ok>${esc(submitText)}</button></div></div>`;
  document.body.append(back);
  const close = () => back.remove();
  back.querySelector('[data-cancel]').addEventListener('click', close);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.querySelector('[data-ok]').addEventListener('click', async () => {
    const btn = back.querySelector('[data-ok]');
    const values = Object.fromEntries(new FormData(back.querySelector('form')).entries());
    btn.disabled = true;
    try { await onSubmit(values); close(); } catch (e) { toast(e.message, true); btn.disabled = false; }
  });
  return back;
}

/* -------------------------------- 概览 -------------------------------- */

async function viewOverview(box) {
  const [stats, audit] = await Promise.all([api('/api/v1/stats'), api('/api/v1/audit?limit=8')]);
  box.innerHTML = `<div class="cards">
    ${[['插件', stats.plugins], ['已上架版本', stats.published], ['待审核', stats.pending], ['分类', stats.categories], ['用户', stats.users]]
      .map(([k, v]) => `<div class="card"><b>${v}</b><span>${k}</span></div>`).join('')}
    </div>
    <div class="panel"><div class="bar"><h2>最近操作</h2><span class="muted">${stats.pending ? stats.pending + ' 个版本等待审核' : '暂无待审'}</span></div>
    ${auditTable(audit.entries)}</div>`;
}

function auditTable(entries) {
  if (!entries.length) return '<div class="empty">还没有操作记录</div>';
  return `<table><thead><tr><th>时间</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody>
    ${entries.map((a) => `<tr><td class="mono">${fmtTime(a.at)}</td><td>${esc(a.action)}</td>
      <td class="mono">${esc(a.target ?? '—')}</td><td class="desc">${esc(a.detail ?? '')}</td></tr>`).join('')}
    </tbody></table>`;
}

/* -------------------------------- 待审核 ------------------------------- */

async function viewPending(box) {
  const { releases } = await api('/api/v1/releases?status=pending');
  state.pending = releases.length;
  box.innerHTML = `<div class="panel"><div class="bar"><h2>待审核版本</h2><span class="muted">上架后才进入索引</span></div>
    ${!releases.length ? '<div class="empty">没有待审核的版本</div>' : `<table>
      <thead><tr><th>插件</th><th>版本</th><th>发布人</th><th>体积</th><th>时间</th><th></th></tr></thead><tbody>
      ${releases.map((r) => `<tr>
        <td><div>${esc(zh(r.meta))}</div><div class="mono muted">${esc(r.name)}</div></td>
        <td class="mono">${esc(r.version)}</td><td class="mono">${esc(r.createdBy ?? '—')}</td>
        <td class="mono">${fmtBytes(r.bytes)}</td><td class="mono">${fmtTime(r.createdAt)}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn sm primary" data-approve="${r.id}">上架</button>
          <button class="btn sm danger" data-reject="${r.id}">拒绝</button></td></tr>`).join('')}
      </tbody></table>`}</div>`;

  box.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api(`/api/v1/releases/${b.dataset.approve}/approve`, { method: 'POST' });
      toast('已上架');
      await refreshBadge();
      route();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
  box.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => {
    modal({
      title: '拒绝发布', submitText: '确认拒绝',
      fields: [{ name: 'reason', label: '原因（会回显给发布者）', required: true }],
      onSubmit: async ({ reason }) => {
        await api(`/api/v1/releases/${b.dataset.reject}/reject`, { method: 'POST', body: { reason } });
        toast('已拒绝'); await refreshBadge(); route();
      },
    });
  }));
}

/* -------------------------------- 插件 -------------------------------- */

async function viewPlugins(box) {
  const [{ plugins }, cats] = await Promise.all([api('/api/v1/plugins'), api('/api/v1/categories')]);
  state.categories = cats.categories;
  const catName = (id) => state.categories.find((c) => c.id === id)?.title_zh ?? id;
  box.innerHTML = `<div class="panel"><div class="bar"><h2>全部插件</h2><span class="muted">改分类/标签不用重新发版</span></div>
    ${!plugins.length ? '<div class="empty">还没有插件，去发一个吧</div>' : `<table>
      <thead><tr><th>插件</th><th>分类</th><th>标签</th><th>版本</th><th></th></tr></thead><tbody>
      ${plugins.map((p) => `<tr>
        <td><div>${esc(zh(p.meta))}</div><div class="mono muted">${esc(p.name)}</div></td>
        <td><span class="tag">${esc(catName(p.category))}</span></td>
        <td>${(p.labels || []).map((l) => `<span class="tag">${esc(l)}</span>`).join('') || '<span class="muted">—</span>'}</td>
        <td class="mono">${p.versions.map((v) => `${esc(v.version)}<span class="muted">/${esc(v.status)}</span>`).join('<br>')}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn sm" data-edit="${esc(p.name)}">编辑</button></td></tr>`).join('')}
      </tbody></table>`}</div>`;

  box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
    const name = b.dataset.edit;
    const one = await api('/api/v1/plugins/' + encodeURIComponent(name));
    const labels = (await api('/api/v1/labels')).labels;
    modal({
      title: name, submitText: '保存',
      fields: [
        { name: 'category', label: '分类', type: 'select', value: one.category, options: state.categories.map((c) => ({ value: c.id, label: c.title_zh })) },
        { name: 'labels', label: `标签（逗号分隔，可选：${labels.map((l) => l.id).join(' / ')}）`, value: (one.labels || []).join(',') },
      ],
      onSubmit: async (v) => {
        await api('/api/v1/plugins/' + encodeURIComponent(name), {
          method: 'PATCH',
          body: { category: v.category, labels: String(v.labels || '').split(',').map((s) => s.trim()).filter(Boolean) },
        });
        toast('已保存并重建索引'); route();
      },
    });
  }));
}

/* -------------------------------- 分类 -------------------------------- */

async function viewCategories(box) {
  const { categories } = await api('/api/v1/categories?all=1');
  box.innerHTML = `<div class="panel"><div class="bar"><h2>分类</h2>
      <button class="btn sm primary" id="newCat">新建分类</button></div>
    <table><thead><tr><th>ID</th><th>中文</th><th>English</th><th>排序</th><th>允许的 scope</th><th>状态</th><th></th></tr></thead><tbody>
    ${categories.map((c) => `<tr>
      <td class="mono">${esc(c.id)}${c.is_default ? ' <span class="tag ok">兜底</span>' : ''}</td>
      <td>${esc(c.title_zh)}</td><td>${esc(c.title_en)}</td><td class="mono">${c.sort}</td>
      <td class="mono">${(c.allowed_scopes || []).join(' ') || '<span class="muted">不限</span>'}</td>
      <td>${c.status === 'active' ? '<span class="tag ok">启用</span>' : '<span class="tag">已归档</span>'}</td>
      <td style="text-align:right">${c.is_default ? '' : `<button class="btn sm danger" data-archive="${esc(c.id)}">归档</button>`}</td>
    </tr>`).join('')}</tbody></table></div>`;

  box.querySelector('#newCat').addEventListener('click', () => modal({
    title: '新建分类', submitText: '创建',
    fields: [
      { name: 'id', label: 'ID（小写字母/数字/横线，创建后不可改）', required: true },
      { name: 'titleZh', label: '中文标题', required: true },
      { name: 'titleEn', label: 'English title', required: true },
      { name: 'sort', label: '排序（小在前）', value: '100' },
      { name: 'scopes', label: '允许发布的 scope（逗号分隔，留空=所有人）', placeholder: '@team-a/' },
    ],
    onSubmit: async (v) => {
      await api('/api/v1/categories', { method: 'POST', body: {
        id: v.id, titleZh: v.titleZh, titleEn: v.titleEn, sort: Number(v.sort) || 100,
        allowedScopes: String(v.scopes || '').split(',').map((s) => s.trim()).filter(Boolean),
      } });
      toast('已创建'); route();
    },
  }));

  box.querySelectorAll('[data-archive]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm(`归档分类「${b.dataset.archive}」？该分类下的插件会自动迁到「通用插件」，索引会重建。`)) return;
    api('/api/v1/categories/' + encodeURIComponent(b.dataset.archive), { method: 'DELETE' })
      .then((out) => { toast(`已归档，迁移 ${out.moved} 个插件`); route(); })
      .catch((e) => toast(e.message, true));
  }));
}

/* -------------------------------- 标签 -------------------------------- */

async function viewLabels(box) {
  const { labels } = await api('/api/v1/labels');
  box.innerHTML = `<div class="panel"><div class="bar"><h2>标签字典</h2>
      <button class="btn sm primary" id="newLabel">新建标签</button></div>
    <table><thead><tr><th>ID</th><th>中文</th><th>English</th></tr></thead><tbody>
    ${labels.map((l) => `<tr><td class="mono">${esc(l.id)}</td><td>${esc(l.title_zh)}</td><td>${esc(l.title_en)}</td></tr>`).join('')
      || '<tr><td colspan="3" class="empty">还没有标签</td></tr>'}
    </tbody></table></div>`;

  box.querySelector('#newLabel').addEventListener('click', () => modal({
    title: '新建标签', submitText: '创建',
    fields: [{ name: 'id', label: 'ID（小写字母/数字/横线）', required: true }, { name: 'titleZh', label: '中文标题', required: true }, { name: 'titleEn', label: 'English title', required: true }],
    onSubmit: async (v) => {
      await api('/api/v1/labels', { method: 'POST', body: { id: v.id, titleZh: v.titleZh, titleEn: v.titleEn } });
      toast('已创建'); route();
    },
  }));
}

/* -------------------------------- 用户 -------------------------------- */

async function viewUsers(box) {
  const { users } = await api('/api/v1/users');
  box.innerHTML = `<div class="panel"><div class="bar"><h2>用户</h2>
      <button class="btn sm primary" id="newUser">新建用户</button></div>
    <table><thead><tr><th>用户名</th><th>角色</th><th>scope</th><th>状态</th><th>有效 token</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr>
      <td class="mono">${esc(u.name)}</td><td>${esc(u.role)}</td>
      <td class="mono">${esc(u.scope ?? '—')}</td>
      <td>${u.status === 'active' ? '<span class="tag ok">启用</span>' : '<span class="tag danger">停用</span>'}</td>
      <td class="mono">${u.active_tokens}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn sm" data-edit="${u.id}">编辑</button>
        <button class="btn sm" data-tokens="${u.id}" data-name="${esc(u.name)}">Tokens</button>
        <button class="btn sm" data-pass="${u.id}">重置密码</button></td></tr>`).join('')}
    </tbody></table></div>`;

  box.querySelector('#newUser').addEventListener('click', () => modal({
    title: '新建用户', submitText: '创建',
    fields: [
      { name: 'name', label: '用户名（小写字母/数字）', required: true },
      { name: 'role', label: '角色', type: 'select', value: 'publisher', options: [{ value: 'publisher', label: 'publisher（可发布）' }, { value: 'viewer', label: 'viewer（只读）' }, { value: 'admin', label: 'admin（管理员）' }] },
      { name: 'scope', label: 'scope（留空=只能靠 admin 发）', placeholder: '@team-a/' },
      { name: 'password', label: '初始密码（可空，之后用 token）', type: 'password' },
    ],
    onSubmit: async (v) => {
      const out = await api('/api/v1/users', { method: 'POST', body: { ...v, withToken: true } });
      toast('已创建');
      if (out.token) showToken(out.token);
      route();
    },
  }));

  box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const u = users.find((x) => x.id === b.dataset.edit);
    modal({
      title: '编辑 ' + u.name, submitText: '保存',
      fields: [
        { name: 'role', label: '角色', type: 'select', value: u.role, options: [{ value: 'publisher', label: 'publisher' }, { value: 'viewer', label: 'viewer' }, { value: 'admin', label: 'admin' }] },
        { name: 'scope', label: 'scope（留空清除）', value: u.scope ?? '', placeholder: '@team-a/' },
        { name: 'status', label: '状态', type: 'select', value: u.status, options: [{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }] },
      ],
      onSubmit: async (v) => {
        await api('/api/v1/users/' + u.id, { method: 'PATCH', body: { role: v.role, scope: v.scope || null, status: v.status } });
        toast('已保存'); route();
      },
    });
  }));

  box.querySelectorAll('[data-tokens]').forEach((b) => b.addEventListener('click', () => tokenPanel(b.dataset.tokens, b.dataset.name)));

  box.querySelectorAll('[data-pass]').forEach((b) => b.addEventListener('click', () => modal({
    title: '重置密码', submitText: '重置',
    fields: [{ name: 'password', label: '新密码（至少 6 位）', type: 'password', required: true }],
    onSubmit: async (v) => {
      await api(`/api/v1/users/${b.dataset.pass}/password`, { method: 'POST', body: { password: v.password } });
      toast('已重置，并作废旧 token');
    },
  })));
}

function showToken(token) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal"><h3>Token（只显示这一次）</h3>
    <div class="body"><div class="tokenbox">${esc(token)}</div>
      <p class="muted" style="margin:0;font-size:12px">给 DSH 插件或 CLI 用：<code>Authorization: Bearer &lt;token&gt;</code></p></div>
    <div class="foot"><button class="btn primary" data-ok>我已保存</button></div></div>`;
  document.body.append(back);
  back.querySelector('[data-ok]').addEventListener('click', () => back.remove());
}

/* -------------------------------- 审计 -------------------------------- */

async function viewAudit(box) {
  const { entries } = await api('/api/v1/audit?limit=200');
  box.innerHTML = `<div class="panel"><div class="bar"><h2>审计日志</h2><span class="muted">最近 200 条</span></div>${auditTable(entries)}</div>`;
}

/* -------------------------------- Token -------------------------------- */

async function viewTokens(box) {
  const [{ tokens }, { users }] = await Promise.all([api('/api/v1/tokens'), api('/api/v1/users')]);
  box.innerHTML = `<div class="panel"><div class="bar"><h2>全部 Token</h2>
      <button class="btn sm primary" id="issueToken">签发新 token</button></div>
    ${!tokens.length ? '<div class="empty">还没有 token</div>' : `<table>
      <thead><tr><th>用户</th><th>用途</th><th>创建</th><th>最后使用</th><th>状态</th><th></th></tr></thead><tbody>
      ${tokens.map((t) => `<tr>
        <td class="mono">${esc(t.user_name)}</td>
        <td>${esc(t.label || '—')}</td>
        <td class="mono">${fmtTime(t.created_at)}</td>
        <td class="mono">${fmtTime(t.last_used_at)}</td>
        <td>${t.revoked_at ? '<span class="tag danger">已作废</span>' : '<span class="tag ok">有效</span>'}</td>
        <td style="text-align:right">${t.revoked_at ? '' : `<button class="btn sm danger" data-revoke="${t.id}">作废</button>`}</td>
      </tr>`).join('')}</tbody></table>`}</div>`;

  box.querySelector('#issueToken').addEventListener('click', () => modal({
    title: '签发新 token', submitText: '签发',
    fields: [
      { name: 'userId', label: '用户', type: 'select', options: users.map((u) => ({ value: u.id, label: `${u.name}（${u.role}）` })) },
      { name: 'label', label: '用途（便于以后识别，如 dsh-web / ci）', value: 'dsh-web' },
    ],
    onSubmit: async (v) => {
      const out = await api(`/api/v1/users/${v.userId}/token`, { method: 'POST', body: { label: v.label } });
      showToken(out.token);
      route();
    },
  }));

  box.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('作废后该 token 立即失效，不可恢复。确定？')) return;
    await api(`/api/v1/tokens/${b.dataset.revoke}/revoke`, { method: 'POST' });
    toast('已作废');
    route();
  }));
}

async function tokenPanel(userId, name) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  document.body.append(back);
  const close = () => back.remove();
  const render = async () => {
    const { tokens } = await api('/api/v1/tokens?userId=' + encodeURIComponent(userId));
    back.innerHTML = `<div class="modal"><h3>${esc(name)} 的 token</h3>
      <div class="body">
        <div style="display:flex;gap:8px;align-items:flex-end">
          <label style="flex:1">用途<input name="label" value="dsh-web"></label>
          <button class="btn primary" data-issue>签发</button>
        </div>
        ${!tokens.length ? '<div class="empty">还没有 token</div>' : `<table>
          <thead><tr><th>用途</th><th>创建</th><th>最后使用</th><th>状态</th><th></th></tr></thead><tbody>
          ${tokens.map((t) => `<tr>
            <td>${esc(t.label || '—')}</td>
            <td class="mono">${fmtTime(t.created_at)}</td>
            <td class="mono">${fmtTime(t.last_used_at)}</td>
            <td>${t.revoked_at ? '<span class="tag danger">已作废</span>' : '<span class="tag ok">有效</span>'}</td>
            <td style="text-align:right">${t.revoked_at ? '' : `<button class="btn sm danger" data-revoke="${t.id}">作废</button>`}</td>
          </tr>`).join('')}</tbody></table>`}
      </div><div class="foot"><button class="btn" data-close>关闭</button></div></div>`;
    back.querySelector('[data-close]').addEventListener('click', close);
    back.querySelector('[data-issue]').addEventListener('click', async () => {
      const label = back.querySelector('input[name=label]').value || 'dsh-web';
      const out = await api(`/api/v1/users/${userId}/token`, { method: 'POST', body: { label } });
      showToken(out.token);
      render();
    });
    back.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('作废后该 token 立即失效，不可恢复。确定？')) return;
      await api(`/api/v1/tokens/${b.dataset.revoke}/revoke`, { method: 'POST' });
      toast('已作废');
      render();
    }));
  };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  await render();
}

/* -------------------------------- 设置 -------------------------------- */

async function viewSettings(box) {
  const { settings } = await api('/api/v1/settings');
  const get = (k) => settings.find((s) => s.key === k)?.value ?? '';
  box.innerHTML = `<div class="panel"><div class="bar"><h2>上游代理</h2>
      <span class="muted">本地没有的包（通常是插件依赖）转发到这里</span></div>
    <div class="body" style="padding:16px;display:grid;gap:14px;max-width:640px">
      <label>状态
        <select name="enabled">
          <option value="1" ${get('upstream.enabled') === '1' ? 'selected' : ''}>开启（缺包时转发）</option>
          <option value="0" ${get('upstream.enabled') === '0' ? 'selected' : ''}>关闭（纯离线，只用本仓库）</option>
        </select>
      </label>
      <label>上游地址<input name="url" value="${esc(get('upstream.url'))}" placeholder="https://registry.npmmirror.com"></label>
      <label>超时（毫秒）<input name="timeoutMs" value="${esc(get('upstream.timeoutMs'))}"></label>
      <div><button class="btn primary" id="saveSettings">保存</button>
        <span class="muted" style="margin-left:10px">保存后立即生效，无需重启</span></div>
    </div></div>`;

  box.querySelector('#saveSettings').addEventListener('click', async () => {
    const v = {
      'upstream.enabled': box.querySelector('select[name=enabled]').value,
      'upstream.url': box.querySelector('input[name=url]').value.trim(),
      'upstream.timeoutMs': box.querySelector('input[name=timeoutMs]').value.trim(),
    };
    try {
      await api('/api/v1/settings', { method: 'PUT', body: v });
      toast('已保存');
    } catch (e) { toast(e.message, true); }
  });
}

/* -------------------------------- 启动 -------------------------------- */

async function refreshBadge() {
  try {
    const { releases } = await api('/api/v1/releases?status=pending');
    state.pending = releases.length;
    const nav = root.querySelector('nav');
    if (nav) { shell(); route(); }
  } catch { /* 忽略 */ }
}

async function boot() {
  if (!state.token) return loginView();
  try {
    const me = await api('/api/v1/auth/me');
    state.user = me.user;
    const { releases } = await api('/api/v1/releases?status=pending').catch(() => ({ releases: [] }));
    state.pending = releases.length;
    shell();
    await route();
  } catch (e) {
    if (state.token) loginView(e.message);
  }
}

boot();
