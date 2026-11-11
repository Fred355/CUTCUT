# CUTCUT 结构与数据约定

## 模块

- `src/shared`：Zod 工程 schema、整数帧运算、片段操作、坐标与文字布局、受限桌面桥接口。
- `src/main`：Electron 主进程及 preload；项目会话、文件对话框、原子保存、素材复制、ffprobe、预览代理和 FFmpeg 导出。
- `src/renderer`：React 编辑器和 Canvas/Web Audio 预览，不访问 Node.js 或任意文件系统。

编辑结果是 Project 数据，而不是已渲染视频。将来 AI 应返回经过 schema 校验的工程修改，由用户确认后进入同一编辑链路；不需要替换导出引擎。

## 工程 version 1

Project 保存 `id/name/width/height/fps/assets/tracks`。分辨率为横屏或竖屏 1080p，fps 为 30。Asset 包含项目相对路径、预览/缩略图路径、类型、时长帧数、显示尺寸、音轨及 HDR 标记。所有 ID 唯一。

Track 按从上到下的合成顺序保存，类型为 video/image/text/audio，包含 muted 和 clips。Clip 包含 `start/duration/in`（整数帧）、`x/y/scale/opacity`、`volume/muted`、素材 ID 或文字属性。时间区间为 `[start, start+duration)`，源帧为 `in + timelineFrame - start`。图片和文字不受源时长约束；音视频不得越界。同轨片段不得重叠。

图片和视频先等比适应画布，再乘 scale，x/y 是最终左上角坐标，不会因改变 scale 自动居中；“画面居中”按钮显式计算位置。顶层轨道最后合成。音量 0–2，透明度 0–1。时间范围、字符串长度、路径、重复 ID、素材类型和片段重叠均在主进程再次校验。

## 持久化与安全边界

工程及草稿通过同目录临时文件、fsync、rename 提交。素材复制为 UUID 文件名，保留原扩展名；无需修改用户源文件。缺失素材不会阻止读取工程，但必须重新定位后才允许导出。

contextIsolation 与 renderer sandbox 开启，nodeIntegration 关闭。preload 仅开放创建/打开/保存/自动恢复、导入/重新定位、启动/取消导出和事件订阅。IPC 只接受主窗口的主 frame；禁止新窗口和页面导航。

`cutcut-media://asset/<id>` 解析为当前工程已登记素材。相对路径与 realpath 均校验，拒绝路径穿越和外部符号链接。媒体协议自行处理字节范围请求：返回 206、Content-Range、Content-Length、Accept-Ranges，并支持 HEAD、后缀范围及 416 越界响应。文件以有界缓冲流式读取，取消请求会关闭文件流；避免 Electron file fetch 返回局部数据却标记 200 导致浏览器寻帧失败。协议支持 CORS，用于 Canvas/Web Audio。渲染器不能指定任意系统路径。

## 渲染

FFmpeg 独立进程通过参数数组启动，不通过 shell。每个剪辑片段读取对应原素材范围，按帧率与时间线位置设置 PTS；画面在 RGB 域按图层顺序叠加，最终明确转换为 BT.709 limited-range YUV420p。原素材 HDR 使用 zscale + Hable tonemap 转 SDR。

预览媒体控制器为片段保留媒体元素与唯一音频节点，播放按钮在用户手势中唤醒 AudioContext。暂停定位只提交一次 seek；解码/seek 未完成时保留上一合成画面，缓冲期间暂停推进时间线。播放 Promise 去重，预加载邻近片段，媒体错误显示在状态栏且不会永久终止动画循环。Canvas 上的选框使用项目坐标，拖动和等比缩放结束时只写入一个可撤销操作。文字与音轨是独立时间段，拆分视频保留其音量、源入点及现有文字时段。

文字使用随附的 Noto Sans CJK SC 字体，由 native Canvas 渲染透明 PNG；与浏览器 Canvas 共用逐行坐标和字体大小计算。避免依赖不同发行版 FFmpeg 的 drawtext 编译选项。

音频裁剪、重采样、按时间线延迟、音量调整并混合，最后使用带延迟补偿的 limiter。空底图/静音底轨定义完整输出时长。FFmpeg 进度经 IPC 回传；完成编码后检查编码和时长并执行完整解码，再原子替换目标。失败和取消都清理工作目录。

## 测试与后续

模型测试覆盖边界和格式；媒体集成测试检验具体像素、音频 RMS、编解码和文件状态；Electron 测试执行实际按钮、拖动、裁剪、播放、保存重开和导出。macOS 必须另行验证系统对话框、音频设备、中文/外置卷路径、Keychain 无关（本版无密钥）、Apple Silicon/Intel 运行和签名公证。

文件拖放由 preload 中的 Electron `webUtils.getPathForFile` 提取真实本地路径，再交给主进程导入；不接受渲染器伪造的 File 内容作为文件路径。主进程校验列表数量、绝对路径及普通文件类型，复用复制、探测和代理生成流程。

## 生成工具方向（2026-11-11）

新增需求指定制图使用 [leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)，音乐使用 [0xShug0/audio.cpp](https://github.com/0xShug0/audio.cpp)。
当前阶段模型优先通过 API 接入；生成图像/音乐属于新增工作，不替代正在建设的初剪、转写和按句切分。
设置页仅展示后端方向，不将未接入的引擎标记为可用。不得假设 Gemini 文本 API 同时提供图像或音乐生成。

设置页的模型连接测试发送固定短文本，不发送项目素材；它仅验证指定模型的文本调用。
视觉能力、语音能力和生成能力需要分别测试。密钥不保存在项目或仓库中。

已核对 audio.cpp 上游说明：支持 macOS/Apple Silicon 与 Metal，包含音乐生成模型。具体模型权重许可独立于运行时许可；尚未在 M1 Pro 验证生成速度或效果。


## 工程 version 2（新增效果）

保留版本 1 读取；包含效果的新工程标记 version 2。Clip 增加可选 speed、fadeIn/fadeOut、audioFadeOut 和关键帧数组。关键帧包含 property、片段局部 frame、value、linear/hold 插值。共享 effects 模块定义预览数值与 FFmpeg 表达式，时间位置仍是整数帧；源定位乘以 speed。

交叉溶解采用下一片段源头余量，在上层独立轨道淡入，第一片段仅淡出音频，保持下层画面直到边界。变速不会隐式移动其他片段；同轨重叠仍拒绝。现有限制详见 README。
