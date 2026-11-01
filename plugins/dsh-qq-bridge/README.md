# dsh-qq-bridge

把 dsh-memory-brain（QQ 桥接）改造成 DSH 纯插件。

## 功能

- **DSH 启动时自动拉起**：
  - `bridge`（`node src/bridge.js`，:3100 控制台）—— SnowLuma→QQ→DSH 桥接
  - `memory-rag`（`.venv/bin/python -m memory_rag.app`，:8093）—— 向量记忆
- **DSH 关闭时自动清理**（`ctx.effect` → kill 子进程）
- **控制台挂到 DSH webServer**：`http://127.0.0.1:3080/dsh-qq-bridge/*` 转发到 :3100
- **DSH WebUI 设置页**：「QQ 桥接」section（显示 bridge 状态 + 控制台入口）

## 结构

```
plugins/dsh-qq-bridge/
├── package.json       # main/exports/dsh.client 配置
├── cordis.patch.yml   # 插件 entry（id: dsh-qq-bridge）
├── lib/index.js       # 宿主半边（apply：spawn bridge/memory-rag + webServer 路由 + 清理）
└── client.js          # 前端设置页（settings.section「QQ 桥接」）
```

## 工作原理

`lib/index.js` 的 `apply(ctx)`：
1. spawn `node src/bridge.js`（BridgeProcess）+ `python -m memory_rag.app`（RagProcess）
2. `ctx.effect(() => () => proc.kill())` 注册清理（DSH 关 → 停子进程）
3. `ctx.webServer.register` 挂 `/dsh-qq-bridge/health`（探活）+ `/dsh-qq-bridge`（prefix 转发控制台到 :3100）

`client.js`：`slots.inject('settings.section', ...)` 注册「QQ 桥接」设置页。
