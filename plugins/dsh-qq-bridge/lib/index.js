// dsh-qq-bridge 插件 · 宿主半边
//
// 目标：把 dsh-memory-brain 的 bridge（SnowLuma→QQ→DSH）与 memory-rag 改造成
// DSH 纯插件（混合方案）：
//   1. DSH 启动时自动 spawn bridge（node src/bridge.js）+ memory-rag（python）
//   2. 控制台（原 :3100）改挂 DSH webServer（/dsh-qq-bridge/*）
//   3. DSH 关闭时自动清理（ctx.effect 注册 stop → kill 子进程）
//
// 策略（混合方案）：
//   - bridge.js 内部逻辑不动（12378 行 main()），作为子进程 spawn 管理
//   - 参考官方先例 dsh-bili-subagent：spawn 长驻子进程 + ctx.effect(() => () => proc.kill())
//   - 子进程崩溃时监听 exit 重置引用，下次访问自动重启
//
// ⚠ 注意事项（来自调研）：
//   - 长驻服务不要 detached/unref（否则 DSH 关闭时不杀）
//   - ctx.effect 清理只有 5 秒宽限，清理函数必须快
//   - ctx 是 Proxy，必须把用到的服务写进 inject 数组

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
// 项目根：插件包在 <项目>/plugins/dsh-qq-bridge/，上两级是项目根
const PROJECT_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const NODE_BIN = process.execPath || 'node';

// 诊断日志（可被 QQ_BRIDGE_DIAG 覆盖；空串=关闭）
const DIAG = process.env.QQ_BRIDGE_DIAG ?? path.join(process.env.DSH_HOME || '', 'qq-bridge-plugin.log');
function diag(msg) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* 诊断失败不影响 */ }
}

// 可热改、不重挂载的配置（DSH settings 可写）
// 注：阶段 2 暂不导出 Config（避免 schemastery 解析问题；DSH 会用默认配置）。
// 阶段 5 设置页需要时再引入并确保依赖可用。

export const name = 'dsh-qq-bridge';
export const inject = ['webServer', 'settings', 'timer'];

/**
 * 长驻 bridge 子进程管理（仿 dsh-bili-subagent 的 mcp.mjs）。
 */
class BridgeProcess {
  constructor(cfg, logFile) {
    this.cfg = cfg;
    this.logFile = logFile;
    this.proc = null;
    this.starting = null;
  }

  running() {
    return this.proc !== null && this.proc.exitCode === null;
  }

  start() {
    if (this.running()) return this.proc;
    if (!this.cfg.enabled) return null;
    diag(`spawn bridge: ${NODE_BIN} ${this.cfg.bridgePath}`);
    this.proc = spawn(NODE_BIN, [this.cfg.bridgePath], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    // 日志输出到插件日志文件
    const logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this.proc.stdout?.pipe(logStream);
    this.proc.stderr?.pipe(logStream);
    this.proc.on('exit', (code, signal) => {
      diag(`bridge exited: code=${code} signal=${signal}`);
      this.proc = null; // 重置引用，下次访问自动重启
    });
    this.proc.on('error', (err) => {
      diag(`bridge spawn error: ${err?.message ?? err}`);
      this.proc = null;
    });
    return this.proc;
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* 已退 */ }
      this.proc = null;
    }
  }
}

/**
 * memory-rag 长驻子进程管理（Python HTTP 服务，:8093）。
 * 与 BridgeProcess 类似，但 cmd/args/cwd 不同（Python venv + sidecars/memory-rag）。
 */
class RagProcess {
  constructor(cfg, logFile, projectRoot) {
    this.cfg = cfg;
    this.logFile = logFile;
    this.projectRoot = projectRoot;
    this.proc = null;
  }

  running() {
    return this.proc !== null && this.proc.exitCode === null;
  }

  start() {
    if (this.running()) return this.proc;
    if (!this.cfg.enabled) return null;
    const ragDir = path.join(this.projectRoot, 'sidecars', 'memory-rag');
    const py = path.join(ragDir, '.venv', 'bin', 'python');
    diag(`spawn memory-rag: ${py} -m memory_rag.app (cwd=${ragDir})`);
    this.proc = spawn(py, ['-m', 'memory_rag.app'], {
      cwd: ragDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this.proc.stdout?.pipe(logStream);
    this.proc.stderr?.pipe(logStream);
    this.proc.on('exit', (code, signal) => {
      diag(`memory-rag exited: code=${code} signal=${signal}`);
      this.proc = null;
    });
    this.proc.on('error', (err) => {
      diag(`memory-rag spawn error: ${err?.message ?? err}`);
      this.proc = null;
    });
    return this.proc;
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* 已退 */ }
      this.proc = null;
    }
  }
}

/**
 * 装配钩子（混合方案阶段 2）：
 * 1. spawn bridge 子进程
 * 2. ctx.effect 注册清理（DSH 关 → kill bridge）
 * 3. 挂探活/控制台路由（阶段 3 完善）
 */
export function apply(ctx, config) {
  // 默认启用 bridge + 默认 bridgePath（DSH 配置没传时自动用项目内 bridge.js）
  const DEFAULT_BRIDGE = path.join(PROJECT_ROOT, 'src', 'bridge.js');
  const cfg = { enabled: true, bridgePath: DEFAULT_BRIDGE, ragEnabled: true, ...(config ?? {}) };
  diag(`apply called; enabled=${cfg.enabled}; ragEnabled=${cfg.ragEnabled}; webServer=${typeof ctx.webServer}; settings=${typeof ctx.settings}`);

  // 日志文件
  const stateDir = path.join(process.env.DSH_HOME || PROJECT_ROOT, 'qq-bridge');
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
  const bridgeLog = path.join(stateDir, 'bridge.log');

  const bridge = new BridgeProcess(cfg, bridgeLog);
  bridge.start();

  // DSH 关闭时清理 bridge 子进程（5 秒宽限，必须快）
  ctx.effect(() => () => {
    diag('DSH 关闭：停 bridge');
    bridge.stop();
  }, 'dsh-qq-bridge: 收 bridge 子进程');

  // 阶段 4：memory-rag（Python :8093）——spawn + 清理
  const ragLog = path.join(stateDir, 'memory-rag.log');
  const rag = new RagProcess({ enabled: cfg.ragEnabled }, ragLog, PROJECT_ROOT);
  rag.start();
  ctx.effect(() => () => {
    diag('DSH 关闭：停 memory-rag');
    rag.stop();
  }, 'dsh-qq-bridge: 收 memory-rag 子进程');

  // 探活路由（阶段 3 替换为完整控制台）
  try {
    if (ctx.webServer?.register) {
      ctx.effect(() => ctx.webServer.register({
        path: '/dsh-qq-bridge/health',
        handler: async (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            plugin: 'dsh-qq-bridge',
            bridge: bridge.running() ? 'running' : 'stopped',
            bridgePath: cfg.bridgePath,
          }));
        },
      }), 'dsh-qq-bridge: 探活路由');
      diag('webServer.register 探活路由成功');
    }
  } catch (err) {
    diag(`webServer.register 失败: ${err?.message ?? err}`);
  }

  // 阶段 3：控制台转发路由（kind:'prefix'，转发到 :3100，剥离 CSP/X-Frame-Options）
  // 控制台通过 http://127.0.0.1:3080/dsh-qq-bridge/* 访问，真正挂到 DSH webServer。
  // exact 优先于 prefix，所以 /dsh-qq-bridge/health 仍走上面的探活路由。
  try {
    if (ctx.webServer?.register) {
      const CONSOLE_PORT = Number(process.env.QQB_CONSOLE_PORT || cfg.consolePort || 3100);
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-qq-bridge',
        handler: async (req, res) => {
          // 去掉 /dsh-qq-bridge 前缀，转发到 bridge 控制台 :3100
          const pathname = (req.url || '/').replace(/^\/dsh-qq-bridge/, '') || '/';
          const upstream = http.request({
            host: '127.0.0.1',
            port: CONSOLE_PORT,
            path: pathname,
            method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${CONSOLE_PORT}` },
          }, (upRes) => {
            // 剥离会阻止在 DSH 页面内嵌入/访问的安全头
            const headers = { ...upRes.headers };
            delete headers['content-security-policy'];
            delete headers['x-frame-options'];
            res.writeHead(upRes.statusCode || 200, headers);
            upRes.pipe(res);
          });
          upstream.on('error', (err) => {
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
            }
            res.end(JSON.stringify({ ok: false, error: `bridge 控制台不可达: ${err?.message ?? err}` }));
          });
          req.pipe(upstream);
        },
      }), 'dsh-qq-bridge: 控制台转发路由');
      diag('webServer.register 控制台转发路由成功');
    }
  } catch (err) {
    diag(`webServer.register 转发失败: ${err?.message ?? err}`);
  }
}
