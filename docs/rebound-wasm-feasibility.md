# REBOUND WebAssembly 可行性报告

- 日期：2026-07-14
- 对应计划：M0 Task 1
- 结论：技术路径可行，Node 与桌面浏览器 Worker 验收均已通过

## 1. 验证目标

本原型验证 REBOUND 能否通过固定工具链编译成独立的 JavaScript 模块和 WebAssembly 文件，并在 Worker 目标环境中运行真实单位的太阳-地球双天体场景。原型隔离在 `spikes/rebound-wasm/`，不会作为正式物理模块直接进入应用。

## 2. 固定来源

| 项目 | 固定值 |
| --- | --- |
| 上游项目 | `https://github.com/hannorein/rebound` |
| tag | `5.0.1` |
| commit | `cabb68a03ebb4f3f1c71c6ff8cde33a1476ac417` |
| 源码 URL | `https://github.com/hannorein/rebound/archive/cabb68a03ebb4f3f1c71c6ff8cde33a1476ac417.tar.gz` |
| 源码 SHA-256 | `7D08E61EF5F0D2BFA6FBE3BF810D33F87A3FA1061B185595B7412AC685918FCD` |
| Worker 补丁 | `patches/rebound-5.0.1-worker-no-emscripten-sleep.patch` |
| 补丁 SHA-256 | `02547C2CD55D19828988E0B68234EFA24C6CFA45507CA9745CA7973D6AEE734C` |
| 上游许可 | `GPL-3.0-or-later` |
| 构建镜像 | `emscripten/emsdk:6.0.3` |
| 镜像 digest | `sha256:bb0910e6a18bb9bd7cb31ae4ed40f9073148b78cb2cdb8ea8676454e0d85425c` |
| 镜像 ID | `sha256:1998ba0793f0e61685f08c62a3e78bbcd1ef84895fefe994bf48d8d66dc1e495` |
| Emscripten | `6.0.3 (283e2d130132859fde6a4e4c87fd254b38127651)` |
| 目标架构 | `wasm32`，构建容器为 `linux/amd64` |

`source-lock.json` 保存这些固定值。`fetch-source.ps1` 最多尝试下载三次，解压前验证归档 SHA-256。每次构建都会删除缓存中的解压目录，从已验证归档重新解压，再验证 `version.txt`、补丁 SHA-256、补丁可应用性和应用结果，避免被修改的缓存源码进入产物。`git ls-remote --tags` 已确认 tag `5.0.1` 指向上述 commit。

## 3. 许可结论

REBOUND 使用 `GPL-3.0-or-later`。用户已经确认 STARY 接受 GPL 发布要求。根目录 `LICENSE` 包含 GPL v3 完整文本，`THIRD_PARTY_NOTICES.md` 记录固定源码、桥接修改和发布方的对应源码交付责任。

当前原型对 REBOUND 上游源码应用一项固定补丁。补丁只把 `simulation.c` 积分循环内用于上游网页显示刷新的 120Hz `emscripten_sleep(0)` 调用替换为说明注释，因为本项目把物理运行放在专用 Worker，线程调度由 JavaScript 负责。补丁没有修改积分器、引力、步长或状态计算。新增的 `rebound_bridge.c`、补丁与生成产物共同按 GPL 覆盖。正式发布时，需要把固定的 REBOUND 对应源码、补丁、桥接源码和可复现构建脚本一同提供给接收者。只链接上游下载地址不足以自动完成发布方义务。

## 4. 构建方式

Windows 入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/rebound-wasm/scripts/build.ps1
```

容器内核心编译参数：

```text
-O3
-std=c11
-DNDEBUG
-D_GNU_SOURCE
-DGITHASH=cabb68a03ebb4f3f1c71c6ff8cde33a1476ac417
-fno-fast-math
--no-entry
-sMODULARIZE=1
-sEXPORT_ES6=1
-sEXPORT_NAME=createReboundModule
-sENVIRONMENT=worker,node
-sALLOW_MEMORY_GROWTH=1
-sFILESYSTEM=0
-sASSERTIONS=0
-sERROR_ON_UNDEFINED_SYMBOLS=1
```

构建没有使用 `SINGLE_FILE`、`ASYNCIFY` 或 fast-math。输出保持为独立 `.mjs` 和 `.wasm`，便于缓存、审计和 Worker 加载。

编译前，获取脚本从已校验归档重建源码并检查固定 Worker 补丁。补丁文件和哈希都进入版本控制，容器构建用 `patch --forward --batch -p1` 应用；检查或应用失败都会终止构建。

## 5. 桥接范围

薄 C 桥接导出以下能力：

- 创建、销毁和重置模拟实例
- 添加带质量、半径、三维位置和三维速度的粒子
- 设置 IAS15 或 WHFast 积分器及初始步长
- 移动到质心坐标
- 积分到指定绝对模拟时间
- 读取模拟时间、粒子数量、粒子状态、总能量和角动量

JavaScript 适配层把 C 状态码转换为清楚的异常，并返回普通对象。正式 M0 仍需通过后续任务定义带版本、序号和运行时校验的 Worker 消息协议。

## 6. 固定场景与容差

场景使用 SI 单位和质心坐标：

- `G = 6.67430e-11 m^3 kg^-1 s^-2`
- 太阳质量 `1.98847e30 kg`
- 地球质量 `5.9722e24 kg`
- 两体间距 `149597870700 m`
- 圆轨道角速度和周期由两体总质量解析计算
- IAS15 初始步长为解析周期的 `1/1000`

| 指标 | 固定上限 | 实测 |
| --- | ---: | ---: |
| 一周期位置相对误差 | `1e-9` | `1.7269473537659648e-15` |
| 一周期速度相对误差 | `1e-9` | `1.9428298167122937e-15` |
| 一周期等效周期相对误差 | `1e-10` | `2.72927861006749e-16` |
| 一周期轨道半径相对误差 | `1e-10` | `2.0399740973719625e-16` |
| 1000 周期总能量相对误差 | `1e-9` | `1.3926629306327789e-14` |
| 1000 周期角动量相对误差 | `1e-9` | `7.08704958019727e-15` |

“等效周期相对误差”取一周期后相位残差除以 `2π`。1000 周期门槛比总体设计的 `1e-5` 更严格，给正式线程调度和多体场景保留误差余量。

## 7. 产物大小

| 文件 | 原始大小 | gzip -9 |
| --- | ---: | ---: |
| `rebound.mjs` | 11,455 B | 3,985 B |
| `rebound.wasm` | 233,850 B | 92,490 B |
| 合计 | 245,305 B | 96,475 B |

gzip 数字通过 Node `zlib.gzipSync` 的 level 9 计算。浏览器实际传输大小还取决于服务器压缩配置和 HTTP 缓存。

`artifact-lock.json` 固定源码 commit、源码归档 SHA-256、补丁 SHA-256、构建镜像 digest，以及 `rebound.mjs` 和 `rebound.wasm` 的 SHA-256 与字节数。校验器要求产物清单必须且只能包含这两个文件。`verify.ps1` 会从固定容器干净重建后严格比对这些值，阻止提交的 `dist/` 与源码或补丁脱节。

## 8. 已完成验证

```powershell
node --test spikes/rebound-wasm/tests/*.test.mjs
node spikes/rebound-wasm/scripts/run-acceptance.mjs
```

Node 22.14.0 成功加载面向 `worker,node` 的同一组 `.mjs` 和 `.wasm` 产物。其中两项轨道测试分别覆盖一周期状态误差和 1000 周期守恒误差。

当前共有 7 个测试文件、13 项自动测试，覆盖桥接重置与非法质量、源码缓存清理、固定补丁存在与应用、一周期误差、1000 周期守恒、验收结果完整性与有限数检查、产物锁严格文件集合与拒绝篡改，以及静态服务器 MIME 和路径穿越防护。

静态浏览器页位于 `spikes/rebound-wasm/web/index.html`，通过模块 Worker 加载同一产物。应用内浏览器在 `http://127.0.0.1:4173/web/` 完成真实验收：一周期四项指标全部通过，1000 周期能量和角动量指标全部通过，控制台 warning 和 error 均为 0。应用内截图 API 超时，Playwright CLI 截图成功，页面结果可见。

经用户许可后，从仓库根目录运行 `node spikes/rebound-wasm/scripts/static-server.mjs`。服务器固定绑定 `127.0.0.1:4173`，为 `.mjs` 返回 `application/javascript`，为 `.wasm` 返回 `application/wasm`，并且只开放原型的 `web/` 和 `dist/` 目录。

## 9. 限制与后续约束

- 固定补丁只禁用积分循环内面向上游网页显示的 120Hz `emscripten_sleep(0)` 调用，其他 Emscripten、显示和物理逻辑保持不变。当前 1000 周期测试仍由同步循环连续调用，期间会占用物理 Worker；正式 Worker 必须按小时间片推进，并在 JavaScript 事件循环中主动让出执行权。
- 原型只证明双天体 IAS15 路径。WHFast 的坐标设置、时间步长和长期误差需要独立测试。
- 原型没有验证 512 个主要天体、线程消息开销、Worker 重启、浏览器内存上限和手机兼容性。
- `ALLOW_MEMORY_GROWTH` 方便后续多体试验，但内存增长会暂停 Worker。正式模块需要基准测试后确定初始内存。
- 当前 `.mjs` 适配层是可行性代码。后续不得绕过正式跨线程协议直接让界面调用桥接。

## 10. 决策

REBOUND 5.0.1 能通过固定源码、固定镜像和项目内脚本生成可审计的 WebAssembly 产物，并达到 M0 双天体精度要求。桌面浏览器 Worker 验收已经通过，可以进入 M0 Task 2；正式物理模块仍由 Task 3 和 Task 4 落地。
