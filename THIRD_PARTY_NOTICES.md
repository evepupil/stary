# 第三方软件与源码交付说明

## STARY 许可

除文件内另有说明外，本仓库代码按 `GPL-3.0-or-later` 发布。根目录 `LICENSE` 包含 GPL v3 完整文本。

## REBOUND

- 项目：REBOUND，N-body integrations
- 官方仓库：`https://github.com/hannorein/rebound`
- 版本：`5.0.1`
- 固定提交：`cabb68a03ebb4f3f1c71c6ff8cde33a1476ac417`
- 许可：`GPL-3.0-or-later`
- 版权：固定源码的逐文件声明归属于 Hanno Rein、Shangfei Liu、Dave Spiegel、Pasquale Tricarico、Ernst Hairer、Daniel Tamayo、Rejean Leblanc、Tiger Lu、Pejvak Javaheri、Dave O'Hallaron、Carnegie Mellon 和其他对应文件中列明的贡献者；`khrplatform.h` 另含 The Khronos Group Inc. 的版权声明
- 本项目修改：构建时应用 `spikes/rebound-wasm/patches/rebound-5.0.1-worker-no-emscripten-sleep.patch`，只禁用积分循环内用于上游网页显示刷新的 120Hz `emscripten_sleep(0)` 调用；`spikes/rebound-wasm/src/rebound_bridge.c` 是新增桥接层
- 获取与校验：`spikes/rebound-wasm/scripts/fetch-source.ps1` 和 `source-lock.json`
- 可复现构建：`spikes/rebound-wasm/scripts/build.ps1` 和 `build-in-container.sh`

上述姓名按参与当前 WebAssembly 构建的上游源码版权头汇总。准确年份、拼写和逐文件归属以固定提交中的源码头为准，分发对应源码时必须原样保留这些声明。

## Solar System Scope 天体纹理

- 项目：Solar System Scope Textures
- 作者与署名：Solar System Scope / INOVE
- 来源：`https://www.solarsystemscope.com/textures/`
- 许可：Creative Commons Attribution 4.0 International（CC BY 4.0）
- 许可链接：`https://creativecommons.org/licenses/by/4.0/`
- 使用范围：太阳、八大行星、月球的等距柱状颜色图，地球云层透明度图，以及土星环透明度图
- 上游说明：这些贴图基于 NASA 高程与影像数据，颜色参考 MESSENGER、Viking、Cassini、New Horizons 和 Hubble 等观测资料调校；部分尚未测绘的缺口使用与周围一致的补全地形，颜色略作饱和增强
- 本项目修改：颜色图和地球云图从 `2048×1024 JPEG` 使用 Lanczos 缩小到 `1024×512`，再编码为 WebP（质量 82、method 6）；土星环从 `2048×125 PNG` 使用 Lanczos 缩小到 `1024×63 PNG`
- 固定输入与成品校验：`src/features/observatory/rendering/assets/planetary-assets.json`

这些成品属于 Solar System Scope / INOVE 发布的 CC BY 4.0 作品。它们虽然基于 NASA 数据，仍须保留上述署名、许可链接和修改说明，不得登记为 NASA 公共领域素材。金星颜色图表示雷达增强表面，气态行星贴图表示固定时间片或合成外观，均不代表实时可见光天气。

## 发布义务

`rebound.mjs`、`rebound.wasm` 和调用它们的桥接代码属于 GPL 覆盖的组合。对外分发这些产物时，发布方至少需要：

1. 随发行物提供 GPL v3 许可文本和版权说明。
2. 按 GPL 约定向接收者提供完整对应源码，包括固定版本的 REBOUND 源码、桥接源码和生成二进制所需的构建脚本。
3. 清楚标注对上游源码的修改，并随对应源码提供上述补丁及其应用方式。
4. 保留接收者重新编译、修改和再分发源码的权利。
5. 如果采用源码下载地址或书面要约交付源码，确保该方式、可用期限和费用符合 GPL 第 6 条。仅引用上游 GitHub 地址不能自动替代发布方自己的源码交付责任。
6. 分发行星纹理时保留 Solar System Scope / INOVE 署名、CC BY 4.0 链接和本项目修改说明。

正式发布流程应把校验后的上游源码归档与项目源码一同保存，并在每个发布版本中记录精确哈希。涉及设备安装限制或商业分发时，应在发布前进行许可合规复核。
