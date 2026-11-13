# 内置本地工具：构建、模型与验收

## 当前交付状态

三种 CLI 接入、模型管理、生成预览/导入及 CPU/Metal 构建脚本已写入源码。Linux x86_64 的三个 CPU 运行时已从固定提交编译成功，并检查 CLI 参数。

**当前没有完成真实神经模型推理或 macOS 安装包验收。** 云环境网络策略拒绝访问 Hugging Face（CONNECT HTTP 403），因此没有下载权重，也没有伪造下载大小和 SHA-256。完整模型锁定清单尚未生成，打包检查会阻止制作缺少清单的完整安装包。运行时编译成功、CLI 协议替身及 FFmpeg 测试均不等于真实模型验收。

## 在应用内补齐 Runtime

模型权重与运行程序是两部分。“模型已安装”只表示权重准备完毕，不能代替 Whisper、sd.cpp 或 audio.cpp 可执行程序。本版使用**应用内从源码编译安装**，不下载预编译支持包，也不要求在终端执行引擎构建命令。

1. 更新并启动应用，进入“软件设置 → 语音识别 / 图像生成 / 音乐生成”。
2. 选择 Metal（Mac）或 CPU，点击“检查编译工具”。Mac 需要 CMake、Git 和 Xcode 命令行工具。
3. 缺少 CMake 时点击“下载 CMake”，从官方页面安装 CMake.app 到“应用程序”；CUTCUT 会自动查找，无需配置终端 PATH。缺少系统编译工具时点击“安装系统编译工具”，完成 macOS 安装对话框。返回后再次检查。
4. 点击“编译并安装运行程序”。应用下载固定版本的上游源码与子模块，执行编译，安装依赖与许可证，并校验输出。需要能访问 GitHub；首次编译可能数分钟，开始前检查至少 4 GiB 空闲空间，实际需求随引擎而变。
5. 看到“运行程序：已找到”后即可继续使用原有模型，**无需重新下载权重或重启应用**。模型还没有安装时，再下载或导入对应模型。

安装页面显示真实阶段、耗时及最近日志，不伪造百分比；可取消并等待编译进程退出。失败或取消不会替换之前可用的运行程序，也不会删除模型。Metal 构建或推理失败需要用户明确选择 CPU 后重试。

运行程序安装在 Electron 用户数据目录的 `runtime-tools/installed/平台-架构/引擎/后端/versions/`，校验成功后原子切换 `active.json`；保留前一个版本。源码和中间编译文件保存在 `runtime-tools/build-cache/` 供重试复用。源码版和 .app 均使用这套应用内流程，不修改 .app 包内容。

安装与本地推理使用同一队列，并与导出互斥。安装是应用级任务，关闭工程不会中止它；退出应用前需要完成或在设置中取消。不会关闭用户的 Ollama 服务。

## audio.cpp 编译失败：std::to_chars / macOS 13.3

2026-11-13 Debug 更新：用户在 M1 Pro 上安装音乐 Runtime 时，CMake 配置成功且 Metal 后端已找到，但编译 `src/framework/debug/trace.cpp:75` 报错：

```text
error: 'to_chars' is unavailable: introduced in macOS 13.3
```

原因是 audio.cpp 使用了浮点 `std::to_chars`，Apple libc++ 将它标记为 macOS 13.3 起可用；CUTCUT 旧构建脚本却指定 `CMAKE_OSX_DEPLOYMENT_TARGET=13.0`。即使当前系统较新，编译器也会按指定的最低部署版本拒绝使用该接口。日志中的 SentencePiece CMake 弃用警告不是这次失败的原因，末尾的 `cmake exited 2` 只是编译失败的结果。

解决方案：仅将 audio.cpp 的 macOS CPU/Metal 构建目标提高到 13.3，sd.cpp 和 Whisper 仍为 13.0。音乐 Runtime 的最低系统要求随之为 macOS 13.3；13.0–13.2 不能使用这个修复后的二进制，需要升级系统或另做上游源码兼容处理。

更新步骤：退出旧应用，获取最新源码，执行 `npm run build` 和 `npm start`；随后在“软件设置 → 音乐生成”再次点击“编译并安装运行程序”。`npm run build` 会重新生成应用实际调用的 `resources/native/build-native.mjs`，只拉取源码而不构建应用仍可能运行旧安装器。引擎安装仍在应用内操作，无需手动执行 CMake。

每次重试都会执行 CMake 配置，新的显式 `-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3` 会覆盖原构建缓存中的 13.0，并由构建系统重编译受影响文件；无需删除模型或整个缓存目录，也无需重装已成功的 sd.cpp。用户已报告 sd.cpp 安装成功，这不代表音频修复或模型推理已通过实机验收。Mac 实际编译及音乐生成结果仍需重试确认。

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

## 开发者构建和打包

源码首次启动仍需要 Node.js 22.12+：

    npm ci
    npm run build
    npm start

`npm run build` 把安装器脚本生成到 `resources/native/build-native.mjs`，并携带固定的 `sources.json`；这一步不编译三个引擎。应用内安装器用 Electron 的 Node 模式启动脚本，参数由主进程固定，渲染器不能提交任意命令。

在可访问 Hugging Face 的构建环境执行 `npm run models:lock`，生成包含不可变修订、真实字节数、SHA-256 和官方 URL 的 `resources/native/models.lock.json`。已有清单默认不覆盖，明确升级时使用 `--refresh` 并复查差异与权重许可。模型权重不打入安装包，首次使用按需下载；禁止用假值或空清单绕过校验。

在目标架构的 Mac 上执行 `npm run package:mac`。打包检查安装器脚本、固定源码清单及完整模型清单，排除 `resources/runtimes/` 中的开发者预编译产物。应用内安装仍需要用户电脑具备编译工具。当前环境无法生成完整模型清单，因此不能宣称已经交付可发布安装包。Linux 不生成 Mac 安装包。

开发者仍可用 `npm run runtimes:build -- --engine audio --backend metal` 独立诊断构建；默认输出 `.native-build/` 缓存与 `resources/runtimes/`。这不是用户安装流程。`npm run runtimes:check` 检查这种开发输出；安装器资源检查使用 `npx tsx scripts/check-native.ts --installer`。

构建固定上游提交及子模块、记录文件 SHA-256，并复制运行时许可。Mac 修正动态库相对路径后临时签名，再记录哈希。编译和应用必须匹配架构；M1 Pro 优先原生 arm64。Developer ID、公证和安装后运行仍待 Mac 验收。

## 应用内使用

1. 软件设置 → 语音识别/图像生成/音乐生成，选择 Metal 或 CPU。默认 Metal，失败后需手动选择 CPU 重试。
2. “查看下载信息”显示真实大小、固定版本和 SHA-256；阅读许可后下载。下载支持取消、大小/哈希校验；校验未通过不会显示可用。
3. “导入已有同款模型”也按同一固定清单校验，不接受任意未知权重。完整安装包可离线校验导入；未带清单的源码构建首次仍需联网获取清单。
4. 正在使用或校验的模型不能删除。软件设置 → 本地存储显示模型和生成缓存路径与占用；清理生成缓存不会删除工程素材副本或历史。
5. 语音：编辑器“AI 剪辑”选择一个有音轨素材 → 语音转文字。源时间码接入现有文稿、SRT、字幕及按句切分，最多 60 分钟，分块 5 分钟。修改文稿不会改时间边界。识别质量、背景音乐和静音幻觉需要实际模型验收。
6. 图像：编辑器“生成素材”→ 图片；每次一张，512×512、512×768 或 768×512。
7. 音乐：同面板选择音乐，生成 10/20/30 秒纯音乐。提示词描述风格，不提供歌词演唱或克隆。模型通常更适合英文风格描述。
8. 先预览或试听，再“加入素材库”。结果只属于生成时的工程；不会自动加入后打开的工程。素材加入时间线仍是独立可撤销操作。

没有可靠百分比时显示实际阶段和耗时。所有本地编译、推理、测试与内置生成共用队列，并与导出互斥；取消仅终止 CUTCUT 启动的子进程。Ollama 的模型释放是单独的原生请求，不关闭 Ollama、不删除权重，也不承诺断开 HTTP 后外部计算立刻停止。

## 实机验收清单

在 M1 Pro 16 GB 上使用 npm run build 后的 npm start，再测试完整安装包：

- 中文、英文及无语音素材；长停顿、音乐背景、裁剪/变速/重复素材的字幕与 SRT 对齐。
- 三种图片尺寸；10/20/30 秒音乐实际解码、试听、加入工程、保存重开及 MP4 导出。
- Metal 初始化失败需明确报错；用户选 CPU 后可重试。记录推理耗时和峰值内存，不假定模型可同时驻留。
- Bonsai 的实际 Ollama 标签做文字执行；Qwen3-VL 4B-Instruct 4-bit 做视觉，2B 备选。分别测试图片理解与真实初剪。
- Ollama 指定模型释放、未使用模型不受影响、失败后重任务阻断；取消生成后关闭工程，确认进程退出与缓存清理。
- 下载损坏、取消、空间不足、模型缺失、运行时崩溃，以及 Mac 签名、系统密钥保护、文件权限和安装后运行。

测试记录需写明模型锁定修订、机器、后端、输入素材、输出与实际用量；不得用 CLI 替身结果填入真实模型验收栏。
