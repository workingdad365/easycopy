'use strict';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen'
    || message.type !== 'copy' || typeof message.text !== 'string') return false;
  const field = document.getElementById('clipboard');
  try {
    field.value = message.text;
    field.focus();
    field.select();
    respond({ ok: document.execCommand('copy') });
  } catch {
    respond({ ok: false });
  } finally {
    field.value = '';
    field.blur();
  }
  return false;
});
