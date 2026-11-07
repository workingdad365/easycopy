'use strict';

const { defaults, normalizeSettings, siteForUrl, supportsUrl } = globalThis.AutoCopy;
const autoCopy = document.getElementById('auto-copy');
const copyInEditable = document.getElementById('copy-in-editable');
const unlock = document.getElementById('unlock');
const showToast = document.getElementById('show-toast');
const status = document.getElementById('status');
const badge = document.getElementById('site-state');
let site = '';
let supported = false;
let settings = normalizeSettings();

function render() {
  autoCopy.checked = settings.autoCopy;
  copyInEditable.checked = settings.copyInEditable;
  showToast.checked = settings.showToast;
  unlock.checked = supported && settings.unlockedSites.includes(site);
  badge.textContent = unlock.checked ? '해제 중' : '기본';
  badge.classList.toggle('enabled', unlock.checked);
}

function report(message, error = false) {
  status.textContent = message;
  status.parentElement.classList.toggle('error', error);
}

async function save(event) {
  const control = event.target;
  const checked = control.checked;
  control.disabled = true;
  try {
    const latest = normalizeSettings(await chrome.storage.local.get(defaults));
    let change;
    if (control === unlock) {
      const sites = new Set(latest.unlockedSites);
      if (checked) sites.add(site);
      else sites.delete(site);
      change = { unlockedSites: [...sites] };
    } else {
      const key = control === autoCopy ? 'autoCopy' : control === copyInEditable ? 'copyInEditable' : 'showToast';
      change = { [key]: checked };
    }
    await chrome.storage.local.set(change);
    settings = normalizeSettings({ ...latest, ...change });
    render();
    report('저장했습니다. 열린 페이지에도 바로 적용됩니다.');
  } catch {
    render();
    report('저장하지 못했습니다. 팝업을 다시 열어 주세요.', true);
  } finally {
    control.disabled = control === unlock && !supported;
  }
}

async function initialize() {
  try {
    document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
    const [raw, tabs] = await Promise.all([
      chrome.storage.local.get(defaults),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    const url = tabs[0]?.url || '';
    site = siteForUrl(url);
    supported = supportsUrl(url);
    settings = normalizeSettings(raw);
    document.getElementById('site-name').textContent = site || '일반 웹페이지에서 사용하세요';
    if (!supported) {
      document.getElementById('site-note').textContent = '이 페이지는 크롬에서 확장 프로그램 실행을 허용하지 않습니다.';
    }
    render();
    autoCopy.disabled = false;
    copyInEditable.disabled = false;
    showToast.disabled = false;
    unlock.disabled = !supported;
    report('설정은 이 브라우저에 저장됩니다.');
    for (const control of [autoCopy, copyInEditable, unlock, showToast]) control.addEventListener('change', save);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const raw = { ...settings };
      for (const key of Object.keys(defaults)) if (key in changes) raw[key] = changes[key].newValue;
      settings = normalizeSettings(raw);
      render();
    });
  } catch {
    report('설정을 불러오지 못했습니다. 팝업을 다시 열어 주세요.', true);
  }
}

initialize();
