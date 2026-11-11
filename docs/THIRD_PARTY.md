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
