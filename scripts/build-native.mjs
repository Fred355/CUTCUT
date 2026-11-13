// Shared fixed-source builder for the in-app installer and developer diagnostics.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const sources = JSON.parse(
  await fs.readFile(arg('--manifest', path.join(root, 'resources/native/sources.json')), 'utf8'),
);
const workRoot = path.resolve(arg('--work-root', path.join(root, '.native-build')));
const outputRoot = path.resolve(arg('--output-root', path.join(root, 'resources/runtimes')));
const stage = (message) =>
  process.stdout.write('CUTCUT_BUILD_STAGE ' + JSON.stringify({ message }) + '\n');
stage('检查编译工具');
const engines = arg('--engine', 'all') === 'all' ? Object.keys(sources) : [arg('--engine')];
const backends =
  arg('--backend', 'all') === 'all'
    ? process.platform === 'darwin'
      ? ['cpu', 'metal']
      : ['cpu']
    : [arg('--backend')];
if (!engines.every((e) => e in sources) || !backends.every((b) => ['cpu', 'metal'].includes(b)))
  throw new Error('Invalid engine/backend');
if (backends.includes('metal') && process.platform !== 'darwin')
  throw new Error('Metal builds require macOS');
const execute = (bin, args, cwd = root) =>
  new Promise((resolve, reject) => {
    const c = spawn(bin, args, { cwd, stdio: 'inherit' });
    c.on('error', (error) =>
      reject(
        new Error(
          error.code === 'ENOENT'
            ? `找不到构建工具 ${bin}。Mac 源码构建需要 Git、CMake 和 Xcode 命令行工具；先准备这些工具再重试。已下载的模型无需重装。`
            : error.message,
        ),
      ),
    );
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`))));
  });
// Fail before fetching source when the local toolchain is incomplete.
await execute(process.env.CUTCUT_CMAKE || 'cmake', ['--version']);
await execute('git', ['--version']);
if (process.platform === 'darwin') await execute('xcrun', ['--find', 'clang']);
console.log(
  `构建目标：${process.platform}-${process.arch}；运行 CUTCUT 的 Electron 需要使用相同架构。`,
);
async function walk(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(f)));
    else if (ent.isFile() || ent.isSymbolicLink()) out.push(f);
  }
  return out;
}
for (const engine of engines) {
  const spec = sources[engine],
    src = path.join(workRoot, 'sources', engine);
  stage('下载固定版本源码：' + engine);
  await fs.mkdir(src, { recursive: true });
  if (!(await fs.stat(path.join(src, '.git')).catch(() => null)))
    await execute('git', ['init'], src);
  await execute('git', ['fetch', '--depth', '1', spec.repo, spec.commit], src);
  await execute('git', ['checkout', '--detach', 'FETCH_HEAD'], src);
  await execute('git', ['config', 'remote.origin.url', spec.repo], src);
  await execute('git', ['submodule', 'sync', '--recursive'], src);
  await execute('git', ['submodule', 'update', '--init', '--recursive', '--depth', '1'], src);
  for (const backend of backends) {
    const build = path.join(workRoot, `${engine}-${process.platform}-${process.arch}-${backend}`),
      out = path.join(outputRoot, `${process.platform}-${process.arch}`, engine, backend),
      bin = path.join(out, 'bin');
    const metal = backend === 'metal' ? 'ON' : 'OFF';
    const flags = [
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DGGML_NATIVE=OFF',
      '-DGGML_OPENMP=OFF',
      '-DGGML_METAL=' + metal,
      '-DGGML_METAL_EMBED_LIBRARY=ON',
    ];
    if (process.platform === 'darwin')
      flags.push(
        '-DCMAKE_OSX_ARCHITECTURES=' + process.arch.replace('x64', 'x86_64'),
        '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0',
      );
    if (engine === 'whisper') flags.push('-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF');
    if (engine === 'sd') flags.push('-DSD_METAL=' + metal, '-DSD_WEBP=OFF', '-DSD_WEBM=OFF');
    if (engine === 'audio')
      flags.push(
        '-DAUDIOCPP_MODEL_SET=custom',
        '-DAUDIOCPP_MODELS=magenta_realtime_2',
        '-DENGINE_ENABLE_METAL=' + metal,
        '-DENGINE_ENABLE_NATIVE_CPU=OFF',
        '-DENGINE_ENABLE_OPENMP=OFF',
        '-DENGINE_BUILD_TESTS=OFF',
        '-DAUDIOCPP_BUILD_NATIVE_MODEL_MANAGER=OFF',
      );
    stage('配置编译：' + engine + ' / ' + backend);
    await execute(process.env.CUTCUT_CMAKE || 'cmake', ['-S', src, '-B', build, ...flags]);
    stage('正在编译：' + engine + ' / ' + backend);
    await execute(process.env.CUTCUT_CMAKE || 'cmake', [
      '--build',
      build,
      '--config',
      'Release',
      '--target',
      spec.binary,
      '--parallel',
      arg('--jobs', '2'),
    ]);
    stage('整理运行程序和许可证：' + engine);
    const artifacts = (await walk(build)).filter(
      (f) => path.basename(f) === spec.binary || /\.(so(?:\.\d+)*|dylib|metallib)$/.test(f),
    );
    if (!artifacts.some((f) => path.basename(f) === spec.binary))
      throw new Error('No executable produced');
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(bin, { recursive: true });
    for (const f of artifacts) await fs.copyFile(f, path.join(bin, path.basename(f)));
    if (process.platform === 'darwin') {
      // Make native libraries relocatable, then ad-hoc sign them before recording their hashes.
      for (const file of artifacts.filter((f) => !f.endsWith('.metallib'))) {
        const target = path.join(bin, path.basename(file));
        const { execFileSync } = await import('node:child_process');
        const deps = execFileSync('otool', ['-L', target], { encoding: 'utf8' })
          .split('\n')
          .slice(1)
          .map((l) => l.trim().split(' ')[0])
          .filter(Boolean);
        for (const dep of deps)
          if (artifacts.some((f) => path.basename(f) === path.basename(dep)))
            await execute('install_name_tool', [
              '-change',
              dep,
              '@loader_path/' + path.basename(dep),
              target,
            ]);
        if (target.endsWith('.dylib'))
          await execute('install_name_tool', [
            '-id',
            '@loader_path/' + path.basename(target),
            target,
          ]);
        await execute('codesign', [
          '--force',
          '--sign',
          process.env.CUTCUT_NATIVE_SIGN_IDENTITY || '-',
          target,
        ]);
      }
    }
    const licenseDir = path.join(out, 'licenses');
    await fs.mkdir(licenseDir, { recursive: true });
    for (const f of (await walk(src)).filter(
      (f) =>
        /^(LICENSE|COPYING|NOTICE)(\..*)?$/i.test(path.basename(f)) &&
        !f.includes(path.sep + '.git' + path.sep),
    )) {
      const relative = path.relative(src, f).replaceAll(path.sep, '__');
      await fs.copyFile(f, path.join(licenseDir, relative));
    }
    const files = [];
    for (const f of await walk(out)) {
      files.push({
        path: path.relative(out, f),
        sha256: createHash('sha256')
          .update(await fs.readFile(f))
          .digest('hex'),
      });
    }
    await fs.writeFile(
      path.join(out, 'manifest.json'),
      JSON.stringify(
        {
          engine,
          backend,
          platform: `${process.platform}-${process.arch}`,
          commit: spec.commit,
          repo: spec.repo,
          license: spec.license,
          files,
        },
        null,
        2,
      ),
    );
  }
}
