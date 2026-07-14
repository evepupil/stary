# STARY Project Roadmap

## Product Goal

交付一个在浏览器中运行的恒星系统级宇宙沙盒。用户可以创建天体、操纵时间、观察多体引力、制造分层碰撞，并保存和回放实验；物理可信度、画面真实感和交互流畅度都必须有明确验收标准。

## Current Phase

M0 实施中。正式 REBOUND 物理 Worker 已完成真实双天体轨道、时间控制和守恒验证，进入 Task 5 Three.js 场景与相机。

## Milestones

| ID | Milestone | Goal | Status | Priority | Depends On | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| M0 | 工程底座与垂直切片 | 建立严格类型、测试和构建门禁，跑通一个可观察的双天体轨道 | active | P0 | None | 设计规格 `0203102` |
| M1 | 创造与观测 | 完成天体创建、参数编辑、轨道预览、相机和时间控制 | planned | P0 | M0 | None |
| M2 | 真实画面 | 完成恒星、行星、大气、光照、尺度切换和兼容回退 | planned | P0 | M0, M1 | None |
| M3 | 碰撞与碎片 | 完成分层碰撞、守恒校验、主要碎块和视觉碎屑 | planned | P0 | M0, M1, M2 | None |
| M4 | 历史与存档 | 完成快照、回放、实验分支、本地存储和文件分享 | planned | P1 | M1, M3 | None |
| M5 | 自适应与首版验收 | 完成性能分档、手机适配、错误恢复和端到端验收 | planned | P1 | M2, M3, M4 | None |

## Active Work

- M0 Task 1：已完成。固定构建、GPL 边界、一周期与 1000 周期验收、浏览器 Worker 和产物哈希门禁均有证据。
- M0 Task 2：已完成。React/Vite/TypeScript strict、pnpm 锁文件、格式/lint/类型/单测/生产构建门禁和前端产物检查均已建立。
- M0 Task 3：已完成。建立版本 1 双向消息、SI 天体状态、Zod 运行时校验和会话顺序门。
- M0 Task 4：已完成。正式 TypeScript 适配层在独立 module Worker 中运行固定 REBOUND 5.0.1 WASM，支持时间控制、安全清理、双天体轨道和守恒验证。
- M0 Task 5：准备建立 Three.js 全屏场景、相机、时间控制界面和物理状态显示。

## Next Recommended Steps

1. 执行 M0 Task 5，建立 Three.js 全屏场景、相机和时间控制。
2. 把正式 Worker 状态接入渲染适配层和守恒指标显示。
3. 完成浏览器垂直切片与 WebGPU/WebGL2 回退验收。

## Inbox

| Item | Source | Status | Triage |
| --- | --- | --- | --- |
| None | None | None | None |

## Backlog

| Item | Priority | Reason | Status |
| --- | --- | --- | --- |
| 银河尺度模拟 | P3 | 超出恒星系统级首版范围 | parked |
| 完整广义相对论 | P3 | 计算与验证成本远高于首版目标 | parked |
| 恒星完整生命周期 | P3 | 需要独立的恒星演化模型 | parked |
| 行星表面降落与人物移动 | P3 | 属于另一类交互系统 | parked |
| 在线多人、账号和云存档 | P3 | 首版采用本地优先 | parked |

## Risks and Unknowns

| Risk/Question | Impact | Status |
| --- | --- | --- |
| REBOUND 与浏览器 WebAssembly 的集成方式和包体积需要原型验证 | Node 与浏览器 Worker 验收均通过 | resolved |
| WebGPU 与 WebGL2 的功能一致性可能限制高级大气和黑洞效果 | 影响兼容范围与画面验收 | open |
| 512 个主要天体和 50,000 个视觉碎屑的目标需要参考设备基准测试 | 影响首版规模承诺 | open |
| 分层碰撞模型需要可靠论文参数或公开模型作依据 | 影响物理可信度 | open |
| 跨浏览器回放只能承诺数值容差内一致，无法提前承诺逐位相同 | 影响分享和复现实验 | open |

## Decision Log

| Date | Decision | Reason | Evidence |
| --- | --- | --- | --- |
| 2026-07-14 | 首版采用自由宇宙沙盒，兼顾创造和灾难实验 | 用户确认双模式体验 | 设计规格 |
| 2026-07-14 | 首版限制在恒星系统级 | 保住物理精度和近景画面 | 设计规格 |
| 2026-07-14 | 物理真实值与视觉增强分层 | 兼顾真实尺度与可观察性 | 设计规格 |
| 2026-07-14 | 采用 REBOUND/WASM、Rust 碰撞扩展和 Three.js 混合架构 | 平衡物理可靠性、浏览器性能和兼容性 | 设计规格 |
| 2026-07-14 | 存档本地优先，首版不引入账号和后端 | 控制首版范围并支持文件分享 | 设计规格 |
| 2026-07-14 | 接受 GPL-3.0-or-later 发布要求 | REBOUND 5.0.1 使用 GPL-3.0-or-later | 用户确认与可行性报告 |
| 2026-07-14 | 固定 Emscripten 6.0.3 镜像摘要构建 REBOUND | 避免全局安装并保证构建输入可审计 | `docs/rebound-wasm-feasibility.md` |
| 2026-07-14 | 正式物理协议固定为版本 1，使用 SI 字段、Zod 校验和新 session 重启门 | 隔离物理实现并阻止非法、乱序和旧 Worker 消息进入应用 | `docs/模块设计/物理核心.md` |
| 2026-07-14 | 1x 固定为每现实秒推进 1 模拟秒，倍率上限为 5400000，单片最多推进 1 模拟天 | 超量时主动降低并回报实际倍率，不保留隐形积压，同时保持 IAS15 精度策略 | `docs/模块设计/物理核心.md` |

## Recent Progress

- 2026-07-14：建立项目路线图与仓库级 AI 开发规范，提交 `67c56eb`。
- 2026-07-14：完成 M0 垂直切片自适应工程计划，等待执行方式确认。
- 2026-07-14：完成并提交 13 章宇宙沙盒设计规格，提交 `0203102`。
- 2026-07-14：完成 M0 Task 1 的 REBOUND/WASM 固定构建、Node 轨道验收、许可记录和静态 Worker 验收页。
- 2026-07-14：完成 M0 Task 1 浏览器验收；一周期与 1000 周期指标通过，控制台无 warning/error，并建立固定产物哈希门禁。
- 2026-07-14：完成 M0 Task 2 严格工程底座；建立可重复安装、格式/lint/类型/单测/生产构建门禁，并验证 Worker、WASM、WebGPU 和 WebGL2 构建产物。
- 2026-07-14：完成 M0 Task 3 正式消息协议；建立版本、SI 数据、双向运行时解析、严格序号与 Worker 重启隔离测试。
- 2026-07-14：完成 M0 Task 4 正式物理 Worker；固定 REBOUND 5.0.1 在产品 TypeScript 适配层中运行真实圆轨道、椭圆轨道、1000 周期守恒和倍率等价测试。
