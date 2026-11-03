import assert from 'node:assert/strict';
import test from 'node:test';
import '../../extension/shared.js';

const { normalizeSettings, siteForUrl, supportsUrl, isDrag } = globalThis.AutoCopy;

test('selection unlocking is opt-in and settings reject malformed stored values', () => {
  assert.deepEqual(normalizeSettings(), { autoCopy: true, showToast: true, unlockedSites: [] });
  assert.deepEqual(normalizeSettings({ autoCopy: 'false', showToast: 0, unlockedSites: 'all' }), {
    autoCopy: true, showToast: true, unlockedSites: [],
  });
  assert.deepEqual(normalizeSettings({ autoCopy: false, showToast: false, unlockedSites: [' Example.COM. ', 'example.com', '', null, 4] }), {
    autoCopy: false, showToast: false, unlockedSites: ['example.com'],
  });
});

test('site settings use exact hostnames across protocols and ports', () => {
  assert.equal(siteForUrl('https://EXAMPLE.com.:8443/path'), 'example.com');
  assert.equal(siteForUrl('http://example.com/other'), 'example.com');
  assert.equal(siteForUrl('https://sub.example.com'), 'sub.example.com');
  for (const url of ['not a url', 'chrome://extensions', 'file:///test.html', 'about:blank', 'javascript:alert(1)']) {
    assert.equal(siteForUrl(url), '');
    assert.equal(supportsUrl(url), false);
  }
  assert.equal(supportsUrl('https://chromewebstore.google.com/detail/test'), false);
  assert.equal(supportsUrl('https://chrome.google.com/webstore/detail/test'), false);
  assert.equal(supportsUrl('https://example.com'), true);
});

test('only a completed left-button drag qualifies for automatic copying', () => {
  const start = { x: 10, y: 10, moved: false };
  assert.equal(isDrag(null, { button: 0, clientX: 100, clientY: 10 }), false);
  assert.equal(isDrag(start, { button: 0, clientX: 11, clientY: 10 }), false);
  assert.equal(isDrag(start, { button: 2, clientX: 100, clientY: 10 }), false);
  assert.equal(isDrag(start, { button: 0, clientX: 100, clientY: 10 }), true);
  assert.equal(isDrag({ ...start, moved: true }, { button: 0, clientX: 10, clientY: 10 }), true);
});
