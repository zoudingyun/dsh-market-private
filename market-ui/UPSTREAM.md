# Fork 来源与改动边界

本目录是 [`dsh-market/dsh-market`](https://github.com/dsh-market/dsh-market) 的 fork，**不是**我们从零写的 UI。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/dsh-market/dsh-market |
| 基线版本 | `dshmarket@1.80.0` |
| 基线提交 | `8747e07367df7f16d6186e1c9047daecee3e8174`（2026-11-22，release 1.80.0） |
| 许可 | MIT（见 `LICENSE`） |
| 引入方式 | 下载该提交的源码包解压入库，未保留上游 `.git` |

## 我们需要在上游之上加的三个口子

上游已经具备：多市场目录（公共 / 组织锁定 / 用户自建，`src/catalogs.ts` + `src/client/CatalogsPanel.tsx`）、安装、更新、备份、诊断。缺的正好是三件：

| 编号 | 能力 | 落点（预计） |
|---|---|---|
| P1 | **市场鉴权探测**：添加自定义市场时先 `GET /api/v1/market/info`，按 `requiresAuth` 决定免登录 / 可选登录 / 强制登录 | `src/client/CatalogsPanel.tsx`、`src/catalogs.ts` |
| P2 | **登录**：账号密码换 token，token 存进宿主凭据（不落明文到目录配置），请求索引时注入 `Authorization` | 新增 `src/account.ts`、`src/routes.ts` |
| P3 | **发布本机插件**：列已装组合包 → 打包 → `POST /api/v1/releases` | 新增 `src/publish.ts`、`src/routes.ts` |

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

## 升级上游的方式

上游迭代很快（1.80.0 仍在发版），升级时**不要**整目录覆盖，否则改动丢失。建议：

```bash
git remote add upstream https://github.com/dsh-market/dsh-market.git
git fetch upstream main
git diff <当前基线> upstream/main -- src/catalogs.ts src/client/CatalogsPanel.tsx src/routes.ts
```

先看冲突范围，再决定整体 rebase 还是逐文件迁移。
