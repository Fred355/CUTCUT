# 内置本地工具：构建、模型与验收

## 当前交付状态

三种 CLI 接入、模型管理、生成预览/导入及 CPU/Metal 构建脚本已写入源码。Linux x86_64 的三个 CPU 运行时已从固定提交编译成功，并检查 CLI 参数。

**当前没有完成真实神经模型推理或 macOS 安装包验收。** 云环境网络策略拒绝访问 Hugging Face（CONNECT HTTP 403），因此没有下载权重，也没有伪造下载大小和 SHA-256。完整模型锁定清单尚未生成，打包检查会阻止制作缺少清单的完整安装包。运行时编译成功、CLI 协议替身及 FFmpeg 测试均不等于真实模型验收。

## 运行时与模型清单

运行时源码提交固定在 resources/native/sources.json；构建目录独立保存 CPU 和 Metal 二进制。

| 功能 | 运行时 | 权重与组件 | 权重许可 |
| --- | --- | --- | --- |
| 语音 | ggml-org/whisper.cpp，MIT | ggerganov/whisper.cpp 的 ggml-small.bin，多语言 small，约 466 MiB；准确大小以清单为准 | OpenAI Whisper MIT |
| 图像 | leejet/stable-diffusion.cpp，MIT | stable-diffusion-v1-5/stable-diffusion-v1-5 的 v1-5-pruned-emaonly.safetensors，包含 SD 1.5 推理所需 UNet、CLIP、VAE | CreativeML Open RAIL-M |
| 音乐 | 0xShug0/audio.cpp，Apache-2.0 | audio-cpp/Magenta-RealTime-2-GGUF 的 magenta-rt2-small-q8_0.gguf；包含生成器、SpectroStream、MusicCoCa、词表与配置 | CC-BY-4.0 与上游使用条款 |

音乐模型的 230M 指生成器，不能据此推断整个包大小或内存需求。audio.cpp 固定版本的 docs/models/magenta_realtime_2.md 明确说明自包含包组成及权重许可。模型托管页面的当前文件大小、哈希、修订及许可全文仍需在可访问环境核对。

来源：
- https://github.com/ggml-org/whisper.cpp
- https://github.com/leejet/stable-diffusion.cpp
- https://github.com/0xShug0/audio.cpp/blob/eeeca9e88b42509707486efb37bb5edb3b1ca48e/docs/models/magenta_realtime_2.md
- https://github.com/openai/whisper/blob/main/LICENSE
- https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/blob/main/LICENSE
- https://github.com/magenta/magenta-realtime

## 开发者准备完整运行时

最终安装包用户无需 Python、Git、CMake 或自行编译。下面的工具仅供源码开发与打包人员使用。

在目标 Mac 架构上准备 Xcode 命令行工具、CMake、Git、Node.js 22.12+，然后执行：

    npm ci
    npm run runtimes:build
    npm run models:lock
    npm run runtimes:check
    npm run build
    npm start

- macOS 默认构建 CPU 和 Metal；Linux 默认仅 CPU。可使用 --engine whisper/sd/audio、--backend cpu/metal 和 --jobs 2。
- 可用 CUTCUT_CMAKE 指定 CMake 可执行文件。代码及构建缓存放在 .native-build/，运行时输出到 resources/runtimes/平台-架构/引擎/后端/。
- 脚本固定上游提交、初始化固定子模块、编译 CLI，复制依赖与许可证，记录文件 SHA-256。macOS 修正动态库相对路径并在记录哈希前签名。
- 本地开发默认临时签名；正式签名需在运行时构建前设置 CUTCUT_NATIVE_SIGN_IDENTITY，并与应用签名身份匹配。打包跳过再次签名这些文件以免哈希失效。Developer ID、签名与公证仍需 Mac 验收。
- models:lock 只读取官方元数据，不下载权重；记录三个模型不可变修订、URL、真实字节数和 SHA-256。已有清单不会被覆盖；明确升级时使用 npm run models:lock -- --refresh 并复查差异及许可证。
- 生成的 resources/native/models.lock.json 应与该版源码一起保存。当前仓库没有假值或空的占位清单。发布构建必须具有完整清单。
- 下载需要 HTTPS 访问 huggingface.co 及其官方 HF CDN 跳转域名。若环境策略拒绝访问，应在允许该来源的构建环境执行，不跳过校验或改用不明镜像。

打包：

    npm run package:mac

打包前检查三个引擎的 CPU/Metal 运行时、全部文件哈希、运行时许可证、模型来源和完整锁定清单。缺少任一项即失败，不产出宣称支持全部本地工具的安装包。权重不打入安装包，首次使用时按需下载。Linux 不生成 Mac 安装包。

## 应用内使用

1. 软件设置 → 语音识别/图像生成/音乐生成，选择 Metal 或 CPU。默认 Metal，失败后需手动选择 CPU 重试。
2. “查看下载信息”显示真实大小、固定版本和 SHA-256；阅读许可后下载。下载支持取消、大小/哈希校验；校验未通过不会显示可用。
3. “导入已有同款模型”也按同一固定清单校验，不接受任意未知权重。完整安装包可离线校验导入；未带清单的源码构建首次仍需联网获取清单。
4. 正在使用或校验的模型不能删除。软件设置 → 本地存储显示模型和生成缓存路径与占用；清理生成缓存不会删除工程素材副本或历史。
5. 语音：编辑器“AI 剪辑”选择一个有音轨素材 → 语音转文字。源时间码接入现有文稿、SRT、字幕及按句切分，最多 60 分钟，分块 5 分钟。修改文稿不会改时间边界。识别质量、背景音乐和静音幻觉需要实际模型验收。
6. 图像：编辑器“生成素材”→ 图片；每次一张，512×512、512×768 或 768×512。
7. 音乐：同面板选择音乐，生成 10/20/30 秒纯音乐。提示词描述风格，不提供歌词演唱或克隆。模型通常更适合英文风格描述。
8. 先预览或试听，再“加入素材库”。结果只属于生成时的工程；不会自动加入后打开的工程。素材加入时间线仍是独立可撤销操作。

没有可靠百分比时显示实际阶段和耗时。所有本地推理、测试与内置生成共用队列，并与导出互斥；取消仅终止 CUTCUT 启动的子进程。Ollama 的模型释放是单独的原生请求，不关闭 Ollama、不删除权重，也不承诺断开 HTTP 后外部计算立刻停止。

## 实机验收清单

在 M1 Pro 16 GB 上使用 npm run build 后的 npm start，再测试完整安装包：

- 中文、英文及无语音素材；长停顿、音乐背景、裁剪/变速/重复素材的字幕与 SRT 对齐。
- 三种图片尺寸；10/20/30 秒音乐实际解码、试听、加入工程、保存重开及 MP4 导出。
- Metal 初始化失败需明确报错；用户选 CPU 后可重试。记录推理耗时和峰值内存，不假定模型可同时驻留。
- Bonsai 的实际 Ollama 标签做文字执行；Qwen3-VL 4B-Instruct 4-bit 做视觉，2B 备选。分别测试图片理解与真实初剪。
- Ollama 指定模型释放、未使用模型不受影响、失败后重任务阻断；取消生成后关闭工程，确认进程退出与缓存清理。
- 下载损坏、取消、空间不足、模型缺失、运行时崩溃，以及 Mac 签名、系统密钥保护、文件权限和安装后运行。

测试记录需写明模型锁定修订、机器、后端、输入素材、输出与实际用量；不得用 CLI 替身结果填入真实模型验收栏。
