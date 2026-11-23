# Fork 来源与改动边界

本目录是 [`dsh-market/dsh-market`](https://github.com/dsh-market/dsh-market) 的 fork，**不是**我们从零写的 UI。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/dsh-market/dsh-market |
| 基线版本 | `dshmarket@1.80.0` |
| 基线提交 | `8747e07367df7f16d6186e1c9047daecee3e8174`（2026-11-22，release 1.80.0） |
| 许可 | MIT（见 `LICENSE`） |
| 引入方式 | 下载该提交的源码包解压入库，未保留上游 `.git` |

## 已落地的三个口子（2026-11-23）

上游已经具备：多市场目录（公共 / 组织锁定 / 用户自建，`src/catalogs.ts` + `src/client/CatalogsPanel.tsx`）、安装、更新、备份、诊断。缺的正好是三件：

| 编号 | 能力 | 落点 | 状态 |
|---|---|---|---|
| P1 | **市场鉴权探测**：读 `/api/v1/market/info`，`requiresAuth` 且未登录 → 页面换成登录门；匿名可读则正常浏览，只在目录行留一个「登录」 | `src/accounts.ts`、`src/routes.ts`（`/dsh-market/account`）、`src/client/MarketAuthGate.tsx` | ✅ 真机验证 |
| P2 | **登录**：账号密码换 token，存进 profile 的 `market state`（`accounts`，按 origin），目录请求自动注入 `Authorization` | `src/accounts.ts`、`src/hot.ts`、`src/catalogs.ts`、`src/client/MarketLoginDialog.tsx` | ✅ 真机验证 |
| P3 | **发布本机插件**：列已装组合包 → `npm pack`（含 `link:` 解析）→ `POST /api/v1/releases` | `src/publish.ts`、`src/routes.ts`、`src/client/PublishPanel.tsx`（已安装页底部） | ✅ 真机验证 |

### 私有市场的显示名与图标（2026-11-23 晚）

上游的卡片标题就是条目里的 `name`（公共目录的包名本身就是可读的）。私有市场的包名是 `@local/xxx`，直接显示是噪音。三处改动：

1. **服务端 `catalog.json` 额外带 `title`（`{zh,en}`）和绝对地址的 `icon`**（新接口 `/api/v1/plugins/:name/icon`）。上游不认这些字段也不会出错。
2. **客户端标题优先取 `title`**：`pluginTitle(plugin, lang)`，`name`/`npm` 继续负责身份、安装、更新、屏蔽——只改显示。
3. **两条上游假设让内网图标显示不出来**，按「用户自己添加的目录」范围放开：
   - `safeIcon` 只接受 https 且拒绝 SVG → 自有目录允许 http + SVG（`<img>` 里的 SVG 不能执行脚本；README 截图仍是 https + 栅格）；
   - 图标一律走 `githubRouteCandidates('raw')` 加速代理 → 只有 GitHub raw 域名才走代理，内网地址直连（否则会拼成 `https://ghfast.top/http://内网/...`）。

### 与上游行为的差异（刻意为之）

1. **`UserCatalog` 仍然只有 `{id, url, file}`** —— token 不进目录配置，按 origin 存在市场状态里。这样删目录不会顺手丢凭据，凭据也不会跟着备份里的目录一起被复制出去。
2. **鉴权失败会清 token**：目录读取或发布收到 401 时丢掉该 origin 的 token，下次进页面就重新要求登录，而不是永远静默失败。
3. **发布面板放在「已安装」页底部**：发布的对象就是那一页列出的东西；设置页里也有一份（`SettingsCard` 的「插件目录」下面）。
4. **`market-element` 外面包了一层 `MarketAuthGate`**：`tests/client/market-element.client.spec.ts` 相应改成先取 gate 再取 section。

## 与根目录服务端的关系

```
dsh-market-private/
├── src/            ← 供给端：npm registry + 账号 + 发布 + 审核 + 索引投影（Node 服务）
└── market-ui/      ← 消费端：fork 的 dsh-market，跑在 DSH 宿主里
```

两者通过 HTTP 契约耦合，只有三个接口：

- `GET /api/v1/market/info` —— 匿名可读，声明是否要求登录（P1 用）
- `GET /api/v1/catalog.json` —— awesome 形状目录（上游原生支持消费，不需要改代码）
- `GET /api/v1/index.json` —— DSH format 1（原生「发现」页用，也可作为上游的第二个目录源）

## 打包发布的三个坑（`scripts/pack-market-ui.mjs` 已处理）

1. **`exports` 不能丢**：DSH 靠 `exports["./client"]` 找浏览器端 bundle。丢了它，宿主半边照常挂载，客户端半边被静默跳过（市场页整块消失，`/plugins/<name>/client.js` 404）——而且没有任何报错。
2. **包名不能改**：`tsdown.config.ts` 里 `const id = 'dshmarket'` 是编译期写死的模块 id，preflight 还断言了产物前缀。改名后加载器报 `duplicate factory registration for "dshmarket"` 并拒绝加载。
3. **`scripts.prepare` 要去掉、`engines.dsh` 要补上**：市场禁止安装脚本，也靠 `engines.dsh` 判断兼容。

## 升级上游的方式

上游迭代很快（1.80.0 仍在发版），升级时**不要**整目录覆盖，否则改动丢失。建议：

```bash
git remote add upstream https://github.com/dsh-market/dsh-market.git
git fetch upstream main
git diff <当前基线> upstream/main -- src/catalogs.ts src/client/CatalogsPanel.tsx src/routes.ts
```

先看冲突范围，再决定整体 rebase 还是逐文件迁移。
