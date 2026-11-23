# dsh-market · 局域网私有插件市场

给 DeepSeek Harness（DSH）用的内网插件市场：**发布 → 审核 → 上架 → 一键安装**。

**一个服务进程搞定全部**：内置 npm registry（packument + tarball）、市场 API、审核与权限、索引生成、管理端页面。不依赖 Verdaccio，也不需要第二个账号体系。

```bash
npm install && npm start
# 管理端  http://<host>:4874/admin
# 索引    http://<host>:4874/api/v1/index.json
# registry http://<host>:4874/registry/
```

---

## 分支约定

| 分支 | 用途 |
|---|---|
| `main` | 可发布状态。**只有测试确认通过后才合并**，合并由维护者确认。 |
| `dev` | 日常开发分支，所有改动先落这里。 |

---

## 组成

| 部分 | 干什么 |
|---|---|
| **网关**（`src/server.mjs`） | 登录、发布、分类/标签、审核、索引生成、审计、`/registry` 只读代理 |
| **index.json** | 唯一的上架表，DSH 读它来决定市场里有什么 |
| **内置 registry** | 自己实现 npm 协议的最小面：packument、tarball、`dist.integrity`。没有第二个服务、第二套存储 |
| **上游代理** | 本地没有的包（通常是插件依赖）透明转发到 `UPSTREAM_REGISTRY`（默认 npmmirror），内网只配一个源 |
| **管理端** | `/admin`：概览、待审核、插件、分类、标签、用户、Token、审计、设置 |

```
员工机器                          内网服务器（一个进程）
发现页 ──Host fetch──▶ /api/v1/index.json
   └──installBundle(spec, registry)──▶ pnpm ──▶ /registry（匿名读）
管理端 /admin ──登录/审核/分类/用户──▶ 同一进程（SQLite + 本地 tarball）
```

---

## 快速开始

```bash
npm install
# 1) 建管理员（同时签发一个 token）
node src/cli.mjs user add admin --role admin --scope @team-a/ --password 你的口令 --token
# 2) 建标签字典（可选）
node src/cli.mjs label add internal --en Internal --zh 内部
# 3) 起服务
npm start
```

打开 `http://127.0.0.1:4874/api/v1/health` 应返回 `{ ok: true }`。

在 DSH 里把它变成市场：插件页 → 更多 → **自定义插件市场**（启用）→ **发现** → 添加索引源：

```
http://<服务器IP>:4874/api/v1/index.json
```

---

## 发布一个插件

```bash
# 从目录发布（内部会跑 npm pack）
node src/cli.mjs publish ./path/to/plugin --as admin --category general --labels internal
# 或者直接发一个 tgz
node src/cli.mjs publish ./plugin-1.0.0.tgz --as admin
```

发布后是 `pending`，**不会**出现在市场里：

```bash
node src/cli.mjs releases --status pending
node src/cli.mjs approve r_xxxx --as admin      # 上架（自动重建索引）
node src/cli.mjs reject  r_xxxx --reason "缺少图标"
node src/cli.mjs yank    r_xxxx --as admin      # 下架（索引移除，包保留）
```

走 HTTP 时同理：`POST /api/v1/releases`，body 是 tarball 原始字节（`application/octet-stream`），`?category=xxx`，标签放 `x-labels` 头。

---

## CLI

| 命令 | 说明 |
|---|---|
| `user add <name> --role admin\|publisher\|viewer [--scope @team-a/] [--password xxx] [--token]` | 建账号 |
| `user token <name>` | 重新签发 token |
| `label add <id> --en X --zh Y` / `label` | 标签字典 |
| `publish <目录\|tgz> --as <用户> [--category id] [--labels a,b]` | 校验并发布 |
| `releases [--status pending]` | 审核列表 |
| `approve\|reject\|yank <releaseId>` | 上架 / 拒绝 / 下架 |
| `categories [--all 1]` | 分类列表 |
| `index` | 重建 `site/index.json` |

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/index.json` | 索引，DSH **format 1**（原生发现页读这个） |
| GET | `/api/v1/catalog.json` | 同一份数据的 **awesome 形状**，dsh-market 等第三方市场直接消费 |
| GET | `/api/v1/plugins/:name/icon` | 插件图标（绝对地址）。catalog 里用它，base64 会被第三方市场的前端安全校验丢掉 |
| GET | `/api/v1/market/info` | 匿名可读：`requiresAuth`，客户端据此决定是否强制登录 |
| GET/POST | `/api/v1/sources`、`/api/v1/sources/refresh` | 透传外部源（官方 catalog 等）的状态与刷新 |
| GET | `/p/:name` | 插件详情页（catalog 里没有仓库地址时作为落地页） |
| GET | `/api/v1/icons/:file` | 索引里相对图标的落点 |
| POST | `/api/v1/auth/login` | `{name,password}` → `{token,user}` |
| GET | `/api/v1/auth/me` | 当前用户 |
| GET | `/api/v1/plugins?category=` | 市场列表（自己未上架的也能看到） |
| POST | `/api/v1/releases` | 发布（原始 tgz） |
| GET | `/api/v1/releases?status=pending` | 审核列表（admin 看全部） |
| POST | `/api/v1/releases/:id/approve\|reject\|yank` | 审核动作 |
| GET/PUT | `/api/v1/settings` | 上游透传开关、上游地址、超时（改完立即生效） |
| GET | `/api/v1/tokens?userId=` | token 列表（含用途、最后使用、是否作废） |
| POST | `/api/v1/tokens/:id/revoke` | 手动作废单个 token |
| GET/POST | `/api/v1/categories` | 分类列表 / 新建 |
| PATCH/DELETE | `/api/v1/categories/:id` | 改标题、排序、绑定 scope / 归档 |
| GET | `/registry/:name`、`/registry/:name/-/:file.tgz` | npm 协议（packument / tarball） |

---

## 校验规则（发布时强制）

路径穿越与符号链接、>100 MB 解包、>2000 文件、无 `package.json`、包名越界、版本非 semver、同版本覆盖、缺 `dsh.bundle.patch`、patch YAML 非法、缺 `engines.dsh`、缺 `meta.title`、图标 >256 KiB 或 SVG 带脚本/外链、安装脚本、依赖 `@deepseek-ai/*`、`git:`/`file:`/`link:` 依赖。

**分类**：`general`（通用插件）是种子行，不可删、不可改 id；删除其它分类 = 归档，其下插件在一个事务里迁到 `general`。分类可绑 `allowed_scopes`，未绑则谁都能发。

**索引生成是硬断言**：模型先用 DSH 自带的 `parseMarketIndex` 校验，不通过就不写文件、上架动作回滚。

---

## 两种 JSON 投影

同一份数据、两个格式，靠请求时的动态渲染产出（带 ETag，未变更返回 304）：

| 格式 | 消费方 | 硬约束 |
|---|---|---|
| format 1 | DSH 原生「发现」页、`plugin_market` 工具 | 每条要有 `versions[].source`，任何一条不合规**整份被拒**，所以渲染后用 DSH 自带 `parseMarketIndex` 硬校验 |
| awesome 形状 | dsh-market（含官方 app） | 每条必须有 `name` + `url`(http) + `category`，缺则**逐条跳过** |

改完数据（上架/下架/改分类）不需要手动重建文件：索引缓存以「进程内版本 + 数据签名 + 外部源时间戳」为 key，CLI 在另一个进程改数据也会被感知。

## 部署

单容器：

```bash
cd deploy
PUBLIC_BASE_URL=http://dsh.internal PUBLIC_REGISTRY_URL=http://dsh.internal/registry \
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d --build
```

数据落在 `deploy/data`（SQLite + tarball）与 `deploy/site`（index.json + 图标），挂载出来即可迁移。

**上游代理**：插件声明的依赖（如 `zod`）本地没有时，会转发到 `UPSTREAM_REGISTRY`。纯离线内网设 `UPSTREAM_ENABLED=0`，并把依赖预先发布进本仓库。

---

## 已验证 / 未验证

**已实测（Windows + Node 22.22 + 局域网 Ubuntu 26.04 服务器 192.168.100.100）**

- 14 个单测全绿：校验规则、上架/下架、分类归档迁移、scope 限制、索引可被官方校验器接受
- **一体化服务（单容器）**：发布 → 管理端点「上架」 → 索引更新 → `npm install --registry http://192.168.100.100:4874/registry/` 装成功，依赖 `zod@4.6.6` 经上游代理自动解析
- 管理端 9 个页面在 Chromium 里逐页点过（登录、改分类、建分类、建用户+签发 token、归档分类、上架/拒绝、改设置、作废 token），无 JS 错误
- 上游开关实测有效：关闭后 `/registry/zod` 返回 404，开启后 200 并透传；改完立即生效、无需重启
- token 可单独作废（不动用户），作废后同一用户其它 token 不受影响
- 索引产物被 DSH 自带 `parseMarketIndex` 校验通过（生成时硬断言，不通过不上架）

**fork 消费端（`market-ui/`，真机验证）**

- 添加 `http://192.168.100.100:4874/api/v1/catalog.json` → 目录合并成功，私有插件与官方 12.7k 条目并存
- 打不开匿名读（`market.requireAuth=1`）→ 市场页变成登录门 → 用管理端账号登录 → 目录带 token 读取成功（源状态 `ok`）
- 「已安装」页底部发布面板：选包 → 发布 → 市场出现 `pending` → 管理端上架 → 索引立即多出版本（无需重启）
- `npm install --registry http://192.168.100.100:4874/registry/` 安装刚发布的版本成功

**未验证**

- 大规模并发与长时间运行
- 上游 `market-ui` 测试在 Windows 有 1 个历史失败（`file:///opt/...` 路径解析），与本次改动无关

### 踩过的坑（都已在代码里处理）

| 坑 | 现象 | 处理 |
|---|---|---|
| packument 只推精简清单 | `npm install` 成功但**依赖没装** | 保存完整 `package.json`，packument 原样带上 |
| 依赖不在本仓库 | 装插件时报 `404 zod` | 加上游代理，tarball 地址改写回本服务 |
| 索引里 `author: undefined` | 整份索引被拒 | 缺值就删键，不能留 `undefined` |
| 容器以 root 写挂载目录 | 宿主删不掉 `data/` | 容器以 `--user $(id -u):$(id -g)` 运行 |

---

## 消费端：fork 的 `market-ui/`（推荐）

`market-ui/` 是 [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) 的 fork（基线 `dshmarket@1.80.0`，见 `market-ui/UPSTREAM.md`）。上游已经有完整的多市场目录（公共 / 组织锁定 / 用户自建）、安装、更新、备份，我们只补了它缺的三件事：

| 能力 | 行为 |
|---|---|
| **自定义市场** | 上游自带；添加时先读一次，读不到不保存 |
| **鉴权探测** | 市场若声明 `requiresAuth`，市场页换成登录门；允许匿名则正常浏览，目录行保留「登录」按钮 |
| **登录** | 账号密码换 token，存 profile 的 market state（按 origin），目录请求自动带 `Authorization`；401 会清掉失效 token |
| **发布本机插件** | 「已安装」页底部：选一个已装组合包 → `npm pack`（`link:` 会解析到源码目录）→ 上传到市场的 `/api/v1/releases`，状态为待审核 |

安装（开发态）：

```bash
cd market-ui && npm install --ignore-scripts && npm run build
dsh plugin --profile <profile> add link:D:/pro/dsh-market/market-ui
```

它消费的是本服务的 `catalog.json`（awesome 形状），所以市场地址填 `http://<host>:4874/api/v1/catalog.json` 即可。

### 把 fork 打成包发到本市场（桌面端 / 其它机器用这个）

开发态可以 `link:` 源码，但桌面端的 profile 由 App 自己管，装不了链接——要一份能直接安装的包：

```bash
node scripts/pack-market-ui.mjs            # → dist/dshmarket-1.90.0.tgz
node scripts/pack-market-ui.mjs --version 1.90.1
# 然后发布 + 上架（管理端或 API）
curl -XPOST -H "authorization: Bearer <token>" -H 'content-type: application/octet-stream' \
     --data-binary @dist/dshmarket-1.90.0.tgz "http://<host>:4874/api/v1/releases?category=general"
```

打包时改了三处，都是市场硬性要求：去掉 `scripts.prepare`（禁止安装脚本）、补 `engines.dsh`、带上 `icon.svg`。
**包名必须保持 `dshmarket`**——浏览器端 bundle 的模块 id 是编译期写死的（`market-ui/tsdown.config.ts` 的 `const id`），改名会让客户端半边静默不挂载（宿主半边却照常起来，很难查）。用版本号区分自己的线（`1.90.x`）。

### 桌面端怎么装

DSH 桌面版（0.2.2-rc.3）的 profile 由 App 自己管，最省事的路径是在 App 内装：

1. 插件页 →「发现」→ 添加索引源 `http://<host>:4874/api/v1/index.json`；
2. 搜「插件市场」→ 安装 → 重启 Desktop。

装完侧栏会多一个「插件市场」，与内置「发现」页并存（两者读同一份数据；只想要一个的话，可以在插件页把 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 关掉）。


## DSH 插件：插件页的「市场」标签页（`plugin/`，旧方案）

不是另开一个侧栏，而是往**插件页**加第三个页签（`plugins.tab` 槽），和「已安装 / 发现」并排：

| 能力 | 状态 |
|---|---|
| 读市场索引、按分类/标签/关键词筛选 | ✅ |
| 版本下拉选版本，一键安装 | ✅ 走宿主自带的安装对话框（审批、进度、重试都是宿主的） |
| 换市场地址 | ✅ 存浏览器 localStorage，首启动会要求填 |
| 登录与发布 | ❌ 尚未实现（暂用管理端/CLI 发布） |
| "已安装"标记 | ⚠️ 本地记录，不是宿主真实状态 |

安装（内网开发态）：

```bash
dsh plugin --profile <profile> add link:D:/pro/dsh-market/plugin
# 或发布到本市场后：dsh plugin --profile <profile> add @local/dsh-market-tab@0.1.0
```

首次打开「市场」页填市场地址（如 `http://192.168.100.100:4874`），之后可点「换地址」修改。

宿主里的安装入口是页面注入的 `install({spec, registry, title, version})`；插件只负责把 spec 递过去，**审批与落盘全由 DSH 自己做**——所以它不会绕开权限，也不会跟「发现」页行为不一致。

## 附：`vendor/`

`vendor/dsh-plugin-market-index.mjs` 提取自本机安装的 DSH 0.2.2-rc.3（`@deepseek-ai/dsh-plugin-market-index`，MIT），用于在生成索引时做**硬断言**：产出的 JSON 必须先通过 DSH 自己的校验器，才允许写盘。升级 DSH 后建议重新提取一份比对。

