// 页面侧：播放器、选中朗读、ChatGPT 朗读替换
(() => {
  if (window.__ttsReaderLoaded) return;
  window.__ttsReaderLoaded = true;

  const HOSTNAME = location.hostname;
  const IS_CHATGPT = /(^|\.)chatgpt\.com$/.test(HOSTNAME) || /(^|\.)chat\.openai\.com$/.test(HOSTNAME);
  const AUTHOR_URL = 'https://github.com/lucas-nous';

  let cfg = null;

  const loadCfg = () =>
    chrome.storage.local.get('cfg').then((r) => {
      cfg = r.cfg || null;
    });
  loadCfg();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cfg) cfg = changes.cfg.newValue;
  });

  function send(payload) {
    try {
      chrome.runtime.sendMessage({ to: 'bg', ...payload }).catch(() => {});
    } catch (e) {}
  }

  // ---------------- 播放器 UI ----------------
  let uiHost = null;
  let barEl = null;
  let labelEl = null;
  let pauseBtn = null;
  let speedBtn = null;
  let unmuteBtn = null;
  let toastEl = null;
  let toastTimer = null;
  let rate = 1;

  function ensureUI() {
    if (uiHost) return;
    uiHost = document.createElement('div');
    uiHost.id = '__tts_reader_host';
    uiHost.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
    const root = uiHost.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '*{box-sizing:border-box}' +
      '.toast{margin-bottom:8px;padding:8px 12px;border-radius:10px;background:#111827;color:#fff;' +
      'font:12px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:360px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.28)}' +
      '.bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:999px;background:#111827;color:#f9fafb;' +
      'font:13px/1.4 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.28)}' +
      '.dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex:0 0 auto;animation:tp 1.2s infinite}' +
      '@keyframes tp{0%,100%{opacity:1}50%{opacity:.3}}' +
      '.bar.synth .dot{background:#f59e0b}' +
      '.label{white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}' +
      'button{all:unset;cursor:pointer;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.14);' +
      'color:#f9fafb;font:12px/1 system-ui,sans-serif}' +
      'button:hover{background:rgba(255,255,255,.28)}' +
      'button.stop{background:#ef4444}' +
      'button.stop:hover{background:#dc2626}' +
      '.by{cursor:pointer;font:10px/1 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'color:rgba(249,250,251,.42);letter-spacing:.03em;padding:0 2px 0 1px;white-space:nowrap;' +
      'user-select:none;transition:color .18s}' +
      '.by:hover{color:rgba(249,250,251,.92)}' +
      '[hidden]{display:none!important}' +
      '</style>' +
      '<div class="toast" hidden></div>' +
      '<div class="bar" hidden>' +
      '<span class="dot"></span><span class="label">准备中</span>' +
      '<button data-act="pause">暂停</button>' +
      '<button data-act="speed">1×</button>' +
      '<button data-act="unmute" hidden>恢复声音</button>' +
      '<button class="stop" data-act="stop">停止</button>' +
      '<span class="by" data-act="author" title="Lucas · GitHub">Lucas</span>' +
      '</div>';

    document.documentElement.appendChild(uiHost);

    barEl = root.querySelector('.bar');
    labelEl = root.querySelector('.label');
    pauseBtn = root.querySelector('[data-act="pause"]');
    speedBtn = root.querySelector('[data-act="speed"]');
    unmuteBtn = root.querySelector('[data-act="unmute"]');
    toastEl = root.querySelector('.toast');

    root.addEventListener('click', (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (!act) return;
      if (act === 'stop') send({ type: 'stop' });
      if (act === 'unmute') {
        send({ type: 'unmute' });
        barEl.hidden = true;
      }
      if (act === 'pause') {
        const willPause = pauseBtn.textContent === '暂停';
        send({ type: willPause ? 'pause' : 'resume' });
        pauseBtn.textContent = willPause ? '继续' : '暂停';
      }
      if (act === 'speed') {
        const steps = [1, 1.25, 1.5, 1.75, 2, 0.75];
        const i = steps.indexOf(rate);
        rate = steps[(i + 1) % steps.length];
        speedBtn.textContent = rate + '×';
        send({ type: 'rate', rate });
      }
      if (act === 'author') {
        send({ type: 'open-url', url: AUTHOR_URL });
      }
    });
  }

  function toast(text, ms) {
    ensureUI();
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, ms || 2800);
  }

  function updateState(s) {
    if (!s || s.phase === 'idle') {
      if (barEl) barEl.hidden = true;
      return;
    }
    ensureUI();
    if (s.phase === 'start') return;
    barEl.hidden = false;

    if (s.phase === 'muted-warning') {
      barEl.classList.remove('synth');
      labelEl.textContent = '网页原声没停干净，已保持静音';
      unmuteBtn.hidden = false;
      pauseBtn.hidden = true;
      speedBtn.hidden = true;
      return;
    }

    unmuteBtn.hidden = true;
    pauseBtn.hidden = false;
    speedBtn.hidden = false;

    barEl.classList.toggle('synth', s.phase === 'synth');
    if (typeof s.paused === 'boolean' && pauseBtn) pauseBtn.textContent = s.paused ? '继续' : '暂停';
    const total = s.total || 0;
    const idx = typeof s.index === 'number' ? s.index + 1 : 0;
    labelEl.textContent =
      (s.phase === 'synth' ? '合成中 ' : '播放中 ') + (total ? idx + '/' + total : '');
  }

  // ---------------- 选中文本朗读 ----------------
  let selHost = null;
  let selBtn = null;

  function ensureSelUI() {
    if (selHost) return;
    selHost = document.createElement('div');
    selHost.id = '__tts_reader_sel';
    selHost.style.cssText =
      'position:fixed;z-index:2147483647;display:none;left:0;top:0;';
    const root = selHost.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      'button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:6px 11px;' +
      'border-radius:999px;background:#111827;color:#fff;font:12px/1 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.26)}' +
      'button:hover{background:#1f2937}' +
      '</style>' +
      '<button type="button">朗读</button>';
    document.documentElement.appendChild(selHost);
    selBtn = root.querySelector('button');

    selBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    selBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sel = currentSelection();
      hideSelBtn();
      if (!sel) return;
      send({ type: 'play', text: sel.text, source: 'selection' });
    });
  }

  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { text, range: sel.getRangeAt(0) };
  }

  function showSelBtn(rect) {
    ensureSelUI();
    const w = 64;
    const h = 30;
    const x = Math.min(window.innerWidth - w - 8, Math.max(8, rect.right + 6));
    const y = Math.min(window.innerHeight - h - 8, Math.max(8, rect.bottom + 8));
    selHost.style.left = x + 'px';
    selHost.style.top = y + 'px';
    selHost.style.display = 'block';
  }

  function hideSelBtn() {
    if (selHost) selHost.style.display = 'none';
  }

  document.addEventListener(
    'mouseup',
    (e) => {
      if (!cfg || cfg.enableSelection === false) return;
      const t = e.target;
      if (t && t.closest && (t.closest('#__tts_reader_host') || t.closest('#__tts_reader_sel'))) return;
      setTimeout(() => {
        const sel = currentSelection();
        if (!sel) {
          hideSelBtn();
          return;
        }
        const rect = sel.range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) return;
        showSelBtn(rect);
      }, 10);
    },
    true
  );

  document.addEventListener(
    'mousedown',
    (e) => {
      const t = e.target;
      if (t && t.closest && (t.closest('#__tts_reader_sel') || t.closest('#__tts_reader_host'))) return;
      hideSelBtn();
    },
    true
  );

  window.addEventListener('scroll', hideSelBtn, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideSelBtn();
  }, true);

  // ---------------- ChatGPT 朗读拦截 ----------------
  let lastReadBtn = null;
  let lastReadLabel = '';

  const READ_ALOUD_RE =
    /(read\s*aloud|read\s*out\s*loud|readaloud|朗读|朗讀|播报|speak|listen|voice[-_]?play|tts)/i;

  function findReadAloudButton(node) {
    const el =
      node && node.closest
        ? node.closest('button,[role="button"],[role="menuitem"],a')
        : null;
    if (!el) return null;
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.dataset ? el.dataset.testid : '',
      el.textContent
    ]
      .filter(Boolean)
      .join(' ');
    return READ_ALOUD_RE.test(label) ? el : null;
  }

  const PROSE_SEL = 'p,pre,ul,ol,blockquote,h1,h2,h3,h4,h5,h6,table,dl,figure';
  let lastRootHow = '';
  let lastRootEl = null;

  function textLen(el) {
    if (!el) return 0;
    const t = el.innerText || el.textContent || '';
    return t.replace(/\s+/g, '').length;
  }

  function hasProse(el) {
    try {
      return !!(el && el.querySelector && el.querySelector(PROSE_SEL));
    } catch (e) {
      return false;
    }
  }

  // 从一个正文块往上爬，取“最贴近这一条消息”的容器：底部不能越过按钮下方太多
  function climbToMessage(start, btnTop) {
    let node = start;
    let best = null;
    let guard = 0;
    while (node && node !== document.body && node !== document.documentElement && guard < 18) {
      guard++;
      if (btnTop != null) {
        const r = node.getBoundingClientRect();
        if (r.height > 0 && r.bottom > btnTop + 240) break;
        if (r.height > window.innerHeight * 2) break;
      }
      if (hasProse(node) && textLen(node) >= 12) best = node;
      node = node.parentElement;
    }
    return best;
  }

  // 四路兜底：页面标记 → 向上找 → 坐标打点 → 全页最近正文块
  function messageRootFor(btn) {
    lastRootHow = '';
    lastRootEl = null;

    const marker = btn.closest(
      '[data-message-author-role],[data-testid^="conversation-turn"],article'
    );
    if (marker && hasProse(marker) && textLen(marker) >= 12) {
      lastRootHow = '标记';
      lastRootEl = marker;
      return marker;
    }

    const b = btn.getBoundingClientRect();

    let node = btn.parentElement;
    let guard = 0;
    while (node && node !== document.body && node !== document.documentElement && guard < 16) {
      guard++;
      if (hasProse(node) && textLen(node) >= 24) {
        const cand = climbToMessage(node, b.top) || node;
        lastRootHow = '向上' + guard;
        lastRootEl = cand;
        return cand;
      }
      node = node.parentElement;
    }

    const xs = [b.left + Math.min(24, Math.max(8, b.width / 2)), b.left + 120, window.innerWidth / 2];
    for (const dy of [10, 26, 64, 140, 280, 460]) {
      const y = b.top - dy;
      if (y < 2) continue;
      for (const x of xs) {
        if (x < 2 || x > window.innerWidth - 2) continue;
        const stack = document.elementsFromPoint(x, y);
        for (const el of stack) {
          if (el.closest && el.closest('#__tts_reader_host,#__tts_reader_sel')) continue;
          const isProse = (el.matches && el.matches(PROSE_SEL)) || hasProse(el);
          if (!isProse) continue;
          const cand = climbToMessage(el, b.top);
          if (cand) {
            lastRootHow = '坐标' + dy;
            lastRootEl = cand;
            return cand;
          }
        }
      }
    }

    const scope = document.querySelector('main') || document.body;
    let best = null;
    let bestGap = Infinity;
    for (const el of scope.querySelectorAll(PROSE_SEL)) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.top > b.top) continue;
      const gap = b.top - r.bottom;
      if (gap < -6 || gap > 1200) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = el;
      }
    }
    if (best) {
      const cand = climbToMessage(best, b.top) || best;
      lastRootHow = '最近块';
      lastRootEl = cand;
      return cand;
    }

    return null;
  }

  const SKIP_SELECTOR =
    'pre,code,table,thead,tbody,tr,td,th,svg,script,style,noscript,canvas,button,' +
    '.sr-only,details,summary,[data-testid*="reasoning"],' +
    '[aria-hidden="true"],.katex,mjx-container,[contenteditable="true"]';

  function collectText(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        const t = node.nodeValue;
        if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n.nodeValue);
    return out.join(' ');
  }

  function normalizeText(s) {
    return String(s || '')
      .replace(/\u200b/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  function extractMessageText(btn) {
    const root = messageRootFor(btn);
    if (!root) return '';
    const prose =
      root.querySelector('.markdown,.prose,[class*="markdown"],[data-testid*="markdown"]') || root;
    let text = normalizeText(collectText(prose));
    if (text.length < 12 && prose !== root) text = normalizeText(collectText(root));
    return text;
  }

  function classBrief(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    return cls.replace(/\s+/g, '.').slice(0, 46);
  }

  function ancestorChain(el, max) {
    const out = [];
    let n = el;
    let i = 0;
    while (n && n !== document.documentElement && i < (max || 12)) {
      out.push(
        n.tagName.toLowerCase() +
          (n.id ? '#' + n.id : '') +
          (classBrief(n) ? '.' + classBrief(n) : '') +
          '（' + textLen(n) + '字' +
          (hasProse(n) ? '·有正文' : '') +
          (n.dataset && n.dataset.testid ? '·tid=' + n.dataset.testid : '') +
          (n.dataset && n.dataset.messageAuthorRole ? '·role=' + n.dataset.messageAuthorRole : '') +
          '）'
      );
      n = n.parentElement;
      i++;
    }
    return out;
  }

  function recordDiag(btn, text, root) {
    try {
      const main = document.querySelector('main');
      const pageProbe = [
        'main：' + (main ? '有' : '无'),
        '带角色标记的消息：' + document.querySelectorAll('[data-message-author-role]').length,
        'article：' + document.querySelectorAll('article').length,
        '正文块总数：' + (main || document.body).querySelectorAll(PROSE_SEL).length,
        'main 直接子层：' +
          (main
            ? [...main.children]
                .slice(0, 6)
                .map((k) => k.tagName.toLowerCase() + '.' + classBrief(k) + '（' + textLen(k) + '字）')
                .join(' / ')
            : '（无）')
      ].join('\n');

      chrome.storage.local.set({
        diag: {
          ts: Date.now(),
          host: location.hostname,
          ariaLabel: btn.getAttribute('aria-label') || '',
          testid: (btn.dataset && btn.dataset.testid) || '',
          className: String(btn.className || '').slice(0, 120),
          insideMessage: !!btn.closest('[data-message-author-role]'),
          insideArticle: !!btn.closest('article'),
          rootHow: lastRootHow || '（没找到）',
          rootInfo: root ? root.tagName.toLowerCase() + '.' + classBrief(root) + '（' + textLen(root) + '字）' : '',
          chain: ancestorChain(btn, 10),
          pageProbe,
          chars: text.length,
          preview: text.slice(0, 140)
        }
      });
    } catch (e) {}
  }

  function isStopState(btn) {
    const s = [
      btn.getAttribute('aria-label'),
      btn.getAttribute('title'),
      btn.dataset ? btn.dataset.testid : '',
      btn.getAttribute('aria-pressed')
    ]
      .filter(Boolean)
      .join(' ');
    return /(stop|停止|暂停|pause|true)/i.test(s);
  }

  function labelOf(btn) {
    return [
      btn.getAttribute('aria-label'),
      btn.getAttribute('title'),
      btn.getAttribute('aria-pressed')
    ]
      .filter(Boolean)
      .join(' ');
  }

  // 点过一次之后按钮文案通常会变（Read aloud → Stop），据此判断它是不是还在播
  function seemsPlaying(btn) {
    if (!btn) return false;
    if (isStopState(btn)) return true;
    if (lastReadLabel && labelOf(btn) !== lastReadLabel) return true;
    return false;
  }

  function anyMediaPlaying() {
    return [...document.querySelectorAll('audio,video')].some((m) => {
      try {
        return !m.paused && !m.ended;
      } catch (e) {
        return false;
      }
    });
  }

  function pauseAllMedia() {
    document.querySelectorAll('audio,video').forEach((m) => {
      try {
        if (!m.paused) m.pause();
        m.muted = true;
      } catch (e) {}
    });
  }

  async function stopPageAudio() {
    for (let i = 0; i < 3; i++) {
      pauseAllMedia();
      if (i === 0 && lastReadBtn) {
        try {
          if (seemsPlaying(lastReadBtn)) lastReadBtn.click();
        } catch (e) {}
      }
      await new Promise((r) => setTimeout(r, 260));
      if (!anyMediaPlaying()) return true;
    }
    return !anyMediaPlaying();
  }

  function recordClick(el, matched) {
    try {
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      const testid = (el.dataset && el.dataset.testid) || '';
      const inMsg = !!(el.closest && el.closest('[data-message-author-role]'));
      if (!inMsg && !/action-button|voice|speak|read/i.test(testid)) return;
      chrome.storage.local.get('clickLog').then((r) => {
        const log = Array.isArray(r.clickLog) ? r.clickLog : [];
        log.push({ t: Date.now(), tag: el.tagName.toLowerCase(), label, testid, inMsg, matched });
        chrome.storage.local.set({ clickLog: log.slice(-10) });
      });
    } catch (e) {}
  }

  if (IS_CHATGPT) {
    document.addEventListener(
      'click',
      (e) => {
        if (!cfg || cfg.enableChatGPT === false) return;
        const btn = findReadAloudButton(e.target);
        if (!btn) {
          const any =
            e.target && e.target.closest
              ? e.target.closest('button,[role="button"],[role="menuitem"]')
              : null;
          if (any) recordClick(any, false);
          return;
        }
        // 不拦默认行为：让 ChatGPT 正常发起朗读，标签页已被静音，声音由我们接管
        recordClick(btn, true);
        const text = extractMessageText(btn);
        recordDiag(btn, text, lastRootEl);
        if (!text) {
          toast('没抓到正文，去设置页复制诊断给我');
          return;
        }
        lastReadBtn = btn;
        lastReadLabel = labelOf(btn);
        send({ type: 'play', text, source: 'chatgpt' });
      },
      true
    );
  }

  // ---------------- 消息 ----------------
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.to !== 'content') return;

    if (msg.type === 'state') {
      updateState(msg);
      return;
    }

    if (msg.type === 'toast') {
      toast(msg.text);
      return;
    }

    if (msg.type === 'play-selection') {
      send({ type: 'play', text: msg.text, source: 'selection' });
      return;
    }

    if (msg.type === 'session-end') {
      stopPageAudio().then((stopped) => reply({ ok: true, stopped: !!stopped }));
      return true;
    }

    if (msg.type === 'silence-again') {
      pauseAllMedia();
      if (lastReadBtn && seemsPlaying(lastReadBtn)) {
        try {
          lastReadBtn.click();
        } catch (e) {}
      }
      reply({ ok: true });
      return;
    }
  });
})();
