import './shared.js';

const OFFSCREEN_URL = new URL('./offscreen.html', import.meta.url).href;

const UNLOCK_CSS = `
  * {
    -webkit-user-select: text !important;
    user-select: text !important;
    -webkit-touch-callout: default !important;
  }
`;

let creatingOffscreen = null;
let clipboardQueue = Promise.resolve();

async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [OFFSCREEN_URL],
    });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['CLIPBOARD'],
      justification: '선택한 텍스트를 HTTP 페이지와 제한된 프레임에서도 클립보드에 복사함.',
    });
  })();
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

function writeClipboard(text) {
  const task = clipboardQueue.catch(() => {}).then(async () => {
    await ensureOffscreen();
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
    if (!result?.ok) throw new Error('Clipboard write failed');
    return { ok: true };
  });
  clipboardQueue = task;
  return task;
}

async function updateUnlockCss(enabled, sender) {
  const target = { tabId: sender.tab.id, documentIds: [sender.documentId] };
  const injection = { target, css: UNLOCK_CSS, origin: 'USER' };
  if (enabled) await chrome.scripting.insertCSS(injection);
  else await chrome.scripting.removeCSS(injection);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === 'offscreen' || sender.id !== chrome.runtime.id || !sender.tab) return false;
  let task;
  if (message?.type === 'copy' && typeof message.text === 'string' && message.text.trim()) {
    task = writeClipboard(message.text);
  } else if (message?.type === 'unlock-css' && typeof message.enabled === 'boolean' && sender.documentId) {
    task = updateUnlockCss(message.enabled, sender);
  } else {
    return false;
  }
  task.then(respond, () => respond({ ok: false }));
  return true;
});
