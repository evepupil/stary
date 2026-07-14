# STARY M0 Vertical Slice Engineering Plan

> **For agentic workers:** This is an adaptive plan. First inspect the live codebase, then choose final paths, abstractions, and commit messages from the actual diff. Do not treat likely touchpoints as locked implementation instructions.

**Goal:** 建立可持续开发的网页工程底座，并在浏览器中跑通一个由独立物理线程驱动、可暂停和变速、可自由观察的双天体真实轨道。

**Non-Goals:** 本计划不实现天体创建器、高级行星材质、大气、分层碰撞、历史分支、完整存档、512 天体性能目标和手机端完整适配。

**Planning Mode:** Adaptive Engineering Plan

---

## Roadmap Link

- Milestone: M0 工程底座与垂直切片
- Roadmap item: 建立严格类型、测试和构建门禁，跑通一个可观察的双天体轨道
- Completion update required: yes

## Goal and Boundaries

### In scope

- 选择并建立适合 Three.js、Web Worker 和 WebAssembly 的前端工具链。
- 开启 TypeScript 严格模式，建立格式、静态检查、测试和生产构建门禁。
- 在浏览器中验证 REBOUND 的 WebAssembly 集成路径、许可、包体积和跨线程调用。
- 建立带物理单位的天体数据和跨线程消息协议。
- 用 REBOUND 或经用户确认的替代路径运行双天体轨道。
- 建立最小的 Three.js 全屏场景、相机、时间控制和物理状态显示。
- 建立 WebGPU 能力检测与 WebGL2 回退边界；M0 只要求两条路径能显示基础场景。
- 为工程底座、物理核心和渲染交互建立模块设计归档。
- 用真实轨道测试、生产构建和浏览器验收证明垂直切片可用。

### Out of scope

- 用户自由创建、删除和修改天体。
- 稳定性预测、引力弹弓辅助和复杂多体场景。
- 真实行星表面、程序化地形、大气散射、体积云和黑洞画面。
- 碰撞分类、碎片、熔融和能量账本。
- 时间倒退、快照、分支、导入导出和自动保存。
- 首版最终性能规模与视觉品质验收。

### Compatibility and migration constraints

- 桌面 Chrome/Edge 的当前稳定版本是 M0 的首要运行环境。
- Safari、Firefox 和手机端在 M0 只记录能力结果，不承诺完整体验。
- WebGPU 缺失时必须回退到 WebGL2，不能显示空白画布。
- 物理数据使用千克、米、秒和双精度数值；渲染适配层负责缩放。
- M0 没有用户存档格式，因此不承担数据迁移。

### Implementation assumptions to verify

- Vite、React、TypeScript 和 pnpm 适合当前空仓库；脚手架前重新确认最新稳定组合与浏览器要求。
- REBOUND 能通过可信的预编译包或项目内可复现的编译流程进入 WebAssembly。
- REBOUND 的许可与计划的分发方式兼容。
- Three.js 的 WebGPU 和 WebGL2 渲染器能够共用 M0 场景数据。
- 浏览器端物理线程能以可接受的消息开销输出双天体状态。

## Known Context

- 仓库当前只包含设计、路线图和 AI 开发规范，没有应用代码、依赖清单或现成测试。
- 总体设计规格位于 `docs/superpowers/specs/2026-07-14-universe-sandbox-design.md`，提交为 `0203102`。
- 路线图位于 `docs/superpowers/roadmap.md`，M0 当前状态为 `active`。
- 仓库规范位于 `AGENTS.md`，要求严格类型、核心逻辑单测、浏览器验收、模块归档和通过门禁后直接提交。
- 当前机器已验证 Node `22.14.0`、npm `10.9.2`、pnpm `10.21.0`、Rust `1.96.0` 和 Cargo `1.96.0` 可用。
- 当前机器未检测到 `wasm-pack`、Clang 或 Emscripten `emcc`。
- CodeGraph 尚未初始化，用户没有确认执行 `codegraph init -i`。
- 用户要求除非明确提出，禁止自行启动开发服务器。

## Likely Touchpoints

仓库仍为空，以下位置只是实施时的候选起点：

- 根目录的包清单、TypeScript 配置、构建配置和代码质量配置。
- 一个前端应用入口，用于挂载全屏模拟器界面。
- 一个独立物理 Worker 及其主线程消息协议。
- 一个 WebAssembly 适配层，隔离 REBOUND 的具体导出接口。
- 一个渲染适配层，隔离 WebGPU 与 WebGL2 后端。
- 物理、渲染、时间控制和单位换算的测试目录。
- `docs/模块设计/` 下的工程底座、物理核心、渲染与交互归档。

最终目录和文件名必须在脚手架建立后，结合实际工具约定再确定。

## Risks and Open Questions

### REBOUND WebAssembly 可行性

REBOUND 以 C 为主要实现，当前机器缺少 Emscripten 和 Clang。第一项工作必须先证明浏览器集成路径。优先评估维护状态、许可和可复现构建，再决定使用可信预编译包或项目内工具链。若只能依赖不可审计的二进制、不可接受的全局安装或无法自动构建，停止并请用户选择。

### 工具链版本

Node 22 和 Rust 1.96 已存在，但前端框架、Three.js 和 WebAssembly 工具的兼容组合尚未建立。脚手架阶段应锁定版本并记录真实验证命令，避免计划中的推荐变成未经验证的事实。

### 渲染后端差异

Three.js 的 WebGPU 与 WebGL2 路径在材质和后处理上有差异。M0 只共享场景状态和基础材质，不提前抽象完整画面系统。若基础场景都无法共享，先记录差异，再收窄后端接口。

### 数值与显示尺度

天文位置直接传给 GPU 会产生抖动。M0 需要从一开始隔离物理坐标和画面坐标，并用相机相对坐标或统一缩放验证稳定性。若最小方案在拉远和靠近时出现明显抖动，停止扩展界面，先修正坐标策略。

### 线程时序

物理更新和画面刷新频率不同。消息协议需要包含模拟时间、单调递增序号和完整或增量状态类型，避免旧帧覆盖新帧。Worker 重启和错误恢复在 M0 只做到可见错误与安全暂停。

### 本地服务授权

生产构建、单测和静态检查不需要启动开发服务器。浏览器端到端验收需要本地页面服务；执行到该步骤前必须获得用户明确许可。

## Verification Strategy

### Toolchain gate

- 脚手架完成后，在 `package.json` 中建立并记录格式检查、lint、TypeScript 类型检查、单元测试和生产构建脚本。
- 把经过实际运行的命令同步回 `AGENTS.md`，不保留猜测命令。
- 锁文件必须提交，依赖安装在干净环境中可重复。

### Physics tests

- 两体圆轨道：一个周期后位置、速度和轨道半径落在明确容差内。
- 两体椭圆轨道：近日点、远日点和周期符合解析结果。
- 守恒检查：运行指定周期后，总能量和角动量误差低于 M0 测试阈值。
- 协议检查：拒绝 `NaN`、无穷大、负质量、重复标识和乱序 Worker 状态。
- 单位检查：物理层输入输出只使用约定的 SI 单位，显示层换算不回写物理状态。

M0 可以使用比首版 `1000` 周期更短的快速测试，但必须额外提供一个可单独运行的长周期验证，用于检查总体设计中的 `10^-5` 能量误差目标。

### Integration checks

- 主线程能够启动、暂停、单步推进和关闭物理 Worker。
- 时间倍率变化不改变相同模拟时刻的轨道结果，只改变完成该模拟时间所需的现实时间。
- Worker 错误会让模拟安全暂停并显示可理解的错误状态。
- WebGPU 初始化失败时，WebGL2 回退仍能显示恒星、行星和轨道。

### Browser and visual checks

获得用户启动本地服务的许可后：

- 在桌面宽屏、普通笔记本尺寸和手机尺寸检查布局。
- 检查画布非空、相机可环绕与缩放、天体不被界面遮挡。
- 采集 WebGPU 与 WebGL2 基础场景截图。
- 检查控制台错误、未处理 Promise 和 Worker 异常。
- 对画布进行像素检查，防止空白画布通过仅 DOM 断言的测试。

## Execution Tasks

### Task 1: Prove the physics delivery path

**Intent:** 在建立完整应用前，证明 REBOUND 可以以可审计、可复现的方式在目标浏览器中运行双天体步进，并形成书面结论。

**Likely touchpoints:** 一个隔离的项目内原型位置、依赖清单候选、物理核心模块归档候选；最终位置根据所选工具链确定。

**Constraints:** 检查许可、来源、维护状态、浏览器兼容、包体积和构建复现性。原型不得形成绕过正式消息协议的永久捷径。

**Risks:** 当前缺少 C 到 WebAssembly 的编译工具；第三方预编译包可能陈旧或不可审计。

**Verification:** 在浏览器或可代表浏览器的 WebAssembly 环境运行已知双天体步骤；对照解析结果；记录构建输入、输出大小、许可和失败条件。

**Stop if:** 需要未经同意的全局编译工具安装、许可不兼容、无法得到可信构建产物，或运行结果无法达到基础轨道容差。

### Task 2: Establish the strict project foundation

**Intent:** 建立能够持续运行格式、静态检查、严格类型、单测和生产构建的前端项目，并把真实命令写入仓库规范。

**Likely touchpoints:** 根包清单、锁文件、TypeScript 与构建配置、测试与 lint 配置、应用入口，以及 `AGENTS.md` 和工程底座模块归档。

**Constraints:** 优先采用已安装的 pnpm；TypeScript 必须开启严格模式；只引入 M0 需要的依赖；禁止一次性全仓格式化产生无关改动。

**Risks:** WebGPU 类型定义、Worker 模块构建和 WebAssembly 资源路径可能需要额外构建配置。

**Verification:** 从干净依赖安装开始，依次运行项目实际定义的格式检查、lint、类型检查、单测和生产构建；检查构建产物不包含源映射泄露或意外大文件。

**Stop if:** 脚手架要求放宽严格模式、测试环境无法加载 Worker/WASM，或构建工具无法同时支持目标渲染后端。

### Task 3: Define physical data and worker contracts

**Intent:** 建立带单位、可校验、可排序的跨线程协议，让物理实现和画面实现可以独立替换。

**Likely touchpoints:** 共享类型、运行时校验、物理 Worker 生命周期、单位换算和协议测试的候选模块。

**Constraints:** 消息必须包含版本、模拟时间和序号；所有数值必须有限；物理数据使用 SI 单位；渲染缩放不能污染物理状态。

**Risks:** 高频完整状态复制可能造成消息开销；过早使用共享内存会增加安全和兼容复杂度。

**Verification:** 对合法消息、缺失字段、非有限数字、乱序消息、未知版本和 Worker 重启编写测试；测量双天体与小规模多体状态传输开销。

**Stop if:** 协议需要依赖具体渲染对象，或双天体状态都无法在目标频率下稳定传输。

### Task 4: Deliver the tested two-body simulation

**Intent:** 在独立 Worker 中运行太阳与类地行星场景，支持启动、暂停、单步和时间倍率，并输出误差指标。

**Likely touchpoints:** REBOUND 适配层、物理 Worker、模拟控制器、误差监测和物理测试，以及物理核心模块归档。

**Constraints:** 轨道结果由物理核心产生；时间倍率不能通过放大步长静默牺牲精度；错误时安全暂停。

**Risks:** 积分器配置、步长和输出频率混淆会造成轨道漂移或界面卡顿。

**Verification:** 通过圆轨道、椭圆轨道、暂停、单步、倍率一致性和长周期误差测试；对照解析值并记录容差。

**Stop if:** 达不到 M0 轨道容差，或加速时间必须突破总体设计中的能量误差边界。

### Task 5: Render and control the vertical slice

**Intent:** 用全屏 Three.js 场景展示物理线程输出，让用户可以观察双天体轨道、操纵相机和控制时间。

**Likely touchpoints:** 场景入口、渲染后端选择、天体视图、轨道视图、相机、底部时间控制、状态显示和渲染交互模块归档。

**Constraints:** 画面状态只读取物理快照；使用相邻快照插值；界面保持克制；控制尺寸稳定且不遮挡主要天体；M0 不加入高级装饰。

**Risks:** 真实尺度下行星不可见、相机速度失控、WebGPU 和 WebGL2 基础材质表现不一致。

**Verification:** 组件行为测试覆盖时间命令与状态映射；浏览器验收覆盖非空画布、相机操作、暂停、单步、倍率、后端回退和响应式布局。纯外观不写单元测试。

**Stop if:** 需要修改真实物理数据来让行星可见，或任一渲染后端无法完成基础场景。

### Task 6: Harden, document, and close M0

**Intent:** 让垂直切片可重复构建、可诊断、可交接，并用证据决定是否进入 M1。

**Likely touchpoints:** 全部门禁脚本、浏览器验收、模块归档、路线图和必要的性能记录。

**Constraints:** 不在 M0 顺带实现 M1 功能；所有模块文档描述当前实现；路线图状态只能依据验证证据更新。

**Risks:** 原型代码可能残留临时路径、调试资源或绕过协议的调用。

**Verification:** 运行完整格式检查、lint、类型检查、单测、生产构建和经许可的浏览器验收；审查暂存差异、依赖、构建体积、控制台和模块文档；记录参考设备上的物理频率与画面帧率。

**Stop if:** 任一核心门禁失败、模块归档与实现不一致、REBOUND 构建不可复现，或浏览器仍存在空白画布和未处理错误。

## Commit and Review Boundaries

- Task 1 的可行性结论应形成独立、可审查的提交；失败结论也要保留证据，提交前请用户决定是否继续。
- 工程底座、物理协议、双天体模拟、渲染交互和 M0 收口分别作为候选提交边界。
- 最终提交数量以实际差异和可独立验证的行为为准，禁止提前固定提交信息。
- 每次 AI 协助提交前检查暂存差异，并按 `AGENTS.md` 的 Review 和文档规则处理问题。

## Execution Notes

- 每项任务开始时先检查当前代码、模块文档和路线图，确认上一步没有改变假设。
- 让实际脚手架和库约定决定最终文件位置，计划中的候选位置不构成强制目录。
- 假设不成立时更新计划或在提交说明中解释偏差，避免继续执行失效方案。
- 提交信息从实际暂存差异生成，遵守 Conventional Commits。
- 涉及全局工具安装、许可、公共数据结构、用户可见行为、兼容范围或物理精度承诺变化时，停止并请用户决定。
- M0 完成后先更新路线图并编写 M1 的独立计划，再进入天体创建和复杂交互。
