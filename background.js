// 后台：负责会话、静音标签页、调度离屏文档
const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1/audio/speech',
  apiKey: '',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  format: 'mp3',
  speed: 1,
  textLang: '中英混合',
  promptLang: '中文',
  emotion: '默认',
  extraParams: '{}',
  useOtherParams: false,
  keyInBody: false,
  maxChars: 120,
  enableChatGPT: true,
  enableSelection: true
};

let session = null;          // { id, tabId, muted, source }
const mutedTabs = new Set(); // 我们自己静音掉的标签页
let creatingOffscreen = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function persistMuted() {
  try {
    await chrome.storage.local.set({ mutedTabIds: [...mutedTabs] });
  } catch (e) {}
}

async function ensureDefaults() {
  const { cfg } = await chrome.storage.local.get('cfg');
  if (!cfg) await chrome.storage.local.set({ cfg: DEFAULTS });
  else {
    const merged = { ...DEFAULTS, ...cfg };
    if (JSON.stringify(merged) !== JSON.stringify(cfg)) await chrome.storage.local.set({ cfg: merged });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'tts-read-selection',
      title: '用 TTS 朗读选中文本',
      contexts: ['selection']
    });
  } catch (e) {}
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults();
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'tts-read-selection') return;
  const text = (info.selectionText || '').trim();
  if (!text) return;
  if (tab?.id != null) {
    try {
      await chrome.tabs.sendMessage(tab.id, { to: 'content', type: 'play-selection', text });
      return;
    } catch (e) {}
  }
  await startPlay({ text, source: 'selection', tabId: tab?.id ?? null });
});

// ---------- 离屏文档 ----------
async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  } catch (e) {}
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: '播放 TTS 合成的语音'
    })
    .catch((e) => {
      if (!String(e?.message || e).includes('Only a single offscreen')) throw e;
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function sendOffscreen(msg) {
  try {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ to: 'offscreen', ...msg });
    if (r !== undefined) return r;
    // 离屏文档刚建好时可能还没挂上监听，补一次
    await sleep(180);
    return await chrome.runtime.sendMessage({ to: 'offscreen', ...msg });
  } catch (e) {
    return null;
  }
}

// ---------- 标签页静音 ----------
async function muteTab(tabId) {
  if (tabId == null) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.mutedInfo && tab.mutedInfo.muted) return false;
    await chrome.tabs.update(tabId, { muted: true });
    mutedTabs.add(tabId);
    await persistMuted();
    return true;
  } catch (e) {
    return false;
  }
}

async function unmuteTab(tabId) {
  if (tabId == null || !mutedTabs.has(tabId)) return;
  mutedTabs.delete(tabId);
  try {
    await chrome.tabs.update(tabId, { muted: false });
  } catch (e) {}
  await persistMuted();
}

async function isTabAudible(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab.audible;
  } catch (e) {
    return false;
  }
}

// 后台被回收又重启时，别把标签页永久留在静音状态
async function bootCleanup() {
  try {
    const { mutedTabIds } = await chrome.storage.local.get('mutedTabIds');
    if (!Array.isArray(mutedTabIds) || !mutedTabIds.length) return;
    mutedTabIds.forEach((id) => mutedTabs.add(id));
    let playing = false;
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
      const r = await chrome.runtime.sendMessage({ to: 'offscreen', type: 'status' });
      playing = !!(r && r.playing);
    }
    if (!playing) {
      for (const id of [...mutedTabs]) await unmuteTab(id);
    }
  } catch (e) {}
}

function relay(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { to: 'content', ...msg }).catch(() => {});
}

// ---------- 会话 ----------
async function startPlay({ text, source, tabId }) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: '文本为空' };

  const { cfg } = await chrome.storage.local.get('cfg');
  if (!cfg || !cfg.baseUrl) {
    relay(tabId, { type: 'toast', text: '还没配置 TTS 接口，点扩展图标打开设置' });
    return { ok: false, error: '未配置接口' };
  }

  if (session) await endSession('restart', { keepMuted: true });

  // 别的标签页还留着我们的静音，先放开
  for (const id of [...mutedTabs]) {
    if (id !== tabId) await unmuteTab(id);
  }

  const wasMuted = tabId != null && mutedTabs.has(tabId);
  if (source !== 'chatgpt' && wasMuted) await unmuteTab(tabId);

  // ChatGPT 场景：先掐静页面，再去准备播放器，别让原声漏出来
  let muted = false;
  if (source === 'chatgpt' && tabId != null) {
    muted = wasMuted || (await muteTab(tabId));
  }

  await ensureOffscreen();

  const id = Math.random().toString(36).slice(2);

  session = { id, tabId, muted, source };
  relay(tabId, { type: 'state', phase: 'synth', index: 0, total: 0 });
  await sendOffscreen({ type: 'play', id, text: clean, cfg });
  return { ok: true };
}

async function endSession(reason, opts = {}) {
  const s = session;
  session = null;

  await sendOffscreen({ type: 'stop' });

  if (s?.tabId != null && !opts.keepMuted) {
    try {
      await chrome.tabs.sendMessage(s.tabId, { to: 'content', type: 'session-end' });
    } catch (e) {}

    // 先确认标签页真的没在发声，再放开静音（audible 有几秒的滞后，要多等几轮）
    let audible = await isTabAudible(s.tabId);
    const waits = [700, 1100, 1500];
    for (let i = 0; i < waits.length && audible; i++) {
      if (i > 0) {
        try {
          await chrome.tabs.sendMessage(s.tabId, { to: 'content', type: 'silence-again' });
        } catch (e) {}
      }
      await sleep(waits[i]);
      audible = await isTabAudible(s.tabId);
    }

    if (audible) {
      relay(s.tabId, { type: 'state', phase: 'muted-warning' });
      return { ok: true, muted: true };
    }

    await unmuteTab(s.tabId);
  }

  if (s?.tabId != null && !opts.keepMuted) {
    relay(s.tabId, { type: 'state', phase: 'idle' });
  }
  return { ok: true };
}

async function onPhase(msg) {
  const s = session;
  if (!s) {
    // 后台被回收过、会话丢了：播放结束时把静音收回来
    if (msg.phase === 'done' || msg.phase === 'error') {
      for (const id of [...mutedTabs]) await unmuteTab(id);
    }
    return { ok: true };
  }

  if (msg.phase === 'done') {
    await endSession('done');
    return { ok: true };
  }
  if (msg.phase === 'error') {
    await chrome.storage.local.set({
      lastError: { message: msg.message || '未知错误', ts: Date.now() }
    });
    relay(s.tabId, { type: 'toast', text: 'TTS 出错：' + (msg.message || '未知错误') });
    await endSession('error');
    return { ok: true };
  }
  relay(s.tabId, {
    type: 'state',
    phase: msg.phase,
    index: msg.index,
    total: msg.total,
    paused: msg.paused
  });
  return { ok: true };
}

// ---------- 消息 ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.to !== 'bg') return;

  const tabId = sender?.tab?.id ?? msg.tabId ?? null;

  (async () => {
    switch (msg.type) {
      case 'play':
        return await startPlay({ text: msg.text, source: msg.source || 'selection', tabId });
      case 'stop':
        return await endSession('user');
      case 'unmute':
        await unmuteTab(tabId);
        relay(tabId, { type: 'state', phase: 'idle' });
        return { ok: true };
      case 'pause':
        await sendOffscreen({ type: 'pause' });
        return { ok: true };
      case 'resume':
        await sendOffscreen({ type: 'resume' });
        return { ok: true };
      case 'rate':
        await sendOffscreen({ type: 'rate', rate: msg.rate });
        return { ok: true };
      case 'phase':
        return await onPhase(msg);
      case 'open-url': {
        const url = String(msg.url || '');
        if (!/^https:\/\/github\.com\/lucas-nous(\/|$)/.test(url)) {
          return { ok: false, error: '地址不在允许范围内' };
        }
        await chrome.tabs.create({ url });
        return { ok: true };
      }
      case 'get-cfg': {
        const { cfg } = await chrome.storage.local.get('cfg');
        return { ok: true, cfg };
      }
      default:
        return { ok: false, error: '未知消息 ' + msg.type };
    }
  })().then(
    (r) => reply(r || { ok: true }),
    (e) => reply({ ok: false, error: String(e?.message || e) })
  );

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mutedTabs.delete(tabId);
  persistMuted();
  if (session && session.tabId === tabId) {
    session = null;
    sendOffscreen({ type: 'stop' });
  }
});

bootCleanup();
