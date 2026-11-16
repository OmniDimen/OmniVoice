// 离屏文档：负责切句、请求 TTS、顺序播放
const audio = document.getElementById('audio');

let st = null;        // 当前会话
let playRate = 1;     // 播放倍速（播放器上的按钮）

const post = (msg) => {
  chrome.runtime.sendMessage({ to: 'bg', ...msg }).catch(() => {});
};

function safeJson(text) {
  if (!text || !String(text).trim()) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

// 把长文本切成适合单次合成的段落
function splitText(raw, max) {
  const limit = Math.max(40, Number(max) || 120);
  let t = String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ')
    .replace(/^[ \t]*[-=]{3,}[ \t]*$/gm, ' ')
    .replace(/^[ \t]*[-*+]\s+/gm, '')
    .replace(/^[ \t]*#{1,6}\s+/gm, '')
    .replace(/^[ \t]*>\s?/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n');

  const segs = t
    .split(/(?<=[。！？!?；;…])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  let buf = '';

  const hardSplit = (s) => {
    let rest = s;
    while (rest.length > limit) {
      let cut = Math.max(
        rest.lastIndexOf('，', limit),
        rest.lastIndexOf(',', limit),
        rest.lastIndexOf('、', limit),
        rest.lastIndexOf('：', limit),
        rest.lastIndexOf(' ', limit)
      );
      if (cut < limit * 0.5) cut = limit;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    return rest;
  };

  for (const s of segs) {
    if (buf && buf.length + s.length > limit) {
      out.push(buf.trim());
      buf = '';
    }
    if (s.length > limit) {
      buf = hardSplit(buf ? buf + ' ' + s : s);
      if (buf) out.push(buf.trim());
      buf = '';
    } else {
      buf += (buf ? ' ' : '') + s;
    }
  }
  if (buf.trim()) out.push(buf.trim());

  return out.filter((s) => s.length > 0);
}

function buildBody(text, cfg) {
  const body = {
    model: cfg.model || '',
    input: text,
    voice: cfg.voice || '',
    response_format: cfg.format || 'mp3',
    speed: Number(cfg.speed) || 1
  };

  const extra = safeJson(cfg.extraParams);

  if (cfg.useOtherParams !== false) {
    const op = {
      app_key: cfg.keyInBody !== false ? cfg.apiKey || '' : '',
      text_lang: cfg.textLang || '中英混合',
      prompt_lang: cfg.promptLang || '中文',
      emotion: cfg.emotion || '默认'
    };
    if (extra) Object.assign(op, extra);
    body.other_params = op;
  } else if (extra) {
    Object.assign(body, extra);
  }

  return body;
}

async function synth(text, cfg) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

  let res;
  try {
    res = await fetch(cfg.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(text, cfg))
    });
  } catch (e) {
    throw new Error('连不上接口（服务没起？' + (e.message || '') + '）');
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (e) {}
    throw new Error('接口返回 ' + res.status + (detail ? '：' + detail : ''));
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('json')) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (e) {}
    throw new Error('接口返回的是 JSON 不是音频：' + detail);
  }

  return await res.blob();
}

function getBlob(i) {
  if (!st) return Promise.reject(new Error('会话已结束'));
  if (st.cache.has(i)) return st.cache.get(i);
  const p = synth(st.chunks[i], st.cfg);
  st.cache.set(i, p);
  p.catch(() => st && st.cache.delete(i));
  return p;
}

function prefetch(i) {
  if (!st || i >= st.chunks.length) return;
  getBlob(i).catch(() => {});
}

function revokeCurrent() {
  if (st && st.currentUrl) {
    try {
      URL.revokeObjectURL(st.currentUrl);
    } catch (e) {}
    st.currentUrl = null;
  }
}

function fail(err) {
  const message = String(err?.message || err || '未知错误');
  if (st) st.playing = false;
  post({ type: 'phase', phase: 'error', message });
}

function finish() {
  if (st) st.playing = false;
  revokeCurrent();
  if (st) {
    st.id = null;
    st.chunks = [];
    st.cache.clear();
  }
  post({ type: 'phase', phase: 'done' });
}

async function playFrom(i) {
  const cur = st;
  if (!cur || !cur.id) return;
  if (i >= cur.chunks.length) return finish();

  cur.idx = i;
  post({ type: 'phase', phase: 'synth', index: i, total: cur.chunks.length });

  let blob;
  try {
    blob = await getBlob(i);
  } catch (e) {
    if (st === cur) fail(e);
    return;
  }
  if (st !== cur || !cur.id) return;

  revokeCurrent();
  const url = URL.createObjectURL(blob);
  cur.currentUrl = url;
  cur.playing = true;

  audio.src = url;
  audio.playbackRate = playRate;

  try {
    await audio.play();
  } catch (e) {
    if (st === cur) fail(new Error('浏览器拦住了播放：' + (e.message || '')));
    return;
  }

  post({ type: 'phase', phase: 'playing', index: i, total: cur.chunks.length });
  prefetch(i + 1);

  audio.onended = () => {
    if (st !== cur || !cur.id) return;
    playFrom(i + 1);
  };
}

function stopAll() {
  if (st) {
    st.id = null;
    st.chunks = [];
    st.cache.clear();
  }
  audio.onended = null;
  try {
    audio.pause();
  } catch (e) {}
  audio.removeAttribute('src');
  try {
    audio.load();
  } catch (e) {}
  revokeCurrent();
}

async function start(msg) {
  stopAll();
  const chunks = splitText(msg.text, msg.cfg.maxChars);
  st = {
    id: msg.id,
    chunks,
    idx: 0,
    playing: false,
    cfg: msg.cfg,
    cache: new Map(),
    currentUrl: null
  };
  if (!chunks.length) {
    post({ type: 'phase', phase: 'error', message: '没有可朗读的文字' });
    return;
  }
  playFrom(0);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.to !== 'offscreen') return;

  switch (msg.type) {
    case 'status':
      reply({ ok: true, playing: !!(st && st.playing), chunks: st ? st.chunks.length : 0 });
      return;
    case 'play':
      start(msg).then(
        () => reply({ ok: true }),
        (e) => reply({ ok: false, error: String(e?.message || e) })
      );
      return true;
    case 'stop':
      stopAll();
      reply({ ok: true });
      return;
    case 'pause':
      try {
        audio.pause();
      } catch (e) {}
      reply({ ok: true });
      return;
    case 'resume':
      audio.play().catch(() => {});
      reply({ ok: true });
      return;
    case 'rate':
      playRate = Number(msg.rate) || 1;
      audio.playbackRate = playRate;
      reply({ ok: true });
      return;
  }
});
