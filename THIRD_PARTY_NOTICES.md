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

## 发布义务

`rebound.mjs`、`rebound.wasm` 和调用它们的桥接代码属于 GPL 覆盖的组合。对外分发这些产物时，发布方至少需要：

1. 随发行物提供 GPL v3 许可文本和版权说明。
2. 按 GPL 约定向接收者提供完整对应源码，包括固定版本的 REBOUND 源码、桥接源码和生成二进制所需的构建脚本。
3. 清楚标注对上游源码的修改，并随对应源码提供上述补丁及其应用方式。
4. 保留接收者重新编译、修改和再分发源码的权利。
5. 如果采用源码下载地址或书面要约交付源码，确保该方式、可用期限和费用符合 GPL 第 6 条。仅引用上游 GitHub 地址不能自动替代发布方自己的源码交付责任。

正式发布流程应把校验后的上游源码归档与项目源码一同保存，并在每个发布版本中记录精确哈希。涉及设备安装限制或商业分发时，应在发布前进行许可合规复核。
