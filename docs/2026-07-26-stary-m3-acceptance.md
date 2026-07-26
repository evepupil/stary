# STARY M3 验收记录

## 结论

M3 碰撞与碎片通过代码级验收，可以进入 M4 历史与存档阶段。浏览器真实画布证据按项目远程开发约定列为非阻塞项，等待真实 GPU 环境补跑,见「待补浏览器证据」。

功能基线建立在 M3 Task 6 提交 `df45ae3` 之上。Task 7 只新增验收测试与文档,没有改变正式物理协议、碰撞模型、Worker 事务或画面实现。

## 环境

| 项目     | 记录                                                   |
| -------- | ------------------------------------------------------ |
| 操作系统 | Windows 11 IoT Enterprise LTSC 2024 `10.0.26100`,64 位 |
| 处理器   | AMD Ryzen 7 5800H,8 核 16 线程                         |
| 内存     | 约 29.9 GiB 可见物理内存                               |
| Node.js  | `24.18.0`(工程声明 `22.14.0`,本轮以引擎警告运行)       |
| pnpm     | `10.21.0`                                              |
| 浏览器   | 未使用;本机为远程开发环境,无可用 GPU 显示链路          |

本轮验收全部在 Node/Vitest 中使用真实固定 REBOUND WASM 与真实固定 Collision WASM 完成;浏览器矩阵与性能矩阵按约定推迟。

## 交付范围

| 任务   | 交付结果                                                                       | 状态 |
| ------ | ------------------------------------------------------------------------------ | ---- |
| Task 1 | 来源锁、EDACM/Genda 公式、材料剥离、event-total 账本、确定性 seed 与候选复算   | 通过 |
| Task 2 | 协议 v3:精确回执、完整物理状态、碰撞批次、双层诊断与场景碰撞资料               | 通过 |
| Task 3 | REBOUND C 桥连续接触、最早时刻、同刻 pair、checkpoint 回放与固定产物锁         | 通过 |
| Task 4 | 固定 Rust/WASM 碰撞内核、工程确定性 v1 重建、黑洞吞噬、C ABI 与跨语言对照      | 通过 |
| Task 5 | 正式 Worker 原子碰撞事务、同刻批次、候选切换、失败回滚与被动资产推进           | 通过 |
| Task 6 | 主要碎块进目录/选择/轨道、tracer 与尘埃有界渲染、视觉碎屑粒子池、碰撞事件面板  | 通过 |
| Task 7 | 真实双 WASM 端到端验收矩阵、确定性重跑、容量与错误码矩阵、生产包与文档归档     | 通过 |

## 物理与守恒矩阵

以下场景全部通过真实固定 REBOUND WASM 检测接触,再由真实固定 Collision WASM 求解,并在 `PhysicsWorkerRuntime` 中完成候选 REBOUND 首帧验收与原子切换(`src/physics/runtime/physics-worker-collision.integration.test.ts`):

| 场景                        | 输入构造                                             | 结果结构                          | 质量闭合   |
| --------------------------- | ---------------------------------------------------- | --------------------------------- | ---------- |
| merge                       | `1e20/5e19 kg`,接触速度 10 m/s 正碰                  | 1 主要残体                        | `<= 1e-12` |
| grazeAndMerge               | `4e24/2e24 kg`,`(1+Genda 临界比)/2 × v_esc`,b=0.8    | 1 主要残体                        | `<= 1e-12` |
| hitAndRun                   | `4e24/2e24 kg`,`1.5 × v_esc`,b=0.8                   | 2 主要残体                        | `<= 1e-12` |
| partialAccretion            | `4e21/2e21 kg`,`sqrt(0.2) × v_crit` 正碰             | 1 主要残体 + 1 tracer             | `<= 1e-12` |
| erosion                     | `4e21/2e21 kg`,`0.95 × v_crit` 正碰                  | 1 主要残体 + 1 tracer             | `<= 1e-12` |
| catastrophicDisruption      | `4e21/2e21 kg`,`1.1 × v_crit` 正碰                   | 1 主要残体 + 1 dust cohort        | `<= 1e-12` |
| superCatastrophicDisruption | `4e21/2e21 kg`,`1.5 × v_crit` 正碰                   | 1 主要残体 + 1 dust cohort        | `<= 1e-12` |
| blackHoleAccretion          | `1e24 kg` 黑洞吞噬 `1e20 kg` 行星                    | 1 黑洞残体,辐射账本 `> 0`         | 相对 1e-12 |

每个场景都在碰撞后继续 `step` 并收到正常 `state`,证明候选实例可继续积分。

事务与批次行为(同文件):

- **同刻独立批次**:两对互不共享天体的同刻接触在一次 `collisionBatchResolved` 中原子提交,2 个事件、2 份账本、修订号只 +1。
- **共享天体安全暂停**:三体同刻共享接触保留接触态,发出 `unsupportedSimultaneousContact` 可恢复错误,修订号不变,没有半提交。
- **确定性重跑**:同一灾难性碎裂场景在两个独立 runtime 实例上重跑,`contactTimeSeconds`、事件、账本与完整状态逐位一致(`toStrictEqual`)。
- **容量上限**:被动资产满载(10,000)时,灾难性碎裂经真实 Collision WASM 返回 `collisionCapacityExceeded`,不创建候选实例,接触态保留,WASM 上下文归零。

内核层批次与错误矩阵(`src/physics/collisions/collision-kernel-wasm.integration.test.ts`,真实 WASM 与 TypeScript 参考实现精确对照):

- **批次原子性**:第二个事件超出剩余容量时整批返回单个 `collisionCapacityExceeded`,第一事件的结果不出现在任何输出中。
- **恒星拒绝**:恒星参与体返回 `unsupportedStellarCollision`。
- **强度区拒绝**:半径小于 `1 km` 返回 `unsupportedStrengthRegime`。
- 既有对照继续覆盖 merge、逆序批次中的 hitAndRun 与灾难性碎裂、黑洞吞噬账本;浮点末位差异路径保持锁定清单不变。

## 代表碰撞延迟

Node 参考机(本表处理器)上,含 Worker 初始化、REBOUND 实例创建、接触检测、Collision WASM 求解、候选创建与首帧验收的单场景端到端墙钟时间:

| 场景                | 墙钟时间 |
| ------------------- | -------- |
| merge(首次含预热)   | 96 ms    |
| grazeAndMerge       | 27 ms    |
| hitAndRun           | 18 ms    |
| partialAccretion    | 21 ms    |
| erosion             | 13 ms    |
| catastrophic        | 20 ms    |
| superCatastrophic   | 14 ms    |
| blackHoleAccretion  | 21 ms    |
| 同刻两事件批次      | 20 ms    |

该数字来自 Vitest 逐测试时长,包含 JS 断言开销,只作数量级参考;浏览器 Worker 内的实际碰撞停顿留待真实 GPU 环境的性能矩阵。

## 生产构建

`pnpm build`(tsc、双 WASM 门禁、Vite 构建、产物校验)输出:

| 产物                      |      原始字节 |      gzip 字节 |
| ------------------------- | ------------: | -------------: |
| 主应用 `index.js`         |       390,142 |        114,809 |
| 观测台场景分块            |       107,045 |         29,730 |
| 物理 Worker               |       151,902 |         43,106 |
| 轨道预览 Worker           |       123,657 |         35,218 |
| REBOUND WASM              |       252,918 |        100,342 |
| Collision WASM            |       361,709 |        129,692 |
| three.webgpu 分块         |       567,996 |        157,885 |
| three.module / three.core |       562,792 |        139,338 |
| 样式                      |        22,875 |          4,684 |
| 全部生产产物              | **3,226,062** |  **1,438,480** |

产物校验确认:恰好两个 WASM 且字节与 SHA-256 与产物锁一致、恰好一个物理 Worker 与一个轨道预览 Worker、无 source map、three.webgpu 与观测台场景保持动态分块。

## 门禁

- `pnpm format:check`、`pnpm lint`(0 警告)、`pnpm typecheck`(strict)全部通过。
- `pnpm test`:68 个 Vitest 文件共 466 项测试通过,其中 Task 7 新增 13 项(9 项真实双 WASM 端到端场景与事务矩阵、2 项内核批次原子性与错误码对照、2 项容量与确定性)。
- `pnpm build` 与产物校验通过。
- `pnpm check` 的最后一步 Playwright 按用户指示与远程环境约定跳过,列入待补浏览器证据。

## M3 已知限制

- EDACM 是分析标度模型,不做逐单元流体仿真;气态巨行星使用无强度流体近似。
- 恒星碰撞、小于 `1 km` 的强度主导区和完整相对论黑洞并合不在首版范围,分别以明确错误码或独立牛顿吞噬账本处理。
- 残体重建使用工程确定性 v1:单 tracer/单 dust cohort 聚合、总体积平均密度球形半径,不提供第二残体谱和逐颗速度谱。
- passive tracer 与 dust cohort 不产生主动引力,省略反作用单独记账;visual debris 质量恒为 0。
- 碰撞历史快照、撤销与确定性回放进入 M4;M3 只保证事件结构可被历史系统记录。
- 512 主要天体、10,000 被动资产、50,000 视觉碎屑的最终设备性能承诺留待 M5 分档。

## 待补浏览器证据(非阻塞)

远程开发环境没有可用 GPU 显示链路(此前两次独立验收:WSL Chrome 150 无 WebGPU 适配器,WebGL2 落入 SwiftShader 且帧率 14–18 FPS),按项目约定以下证据列为非阻塞项,待真实 GPU 环境补跑:

- 28 条既有 Playwright 加 Task 6 碰撞画面与事件面板流程(桌面 WebGPU、强制 WebGL2、手机)。
- 四场景五秒性能矩阵,含默认 10 体无碰撞场景 Worker state 中位频率 `>= 26.69 次/秒` 的硬门槛。
- 双后端真实画布中的主要碎块一致性、粒子池有界与资源平台快照。

## 进入 M4 的门槛

- 快照、回放、实验分支、本地存储与文件分享的设计基于协议 v3 的完整 `PhysicsState` 与碰撞事件结构。
- 碰撞事件、账本与被动资产已随每帧状态可序列化,历史系统无需修改物理层即可记录。
- 上述浏览器证据补跑属于 M3 的收尾责任,不阻塞 M4 的设计与实现开始。

以上条件全部满足。M4 可以开始。
