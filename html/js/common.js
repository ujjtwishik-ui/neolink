// Общие утилиты для index.html и admin.html (без фреймворков)
(function () {
  const API = (window.NEONLINK_API || '').replace(/\/$/, '');
  const NL = (window.NL = { API });

  NL.token = () => { try { return localStorage.getItem('nl_token') || ''; } catch { return ''; } };
  NL.setToken = (t) => { try { t ? localStorage.setItem('nl_token', t) : localStorage.removeItem('nl_token'); } catch {} };

  NL.api = async (method, url, body) => {
    const res = await fetch(API + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + NL.token() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || 'Ошибка ' + res.status); e.status = res.status; throw e; }
    return data;
  };

  // el('div', {class:'x', onclick: fn}, child1, 'text') — безопасное создание DOM (никакого innerHTML с данными)
  NL.el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };

  NL.avatar = (u, small) => {
    const cls = 'avatar' + (small ? ' sm' : '');
    if (u.avatarUrl) { const i = NL.el('img', { class: cls, src: u.avatarUrl, alt: '' }); i.onerror = () => i.replaceWith(NL.avatar({ ...u, avatarUrl: '' }, small)); return i; }
    return NL.el('div', { class: cls }, (u.displayName || u.username || '?').trim().charAt(0).toUpperCase());
  };

  NL.fmt = (d) => new Date(d).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  NL.toast = (msg) => {
    const t = NL.el('div', { class: 'toast' }, msg);
    document.body.append(t); setTimeout(() => t.remove(), 3200);
  };

  // reCAPTCHA v3: подгружаем скрипт, если сервер вернул site key
  let siteKey = '';
  NL.initCaptcha = (key) => new Promise((resolve) => {
    siteKey = key || '';
    if (!siteKey) return resolve();
    const s = document.createElement('script');
    s.src = 'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(siteKey);
    s.onload = () => resolve(); s.onerror = () => resolve();
    document.head.append(s);
  });
  NL.captcha = async (action) => {
    if (!siteKey || !window.grecaptcha) return '';
    await new Promise((r) => grecaptcha.ready(r));
    try { return await grecaptcha.execute(siteKey, { action }); } catch { return ''; }
  };

  NL.loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });

  // Модалка ввода
  NL.prompt = (title, value = '', multiline = false) => new Promise((resolve) => {
    const input = multiline ? NL.el('textarea', { rows: 5 }) : NL.el('input', { type: 'text' });
    input.value = value;
    const close = (v) => { m.remove(); resolve(v); };
    const m = NL.el('div', { class: 'modal', onclick: (e) => e.target === m && close(null) },
      NL.el('div', { class: 'card' }, NL.el('h3', { class: 'neon-text', style: 'margin-top:0' }, title), input,
        NL.el('div', { class: 'row', style: 'margin-top:12px;justify-content:flex-end' },
          NL.el('button', { class: 'btn ghost', onclick: () => close(null) }, 'Отмена'),
          NL.el('button', { class: 'btn', onclick: () => close(input.value) }, 'OK'))));
    document.body.append(m); input.focus();
  });
})();
