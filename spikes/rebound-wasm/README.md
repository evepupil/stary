# REBOUND WebAssembly 可行性原型

本目录只用于验证 M0 的物理交付路径。它不会成为正式前端工程，也不定义后续 Worker 消息协议。

## 固定输入

- REBOUND `5.0.1`
- commit `cabb68a03ebb4f3f1c71c6ff8cde33a1476ac417`
- 官方仓库 `https://github.com/hannorein/rebound`
- 源码归档 SHA-256 `7D08E61EF5F0D2BFA6FBE3BF810D33F87A3FA1061B185595B7412AC685918FCD`
- Worker 补丁 SHA-256 `02547C2CD55D19828988E0B68234EFA24C6CFA45507CA9745CA7973D6AEE734C`
- Emscripten `6.0.3`
- 构建镜像 `emscripten/emsdk@sha256:bb0910e6a18bb9bd7cb31ae4ed40f9073148b78cb2cdb8ea8676454e0d85425c`

完整固定值位于 `source-lock.json`。下载脚本会在解压前校验源码 SHA-256，每次从归档重建干净源码树，并校验 `patches/` 中的固定补丁。容器构建使用 `patch --forward --batch -p1` 应用补丁。补丁只禁用 REBOUND 积分循环内面向上游网页显示的 120Hz `emscripten_sleep(0)` 调用，物理积分逻辑保持原样。

## 构建与验证

在本目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
node --test tests/*.test.mjs
node scripts/run-acceptance.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

构建只依赖 Docker，不向系统安装 Emscripten。输出是独立的 `dist/rebound.mjs` 和 `dist/rebound.wasm`。构建参数明确关闭 fast-math，并且没有使用 `SINGLE_FILE` 或 `ASYNCIFY`。

`verify.ps1` 是一次性交付门禁：从固定容器重新构建，运行全部 Node 测试和数值验收，再根据 `artifact-lock.json` 严格比对源码输入、补丁、`.mjs` 和 `.wasm` 的 SHA-256 与字节数。

静态验收页位于 `web/index.html`。它必须通过 HTTP 打开，因为模块 Worker 和 WebAssembly 受浏览器同源规则约束。经用户许可后，可从仓库根目录临时运行项目内服务器：

```powershell
node spikes/rebound-wasm/scripts/static-server.mjs
```

然后访问 `http://127.0.0.1:4173/web/`。服务器只绑定本机地址，只开放 `web/` 和 `dist/`，并为 `.mjs` 和 `.wasm` 返回浏览器要求的 MIME。页面会自动运行一周期验收，也可手动运行 1000 周期守恒验收。

## 目录说明

- `src/rebound_bridge.c`：REBOUND 的最小 C 接口。
- `patches/`：固定上游版本的可审计源码补丁。
- `artifact-lock.json`：固定构建输入与发布产物哈希。
- `scripts/static-server.mjs`：带固定 MIME 和安全路径限制的本机验收服务器。
- `web/rebound-client.mjs`：面向 Worker 的 JavaScript 适配层。
- `web/physics-worker.mjs`：静态浏览器验收 Worker。
- `web/sun-earth-scenario.mjs`：固定的太阳-地球质心场景和容差。
- `tests/`：Node 中直接加载浏览器同款 WASM 产物的轨道测试。
- `.cache/`：校验后的上游源码，只用于本地构建，不进入 Git。

## 已知边界

- REBOUND 原始 Emscripten 路径会在单次积分墙钟超过约 8.33ms 时调用 `emscripten_sleep(0)`。专用 Worker 不承担上游页面刷新，所以固定补丁禁用了这一显示让出调用，构建仍不使用 `ASYNCIFY`。当前长周期验收的同步循环会占用物理 Worker，不会在片段之间处理新消息；M0 正式调度必须由 JavaScript 异步让出 Worker 事件循环。
- M0 只验证 IAS15 的双天体场景。多体规模、WHFast 参数、近距离相遇和正式消息协议留给后续任务。
- REBOUND 与本桥接构成 GPL 覆盖的组合。发布二进制时必须同时履行 `THIRD_PARTY_NOTICES.md` 记录的源码与许可义务。
