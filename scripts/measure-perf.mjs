#!/usr/bin/env node
/**
 * 生产构建性能基线测量（Playwright 驱动）
 *
 * I. 这个脚本测什么
 *
 * 1. 用 Playwright 打开 `pnpm run build` 产出的 `dist/`（通过 `vite preview`），
 *    也就是真正会发布到 Cloudflare Pages 的那份产物，而不是 dev server。
 * 2. 在页面里独立测量 rAF 帧间隔（p50/p95/p99）、WebGL draw call 次数、
 *    JS 堆占用与堆增长，并同时读取游戏自身 DebugOverlay 报出的
 *    FPS / frameTime / drawCalls / triangles，两者互相印证。
 * 3. 明确区分渲染后端：headless Chromium 默认走 SwiftShader 软件光栅化，
 *    它的 FPS **不代表真机 GPU 性能**，报告里必须单独标注。
 *
 * II. 为什么 draw call 要自己数
 *
 * 游戏只在 DebugOverlay 可见时才写 `renderer.info`，而那个面板可能被 UI 重构
 * 影响。脚本在页面启动前 patch 掉 WebGL 原型的 drawElements/drawArrays，
 * 因此即使面板消失也仍然有可信的 draw call 数据；同时把面板里的数字读出来做
 * 交叉验证（两者数量级不一致就说明有一次渲染没走预期路径）。
 *
 * III. 用法
 *
 * ```
 * node scripts/measure-perf.mjs                       # 默认：1280x720 + 640x360
 * node scripts/measure-perf.mjs --duration=15         # 每个分辨率测 15 秒
 * node scripts/measure-perf.mjs --sizes=1920x1080
 * node scripts/measure-perf.mjs --headed              # 用真实窗口（macOS 上走真 GPU）
 * node scripts/measure-perf.mjs --channel=chromium    # 完整 Chromium + 新 headless
 * node scripts/measure-perf.mjs --json=perf.json      # 额外落盘 JSON
 * node scripts/measure-perf.mjs --no-build            # 不复用/不重建 dist，缺失即报错
 * ```
 *
 * 退出码：0 = 测量完成；1 = 环境问题（dist 缺失、端口被占用、启动失败）。
 * 注意：FPS 高低 **不影响** 退出码，因为这个数字本身不是门禁。
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { chromium } from '@playwright/test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.html');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/** 解析 `--key=value` / `--flag` 形式的参数。 */
function parseArgs(argv) {
  const options = {
    duration: 10,
    port: Number(process.env['PERF_PORT'] ?? 4174),
    sizes: '1280x720,640x360',
    json: null,
    headed: process.env['PERF_HEADED'] === '1',
    channel: process.env['PERF_CHANNEL'] ?? null,
    build: true,
    warmupMs: 2500,
    // 固定种子：否则 1280x720 与 640x360 会落在两个不同的世界，三角形数无法对比。
    seed: process.env['PERF_SEED'] ?? 'perf-baseline',
  };

  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (match === null) {
      continue;
    }
    const key = match[1];
    const value = match[2];
    if (key === 'duration') options.duration = Number(value);
    else if (key === 'port') options.port = Number(value);
    else if (key === 'sizes') options.sizes = String(value);
    else if (key === 'json') options.json = String(value);
    else if (key === 'headed') options.headed = true;
    else if (key === 'channel') options.channel = String(value);
    else if (key === 'no-build') options.build = false;
    else if (key === 'warmup') options.warmupMs = Number(value);
    else if (key === 'seed') options.seed = String(value);
  }

  options.duration =
    Number.isFinite(options.duration) && options.duration > 0 ? options.duration : 10;
  return options;
}

/** 把 `1280x720,640x360` 解析成视口列表。 */
function parseSizes(spec) {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [width, height] = entry.split('x').map((part) => Number(part));
      return { width: width || 1280, height: height || 720 };
    });
}

// ---------------------------------------------------------------------------
// 子进程与环境
// ---------------------------------------------------------------------------

/** 以继承 stdio 的方式运行命令，失败时抛错。 */
function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 失败，退出码 ${code}`));
    });
  });
}

/** 轮询直到预览服务器可访问。 */
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) {
        return;
      }
    } catch {
      // 服务器还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待 ${url} 超时（${timeoutMs} ms）`);
}

/** 启动 `vite preview`，返回终止函数。 */
function startPreview(port) {
  const child = spawn(PREVIEW_BIN, ['preview', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[perf] vite preview 退出，code=${code}\n${logs.join('')}\n`);
    }
  });

  return () => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  };
}

// ---------------------------------------------------------------------------
// 页面内探针
// ---------------------------------------------------------------------------

/**
 * 在任何页面脚本之前注入的探针。
 *
 * 这必须通过 `addInitScript` 安装：游戏在模块初始化时就创建 WebGL 上下文，
 * 之后再 patch 原型就晚了。
 */
function installProbe() {
  const state = {
    frames: [],
    lastTimestamp: null,
    drawCalls: 0,
    drawCallsPerFrame: [],
    lastFrameDrawCalls: 0,
    instancedCalls: 0,
    programs: 0,
    contextLost: false,
    recording: false,
  };
  /** @type {any} */ (globalThis).__DSH_PERF__ = state;

  const patch = (prototype) => {
    if (prototype === undefined || prototype === null) return;

    const originalElements = prototype.drawElements;
    if (typeof originalElements === 'function') {
      prototype.drawElements = function patchedDrawElements(...args) {
        state.drawCalls += 1;
        return originalElements.apply(this, args);
      };
    }

    const originalArrays = prototype.drawArrays;
    if (typeof originalArrays === 'function') {
      prototype.drawArrays = function patchedDrawArrays(...args) {
        state.drawCalls += 1;
        return originalArrays.apply(this, args);
      };
    }

    const originalInstanced = prototype.drawElementsInstanced;
    if (typeof originalInstanced === 'function') {
      prototype.drawElementsInstanced = function patchedDrawElementsInstanced(...args) {
        state.drawCalls += 1;
        state.instancedCalls += 1;
        return originalInstanced.apply(this, args);
      };
    }

    const originalLink = prototype.linkProgram;
    if (typeof originalLink === 'function') {
      prototype.linkProgram = function patchedLinkProgram(...args) {
        state.programs += 1;
        return originalLink.apply(this, args);
      };
    }
  };

  patch(globalThis.WebGL2RenderingContext?.prototype);
  patch(globalThis.WebGLRenderingContext?.prototype);

  const tick = (timestamp) => {
    if (state.recording && state.lastTimestamp !== null) {
      state.frames.push(timestamp - state.lastTimestamp);
    }
    state.lastTimestamp = timestamp;
    state.drawCallsPerFrame.push(state.drawCalls - state.lastFrameDrawCalls);
    state.lastFrameDrawCalls = state.drawCalls;
    if (state.drawCallsPerFrame.length > 100000) {
      state.drawCallsPerFrame.length = 0;
    }
    globalThis.requestAnimationFrame(tick);
  };
  globalThis.requestAnimationFrame(tick);

  globalThis.addEventListener('webglcontextlost', () => {
    state.contextLost = true;
  });
}

/** 读取 WebGL 后端信息（在页面里执行）。 */
function readBackend() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (gl === null) {
    return { available: false, reason: 'no webgl context' };
  }
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const timerQuery = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  return {
    available: true,
    version: gl.getParameter(gl.VERSION),
    vendor:
      debugInfo !== null
        ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR),
    renderer:
      debugInfo !== null
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
    unmaskedAvailable: debugInfo !== null,
    timerQueryAvailable: timerQuery !== null,
  };
}

/** 读取 DebugOverlay 上游戏自己报告的数字（在页面里执行）。 */
function readOverlayMetrics() {
  const readRow = (key) => {
    const element = document.querySelector(
      `[data-testid="debug-row-${key}"] .debug-overlay__value`,
    );
    return element?.textContent ?? null;
  };
  const canvas = document.querySelector('canvas');
  return {
    fps: readRow('fps'),
    frameTime: readRow('frameTime'),
    drawCalls: readRow('drawCalls'),
    triangles: readRow('triangles'),
    overlayPresent: document.querySelector('[data-testid="debug-overlay"]') !== null,
    canvasWidth: canvas?.width ?? null,
    canvasHeight: canvas?.height ?? null,
    devicePixelRatio: globalThis.devicePixelRatio,
    navigatorConcurrency: globalThis.navigator.hardwareConcurrency ?? null,
  };
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

/** 分位数（输入会被排序，调用方传入副本）。 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index];
}

/** 把一组帧间隔换算成可读统计。 */
function summariseFrames(intervals) {
  const finite = intervals.filter((value) => Number.isFinite(value) && value > 0);
  if (finite.length === 0) {
    return { samples: 0 };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const total = finite.reduce((sum, value) => sum + value, 0);
  const mean = total / finite.length;
  const median = percentile(sorted, 0.5);

  // 帧率由平均帧间隔换算，与游戏自身的 EMA 口径不同：这里的平均值是整段
  // 测量窗口的算术平均，不会被平滑系数影响。
  return {
    samples: finite.length,
    meanMs: mean,
    medianMs: median,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    fpsFromMean: 1000 / mean,
    // 明显超过中位帧时间的帧视为"卡顿帧"；用中位数而不是 16.7ms 做基准，
    // 因为软件渲染下中位数本身就可能是 60ms。
    longFrames: finite.filter((value) => value > median * 2).length,
    measuredSeconds: total / 1000,
  };
}

/** 判断后端是否为软件光栅化。 */
function classifyBackend(rendererString) {
  const text = String(rendererString ?? '').toLowerCase();
  if (/swiftshader|llvmpipe|softwarerasterizer|swrast|software|mesa offscreen/.test(text)) {
    return 'software';
  }
  if (
    text.includes('angle') ||
    text.includes('metal') ||
    text.includes('apple') ||
    text.includes('nvidia') ||
    text.includes('amd') ||
    text.includes('intel')
  ) {
    return 'hardware';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 测量
// ---------------------------------------------------------------------------

/**
 * 把页面推进到"世界里、正在渲染"的状态。
 *
 * I. 为什么要走主菜单流程
 *
 * Phase 0 的页面加载完就是烟雾场景，直接测 rAF 即可；接入真实游戏后启动落在主菜单，
 * 菜单是纯 DOM（0 个 draw call、0 个三角形），此时测到的是**空转的 60 FPS**——数字
 * 好看但完全没有意义（这是本脚本第一版踩过的坑）。因此必须按真实流程新建世界，并等到
 * 调试面板报告区块数 > 0，才算"真的在渲染"。
 *
 * @param page - 页面。
 * @param timeoutMs - 等待世界就绪的上限。
 * @param seed - 世界种子；两个视口使用同一个种子，否则三角形数不可比。
 * @returns 就绪时的已加载区块数。
 */
async function enterWorld(page, timeoutMs, seed) {
  const newWorld = page.getByTestId('main-menu-new-world');
  if ((await newWorld.count()) > 0) {
    const seedInput = page.getByTestId('main-menu-seed');
    if ((await seedInput.count()) > 0) {
      await seedInput.fill(seed);
    }
    await newWorld.click({ timeout: 15_000 });
  }

  const readChunkCount = async () => {
    const element = page.locator('[data-testid="debug-row-chunks"] .debug-overlay__value');
    if ((await element.count()) === 0) {
      return 0;
    }
    const match = /(\d+)/.exec(await element.innerText());
    return match === null ? 0 : Number.parseInt(match[1], 10);
  };

  const deadline = Date.now() + timeoutMs;
  let chunks = 0;
  while (Date.now() < deadline) {
    chunks = await readChunkCount();
    if (chunks > 0) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (chunks === 0) {
    throw new Error(
      '世界没有在超时时间内加载出任何区块，性能数字会是无意义的空转数据。' +
        '请确认主菜单可以新建世界，或调试面板是否可见。',
    );
  }
  return chunks;
}

/**
 * 在指定视口下测量一次。
 *
 * @param {import('@playwright/test').Browser} browser - 已启动的浏览器。
 * @param {string} baseUrl - 预览服务器地址。
 * @param {{width:number,height:number}} viewport - 视口尺寸。
 * @param {object} options - CLI 选项。
 * @param {number} bootTimeoutMs - 引擎就绪超时。
 */
async function measure(browser, baseUrl, viewport, options, bootTimeoutMs) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 200)));

  await page.addInitScript(installProbe);
  await page.goto(baseUrl, { waitUntil: 'load', timeout: bootTimeoutMs });

  // 等引擎就绪：画布可见、启动遮罩消失。
  await page.waitForSelector('[data-testid="game-canvas"]', {
    timeout: bootTimeoutMs,
    state: 'visible',
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="boot-loading"]') === null,
    undefined,
    { timeout: bootTimeoutMs },
  );

  // 主菜单 → 新建世界。跳过这一步会测到空转的菜单帧。
  const loadedChunks = await enterWorld(page, bootTimeoutMs, options.seed);

  await page.waitForFunction(
    () => (globalThis.__DSH_PERF__?.drawCallsPerFrame.length ?? 0) > 30,
    undefined,
    { timeout: bootTimeoutMs },
  );

  await page.waitForTimeout(options.warmupMs);

  // 堆在测量窗口前后各取一次，用增长量判断是否存在泄漏趋势。
  const session = await context.newCDPSession(page);
  const readHeap = async () => {
    try {
      const usage = await session.send('Runtime.getHeapUsage');
      return { cdpUsedBytes: usage.usedSize, cdpTotalBytes: usage.totalSize };
    } catch {
      return { cdpUsedBytes: null, cdpTotalBytes: null };
    }
  };
  const readJsHeap = () =>
    page.evaluate(() => {
      const memory = /** @type {any} */ (globalThis).performance?.memory;
      return memory === undefined ? null : (memory.usedJSHeapSize ?? null);
    });

  const heapBefore = { ...(await readHeap()), jsHeapBefore: await readJsHeap() };

  // 开始记录：清空探针缓冲并打开 recording。
  await page.evaluate(() => {
    const state = /** @type {any} */ (globalThis).__DSH_PERF__;
    state.frames = [];
    state.lastTimestamp = null;
    state.drawCallsPerFrame = [];
    state.recording = true;
  });

  await page.waitForTimeout(options.duration * 1000);

  const sample = await page.evaluate(() => {
    const state = /** @type {any} */ (globalThis).__DSH_PERF__;
    state.recording = false;
    return {
      frames: state.frames.slice(),
      drawCalls: state.drawCalls,
      drawCallsPerFrame: state.drawCallsPerFrame.slice(-600),
      instancedCalls: state.instancedCalls,
      programs: state.programs,
      contextLost: state.contextLost,
    };
  });

  const heapAfter = { ...(await readHeap()), jsHeapAfter: await readJsHeap() };
  const backend = await page.evaluate(readBackend);
  const overlay = await page.evaluate(readOverlayMetrics);

  await context.close();

  const drawCallsPerFrame = sample.drawCallsPerFrame.filter((value) => Number.isFinite(value));
  const maxDrawCallsPerFrame = drawCallsPerFrame.reduce((max, value) => Math.max(max, value), 0);

  return {
    viewport: `${viewport.width}x${viewport.height}`,
    loadedChunks,
    backend,
    backendClass: classifyBackend(backend.renderer),
    frames: summariseFrames(sample.frames),
    drawCallsTotal: sample.drawCalls,
    drawCallsPerFramePeak: maxDrawCallsPerFrame,
    drawCallsPerFrameMean:
      drawCallsPerFrame.length === 0
        ? null
        : drawCallsPerFrame.reduce((sum, value) => sum + value, 0) / drawCallsPerFrame.length,
    instancedCalls: sample.instancedCalls,
    linkedPrograms: sample.programs,
    contextLost: sample.contextLost,
    heap: {
      usedBytesAfter: heapAfter.cdpUsedBytes ?? heapAfter.jsHeapAfter,
      usedBytesBefore: heapBefore.cdpUsedBytes ?? heapBefore.jsHeapBefore,
      totalBytes: heapAfter.cdpTotalBytes,
      jsHeapUsedAfter: heapAfter.jsHeapAfter,
      growthBytes:
        (heapAfter.cdpUsedBytes ?? heapAfter.jsHeapAfter ?? 0) -
        (heapBefore.cdpUsedBytes ?? heapBefore.jsHeapBefore ?? 0),
    },
    overlay,
    consoleErrors,
    pageErrors,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 把字节格式化成 MB。 */
function toMb(bytes) {
  return Number.isFinite(bytes) ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : 'n/a';
}

/** 打印一次测量的结论。 */
function printResult(result) {
  const backendLabel =
    result.backendClass === 'software'
      ? '软件光栅化（SwiftShader 类）'
      : result.backendClass === 'hardware'
        ? '硬件 GPU'
        : '未知';

  console.log(`\n── ${result.viewport} ─────────────────────────────────────────`);
  console.log(`渲染后端      : ${result.backend.renderer ?? 'n/a'}`);
  console.log(
    `后端类型      : ${backendLabel}${result.backend.timerQueryAvailable ? '（支持 GPU 计时查询）' : ''}`,
  );
  console.log(`WebGL 版本    : ${result.backend.version ?? 'n/a'}`);
  console.log(
    `帧间隔        : 样本 ${result.frames.samples} / 测时 ${result.frames.measuredSeconds?.toFixed(1) ?? '0'} s`,
  );
  console.log(
    `              mean ${result.frames.meanMs?.toFixed(2) ?? 'n/a'} ms | p50 ${result.frames.medianMs?.toFixed(2) ?? 'n/a'} | p95 ${result.frames.p95Ms?.toFixed(2) ?? 'n/a'} | p99 ${result.frames.p99Ms?.toFixed(2) ?? 'n/a'}`,
  );
  console.log(
    `              min ${result.frames.minMs?.toFixed(2) ?? 'n/a'} | max ${result.frames.maxMs?.toFixed(2) ?? 'n/a'} | 卡顿帧(>2x p50) ${result.frames.longFrames ?? 'n/a'}`,
  );
  console.log(`FPS(均值换算) : ${result.frames.fpsFromMean?.toFixed(1) ?? 'n/a'}`);
  console.log(
    `DebugOverlay  : fps=${result.overlay.fps ?? 'n/a'} frameTime=${result.overlay.frameTime ?? 'n/a'} drawCalls=${result.overlay.drawCalls ?? 'n/a'} triangles=${result.overlay.triangles ?? 'n/a'}`,
  );
  console.log(
    `Draw call     : 总计 ${result.drawCallsTotal} | 峰值/帧 ${result.drawCallsPerFramePeak} | 均值/帧 ${result.drawCallsPerFrameMean?.toFixed(1) ?? 'n/a'} | instanced ${result.instancedCalls}`,
  );
  console.log(`着色器程序    : ${result.linkedPrograms} 次 linkProgram`);
  console.log(
    `JS 堆         : ${toMb(result.heap.usedBytesAfter)}（起始 ${toMb(result.heap.usedBytesBefore)}，窗口内增长 ${toMb(result.heap.growthBytes)}）`,
  );
  console.log(
    `画布/DPR      : ${result.overlay.canvasWidth}x${result.overlay.canvasHeight} @ ${result.overlay.devicePixelRatio}x | hardwareConcurrency=${result.overlay.navigatorConcurrency}`,
  );
  console.log(`上下文丢失    : ${result.contextLost ? '是' : '否'}`);
  if (result.consoleErrors.length > 0) {
    console.log(
      `控制台错误    : ${result.consoleErrors.length} 条，例：${result.consoleErrors[0]}`,
    );
  }
  if (result.pageErrors.length > 0) {
    console.log(`页面异常      : ${result.pageErrors.length} 条，例：${result.pageErrors[0]}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sizes = parseSizes(options.sizes);
  const baseUrl = `http://127.0.0.1:${options.port}/`;
  const bootTimeoutMs = Number(process.env['PERF_BOOT_TIMEOUT_MS'] ?? 60_000);

  if (!existsSync(DIST_INDEX)) {
    if (!options.build) {
      throw new Error(`缺少 ${DIST_INDEX}，且指定了 --no-build。请先运行 pnpm run build。`);
    }
    console.log('[perf] 未找到生产构建产物，先执行 pnpm run build …');
    await run('pnpm', ['run', 'build'], 'pnpm run build');
  } else if (options.build) {
    console.log('[perf] 复用已存在的 dist/（如需重新构建请先手动运行 pnpm run build）');
  }

  const stopPreview = startPreview(options.port);
  let browser = null;

  try {
    await waitForServer(baseUrl, 60_000);

    const launchArgs = [
      '--enable-unsafe-swiftshader',
      '--disable-infobars',
      // 让 performance.memory 返回精确值而不是量化后的桶。
      '--enable-precise-memory-info',
    ];
    browser = await chromium.launch({
      headless: !options.headed,
      args: launchArgs,
      ...(options.channel === null ? {} : { channel: options.channel }),
    });

    const results = [];
    for (const viewport of sizes) {
      console.log(
        `\n[perf] 测量 ${viewport.width}x${viewport.height}，预热 ${options.warmupMs} ms + 采样 ${options.duration} s`,
      );
      const result = await measure(browser, baseUrl, viewport, options, bootTimeoutMs);
      printResult(result);
      results.push(result);
    }

    const software = results.every((result) => result.backendClass === 'software');
    const perSize = Object.fromEntries(
      results.map((result) => [
        result.viewport,
        {
          fps: result.frames.fpsFromMean ?? null,
          frameTimeMs: result.frames.meanMs ?? null,
          p95FrameTimeMs: result.frames.p95Ms ?? null,
          drawCallsPerFrame: result.drawCallsPerFramePeak,
          trianglesOverlay: result.overlay.triangles,
          jsHeapUsedBytes: result.heap.usedBytesAfter,
        },
      ]),
    );

    const payload = {
      generatedAt: new Date().toISOString(),
      seed: options.seed,
      gitHead: process.env['GIT_HEAD'] ?? null,
      mode: options.headed ? 'headed' : 'headless',
      channel: options.channel ?? 'bundled-chromium',
      durationSeconds: options.duration,
      backend: results[0]?.backend ?? null,
      backendClass: results[0]?.backendClass ?? 'unknown',
      results,
      summary: perSize,
      caveat: software
        ? 'SwiftShader/软件光栅化结果，仅代表 CPU 光栅化的下限，不能当作真机 GPU 性能；真机数据请用 --headed（macOS 会用真实 GPU）重测。'
        : '硬件 GPU 结果，可代表同档机器的大致水平。',
    };

    console.log('\n══ 结论 ══════════════════════════════════════════════════════');
    console.log(payload.caveat);
    console.log(
      `本次后端：${payload.backend?.renderer ?? 'n/a'}（${payload.backendClass === 'software' ? '软件' : payload.backendClass === 'hardware' ? '硬件' : '未知'}）`,
    );
    for (const result of results) {
      console.log(
        `  ${result.viewport}: ${result.frames.fpsFromMean?.toFixed(1) ?? 'n/a'} FPS / ${result.frames.meanMs?.toFixed(2) ?? 'n/a'} ms（p95 ${result.frames.p95Ms?.toFixed(2) ?? 'n/a'} ms），draw call 峰值/帧 ${result.drawCallsPerFramePeak}，堆 ${toMb(result.heap.usedBytesAfter)}`,
      );
    }

    if (options.json !== null) {
      const target = path.isAbsolute(options.json)
        ? options.json
        : path.join(REPO_ROOT, options.json);
      writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(`[perf] JSON 已写入 ${target}`);
    }
  } finally {
    if (browser !== null) {
      await browser.close();
    }
    stopPreview();
  }
}

process.on('SIGINT', () => {
  process.exit(130);
});

main().catch((error) => {
  console.error(`[perf] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
