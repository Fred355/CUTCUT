# 第三方来源与分发说明

应用自身当前标记为 UNLICENSED/private，尚未选择对外开源许可。以下第三方组件保留各自许可证。

| 组件                       | 来源与版本记录                                                           | 许可                                       |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| Electron、React、Vite、Zod | npm，精确版本见 package-lock.json                                        | 各包附带许可（主要 MIT）                   |
| FFmpeg                     | ffmpeg-static 5.3.0，二进制由其官方 GitHub release 下载                  | 随附 ffmpeg.LICENSE；含 GPL 编译组件       |
| ffprobe                    | @ffprobe-installer/ffprobe 2.1.2，平台包由 npm integrity 校验            | 平台包许可与 README；当前 Linux 包 GPL-3.0 |
| native Canvas              | @napi-rs/canvas，精确版本见锁文件                                        | MIT 及其第三方 notices                     |
| Noto Sans CJK SC Regular   | notofonts/noto-cjk，固定 commit f8d157532fbfaeda587e826d4cd5b21a49186f7c | SIL Open Font License 1.1                  |

字体原文件：
https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf

字体许可证位于 `resources/fonts/OFL.txt`，文件摘要位于同目录 `SHA256SUMS`。

构建时将本平台媒体工具的实际版本、SHA-256、FFmpeg 许可证与构建来源 README、Canvas 许可证、ffprobe README 写入 `resources/toolchain/` 并随包分发。FFmpeg 静态发行来源与对应源码说明见其 README；ffprobe 平台包来源见平台包元数据。正式对外分发应履行对应 GPL 二进制的源码提供义务，保留第三方许可，并完成 H.264/AAC 分发要求的适用性核查。自动构建不会替代这些分发事项，也不生成 Apple 签名或公证。


## 本地 AI 工具与模型（2026-11-13）

固定运行时提交见 resources/native/sources.json：whisper.cpp（MIT）、stable-diffusion.cpp（MIT）、audio.cpp（Apache-2.0）。构建脚本复制源码和依赖中 LICENSE/COPYING/NOTICE 文件至每个运行时的 licenses/，随完整安装包分发；运行时哈希清单包含这些许可证。

权重独立下载：Whisper small 为 MIT；SD 1.5 为 CreativeML Open RAIL-M；Magenta RealTime 2 包保留 CC-BY-4.0 和上游使用条款。audio.cpp 固定提交的模型文档确认 GGUF 含生成器、SpectroStream、MusicCoCa、词表及配置，参数量不等于包大小。应用分别展示运行时和模型许可，下载前展示准确大小及哈希。

当前网络限制阻止核对 Hugging Face 文件元数据及托管许可全文，真实模型锁定清单尚未生成；不得据占位值打包发布。完整来源、构建和发布前检查见 LOCAL-TOOLS.md。运行时许可不替代权重使用条款，生成内容也不因此获得第三方素材授权。
