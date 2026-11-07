(() => {
  'use strict';

  const defaults = Object.freeze({
    autoCopy: true, copyOnMultiClick: true, trimMultiClick: true, copyInEditable: false, showToast: true, unlockedSites: [],
  });

  function normalizeSettings(raw = {}) {
    return {
      autoCopy: typeof raw.autoCopy === 'boolean' ? raw.autoCopy : defaults.autoCopy,
      copyOnMultiClick: typeof raw.copyOnMultiClick === 'boolean' ? raw.copyOnMultiClick : defaults.copyOnMultiClick,
      trimMultiClick: typeof raw.trimMultiClick === 'boolean' ? raw.trimMultiClick : defaults.trimMultiClick,
      copyInEditable: typeof raw.copyInEditable === 'boolean' ? raw.copyInEditable : defaults.copyInEditable,
      showToast: typeof raw.showToast === 'boolean' ? raw.showToast : defaults.showToast,
      unlockedSites: Array.isArray(raw.unlockedSites)
        ? [...new Set(raw.unlockedSites
          .filter((site) => typeof site === 'string')
          .map((site) => site.trim().toLowerCase().replace(/\.+$/, ''))
          .filter(Boolean))]
        : [],
    };
  }

  function siteForUrl(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return url.hostname.toLowerCase().replace(/\.+$/, '');
    } catch {
      return '';
    }
  }

  function supportsUrl(value) {
    const site = siteForUrl(value);
    if (!site || site === 'chromewebstore.google.com') return false;
    return !(site === 'chrome.google.com' && new URL(value).pathname.startsWith('/webstore'));
  }

  function isDrag(start, end) {
    return Boolean(start && end.button === 0
      && (start.moved || Math.hypot(end.clientX - start.x, end.clientY - start.y) >= 3));
  }

  // 더블클릭(단어) / 트리플클릭(문단) 선택은 마우스 이동 없이 이루어짐.
  function isMultiClick(start, end) {
    return Boolean(start && end.button === 0 && end.detail >= 2);
  }

  globalThis.AutoCopy = Object.freeze({ defaults, normalizeSettings, siteForUrl, supportsUrl, isDrag, isMultiClick });
})();
