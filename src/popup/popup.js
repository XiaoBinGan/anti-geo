import { getSettings, saveSettings } from '../lib/config.js';

const $ = (s) => document.querySelector(s);

const LEVEL_TEXT = { green: '低风险', yellow: '存疑', red: '高风险' };
const LEVEL_COLOR = { green: '#16a34a', yellow: '#d97706', red: '#dc2626' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function init() {
  const s = await getSettings();
  $('#en').checked = s.enabled !== false;

  $('#en').addEventListener('change', async (e) => {
    await saveSettings({ enabled: e.target.checked });
  });

  $('#opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('#rescan').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await chrome.tabs.reload(tab.id);
      window.close();
    } catch {}
  });

  await renderState();
}

async function renderState() {
  const el = $('#state');
  const hint = $('#hint');

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}

  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    el.innerHTML = '<div class="empty">当前不是网页</div>';
    return;
  }

  let resp = null;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: 'AG_GET_LAST' });
  } catch {
    // content script 没注入（不在支持的平台）
  }

  if (!resp) {
    el.innerHTML = `<div class="empty">当前页面不在支持列表内</div>`;
    hint.textContent = '支持 ChatGPT / Perplexity / Google AI 概览 / Bing Copilot / 豆包 / Kimi / 元宝 / 秘塔 / DeepSeek。可在设置里添加自定义站点。';
    return;
  }

  hint.textContent = '';

  const r = resp.result;
  if (!r) {
    el.innerHTML = `<div class="empty">本页尚未检测到 AI 答案中的外部引用<br/><span style="font-size:11px">生成带引用的回答后会自动出现</span></div>`;
    el.insertAdjacentHTML('afterbegin', `<div class="platform">${esc(resp.platform)}</div>`);
    return;
  }

  const s = r.summary;
  const deepNote = r.deep
    ? `已深度核查 ${r.deepChecked} 页`
    : '域名级快速判断（页面还在生成或已关闭深度核查）';

  el.innerHTML = `
    <div class="now">
      <span class="pill" style="background:${LEVEL_COLOR[s.level.key] || '#9ca3af'}">${LEVEL_TEXT[s.level.key] || ''} ${s.pollution}</span>
      <span class="platform">${esc(resp.platform)}</span>
    </div>
    <div class="stats">
      <div class="stat"><b>${s.total}</b><span>引用</span></div>
      <div class="stat"><b style="color:${s.flagged ? '#dc2626' : '#16a34a'}">${s.flagged}</b><span>可疑</span></div>
      <div class="stat"><b>${s.distinctDomains}</b><span>独立站点</span></div>
    </div>
    <ul class="concl">${s.conclusions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    <div style="margin-top:10px;color:#9ca3af;font-size:11px;text-align:center">${esc(deepNote)}</div>
  `;
}

init();
