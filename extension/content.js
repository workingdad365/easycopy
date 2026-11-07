(() => {
  'use strict';

  const { defaults, normalizeSettings, siteForUrl, isDrag } = globalThis.AutoCopy;
  const ancestors = location.ancestorOrigins;
  const site = siteForUrl(ancestors?.length ? ancestors[ancestors.length - 1] : location.href)
    || siteForUrl(globalThis.origin);
  const controlSelector = 'input, textarea, select, option, button, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="slider"], video, audio, canvas';
  const blockedEvents = new Set([
    'selectstart', 'selectionchange', 'select', 'copy', 'contextmenu', 'dragstart',
    'mousedown', 'mousemove', 'mouseup', 'pointerdown', 'pointermove', 'pointerup',
  ]);
  const cleanups = [];
  let settings = normalizeSettings();
  let unlockEnabled = false;
  let cssApplied = false;
  let cssQueue = Promise.resolve();
  let copyQueue = Promise.resolve();
  let drag = null;
  let destroyed = false;
  let toastHost = null;
  let toastTimer = 0;

  function alive() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }

  function listen(target, name, handler) {
    target.addEventListener(name, handler, true);
    cleanups.push(() => target.removeEventListener(name, handler, true));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    drag = null;
    for (const cleanup of cleanups) cleanup();
    clearTimeout(toastTimer);
    toastHost?.remove();
    try { chrome.storage.onChanged.removeListener(onSettingsChanged); } catch {}
  }

  function activeElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  }

  function isEditable(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return !element.readOnly && !element.disabled;
    }
    return Boolean(element?.isContentEditable);
  }

  function readSelection() {
    const element = activeElement();
    const selection = window.getSelection();
    if (!settings.copyInEditable && (document.designMode === 'on'
      || [element, selection?.anchorNode, selection?.focusNode].some(isEditable))) return '';
    if (element instanceof HTMLInputElement) {
      if (element.type === 'password' || /(?:current|new)-password/i.test(element.autocomplete)) return '';
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
        return element.value.slice(element.selectionStart, element.selectionEnd);
      }
    }
    return selection?.toString() || '';
  }

  function isControl(event) {
    if (event.type === 'selectionchange') return Boolean(activeElement()?.closest(controlSelector));
    return event.composedPath().some((node) => node instanceof Element && node.matches(controlSelector));
  }

  function syncCss() {
    cssQueue = cssQueue.catch(() => {}).then(async () => {
      if (destroyed || cssApplied === unlockEnabled) return;
      const enabled = unlockEnabled;
      const response = await chrome.runtime.sendMessage({ type: 'unlock-css', enabled });
      if (response?.ok) cssApplied = enabled;
    }).catch(() => { if (!alive()) destroy(); });
  }

  function applySettings(raw) {
    settings = normalizeSettings(raw);
    unlockEnabled = Boolean(site && settings.unlockedSites.includes(site));
    if (!settings.autoCopy) drag = null;
    if (!settings.showToast) toastHost?.remove();
    syncCss();
  }

  function onSettingsChanged(changes, area) {
    if (area !== 'local' || destroyed) return;
    const raw = { ...settings };
    for (const key of Object.keys(defaults)) {
      if (key in changes) raw[key] = changes[key].newValue;
    }
    applySettings(raw);
  }

  function showToast(message, point, failed = false) {
    if (!settings.showToast || destroyed || !document.documentElement) return;
    clearTimeout(toastTimer);
    toastHost?.remove();
    const host = document.createElement('autocopy-toast');
    host.setAttribute('popover', 'manual');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial !important; position: fixed !important; inset: auto !important;
        left: var(--autocopy-left, 0px) !important; top: var(--autocopy-top, 0px) !important;
        margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important;
        width: max-content !important; height: auto !important; overflow: visible !important;
        z-index: 2147483647 !important; pointer-events: none !important; }
      div { font: 500 12px/1.4 system-ui, sans-serif; color: #fff; background: ${failed ? '#853d2b' : '#172c34'};
        padding: 7px 11px; border-radius: 7px; box-shadow: 0 3px 14px #0002; white-space: nowrap; }
    `;
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.textContent = message;
    shadow.append(style, box);
    document.documentElement.append(host);
    toastHost = host;
    try { host.showPopover(); } catch {}
    const bounds = host.getBoundingClientRect();
    // Shadow DOM의 !important 초기화와 충돌하지 않도록 좌표를 CSS 변수로 전달함.
    host.style.setProperty('--autocopy-left', `${Math.max(8, Math.min(point.x + 12, innerWidth - bounds.width - 8))}px`, 'important');
    host.style.setProperty('--autocopy-top', `${Math.max(8, Math.min(point.y + 16, innerHeight - bounds.height - 8))}px`, 'important');
    toastTimer = setTimeout(() => host.remove(), failed ? 2500 : 1200);
  }

  async function copyText(text, point) {
    if (destroyed || !settings.autoCopy || !alive()) return;
    let copied = false;
    try {
      if (document.hasFocus() && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {}
    if (!copied) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'copy', text });
        copied = Boolean(response?.ok);
      } catch { if (!alive()) destroy(); }
    }
    if (copied) showToast(`${Array.from(text).length.toLocaleString()}자 복사됨`, point);
    else showToast('복사하지 못했습니다. 다시 선택해 주세요.', point, true);
  }

  function onMouse(event) {
    if (!event.isTrusted || destroyed) return;
    if (!alive()) { destroy(); return; }
    if (event.type === 'mousedown') {
      drag = settings.autoCopy && event.button === 0
        ? { x: event.clientX, y: event.clientY, moved: false } : null;
    } else if (event.type === 'mousemove' && drag) {
      if (!(event.buttons & 1)) { drag = null; return; }
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 3) drag.moved = true;
    } else if (event.type === 'mouseup') {
      const completed = drag;
      drag = null;
      if (!settings.autoCopy || !isDrag(completed, event)) return;
      const text = readSelection();
      if (!text.trim()) return;
      const point = { x: event.clientX, y: event.clientY };
      copyQueue = copyQueue.catch(() => {}).then(() => copyText(text, point));
    }
  }

  function unlock(event) {
    if (!unlockEnabled || destroyed) return;
    if (!alive()) { destroy(); return; }
    if (isControl(event)) return;
    if (event.type.endsWith('move') && !(event.buttons & 1)) return;
    if (event.type.startsWith('pointer') && event.pointerType !== 'mouse') return;
    if (event.type === 'mousedown' || event.type === 'mouseup' || event.type === 'pointerdown' || event.type === 'pointerup') {
      if (event.button !== 0) return;
    }
    event.stopImmediatePropagation();
  }

  // 복사 이벤트를 먼저 읽고 페이지의 방지 핸들러를 차단함.
  for (const name of ['mousedown', 'mousemove', 'mouseup']) listen(window, name, onMouse);
  for (const name of blockedEvents) listen(window, name, unlock);
  listen(window, 'blur', (event) => { if (event.target === window) drag = null; });
  listen(window, 'pagehide', () => { drag = null; });
  chrome.storage.onChanged.addListener(onSettingsChanged);
  chrome.storage.local.get(defaults).then(applySettings, () => { if (!alive()) destroy(); });
})();
