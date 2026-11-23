window.__ModuleLoader__.load({
  id: '@local/dsh-market-tab',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-market-tab';
    const SERVER_KEY = 'dsh-market-tab:server';
    const INSTALLED_KEY = 'dsh-market-tab:installed';

    const zh = {
      tab: '市场',
      title: '插件市场',
      subtitle: '内网私有仓库 · 分类筛选 · 一键安装',
      setup: '先填写市场地址',
      setupHelp: '填内网市场服务的地址，例如 http://192.168.100.100:4874。只存在本机浏览器里。',
      server: '市场地址',
      save: '保存',
      change: '换地址',
      refresh: '刷新',
      search: '搜索名称、描述、关键词',
      all: '全部',
      category: '分类',
      labels: '标签',
      install: '安装',
      installing: '安装中…',
      installed: '已安装',
      version: '版本',
      author: '作者',
      empty: '这个市场还没有上架的插件',
      noMatch: '没有匹配的插件',
      loadFailed: '市场读取失败',
      notConfigured: '当前页面拿不到安装入口，请在「发现」页安装。',
      hint: '安装后如未生效，重启 DSH。',
      confirm: '安装',
      publish: '发布',
      publishTitle: '发布本机插件到市场',
      server: '市场地址',
      user: '用户名',
      password: '密码',
      login: '登录',
      logout: '退出登录',
      pickPlugin: '选择要发布的插件',
      category: '分类',
      publishNow: '提交发布',
      publishing: '上传中…',
      cancel: '取消',
      noInstalled: '本机没有可发布的插件（只列出可读到源码目录的已装组合包）',
    };
    const en = {
      tab: 'Market',
      title: 'Plugin market',
      subtitle: 'Private LAN registry · filters · one-click install',
      setup: 'Set the market address first',
      setupHelp: 'Point it at your LAN market, e.g. http://192.168.100.100:4874. Stored in this browser only.',
      server: 'Market address',
      save: 'Save',
      change: 'Change address',
      refresh: 'Refresh',
      search: 'Search name, description, keywords',
      all: 'All',
      category: 'Category',
      labels: 'Labels',
      install: 'Install',
      installing: 'Installing…',
      installed: 'Installed',
      version: 'Version',
      author: 'Author',
      empty: 'No plugins published yet',
      noMatch: 'Nothing matches these filters',
      loadFailed: 'Failed to read the market',
      notConfigured: 'The install entry is unavailable here; use the Discover tab.',
      hint: 'If nothing happens, restart DSH.',
      confirm: 'Install',
    };

    const css = `
.mk{height:100%;overflow:auto;padding:20px;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:13px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif}
.mk *{box-sizing:border-box}
.mk h1,.mk h2,.mk h3,.mk p{margin:0}
.mk .head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.mk h1{font-size:20px;letter-spacing:-.2px}
.mk .sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:3px}
.mk .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mk button,.mk input,.mk select{font:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:6px 10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.mk button{cursor:pointer}
.mk button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.mk button:disabled{opacity:.55;cursor:default}
.mk button.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}
.mk .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:14px}
.mk .search{flex:1 1 240px;min-width:180px}
.mk .chips{display:flex;gap:6px;flex-wrap:wrap}
.mk .chip{border-radius:999px;padding:3px 11px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary)}
.mk .chip.on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}
.mk .labelrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.mk .labelrow .cap{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mk .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.mk .card{display:flex;flex-direction:column;gap:9px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1)}
.mk .top{display:flex;gap:10px;align-items:flex-start}
.mk .icon{width:34px;height:34px;flex:0 0 34px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);display:grid;place-items:center;overflow:hidden;font-weight:600;color:var(--dsw-alias-label-secondary)}
.mk .icon img{width:100%;height:100%;object-fit:contain}
.mk .name{font-weight:600;font-size:13px;line-height:1.35}
.mk .pkg{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.mk .desc{color:var(--dsw-alias-label-secondary);font-size:12px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-height:54px}
.mk .meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.mk .pill{padding:1px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2)}
.mk .foot{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:auto;padding-top:4px}
.mk .foot select{max-width:120px}
.mk .notice{padding:10px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.mk .notice.bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.mk .setup{max-width:520px;display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.mk .setup input{width:100%}
.mk .empty{text-align:center;padding:50px 20px;color:var(--dsw-alias-label-secondary)}
.mk .overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:50;padding:20px}
.mk .sheet{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;width:min(560px,100%);max-height:86vh;overflow:auto;padding:0 0 4px}
.mk .sheetHead{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mk .sheetHead h3{margin:0;font-size:14px}
.mk .stack{display:flex;flex-direction:column;gap:10px;padding:16px}
.mk .stack label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mk .sheetFoot{display:flex;justify-content:flex-end;gap:8px;padding-top:6px}
.mk .who{font-size:12px;color:var(--dsw-alias-label-secondary)}
@media(max-width:720px){.mk{padding:14px}.mk .grid{grid-template-columns:1fr}}
`;

    function useStyles() {
      React.useEffect(() => {
        if (document.getElementById('mk-style')) return;
        const el = document.createElement('style');
        el.id = 'mk-style';
        el.textContent = css;
        document.head.append(el);
      }, []);
    }

    const readInstalled = () => {
      try { return JSON.parse(localStorage.getItem(INSTALLED_KEY) || '{}'); } catch { return {}; }
    };

    function Market(props) {
      useStyles();
      const t = (k) => {
        // 简易翻译：跟随宿主语言只在 apply 时绑定一次，这里直接用中文字典兜底
        return (zh[k] ?? k);
      };
      const [server, setServer] = React.useState(() => localStorage.getItem(SERVER_KEY) || '');
      const [draft, setDraft] = React.useState(server);
      const [data, setData] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [category, setCategory] = React.useState('');
      const [labels, setLabels] = React.useState([]);
      const [picked, setPicked] = React.useState({});
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState('');
      const [installed, setInstalled] = React.useState(readInstalled);
      const [publish, setPublish] = React.useState(false);
      const alive = React.useRef(true);

      async function load(url) {
        if (!url) return;
        setLoading(true); setError('');
        try {
          const res = await fetch(url.replace(/\/+$/, '') + '/api/v1/index.json', { headers: { accept: 'application/json' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const doc = await res.json();
          if (!doc || doc.format !== 1 || !Array.isArray(doc.plugins)) throw new Error('索引格式不对');
          if (alive.current) setData(doc);
        } catch (e) {
          if (alive.current) setError(String(e.message || e));
        } finally {
          if (alive.current) setLoading(false);
        }
      }

      React.useEffect(() => {
        alive.current = true;
        load(server);
        return () => { alive.current = false; };
      }, [server]);

      const saveServer = () => {
        const value = draft.trim().replace(/\/+$/, '');
        if (!value) return;
        localStorage.setItem(SERVER_KEY, value);
        setServer(value);
        setData(null);
        setError('');
      };

      const latestVersion = (p) => {
        const v = p.versions && p.versions[0];
        return v ? v.version : '';
      };
      const registryOf = (p) => (p.versions && p.versions[0] && p.versions[0].source && p.versions[0].source.registry) || '';

      function install(p) {
        const version = picked[p.name] || latestVersion(p);
        const spec = p.name + '@' + version;
        if (typeof props?.install !== 'function') {
          setNote(t('notConfigured') + ' ' + spec);
          return;
        }
        setBusy(p.name); setNote('');
        try {
          props.install({ spec, registry: registryOf(p), title: (p.title && (p.title.zh || p.title.en)) || p.name, version });
          const next = { ...installed, [p.name]: version };
          localStorage.setItem(INSTALLED_KEY, JSON.stringify(next));
          setInstalled(next);
          setNote(t('hint'));
        } catch (e) {
          setNote(String(e.message || e));
        } finally {
          setBusy('');
        }
      }

      if (!server) {
        return h('div', { className: 'mk' }, h('div', { className: 'setup' },
          h('h1', null, t('setup')),
          h('p', { className: 'sub' }, t('setupHelp')),
          h('input', { value: draft, placeholder: 'http://192.168.100.100:4874', onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') saveServer(); } }),
          h('div', null, h('button', { className: 'primary', onClick: saveServer }, t('save'))),
        ));
      }

      const cats = (data?.metadata?.categories) || {};
      const labelDict = (data?.metadata?.labels) || {};
      const catName = (id) => cats[id]?.title?.zh || cats[id]?.title?.en || id;
      const labelName = (id) => labelDict[id]?.title?.zh || labelDict[id]?.title?.en || id;

      const plugins = (data?.plugins || []).filter((p) => {
        if (category && (p.metadata?.category || '') !== category) return false;
        const pl = p.metadata?.labels || [];
        if (labels.length && !labels.every((x) => pl.includes(x))) return false;
        if (!query.trim()) return true;
        const q = query.trim().toLowerCase();
        const hay = [p.name, p.title?.zh, p.title?.en, p.description?.zh, p.description?.en, ...(p.metadata?.keywords || [])]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });

      return h('div', { className: 'mk' },
        h('div', { className: 'head' },
          h('div', null,
            h('h1', null, data?.title?.zh || data?.title?.en || t('title')),
            h('div', { className: 'sub' }, (data?.description?.zh || t('subtitle')) + ' · ' + server)),
          h('div', { className: 'actions' },
            h('button', { onClick: () => load(server), disabled: loading }, loading ? '…' : t('refresh')),
            h('button', { className: 'primary', onClick: () => setPublish(true) }, t('publish')),
            h('button', { onClick: () => { setServer(''); setDraft(''); } }, t('change')),
          )),

        error ? h('div', { className: 'notice bad' }, t('loadFailed') + '：' + error) : null,
        note ? h('div', { className: 'notice' }, note) : null,

        h('div', { className: 'toolbar' },
          h('input', { className: 'search', placeholder: t('search'), value: query, onChange: (e) => setQuery(e.target.value) }),
          h('div', { className: 'chips' },
            h('button', { className: 'chip' + (category === '' ? ' on' : ''), onClick: () => setCategory('') }, t('all')),
            Object.keys(cats).map((id) => h('button', {
              key: id, className: 'chip' + (category === id ? ' on' : ''), onClick: () => setCategory(id),
            }, catName(id)))),
        ),

        Object.keys(labelDict).length ? h('div', { className: 'labelrow' },
          h('span', { className: 'cap' }, t('labels')),
          Object.keys(labelDict).map((id) => h('button', {
            key: id,
            className: 'chip' + (labels.includes(id) ? ' on' : ''),
            onClick: () => setLabels((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]),
          }, labelName(id))),
        ) : null,

        loading && !data ? h('div', { className: 'empty' }, '…') : null,
        !loading && data && !plugins.length ? h('div', { className: 'empty' }, data.plugins.length ? t('noMatch') : t('empty')) : null,

        h('div', { className: 'grid' }, plugins.map((p) => {
          const title = p.title?.zh || p.title?.en || p.name;
          const desc = p.description?.zh || p.description?.en || '';
          const ver = latestVersion(p);
          const isInstalled = installed[p.name] === ver && ver;
          const versions = (p.versions || []).map((v) => v.version);
          return h('div', { className: 'card', key: p.name },
            h('div', { className: 'top' },
              h('div', { className: 'icon' }, p.icon
                ? h('img', { src: p.icon, alt: '', referrerPolicy: 'no-referrer' })
                : String(title).slice(0, 1)),
              h('div', { style: { minWidth: 0 } },
                h('div', { className: 'name' }, title),
                h('div', { className: 'pkg' }, p.name))),
            h('div', { className: 'desc' }, desc),
            h('div', { className: 'meta' },
              p.metadata?.category ? h('span', { className: 'pill' }, catName(p.metadata.category)) : null,
              (p.metadata?.labels || []).map((l) => h('span', { className: 'pill', key: l }, labelName(l))),
              p.author ? h('span', { className: 'pill' }, p.author) : null),
            h('div', { className: 'foot' },
              versions.length > 1
                ? h('select', { value: picked[p.name] || ver, onChange: (e) => setPicked({ ...picked, [p.name]: e.target.value }) },
                  versions.map((v) => h('option', { key: v, value: v }, v)))
                : h('span', { className: 'pkg' }, ver),
              h('button', {
                className: 'primary', disabled: busy === p.name, onClick: () => install(p),
              }, busy === p.name ? t('installing') : (isInstalled ? t('installed') : t('install')))),
          );
        })),
        publish ? h(PublishOverlay, {
          t,
          server,
          categories: data?.metadata?.categories || {},
          onClose: () => setPublish(false),
          onDone: (msg) => { setNote(msg); setPublish(false); load(server); },
        }) : null,
      );
    }


    function PublishOverlay(props) {
      const t = props.t;
      const [session, setSession] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [list, setList] = React.useState([]);
      const [name, setName] = React.useState('');
      const [category, setCategory] = React.useState('general');
      const [form, setForm] = React.useState({ server: props.server || localStorage.getItem(SERVER_KEY) || '', name: '', password: '' });

      const call = async (path, body) => {
        const res = await fetch(path, body === undefined
          ? { credentials: 'same-origin' }
          : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      };

      React.useEffect(() => {
        call('/api/dsh-market?op=session').then((s) => {
          setSession(s);
          if (s.loggedIn) loadInstalled();
        }).catch((e) => setError(String(e.message || e)));
      }, []);

      async function loadInstalled() {
        setBusy('list');
        try {
          const out = await call('/api/dsh-market?op=installed');
          const usable = (out.installed || []).filter((x) => x.dir);
          setList(usable);
          if (usable.length) setName(usable[0].name);
        } catch (e) { setError(String(e.message || e)); }
        finally { setBusy(''); }
      }

      async function login(event) {
        event.preventDefault();
        setBusy('login'); setError('');
        try {
          const out = await call('/api/dsh-market', { action: 'login', server: form.server, name: form.name, password: form.password });
          setSession({ loggedIn: true, user: out.user, server: out.server });
          setForm({ ...form, password: '' });
          await loadInstalled();
        } catch (e) { setError(String(e.message || e)); }
        finally { setBusy(''); }
      }

      async function publish() {
        setBusy('publish'); setError('');
        try {
          const out = await call('/api/dsh-market', { action: 'publish', name, category });
          props.onDone(`已提交 ${out.published.name}@${out.published.version}，等待审核`);
        } catch (e) { setError(String(e.message || e)); }
        finally { setBusy(''); }
      }

      const cats = props.categories || {};
      return h('div', { className: 'overlay' },
        h('div', { className: 'sheet' },
          h('div', { className: 'sheetHead' },
            h('h3', null, t('publishTitle')),
            h('button', { onClick: props.onClose }, '✕')),

          error ? h('div', { className: 'notice bad' }, error) : null,

          !session ? h('div', { className: 'empty' }, '…') : !session.loggedIn
            ? h('form', { className: 'stack', onSubmit: login },
              h('label', null, t('server'), h('input', { value: form.server, onChange: (e) => setForm({ ...form, server: e.target.value }) })),
              h('label', null, t('user'), h('input', { value: form.name, autoComplete: 'username', onChange: (e) => setForm({ ...form, name: e.target.value }) })),
              h('label', null, t('password'), h('input', { type: 'password', value: form.password, autoComplete: 'current-password', onChange: (e) => setForm({ ...form, password: e.target.value }) })),
              h('button', { className: 'primary', disabled: busy === 'login' }, busy === 'login' ? '…' : t('login')))
            : h('div', { className: 'stack' },
              h('div', { className: 'who' }, session.user + ' @ ' + (session.server || '')),
              busy === 'list' ? h('div', { className: 'empty' }, '…') : null,
              !busy && !list.length ? h('div', { className: 'notice' }, t('noInstalled')) : null,
              list.length ? h('label', null, t('pickPlugin'),
                h('select', { value: name, onChange: (e) => setName(e.target.value) },
                  list.map((x) => h('option', { key: x.name, value: x.name }, `${x.title || x.name} · ${x.name}${x.version ? '@' + x.version : ''}${x.linked ? '（link）' : ''}`)))) : null,
              list.length ? h('label', null, t('category'),
                h('select', { value: category, onChange: (e) => setCategory(e.target.value) },
                  Object.keys(cats).length
                    ? Object.keys(cats).map((id) => h('option', { key: id, value: id }, cats[id]?.title?.zh || cats[id]?.title?.en || id))
                    : h('option', { value: 'general' }, '通用插件'))) : null,
              h('div', { className: 'sheetFoot' },
                h('button', { onClick: props.onClose }, t('cancel')),
                h('button', { className: 'primary', disabled: !list.length || busy === 'publish', onClick: publish }, busy === 'publish' ? t('publishing') : t('publishNow')))),
        ));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh));
        ctx.effect(() => ctx.locale.register(NS, 'zh-CN', zh));
        ctx.effect(() => ctx.locale.register(NS, 'en', en));
        const translate = ctx.locale.bind(NS);
        ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab',
          id: 'market',
          label: () => String(translate('tab')),
          locale: NS,
          order: 1,
        }, Market));
      },
    };
  },
});
