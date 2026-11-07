import { test as base, expect, chromium } from '@playwright/test';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const origin = 'https://autocopy.test';
const fixture = await readFile(new URL('../fixtures/selection.html', import.meta.url), 'utf8');

const test = base.extend({
  extensionContext: [async ({}, use) => {
    const temp = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
    await mkdir(temp, { recursive: true });
    const profile = await mkdtemp(join(temp, 'autocopy-test-'));
    const path = resolve('.');
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1100, height: 900 },
      args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
    });
    await context.route(/^https?:\/\/([a-z]+\.)?autocopy\.test\//, (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: fixture,
    }));
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    try { await use(context); } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5 });
    }
  }, { scope: 'worker' }],
  extensionWorker: [async ({ extensionContext }, use) => {
    const worker = extensionContext.serviceWorkers()[0]
      || await extensionContext.waitForEvent('serviceworker');
    await use(worker);
  }, { scope: 'worker' }],
  app: async ({ extensionContext, extensionWorker }, use) => {
    await extensionWorker.evaluate(() => chrome.storage.local.clear());
    const page = await extensionContext.newPage();
    await page.goto(`${origin}/selection`);
    await page.bringToFront();
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    try { await use(page); } finally {
      for (const openPage of extensionContext.pages()) await openPage.close();
    }
  },
});

async function settings(worker, values) {
  await worker.evaluate((values) => chrome.storage.local.set(values), values);
}

async function clipboard(page) {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

async function textCoordinates(scope, selector) {
  return scope.locator(selector).evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const start = document.createRange();
    start.setStart(nodes[0], 0);
    start.setEnd(nodes[0], 1);
    const end = document.createRange();
    const last = nodes[nodes.length - 1];
    end.setStart(last, last.length - 1);
    end.setEnd(last, last.length);
    const a = start.getBoundingClientRect();
    const b = end.getBoundingClientRect();
    return { x: a.left + 0.2, y: a.top + a.height / 2, endX: b.right - 0.2, endY: b.top + b.height / 2 };
  });
}

async function drag(page, selector, { release = true } = {}) {
  const { x, y, endX, endY } = await textCoordinates(page, selector);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 12 });
  if (release) await page.mouse.up();
}

async function dragInput(page, selector) {
  const control = page.locator(selector);
  await control.scrollIntoViewIfNeeded();
  const rect = await control.boundingBox();
  const y = rect.y + 15;
  await page.mouse.move(rect.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 10, y, { steps: 12 });
  await page.mouse.up();
}

async function userSelect(page, selector = '#text') {
  return page.locator(selector).evaluate((node) => getComputedStyle(node).userSelect);
}

async function openPopup(context, worker, targetPage) {
  const id = new URL(worker.url()).host;
  const popupPath = await worker.evaluate(() => chrome.runtime.getManifest().action.default_popup);
  const popup = await context.newPage();
  await targetPage.bringToFront();
  await popup.goto(`chrome-extension://${id}/${popupPath}`);
  await expect(popup.locator('#auto-copy')).toBeEnabled();
  return popup;
}

test('copies only after releasing the left button and preserves the selection', async ({ app }) => {
  await drag(app, '#text', { release: false });
  expect(await clipboard(app)).toBe('sentinel');
  await app.mouse.up();
  await expect.poll(() => clipboard(app)).toBe('Drag this text into the clipboard.');
  expect(await app.evaluate(() => getSelection().toString())).toBe('Drag this text into the clipboard.');
  await expect(app.locator('autocopy-toast')).toHaveCount(1);
});

test('positions the copy toast next to the mouse release point', async ({ app }, testInfo) => {
  for (const selector of ['#text', '#formatted']) {
    const point = await textCoordinates(app, selector);
    await drag(app, selector);
    const toast = app.locator('autocopy-toast');
    await expect(toast).toBeVisible();
    const bounds = await toast.boundingBox();
    await app.screenshot({ path: testInfo.outputPath(`toast-${selector.slice(1)}.png`) });
    // MouseEvent 좌표가 정수 CSS 픽셀로 변환될 때의 오차를 허용함.
    expect(Math.abs(bounds.x - (point.endX + 12))).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.y - (point.endY + 16))).toBeLessThanOrEqual(1);
  }
});

test('keeps the toast by the pointer on a scrolled page with conflicting styles', async ({ app }) => {
  await app.addStyleTag({ content: `
    body { min-height: 2400px; }
    #text { margin-top: 1200px; }
    html { transform: translate(10px, 10px); }
    autocopy-toast { inset: 0 !important; margin: 40px !important; transform: translate(50px, 50px) !important; }
  ` });
  await app.locator('#text').scrollIntoViewIfNeeded();
  expect(await app.evaluate(() => scrollY)).toBeGreaterThan(0);
  const point = await textCoordinates(app, '#text');
  await drag(app, '#text');
  const toast = app.locator('autocopy-toast');
  await expect(toast).toBeVisible();
  const bounds = await toast.boundingBox();
  expect(Math.abs(bounds.x - (point.endX + 12))).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds.y - (point.endY + 16))).toBeLessThanOrEqual(1);
});

test('keeps the copy toast inside the viewport at its lower-right edge', async ({ app }) => {
  await app.locator('#text').evaluate((node) => {
    node.style.cssText = 'position: fixed; right: 12px; bottom: 12px; margin: 0';
  });
  await drag(app, '#text');
  const toast = app.locator('autocopy-toast');
  await expect(toast).toBeVisible();
  const bounds = await toast.boundingBox();
  const viewport = app.viewportSize();
  expect(bounds.x).toBeGreaterThan(viewport.width - 200);
  expect(bounds.y).toBeGreaterThan(viewport.height - 100);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 8);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 8);
});

test('leaves protection unchanged by default, enables it per site and restores it live', async ({ app, extensionWorker }) => {
  await app.goto(`${origin}/selection?blocked`);
  expect(await userSelect(app)).toBe('none');
  await drag(app, '#text');
  expect(await clipboard(app)).toBe('sentinel');
  const blockedBefore = await app.evaluate(() => eventCounts.blocked);
  expect(blockedBefore).toBeGreaterThan(0);

  await settings(extensionWorker, { unlockedSites: ['autocopy.test'] });
  await expect.poll(() => userSelect(app)).toBe('text');
  await expect.poll(() => userSelect(app, '#inline')).toBe('text');
  await drag(app, '#inline');
  await expect.poll(() => clipboard(app)).toBe('Inline protected selection.');
  expect(await app.evaluate(() => eventCounts.blocked)).toBe(blockedBefore);
  expect(await app.locator('#inline').evaluate((node) => typeof node.onselectstart)).toBe('function');
  expect(await app.locator('#text').evaluate((node) => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))).toBe(true);

  await settings(extensionWorker, { unlockedSites: [] });
  await expect.poll(() => userSelect(app)).toBe('none');
  await expect.poll(() => userSelect(app, '#inline')).toBe('none');
  expect(await app.locator('#text').evaluate((node) => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))).toBe(false);
});

test('auto-copy and copy notifications can be disabled independently', async ({ app, extensionWorker }) => {
  await settings(extensionWorker, { autoCopy: false });
  await drag(app, '#text');
  expect(await clipboard(app)).toBe('sentinel');
  await settings(extensionWorker, { autoCopy: true, showToast: false });
  await drag(app, '#formatted');
  await expect.poll(() => clipboard(app)).toBe('Formatted text stays plain.');
  await expect(app.locator('autocopy-toast')).toHaveCount(0);
});

for (const [name, selector, select, type] of [
  ['text input', '#input', dragInput],
  ['email input', '#input', dragInput, 'email'],
  ['textarea', '#textarea', dragInput],
  ['nested editable content', '#editor', drag],
]) {
  test(`excludes ${name} by default and applies editable copying changes live`, async ({ app, extensionWorker }) => {
    if (type) await app.locator(selector).evaluate((element, type) => { element.type = type; }, type);
    const text = await app.locator(selector).evaluate((element) => element.value ?? element.textContent);
    await select(app, selector);
    const selected = await app.locator(selector).evaluate((element) => typeof element.selectionStart === 'number'
      ? element.value.slice(element.selectionStart, element.selectionEnd) : getSelection().toString());
    expect(selected).toBe(text);
    expect(await clipboard(app)).toBe('sentinel');
    await expect(app.locator('autocopy-toast')).toHaveCount(0);

    await app.keyboard.press('Control+c');
    await expect.poll(() => clipboard(app)).toBe(text);
    await app.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await settings(extensionWorker, { copyInEditable: true });
    await app.keyboard.press('ArrowRight');
    await select(app, selector);
    await expect.poll(() => clipboard(app)).toBe(text);

    await settings(extensionWorker, { copyInEditable: false });
    await app.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await app.keyboard.press('ArrowRight');
    await select(app, selector);
    expect(await clipboard(app)).toBe('sentinel');
    await drag(app, '#text');
    await expect.poll(() => clipboard(app)).toBe('Drag this text into the clipboard.');
  });
}

test('applies the editable option inside a shadow root', async ({ app, extensionWorker }) => {
  await app.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'shadow-editor';
    const root = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    input.value = 'Shadow input text';
    input.style.cssText = 'width: 500px; padding: 8px; font: 18px/1.6 monospace';
    root.append(input);
    document.body.append(host);
  });
  await dragInput(app, '#shadow-editor input');
  expect(await clipboard(app)).toBe('sentinel');
  await settings(extensionWorker, { copyInEditable: true });
  await app.keyboard.press('ArrowRight');
  await dragInput(app, '#shadow-editor input');
  await expect.poll(() => clipboard(app)).toBe('Shadow input text');
});

test('copies read-only text controls when editable copying is off', async ({ app }) => {
  for (const selector of ['#input', '#textarea']) {
    await app.locator(selector).evaluate((element) => { element.readOnly = true; });
    const text = await app.locator(selector).inputValue();
    await dragInput(app, selector);
    await expect.poll(() => clipboard(app)).toBe(text);
  }
});

test('applies the editable option to document editing mode', async ({ app, extensionWorker }) => {
  await app.evaluate(() => { document.designMode = 'on'; });
  await drag(app, '#text');
  expect(await clipboard(app)).toBe('sentinel');
  await settings(extensionWorker, { copyInEditable: true });
  await app.keyboard.press('ArrowRight');
  await drag(app, '#text');
  await expect.poll(() => clipboard(app)).toBe('Drag this text into the clipboard.');
});

test('does not copy keyboard selections, clicks, right clicks or synthetic mouse drags', async ({ app }) => {
  await app.locator('#text').evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10 }));
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 100 }));
  });
  expect(await clipboard(app)).toBe('sentinel');
  await app.locator('#text').click({ button: 'right' });
  await app.keyboard.press('Escape');
  expect(await clipboard(app)).toBe('sentinel');
  await app.locator('#text').click();
  await app.keyboard.press('Control+a');
  expect(await clipboard(app)).toBe('sentinel');
});

test('supports an HTTP page through the offscreen clipboard fallback', async ({ app, extensionContext, extensionWorker }) => {
  const http = await extensionContext.newPage();
  await http.goto('http://autocopy.test/selection');
  expect(await http.evaluate(() => Boolean(navigator.clipboard))).toBe(false);
  await drag(http, '#text');
  await expect(http.locator('autocopy-toast')).toHaveCount(1);
  await expect.poll(() => clipboard(app)).toBe('Drag this text into the clipboard.');
  const contexts = await extensionWorker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  expect(contexts).toHaveLength(1);
});

test('keeps normal controls usable and never copies password selections', async ({ app, extensionWorker }) => {
  await settings(extensionWorker, { unlockedSites: ['autocopy.test'] });
  await expect.poll(() => userSelect(app, '#inline')).toBe('text');
  await app.locator('#button').click();
  expect(await app.evaluate(() => eventCounts.button)).toBe(1);
  await app.locator('#input').fill('Still editable');
  expect(await app.evaluate(() => eventCounts.input)).toBeGreaterThan(0);
  await app.locator('#editor').fill('Editor still works');
  await expect(app.locator('#editor')).toHaveText('Editor still works');
  await settings(extensionWorker, { copyInEditable: true });
  const rect = await app.locator('#password').boundingBox();
  await app.mouse.move(rect.x + 10, rect.y + rect.height / 2);
  await app.mouse.down();
  await app.mouse.move(rect.x + rect.width - 10, rect.y + rect.height / 2, { steps: 12 });
  await app.mouse.up();
  expect(await clipboard(app)).toBe('sentinel');
});

test('handles dynamic protected text and remembers site settings across navigation', async ({ app, extensionWorker }) => {
  await settings(extensionWorker, { unlockedSites: ['autocopy.test'] });
  await app.goto(`${origin}/selection?blocked`);
  await expect.poll(() => userSelect(app)).toBe('text');
  await app.locator('#dynamic').evaluate((node) => {
    const paragraph = document.createElement('p');
    paragraph.id = 'added';
    paragraph.style.setProperty('user-select', 'none', 'important');
    paragraph.textContent = 'Dynamically inserted text.';
    paragraph.onselectstart = () => false;
    node.append(paragraph);
  });
  await drag(app, '#added');
  await expect.poll(() => clipboard(app)).toBe('Dynamically inserted text.');
  await app.goto('https://other.autocopy.test/selection?blocked');
  expect(await userSelect(app)).toBe('none');
});

test('applies the top-level site option inside a cross-origin iframe', async ({ app, extensionWorker }) => {
  await settings(extensionWorker, { unlockedSites: ['autocopy.test'] });
  await app.goto(`${origin}/selection?frame`);
  const frameElement = app.locator('#frame');
  await frameElement.scrollIntoViewIfNeeded();
  const frame = app.frameLocator('#frame');
  await expect.poll(() => frame.locator('#text').evaluate((node) => getComputedStyle(node).userSelect)).toBe('text');
  const { x, y, endX, endY } = await textCoordinates(frame, '#text');
  const rect = await frameElement.boundingBox();
  await app.mouse.move(rect.x + 2 + x, rect.y + 2 + y);
  await app.mouse.down();
  await app.mouse.move(rect.x + 2 + endX, rect.y + 2 + endY, { steps: 12 });
  await app.mouse.up();
  await expect.poll(() => clipboard(app)).toBe('Drag this text into the clipboard.');
  await settings(extensionWorker, { unlockedSites: [] });
  await expect.poll(() => frame.locator('#text').evaluate((node) => getComputedStyle(node).userSelect)).toBe('none');
});

test('popup shows defaults and saves independent switches for the current site', async ({ app, extensionContext, extensionWorker }, testInfo) => {
  const popup = await openPopup(extensionContext, extensionWorker, app);
  await expect(popup.locator('#site-name')).toHaveText('autocopy.test');
  await expect(popup.locator('#unlock')).not.toBeChecked();
  await expect(popup.locator('#auto-copy')).toBeChecked();
  await expect(popup.locator('#copy-in-editable')).not.toBeChecked();
  await popup.locator('#unlock').check();
  await expect(popup.locator('#site-state')).toHaveText('해제 중');
  await expect.poll(() => userSelect(app, '#inline')).toBe('text');
  await popup.locator('#auto-copy').uncheck();
  await popup.locator('#copy-in-editable').check();
  await popup.locator('#show-toast').uncheck();
  await expect.poll(() => extensionWorker.evaluate(() => chrome.storage.local.get())).toEqual({
    autoCopy: false, copyInEditable: true, showToast: false, unlockedSites: ['autocopy.test'],
  });
  await popup.setViewportSize({ width: 360, height: 490 });
  await popup.screenshot({ path: testInfo.outputPath('popup.png'), fullPage: true });
  await popup.close();
  const reopened = await openPopup(extensionContext, extensionWorker, app);
  await expect(reopened.locator('#unlock')).toBeChecked();
  await expect(reopened.locator('#auto-copy')).not.toBeChecked();
  await expect(reopened.locator('#copy-in-editable')).toBeChecked();
  await expect(reopened.locator('#show-toast')).not.toBeChecked();
});

test('popup disables site unlocking on restricted Chrome pages', async ({ app, extensionContext, extensionWorker }) => {
  await app.goto('chrome://version');
  const popup = await openPopup(extensionContext, extensionWorker, app);
  await expect(popup.locator('#unlock')).toBeDisabled();
  await expect(popup.locator('#site-note')).toContainText('허용하지 않습니다');
  await expect(popup.locator('#auto-copy')).toBeEnabled();
  await expect(popup.locator('#copy-in-editable')).toBeEnabled();
});
