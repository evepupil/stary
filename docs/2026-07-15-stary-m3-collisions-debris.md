# STARY M3 碰撞与碎片实施计划

## 目标

在 M2 已验收的真实画面和 M1 正式 REBOUND Worker 上，交付可连续检测、可解释、可守恒、可回滚的分层碰撞。用户制造撞击后，系统必须停在真实接触时刻，给出来源明确的分类、主要残体、物质去向和能量账本；确认后的主要碎块继续参与多体引力。

M3 保持四条硬边界：

- 碰撞检测和轨道推进处于同一物理时间线，禁止用画面帧或稀疏预览点代替正式接触事件。
- Rust 碰撞内核只消费 SI 快照并返回候选结果，不持有 REBOUND 指针，也不直接修改正式宇宙。
- 候选结果通过 schema、容量和守恒门禁后才原子替换 REBOUND 实例。
- 画质只改变视觉尘埃数量，主要残体、材料分配、事件时间和账本在 WebGPU、WebGL2 间保持一致。

## 当前基础

- M3 Task 1 已建立 `src/physics/collisions/`，包含来源锁、接触量、破坏标度、分类、材料、候选门禁和 event-total 守恒账本。
- 正式协议为 v2，`BodyState` 只有 ID、质量、半径、位置和速度。
- `PhysicsWorkerRuntime` 的单步和连续运行都直接调用 `integrateTo(targetTime)`，随后发送完整状态。
- REBOUND C 桥已经提供创建、销毁、添加粒子、IAS15、推进、快照、能量和角动量导出。
- `replaceBodies` 已具备候选实例、首帧校验、原子切换、修订冲突和失败回滚。
- 轨道预览已经用扫掠线段识别有限采样间的碰撞风险。这条路径只负责预警，无法保证捕获 IAS15 步内的弯曲接触。
- 仓库当前没有 Rust crate、Rust 工具链锁或正式碰撞 WASM。
- M2 最终生产包只允许一个 REBOUND WASM。引入碰撞内核后，门禁要改成分别要求一个 REBOUND WASM 和一个 Collision WASM。

## 科学模型

### 固定来源

以下出版信息已在 2026-07-15 通过 Crossref 元数据核对。Task 1 已把论文公式编号、参数和黄金样例写入版本化引用表，运行时不会访问外部网站。

| 来源                                                                            | M3 用途                                          | 适用边界                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------- |
| [Leinhardt & Stewart 2012, Part I](https://doi.org/10.1088/0004-637X/745/1/79)  | EDACM 结果分区、破坏标度、最大残体和 hit-and-run | 引力主导天体                       |
| [Stewart & Leinhardt 2012, Part II](https://doi.org/10.1088/0004-637X/751/1/32) | 行星形成末期结果分布与模型应用边界               | 行星级碰撞背景                     |
| [Genda, Kokubo & Ida 2012](https://doi.org/10.1088/0004-637X/744/2/137)         | 原行星合并与 hit-and-run 临界速度                | 岩质原行星                         |
| [Benz & Asphaug 1999](https://doi.org/10.1006/icar.1999.6204)                   | 玄武岩和冰的强度区、引力区破坏曲线               | 参数依赖撞击速度，不直接外推到行星 |
| [Marcus et al. 2009](https://doi.org/10.1088/0004-637X/700/2/L118)              | 超级地球铁核和硅酸盐地幔剥离                     | `1..10 M⊕`、最高约 `5 v_esc`       |

### 接触量

目标体固定为 `M_t >= M_p`。所有公式使用千克、米、秒和弧度：

```text
M_tot = M_t + M_p
mu = M_t M_p / M_tot
v_imp = |v_p - v_t|
v_esc = sqrt(2 G M_tot / (R_t + R_p))
Q_R = mu v_imp^2 / (2 M_tot)
b = sin(theta) = |r_rel x v_rel| / (|r_rel| |v_rel|)
b_crit = R_t / (R_t + R_p)
```

`theta=0` 表示正碰，`theta=90°` 表示理想擦边。`b > b_crit` 进入擦碰分支。斜碰使用真实参与接触的投射体质量比例 `alpha` 修正约化质量和破坏阈值，掠过部分不会被计入有效撞击能。

### 破坏标度

首版锁定两档 Leinhardt-Stewart 参数：

| 参数档             |                         `c*` | `muBar` | 使用对象                                     |
| ------------------ | ---------------------------: | ------: | -------------------------------------------- |
| 引力主导固体小天体 |     `5.0`，敏感性范围 `3..7` |  `0.37` | 当前 `100 km` 小行星预设、碎石堆和固体小天体 |
| 无强度流体行星     | `1.9`，敏感性范围 `1.6..2.2` |  `0.36` | 原行星、行星和气态巨行星近似                 |

等质量正碰主曲线为：

```text
rho_1 = 1000 kg/m^3
R_C1 = (3 M_tot / (4 pi rho_1))^(1/3)
Q*_(RD,gamma=1) = c* (4/5) pi rho_1 G R_C1^2
```

质量比和擦碰参与质量继续使用论文的 reduced-mass scaling 与 `alpha` 修正。Task 1 已把论文对应公式转成固定黄金样例，并标记 `alpha <= 0.5` 的斜碰外推范围。

普通破坏区和超灾难区的最大残体采用：

```text
M_lr / M_tot = -0.5 (Q_R / Q*'_RD - 1) + 0.5

Q_R / Q*'_RD >= 1.8 时：
M_lr / M_tot = (0.1 / 1.8^eta) (Q_R / Q*'_RD)^eta
eta = -1.5
```

### 结果分类

内部结果保留论文语义，界面再映射成用户可读名称：

| 内部结果                      | 用户显示         | 判定重点                               |
| ----------------------------- | ---------------- | -------------------------------------- |
| `merge` / `grazeAndMerge`     | 合并             | Genda 临界线以下，最终只有一个主要残体 |
| `hitAndRun`                   | 擦碰分离         | `b > b_crit` 且 runner 仍能分离        |
| `partialAccretion`            | 撞击坑或部分吸积 | `M_lr > M_t`，靶体净增长               |
| `erosion`                     | 外层剥离         | `0.5 M_tot < M_lr <= M_t`，靶体净损失  |
| `catastrophicDisruption`      | 灾难性碎裂       | `0.1 M_tot <= M_lr <= 0.5 M_tot`       |
| `superCatastrophicDisruption` | 超灾难性碎裂     | `M_lr < 0.1 M_tot`                     |

“撞击坑”只是一层显示标签：抛射质量低于总质量 `1%` 且最大残体仍为原目标时使用。这个 `1%` 是明确记录的产品分档，不改变 EDACM 计算。

### 材料层与自转

协议 v3 为每个主要天体增加：

- `spinAngularMomentumKgMetersSquaredPerSecond` 三维向量。
- `momentOfInertiaFactor`，范围 `(0, 0.4]`，由固定场景或创建预设给出。
- 有序材料层，顺序固定为由外到内；材料集合为 `gas`、`ice`、`silicate`、`iron`。
- 每层使用质量分数，全部为正且总和在 `1e-12` 内等于 `1`。
- `collisionModel` 明确区分 `gravitySolid`、`gravityFluid`、`stellar` 和 `blackHole`。

物质损失按外到内扣减，因此大气、冰层和地幔会先于铁核被剥离。Marcus 关系只在论文覆盖的超级地球范围内启用，超出范围的结果会带 `modelExtrapolated=true`。

自转必须进入 M3。合并时，入射轨道角动量不能从账本中消失；它会进入残体自旋、主要碎片、tracer 或 dust reservoir 的轨道角动量。没有自转字段就无法满足既定 `1e-8` 角动量门槛。

### 模型范围

- 半径不小于 `1 km` 的固体、冰质和行星级天体进入 EDACM。
- 小于 `1 km` 的强度主导天体首版返回 `unsupportedStrengthRegime` 并安全暂停。当前最小创建预设为 `100 km`，正常流程不会触发该边界。Benz-Asphaug 速度参数表留作后续扩展。
- 气态巨行星使用 `gravityFluid` 参数，并明确标记为流体行星近似。
- 恒星碰撞返回 `unsupportedStellarCollision` 并安全暂停。恒星流体、核反应和质量损失需要专用模型。
- 黑洞使用独立牛顿吞噬规则：接触后质量和线动量合并，初始自旋与轨道角动量进入新黑洞自旋，损失的相对机械能进入辐射账本。该规则不模拟引力波质量损失或完整广义相对论。

## 守恒账本

每次事件输出不可省略的版本化 `CollisionLedger`。它同时保存参考系、模型版本、碰前与碰后分项、误差尺度、实测误差和门槛：

```text
massBeforeKg
massInMajorRemnantsKg
massInTracersKg
massInDustKg
linearMomentumBefore / After
angularMomentumBefore / After
translationalEnergyBefore / After
spinEnergyBefore / After
activeActivePotentialBefore / After
activePassivePotentialBefore / After
selfBindingEnergyBefore / After
subgridEjectaEnergyBefore / After
heatJoules
deformationJoules
fractureJoules
radiationJoules
```

`dust reservoir` 由带质量、质心位置、质心速度、材料组成和未展开速度离散能的 `DustCohort` 组成。GPU visual debris 的质量固定为 `0`，每个视觉粒子只引用一个 cohort，不能代替物理质量。

守恒和长期诊断使用两套明确口径：

- `event-total` 在同一接触时刻、同一惯性系中比较完整模型状态。它包含主要天体、tracer 和 dust cohort 的平动与自转能、主要天体之间的势能、主要天体与被动碎片之间的势能、天体自束缚能和 cohort 未展开的机械能。
- `active-REBOUND` 只衡量主要天体在两次碰撞之间的 IAS15 数值漂移。成功碰撞后用新主要天体重建这套基线，碰撞造成的真实跳变只进入 `event-total`。

tracer 和 dust cohort 只受主要天体引力，首版不计算 tracer-tracer、tracer-dust 和 dust-dust 相互作用。协议会记录 `omittedInteractionClasses`，并在每个物理步累计省略反作用的冲量、角冲量和功。界面分别显示 REBOUND 数值漂移、碰撞事件闭合误差、被动碎片省略反作用和 subgrid 机械能，不能把它们合成一个总误差。

所有耗散项必须非负。碰前与碰后机械能都使用相同分项和近似。热、变形、破碎和辐射只接收机械能差，不能吸收未守恒的质量或角动量；若候选结果需要负耗散才能闭合，整次候选必须拒绝。

近零总量使用带物理尺度的归一化误差：质量取总输入质量，线动量取 `max(sum(m |v|), M_tot v_esc, 1 kg m/s)`，角动量取 `max(sum(|r x p|)+sum(|L_spin|), M_tot R_sum v_esc, 1 kg m^2/s)`，能量取 `max(|E_before|, 0.5 mu v_imp^2 + G M_t M_p/R_sum, 1 J)`。

| 项目             | 硬门槛     |
| ---------------- | ---------- |
| 质量             | `<= 1e-12` |
| 线动量           | `<= 1e-10` |
| 轨道加自转角动量 | `<= 1e-8`  |
| 机械能加耗散账本 | `<= 1e-6`  |

碰撞后会重建 `active-REBOUND` 基线，同时把事件差额记入累计 `event-total` 与耗散账本。这样后续 IAS15 漂移只从新主要天体状态开始计算，碰撞本身的能量变化仍有完整来源。

## 连续接触检测

正式检测放在 REBOUND C 桥，统一替换单步和连续运行的直接 `integrateTo`：

```text
advanceUntilEvent(targetTime)
  -> advanced(targetTime)
  -> contactBatch(time, contact pairs, contact snapshot)
```

实现顺序：

1. 每个受控子步前用 `reb_simulation_copy()` 保存包含 IAS15 内部状态的完整 checkpoint，再用 `reb_simulation_steps()` 推进一个不越过目标时间的真实接受步。
2. 对每一对天体计算真实步首、步尾相对位置的弦最小距离。安全半径额外膨胀 `A_rel_bound h^2 / 8 + epsDistance`；`A_rel_bound` 使用首次接触前的全局引力上界，局部加速只能在位移 enclosure 验证通过后替代它。
3. 弦与曲率上界能证明无接触时接受该区间。无法证明时，从 checkpoint 回放到区间中点，递归检查左右区间。该判定覆盖弯曲路径，不能只看端点是否重叠。
4. 穿透区间求最早的表面间隙零点；正切没有符号变化，使用带界的距离最小化确认。主 simulation 最终从 checkpoint 精确积分到最早接触时刻。
5. 先收集时间容差内的候选 pair，再在接触快照补收距离容差内且正在接近或相切的 pair。C 只返回粒子下标，TypeScript 映射稳定 ID 并排序，不删除或合并粒子。
6. 任意错误都释放临时 copy 并回滚到子步前 checkpoint；接触集合溢出时明确失败，禁止静默截断。

REBOUND 5.0.1 的 `LINE/LINETREE` 碰撞模式使用线性路径近似，只能作为参考，不能成为正式接触事实源。

距离容差固定为 `max(1e-10 R_sum, 64 ulp(worldCoordinateScale), IAS15PositionErrorBudget)`。时间容差固定为 `max(1e-9 s, 8 ulp(eventTime), 1e-12 h, epsDistance / max(|v_rel|, epsDistance/h))`。这组门槛同时考虑接触尺度和双精度世界坐标极限；位于 `1 AU` 的小天体不会被要求达到低于坐标 ULP 的距离精度。

测试必须覆盖步首和步尾均不重叠但步中穿透、正切与近切两侧、强弯曲近掠、初始重叠、已经分离的重叠体和同刻多接触，并用至少 `100x` 更细参考积分做随机 `2..10` 体零漏检对照。

现有预览 `computeSweptCollisionFraction` 保留为风险提示，正式 Worker 不复用稀疏预览采样作为事件事实来源。

## 运行时事务

一次正式事件按以下顺序完成：

```text
start / step
-> REBOUND 推进到目标时间或首个接触
-> 按最早时刻的接触 pair 构图
-> Rust 分别计算互不共享天体的二体候选、残体、材料和账本
-> TypeScript 严格解析并复算守恒
-> 用候选主要残体创建新的 REBOUND simulation
-> 校验时间、首帧、容量、ID 和诊断
-> 原子切换实例，bodyRevision + 1
-> 发送 collisionBatchResolved，消息内同时携带整批事件与新状态
```

Rust 或候选校验失败时，旧实例保持在接触时刻，临时 WASM 内存和候选 REBOUND 全部释放，Worker 进入可恢复暂停，修订号不变。

运行中成功解决首个不可逆碰撞后默认暂停，模拟时间停在接触时刻，用户检查账本和碎块后继续。单步命令遇到碰撞时也提前返回实际接触时间。未来可以增加自动继续选项，M3 首版不隐藏不可逆事件。

同刻接触以天体为点、接触 pair 为边构图。每个只有两个天体的连通分量都从同一碰前快照独立计算，全部分量作为一个事务通过门禁后一次提交，`bodyRevision` 和 `collisionBatchSequence` 各递增一次。任一分量失败则整批不提交。

包含三个或更多共享天体的连通分量超出首版二体 EDACM 范围。Worker 返回 `unsupportedSimultaneousContact`，保留接触时刻状态、保持修订号并暂停，禁止按 pair 排序依次合并。初始重叠在当前模拟时间产生事件；成功残体必须拥有合法分离位置或分离速度，避免同一对天体在同一时间无限重复。

## 碎片分层

- 每次事件最多生成 64 个主要残体，且主要天体总数不得超过 512。
- 容量不足时优先保留质量最大的残体，剩余质量进入 tracer 或 dust cohort，禁止丢失。
- 主要残体进入 REBOUND，完整参与互相引力。
- tracer 上限为 10,000，保存代表质量、位置、速度和材料，只受主要天体引力，不产生主动引力。
- dust reservoir 保存有物理质量的 `DustCohort`；每个 cohort 记录聚合位置、速度、材料和 subgrid 机械能。
- visual debris 上限目标为 50,000。GPU 粒子只采样事件与 dust cohort，质量固定为 `0`。
- tracer 和 dust cohort 的质量、线动量、角动量、动能和主要天体势能进入被动诊断，省略反作用单独累计。
- 固定事件 ID、父体排序和碎片序号生成确定性 seed；禁止使用 `Math.random()`。

512 个主要天体、10,000 tracer 和 50,000 visual debris 的最终设备分档与性能承诺仍归 M5。M3 要先证明容量路由、守恒和画质无关性。

## 协议 v3

v3 一次性升级以下公共结构：

- `BodyState`：材料层、自转角动量、转动惯量因子和碰撞模型。
- 所有 Worker 响应：增加 `replyToSequence`。直接完成命令时等于命令序号，后台推送固定为 `null`；controller 必须先按该字段关联请求，再检查消息类型和业务条件。
- `PhysicsState`：主要天体、tracer、dust cohorts、累计碰撞账本、省略相互作用类别和累计反作用近似量。
- `collisionBatchResolved`：`collisionBatchSequence`、`replyToSequence`、原请求目标时间、实际接触时间、`runState=paused`、修订号前后值、事件数组、账本增量和完整新状态。事件包含稳定 ID、参与体、分类、`Q_R/Q*'_RD` 和残体引用。
- 错误码：`collisionResolutionFailed`、`collisionConservationFailed`、`collisionCapacityExceeded`、`collisionContactSetOverflow`、`unsupportedSimultaneousContact`、`unsupportedStrengthRegime` 和 `unsupportedStellarCollision`。

`collisionBatchResolved` 是原子消息，主线程不能先收到碎片再收到事件。消息缓冲在新修订到达时清除旧修订 state；创建和编辑继续通过预期修订号阻止旧草稿覆盖碰撞后的宇宙。

`step` 的返回类型升级为“到达目标的 state”或“提前暂停的 collision batch”。两者都必须精确携带本次 `replyToSequence` 和原目标时间，因此接触时刻早于目标时间也能正常完成 Promise。`start` 在运行循环成功挂起后才发送带命令序号的 `running` 回执；后续运行帧和碰撞批次属于后台推送，不会误完成其他请求。

预览协议同步升级材料和自转输入，但继续只输出风险，不提前执行正式碎裂。

## 任务拆分

### Task 1：锁定碰撞科学模型与纯函数底座（已完成）

- 建立 `src/physics/collisions/`，保存版本化来源、SI 类型、接触量、材料档、EDACM 阈值、最大残体、分类和守恒计算。
- 固定论文公式编号与 golden fixtures，覆盖 `0.99x / 1.00x / 1.01x` 分类边界。
- 建立材料层、自转、碰撞输入输出和账本 schema，但不接入正式 Worker。
- 单测覆盖交换对称性、极端质量比、正碰、擦边、近零动量、非有限数和确定性 seed。

完成依据：来源、公式、候选绑定、材料和守恒实现已归档；6 个测试文件共 41 项定向测试通过，完整项目门禁见对应提交。

### Task 2：升级协议 v3 与场景物理资料

- 升级正式协议、预览协议、controller、状态 reducer 和固定太阳系场景。
- 为成功响应增加 `replyToSequence`，把 `step` 改成显式 advance result，并定义原子 `collisionBatchResolved`、dust cohort 与双层诊断结构。
- 为太阳系和六类创建预设补材料层、自转角动量和转动惯量因子，来源与近似写入场景资料。
- v2 消息被严格拒绝；创建、编辑、删除、预览和 M0/M1/M2 行为全部迁移。

完成门槛：公共结构一次升级完成，全部旧流程通过，新字段在 Worker 往返中无损。

### Task 3：交付 REBOUND 连续接触桥

- 扩展固定 C 桥和 Emscripten 导出，提供事件式推进、接触读取和幂等清理。
- 重新固定源码补丁、WASM 字节数和 SHA-256。
- 覆盖高速穿透、正切、强弯曲近掠、初始重叠、同刻多接触、最早事件、checkpoint 回滚和尺度化容差。

完成门槛：单步与连续运行共享同一 CCD；随机参考积分无漏检；接触时间与距离达到尺度化容差；无事件路径与旧 `integrateTo` 数值等价；全部 simulation copy 可证明释放。

### Task 4：交付 Rust/WASM 碰撞内核

- 新建固定 Rust 工具链、crate、构建脚本、C ABI、内存所有权和产物哈希。
- 实现二体 EDACM、Genda 临界线、材料剥离、黑洞吞噬、主要残体、tracer、dust cohort 和 event-total 账本。
- 接受一批互不共享天体的二体输入并给出确定性结果；共享天体的多体接触由 Worker 在调用前拒绝。
- TypeScript 参考实现与 Rust 对同一 golden fixtures 输出一致。
- 构建门禁分别验证唯一 REBOUND WASM 和唯一 Collision WASM。

完成门槛：成功、失败、畸形输入、alloc/free 和重复销毁都可验证，无 NaN、Infinity 或越界内存。

### Task 5：接入正式 Worker 原子碰撞事务

- `PhysicsSimulation` 改为事件式推进，单步和连续运行统一处理。
- 候选碰撞结果通过 Zod、守恒、容量和首帧门禁后原子切换实例。
- 同刻 pair 构图、二体分量整批提交、多体分量安全暂停、修订号、批次序号、状态缓冲和创建编辑冲突全部接入。
- tracer 与 dust cohort 在 Worker 中按主要天体引力推进，累计省略反作用冲量、角冲量和功。
- 增加 event-total、active-REBOUND 与被动资产诊断，分开计算物理耗散、IAS15 数值漂移和模型近似。
- controller 使用 `replyToSequence` 完成 `start`、`step` 等请求；单步碰撞以提前暂停结果正常结束，不能等待原目标直至超时。

完成门槛：任何失败都不产生半提交；碰撞后的主要碎块、tracer 和 dust cohort 能继续推进；旧 state 不能覆盖碰撞结果；资源无泄漏。

### Task 6：交付主要碎块、tracer 与碰撞观察界面

- 主要碎块进入正式目录、选择、轨道和移动渲染原点。
- tracer 与 dust cohort 读取 Task 5 的正式状态；visual debris 使用双后端有界资源池且质量固定为 `0`。
- 实验模式显示事件分类、模型范围、接触速度、角度、`Q_R/Q*`、物质去向和账本。
- 桌面与手机都能检查事件并继续模拟。

完成门槛：WebGPU 与 WebGL2 的主要碎块完全一致；降低画质只减少视觉粒子。

### Task 7：M3 综合验收

- 覆盖合并、hit-and-run、坑蚀、剥离、灾难和超灾难碎裂。
- 覆盖失败回滚、同刻接触、容量上限、确定性重跑和双后端真实画布。
- 记录生产包、无碰撞性能、代表碰撞延迟、资源平台和已知边界。
- 更新路线图、验收记录和模块归档。

完成门槛：完整 `pnpm check` 通过；默认 10 体无碰撞场景的 Worker state 中位频率继续不低于 `26.69 次/秒`。

## 测试矩阵

### 纯函数

- `v_esc`、`Q_R`、`b`、`b_crit`、参与质量、破坏阈值和最大残体黄金值。
- merge、hit-and-run、partial accretion、erosion、catastrophic 和 super-catastrophic 的边界两侧。
- 材料层总和、外到内剥离、自转能、碎片质量分配和 64/512 容量路由。
- 固定 seed、稳定 ID、目标/投射体交换、非有限数和极端质量比。

### C 与 WASM 集成

- 步中穿透、正切、弯曲近掠、初始重叠、已分离重叠和同刻三体接触。
- 接触时间、尺度化距离容差、稳定 pair 集合、剩余时间、碰前快照和全部 copy 释放。
- Rust golden fixtures、边界校验、内存释放、错误状态和固定产物哈希。

### Worker 与协议

- v3 严格解析、旧版本拒绝、悬空残体引用、重复 ID 和错误账本。
- 运行与单步碰撞、命令序号精确回执、批次修订递增、同刻多体暂停、创建编辑冲突和候选失败回滚。
- event-total、active-REBOUND、被动资产和省略反作用分账，暂停后继续保持时间连续。

### 浏览器

- 桌面 WebGPU 与强制 WebGL2 各完成一次真实碰撞、检查分类、体数、账本和碎块继续运动。
- 灾难性碎裂验证主要碎块一致、粒子池有界、canvas 非空和资源回收。
- 手机验证事件面板、暂停、继续和降级 visual debris。
- 全流程 console warning/error、pageerror、requestfailed 和错误覆盖层为零；主动故障测试单独白名单。

## 明确暂缓

- 完整恒星流体、核反应和恒星质量损失。
- 小于 `1 km` 的 Benz-Asphaug 强度主导碰撞。
- 广义相对论黑洞并合、引力波反冲和辐射质量损失。
- 熔融流体表面、长期热演化和重新凝固。
- 512 主要天体、10,000 tracer、50,000 visual debris 的最终设备性能承诺。
- 碰撞历史回放和撤销进入 M4；M3 只保证事件结构可被后续历史系统记录。
