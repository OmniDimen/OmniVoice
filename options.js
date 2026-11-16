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

const FIELDS = [
  'baseUrl',
  'apiKey',
  'model',
  'voice',
  'format',
  'speed',
  'textLang',
  'promptLang',
  'emotion',
  'extraParams',
  'maxChars'
];

const CHECKS = ['useOtherParams', 'keyInBody', 'enableChatGPT', 'enableSelection'];

const $ = (id) => document.getElementById(id);

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (cls ? ' ' + cls : '');
}

async function load() {
  const { cfg } = await chrome.storage.local.get('cfg');
  const c = { ...DEFAULTS, ...(cfg || {}) };
  for (const k of FIELDS) {
    const el = $(k);
    if (el) el.value = c[k] ?? '';
  }
  for (const k of CHECKS) {
    const el = $(k);
    if (el) el.checked = c[k] !== false;
  }
  $('enableChatGPT').checked = c.enableChatGPT !== false;
  $('enableSelection').checked = c.enableSelection !== false;
  $('useOtherParams').checked = c.useOtherParams !== false;
  $('keyInBody').checked = c.keyInBody !== false;
}

function readForm() {
  const cfg = {};
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'number') cfg[k] = Number(el.value) || (k === 'maxChars' ? 120 : 1);
    else cfg[k] = el.value.trim();
  }
  for (const k of CHECKS) cfg[k] = $(k).checked;
  if (cfg.extraParams) {
    try {
      JSON.parse(cfg.extraParams);
    } catch (e) {
      throw new Error('附加参数不是合法 JSON');
    }
  }
  return cfg;
}

async function save(silent) {
  let cfg;
  try {
    cfg = readForm();
  } catch (e) {
    setStatus(e.message, 'err');
    return false;
  }
  await chrome.storage.local.set({ cfg });
  if (!silent) setStatus('已保存', 'ok');
  return true;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(true), 400);
}

function renderDiag() {
  chrome.storage.local.get(['diag', 'lastError', 'clickLog']).then((r) => {
    const parts = [];
    if (r.lastError) {
      parts.push('最近一次错误（' + new Date(r.lastError.ts).toLocaleString() + '）：\n' + r.lastError.message);
    }
    if (r.diag) {
      const d = r.diag;
      const lines = [
        '最近一次朗读点击（' + new Date(d.ts).toLocaleString() + '）：',
        '站点：' + d.host,
        '按钮 aria-label：' + (d.ariaLabel || '（空）'),
        '按钮 testid：' + (d.testid || '（空）'),
        '按钮 class：' + (d.className || '（空）'),
        '在消息容器内：' + (d.insideMessage ? '是' : '否') + ' / article：' + (d.insideArticle ? '是' : '否'),
        '正文定位方式：' + (d.rootHow || '（没找到）'),
        '定位到的容器：' + (d.rootInfo || '（无）'),
        '抓到字数：' + d.chars,
        '开头：' + (d.preview || '（空）')
      ];
      if (Array.isArray(d.chain) && d.chain.length) {
        lines.push('按钮祖先链（由内向外）：');
        d.chain.forEach((c, i) => lines.push('  ' + (i + 1) + '. ' + c));
      }
      if (d.pageProbe) lines.push('页面结构：\n' + d.pageProbe);
      parts.push(lines.join('\n'));
    }
    if (Array.isArray(r.clickLog) && r.clickLog.length) {
      const lines = r.clickLog
        .slice(-6)
        .map((c) => {
          const time = new Date(c.t).toLocaleTimeString();
          return (
            time +
            '  ' + (c.matched ? '✔ 命中' : '　未命中') +
            '  <' + c.tag + '>' +
            '  label=' + (c.label || '（空）') +
            '  testid=' + (c.testid || '（空）')
          );
        });
      parts.push('最近的按钮点击：\n' + lines.join('\n'));
    }
    $('diag').textContent = parts.length ? parts.join('\n\n') : '（还没有记录）';
  });
}

async function test() {
  if (!(await save(true))) return;
  setStatus('正在请求接口…');
  try {
    const res = await chrome.runtime.sendMessage({
      to: 'bg',
      type: 'play',
      text: '你好，这是 OmniVoice 的试听，音色和语速都可以在设置里调整。',
      source: 'test'
    });
    if (res && res.ok === false) {
      setStatus('失败：' + (res.error || '未知错误'), 'err');
      return;
    }
    setStatus('已发出请求，听一下', 'ok');
    setTimeout(renderDiag, 1500);
  } catch (e) {
    setStatus('失败：' + (e.message || e), 'err');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await load();

  FIELDS.forEach((k) => {
    const el = $(k);
    if (!el) return;
    el.addEventListener('input', scheduleSave);
    el.addEventListener('change', scheduleSave);
  });
  CHECKS.forEach((k) => {
    const el = $(k);
    if (!el) return;
    el.addEventListener('change', scheduleSave);
  });

  $('save').addEventListener('click', () => save(false));
  $('test').addEventListener('click', test);
  $('refreshDiag').addEventListener('click', renderDiag);
  $('copyDiag').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('diag').textContent || '');
      setStatus('诊断信息已复制', 'ok');
    } catch (e) {
      setStatus('复制失败', 'err');
    }
  });

  renderDiag();
  setInterval(renderDiag, 4000);
});
