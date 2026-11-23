# DSH 插件市场（局域网私有）· 设计 v1.1

> **v1.1 变更**：实现改为**一体化服务端**——内置 npm registry、市场 API、审核、管理端跑在同一进程、同一套账号、同一份存储。
> §2 里"网关 + Verdaccio"的双服务形态作废；原因是实测中立刻出现两套账号（Verdaccio 的 htpasswd 与市场的 SQLite）和两个 UI，运维和体验都不成立。
> 保留不变的结论：索引是唯一闸门（publish ≠ 上架）、安装侧不认账号、分类 `general` 兜底。

> **一句话**：Verdaccio 存包，网关管人和上架，`index.json` 是唯一的上架表，一个 DSH 插件 tab 做门面。
>
> 目标环境：内网、无外网、20–200 人团队；DSH 0.2.2-rc.x。

---

## 1. 目标与非目标

**要做**

1. 内网私有分发：插件不上公网 npm。
2. 账号与权限：谁能发布、谁能管别人，可审计。
3. **分类 + 标签双层**：分类是受权限管控的资源（有权限者自建，`general` 兜底不可删），标签用于细粒度筛选。
4. DSH 内一个页面完成：浏览 → 一键安装 → 把自己装的插件发回仓库。

**不做**

- 公网 / 多租户 SaaS；付费与结算。
- 包级读权限（技术上做不干净，见 §3.2）。
- 自己实现 npm 协议（交给 Verdaccio）。
- 静态扫描 / 代码签名（M4 之后再议）。

---

## 2. 最终形态

```
员工机器                              内网服务器
──────────                            ──────────────────────────────
市场 tab（自研插件）──登录/发布/读索引──▶ 网关 ──publish──▶ Verdaccio
  │                                       │                （只存包）
  └──installBundle(spec, registry)──┐     ├──生成──▶ index.json
                                    ▼     │           （静态托管）
                              pnpm 匿名拉包 ┴──▶ Verdaccio
发现页（原生，兜底）──Host fetch──▶ index.json
```

> 网关里装着五样东西：**账号与角色 · 分类（受管资源）· 标签字典 · 上架审核 · 审计**。Verdaccio 只认包名和版本，上面这些它一概不知道。

| 组件 | 职责 | 不做什么 |
|---|---|---|
| **市场 tab**（自研插件） | 浏览、搜索、**分类切换**、标签筛选、安装、发布、我的插件 | 不实现安装对话框、不存账号密码 |
| **发现页**（DSH 原生） | 只读浏览、安装、更新 | 无登录、无上传、无“我的” |
| **网关**（Node + Fastify） | 注册登录、角色、发布鉴权、**分类管理（含 `general` 兜底）**、标签、上架审核、索引生成、审计、反代 `/registry` | 不存包体 |
| **Verdaccio** | 存 tarball、吐 packument、拒绝覆盖同版本 | 不管权限、不管分类、不管审核 |
| **Postgres** | 用户/角色/scope 归属/**分类**/标签/发布记录/审计 | — |
| **管理端 Web** | 用户与角色、**分类与标签字典**、上架/下架、审计查询 | 不做安装（安装只在 DSH 里） |

**对象模型**（先看清关系，后面所有规则都是它的推论）

| 对象 | 关系 | 要点 |
|---|---|---|
| 用户 | 角色 + scope 归属 | 角色决定能做什么，scope 决定能发到哪个包名 |
| 插件 | **分类（1）** + 标签（N） | 分类是受管资源，标签只是字典值 |
| 分类 | 可绑允许发布的 scope（空 = 通用） | `general` 是种子行，`is_default`、不可删、不可改 id |
| 发布记录 | 状态：`pending` → `published` / `rejected`；`yanked` | **只有 `published` 才进索引**，这才是“上架” |

**三处入口，职责不重叠**：市场 tab 负责**发**（要登录）、发现页负责**装**（匿名）、管理端负责**管**（管理员）。

---

## 3. 三条决定性约束

### 3.1 索引是唯一的闸门

DSH 只读 `index.json`，Verdaccio 里有什么、有多少版本，市场完全不知道。所以：

- **publish ≠ 上架**。包进了仓库只是“存在”，写进 `index.json` 才“在市场里”。
- 审核、下架、灰度，全部落在索引生成这一步，**不用改 Verdaccio 一行代码**。

### 3.2 安装侧不认账号

`installBundle` → pnpm → registry，这条链上没有任何 DSH 凭据。所以：

- Verdaccio 必须**匿名只读**，否则每台机器都要配 `.npmrc` token。
- 权限只控「能不能发」和「上不上架」，不控「谁能看」。
- 推论：**不要给员工加“登录后才能安装”**，那会让装插件变成注册流程。

### 3.3 一个 tab 装下全部是便宜的

DSH 插件页的 `plugins.tab` 是开放槽（`label` 命名、`order` 定位），注册后会拿到页面给的回调 `install({spec, registry?, title, version})`；索引的搜索/校验/兼容性由 Host 的 `pluginMarket` 服务提供，前端只是渲染。

所以自建页面 = 换皮 + 加“发布”，不是重写一套市场。安装直接复用插件页的安装对话框（审批、进度、重试全自带）。

---

## 4. 角色与权限

| 角色 | 能做什么 | 说明 |
|---|---|---|
| 匿名 | 浏览索引、安装 | 内网默认可读，不登录也能装 |
| viewer | 登录后可见“我的”、查看自己的审计 | 可选，通常直接给 publisher |
| publisher | 发布到自己的 scope（`@team-a/*`）、给自己包挂白名单标签、**按授权建分类** | 主角色 |
| admin | 建号/停用、改角色、改 scope 归属、维护标签字典、**归档分类**、上架/下架、看审计 | 不做包体操作 |

**四条铁律**

1. 包名必须在自己的 scope 下，越界直接 403（admin 例外，用于镜像搬运）。
2. 注册默认**关闭**，账号由 admin 创建或邀请码注册——内网开放注册等于任何人都能往生产市场推包。
3. 标签只能从 admin 维护的字典里选，不能自由输入（否则半年后 500 个同义标签）。
4. 所有写操作（发布/上架/下架/改权限/建分类/删分类）写审计：谁、何时、对哪个对象、改了什么。

### 4.1 分类与标签是两个东西

| | 分类 category | 标签 label |
|---|---|---|
| 数量 | 每个插件**只能归一个** | 可挂多个 |
| 粒度 | 粗：业务域 / 团队 | 细：属性 / 场景 / 状态 |
| 谁维护 | **受管资源**：有权限者可建，admin 可归档 | admin 维护字典，publisher 只能选 |
| 索引字段 | `metadata.category`（单值） | `metadata.labels`（数组） |
| 用途 | 导航、权限边界 | 筛选、检索 |

分类是**权限对象**，所以它比标签多三条约束：

**分类表就这几个字段**

| 字段 | 说明 |
|---|---|
| `id` | 唯一，创建后不可改（写进索引 `metadata.categories` 的 key） |
| `title_en` / `title_zh` | 必填，直接映射成索引里的 `LocalizedText` |
| `sort` | 顶部按钮顺序；`general` 固定排第一 |
| `is_default` | 只有 `general` 为 true |
| `status` | `active` / `archived`（归档后不出现在 picker 与索引声明里） |
| `created_by` / `created_at` | 审计用，删除时也记在审计里 |

**分类规则**

1. **`general`（通用插件）是种子分类**：`is_default = true`，不可删、不可改 id、不可停用。索引里**永远声明它**，哪怕一个插件都没有。
2. **分类 id 一经创建不可改**（它被写进 `metadata.categories` 的 key），只允许改中英标题与排序。
3. **删除 = 归档**：事务内把该分类下所有插件的 `category_id` 迁到 `general`，同时写审计（谁删的、迁了几个、原 id）。历史 `release` 记录保留原 id 以便追溯。

**谁能做什么**

| 动作 | 权限 |
|---|---|
| 创建分类 | admin，或被授予 `category:create` 的 publisher；中英标题必填 |
| 改标题 / 排序 | 创建者或 admin |
| 归档删除 | **仅 admin**；二次确认要显示“将迁移 N 个插件到通用插件” |
| 给插件改分类 | 包 owner 或 admin |

**索引生成时的强制兜底**：每个插件的 `category` 必须 ∈ 当前 active 分类集合；不满足就落到 `general` 并记异常——**绝不允许因为一个失效分类，产出会被整份拒绝的索引**。

> 分类是**市场侧元数据**，不写进包的 `package.json`。所以改分类、删分类都不影响已装用户，也不需要重新发版。

> 可选（M2 之后）：给分类绑“允许发布的 scope”，同一个分类下只收特定团队的包；MVP 先不做。

---

## 5. 三条主流程

### 5.1 发布（作者）

1. 市场 tab →「发布」→ 列出本机已装组合包（`pluginManager/listBundles()`）。
2. 选一个 → 填**分类**（默认「通用插件」；有 `category:create` 权限时可直接新建）与**标签**（从字典多选）→ 插件定位目录 → 跑校验（见 §5.4）→ 打包 `tgz`。
3. 上传网关 `POST /api/v1/releases`（带 token，分类/标签随表单提交）。
4. 网关二次校验 → 转发 `npm publish` 到 Verdaccio（服务 token）→ 记 `release` 行（状态 `pending`，分类 id 落到 `plugin.category_id`）。
5. 插件列表里立刻出现“我的包 · 待审核”，并按分类归位。

### 5.2 上架（管理员）

1. 管理端看到 `pending` 列表（含描述、分类、标签、体积、发布人）。
2. 通过 → 状态 `published`；拒绝 → `rejected` + 理由回显给作者（分类不对也在这里退回，不占用发布者的重传）。
3. 网关重新生成 `index.json`（含该版本），静态托管生效（≤ 5 分钟被拉到）。
4. 员工在市场 tab / 发现页按分类看到新插件。

### 5.3 安装（员工）

1. 市场 tab 点「安装」→ 拿到 `spec` 与 `registry` → 调 owner props 的 `install()`。
2. 插件页弹确认框（图标、版本、来源、信任提示）→ 用户确认。
3. `installBundle('@team-a/foo@1.2.0', {registry})` → pnpm 向 Verdaccio 要 packument + tarball → 校验 integrity。
4. 落到 profile 的 `node_modules` → 读 `dsh.bundle.patch` → HMR 生效或提示重启。

### 5.4 发布前的校验（网关与插件共用同一份规则）

| 检查 | 拒收条件 |
|---|---|
| 包结构 | 路径穿越、符号链接、解包 >100 MB、文件数 >2000 |
| 清单 | 无 `package.json`；`name` 不在自己 scope；`version` 非 semver；同版本已存在 |
| 组合包 | 无 `dsh.bundle.patch`；YAML 解析失败；patch 行在包内解析不到 |
| 运行文件 | `files` 未覆盖 patch/locale/icon；`exports` 指向不存在的文件 |
| 展示元数据 | 缺 `locale/*.json` 的 `meta.title`/`meta.description` |
| 图标 | 非 SVG/PNG/JPEG/WebP；>256 KiB；SVG 含脚本或外链 |
| 依赖 | 含安装脚本；依赖 `@deepseek-ai/*`；`git:`/`file:`/`link:` 依赖；非精确版本 |

> 规则实现成一个独立包（如 `@team/dshm-manifest`），插件本地预检与网关二次校验共用，避免“本地过了线上不过”。

---

## 6. 插件设计（市场 tab）

**四个区**

| 区 | 内容 | 数据来源 |
|---|---|---|
| 顶栏 | 搜索、**分类切换（含「通用插件」）**、标签筛选、登录态、「发布」按钮（无权限隐藏） | `remote.pluginMarket.search` |
| 列表 | 卡片：图标/标题/描述/分类/标签/版本/状态/操作（安装·已装·更新·待审核） | 同上 + `listBundles()` |
| 详情 | 版本列表与兼容性、来源 registry、README；分类可在此改（owner/admin） | `remote.pluginMarket.readEntryDetail` + 网关 |
| 我的 | 我发布的包、审核状态、分类、下架、重新提交 | 网关 API |

分类用**顶部横排按钮**（`全部 / 通用插件 / …`，按 `sort` 排序），标签用下拉多选——两者视觉上必须能区分开，否则用户会把标签当分类用。

**必须处理的五个技术点**

1. **降级**：`remote.pluginMarket` 只在“自定义插件索引”组合包启用时存在。启动探测，没有就自己 fetch `index.json` 做简单过滤。
2. **待审核可见**：未上架的包不在索引里，原生页面看不到。列表要合并“我的发布（待审核）”，否则用户以为发丢了。
3. **`link:` 是符号链接**：发布已装插件前必须 `realpath` 到源码目录，否则打进去的是链接本身。
4. **打包用 `npm pack --json`**：跨平台 spawn 按 `PATHEXT` 找 `.cmd`；不要自己实现 `files` 过滤语义。
5. **token 存 `ctx.credentials`**，不落 localStorage、不写日志。

**镜像搬运（可选能力）**：如果装的是别人的包，“发布”本质是镜像。必须从原 registry 拉原始 tarball 保 integrity、标注 upstream，且只给 admin。

---

## 7. 索引契约（format 1）

```json
{
  "format": 1,
  "title": { "en": "Team plugins", "zh": "团队插件" },
  "metadata": {
    "categories": {
      "general": { "title": { "en": "General", "zh": "通用插件" } },
      "dev":     { "title": { "en": "Development", "zh": "开发" } }
    },
    "labels":     { "internal": { "title": { "en": "Internal", "zh": "内部" } } }
  },
  "plugins": [{
    "name": "@team-a/dsh-foo",
    "title": { "en": "Foo", "zh": "Foo 工具" },
    "description": { "en": "Adds the foo tool.", "zh": "增加 foo 工具。" },
    "icon": "icons/team-a__dsh-foo.svg",
    "author": "team-a",
    "repository": { "url": "https://git.internal/team-a/dsh-foo" },
    "metadata": { "category": "general", "labels": ["internal"], "keywords": ["foo"], "sortKeys": {} },
    "versions": [{
      "version": "1.2.0",
      "publishTimestamp": 1795000000,
      "source": { "type": "npm", "registry": "http://npm.internal:4873/" },
      "engines": { "dsh": ">=0.2.2-rc.3 <0.3.0" }
    }]
  }]
}
```

**六条硬规则**

1. 任何一条不合法，**整份索引被拒**，用户只看到“读取失败”。
2. 字段“存在即校验”：`author: undefined` 也会被拒，序列化前删空键。
3. 图标用**相对路径**或 base64 data URL（≤32 KiB）；他源 http 图标整份被拒。
4. `category` / `labels` 的 id 必须先在该索引声明，否则报 `references undeclared id`。**`general` 永远声明**，即使没有插件落在里面。
5. git 源必须钉 **40 位小写 commit**，不能用分支名。
6. `engines.dsh` 必填；`title` 必须含 `en`；`engines` 不能写 `workspace:*`。

> 分类与插件之间的引用是**索引生成时的一次性快照**：某插件分类被删（归档）后，网关重建索引时它已迁到 `general`，所以不会出现“插件引用了未声明分类”这种整份失败。这一步必须在生成器里做成硬断言。

> **DSH 不读 npm `dist-tags`**。它自己算“默认版本 = 最高兼容的非预发布版”。想控制推荐版本，只能控制索引里列哪些版本。

**托管要求**：HTTP 200 直出、**不跟随重定向**、UTF-8 JSON、单次 15s 超时、缓存 ≤10 分钟。

---

## 8. 接口清单

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/auth/login` | 账密换 token（`dshm_` 前缀，只存哈希） |
| POST | `/api/v1/auth/device` | 插件设备码登录 |
| GET | `/api/v1/plugins?q=&label=&status=` | 市场列表（含待审核合并） |
| POST | `/api/v1/releases` | 上传 tgz（multipart）→ 校验 → 转存 |
| POST | `/api/v1/releases/:id/approve` | 上架（admin） |
| POST | `/api/v1/releases/:id/reject` | 拒绝 + 理由 |
| POST | `/api/v1/releases/:id/yank` | 下架（索引移除，包保留） |
| GET/PUT | `/api/v1/admin/users` | 建号、改角色、改 scope |
| GET/PUT | `/api/v1/admin/labels` | 标签字典 |
| GET/POST/PATCH/DELETE | `/api/v1/categories` | 分类列表/新建（需 `category:create`）/改名排序/归档（仅 admin，事务内迁移插件到 `general`） |
| GET | `/api/v1/index.json` | 索引（静态产物，可直接由 nginx 出） |
| GET | `/registry/:name`、`/registry/:name/-/:file.tgz` | 反代到 Verdaccio（只读） |

写接口一律要求 token + 角色校验；`/registry` 的 PUT 只允许网关自身的服务 token。

---

## 9. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| **M1** | compose（Verdaccio + 网关 + PG）、`/releases` 上传+校验+转存、索引生成、市场 tab 骨架（列表+安装） | 用 `project-progress-board` 走通：发布 → 上架 → 发现页/市场 tab 看见 → 装上 |
| **M2** | 登录、角色、scope 归属、分类（含 `general` 兜底与归档迁移）、标签字典、软审核、审计 | 无权限账号发布被 403；删分类后其插件自动落到「通用插件」且索引仍合法 |
| **M3** | 市场 tab 完整（搜索/筛选/详情/我的/发布） | 发布后 3 分钟内同事可见，待审核状态正确 |
| **M4** | 管理端 Web、下架/回滚、镜像搬运 | 下架后索引消失、已装用户不受影响 |

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| DSH 0.3 破坏性升级 | `engines.dsh` 精确界；索引并存多版本；保留旧版包 |
| 索引源被篡改（= 投毒） | 索引只由网关生成；文件权限收敛；审计生成记录 |
| 私有 registry 详情页降级 | 强制填 `repository`；功能说明写进 `meta.description` |
| 内网无外网拉不到依赖 | 插件零运行时依赖；其余依赖预先 publish 进 Verdaccio |
| 一键装高权限插件 | 详情页列能力（`inject`）；高风险默认 `enabled:false` |

---

## 11. 动工前要实测的三件事（30 分钟）

1. 第三方插件能否注入 `remote.pluginMarket` 并调到 `search/readEntryDetail`。
2. `pluginManager/listBundles()` 的返回结构：是否带解析路径与版本（决定“发布已装”怎么定位目录）。
3. `installBundle(spec, {registry})` 指向内网 http registry 能否成功（含 pnpm 是否需要额外配置）。

---

## 附：事实来源

`D:\app\dsh\resources\app.asar` 内 `@deepseek-ai/dsh-plugin-market`、`dsh-plugin-market-index`、`dsh-client-ui-plugin-market`、`dsh-plugin-manager`、`dsh-client-ui-plugin-manager` 的 README 与源码（DSH 0.2.2-rc.3）。
