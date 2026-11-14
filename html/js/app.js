// NeonLink — клиент мессенджера
(function () {
  const { el, api, avatar, fmt, toast } = NL;
  const root = document.getElementById('root');
  const S = { me: null, isAdmin: false, cfg: {}, view: { type: 'global' }, convs: [], socket: null, msgs: [], oldest: null, hasMore: true, peer: null, blocked: false };

  const isStaff = () => S.me && (S.me.role === 'admin' || S.me.role === 'owner');
  const canEdit = (createdAt) => Date.now() - new Date(createdAt) < (S.cfg.editWindowMs || 900000);

  // ============ AUTH ============
  function showAuth() {
    let mode = 'login';
    const err = el('div', { class: 'err' });
    const u = el('input', { type: 'text', autocomplete: 'username', maxlength: 32 });
    const dn = el('input', { type: 'text', maxlength: 64 });
    const p = el('input', { type: 'password', autocomplete: 'current-password', maxlength: 72 });
    const dnField = el('div', { class: 'field', hidden: true }, el('label', {}, 'Отображаемое имя'), dn);
    const submit = el('button', { class: 'btn', style: 'width:100%' }, 'Войти');
    const tLogin = el('button', { class: 'btn ghost active', type: 'button' }, 'Вход');
    const tReg = el('button', { class: 'btn ghost', type: 'button' }, 'Регистрация');
    const setMode = (m) => {
      mode = m; err.textContent = '';
      tLogin.classList.toggle('active', m === 'login'); tReg.classList.toggle('active', m === 'register');
      dnField.hidden = m === 'login'; submit.textContent = m === 'login' ? 'Войти' : 'Создать аккаунт';
      p.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    };
    tLogin.onclick = () => setMode('login'); tReg.onclick = () => setMode('register');
    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; submit.disabled = true;
      try {
        const body = { username: u.value.trim(), password: p.value };
        if (mode === 'register') { body.displayName = dn.value; body.captcha = await NL.captcha('register'); }
        const r = await api('POST', '/api/auth/' + mode, body);
        NL.setToken(r.token); await start();
      } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
    } },
      el('div', { class: 'tabs' }, tLogin, tReg),
      el('div', { class: 'field' }, el('label', {}, 'Username'), u), dnField,
      el('div', { class: 'field' }, el('label', {}, 'Пароль'), p), err, submit);
    root.replaceChildren(el('div', { class: 'auth-wrap' }, el('div', { class: 'card auth-card' },
      el('h1', { class: 'neon-text' }, 'NeonLink'), el('div', { class: 'sub' }, 'мессенджер в неоновом свете'), form,
      S.cfg.maintenance ? el('div', { class: 'err' }, 'Режим обслуживания: регистрация отключена') : null,
      S.cfg.recaptchaSiteKey ? el('div', { class: 'hint' }, 'Защищено reCAPTCHA') : null)));
  }

  // ============ APP SHELL ============
  let $list, $msgs, $title, $composerTa, $app, $banner, $headActions, $search, $chatHead;

  function showApp() {
    $banner = el('div', { class: 'banner', hidden: !S.cfg.maintenance }, '⚠ Экстренный режим: отправка сообщений доступна только администраторам');
    $list = el('div', { class: 'list' });
    $search = el('input', { type: 'search', placeholder: 'Найти пользователя…', oninput: debounce(onSearch, 250) });
    const me = el('div', { class: 'me', onclick: openProfile }, avatar(S.me, true), el('div', { style: 'min-width:0' }, el('b', {}, S.me.displayName), el('small', {}, '@' + S.me.username)));
    const side = el('aside', { class: 'sidebar' },
      el('div', { class: 'side-head' }, me, el('span', { class: 'neon-text' }, 'NL')),
      el('div', { class: 'search' }, $search), $list);

    $title = el('h2', { class: 'neon-text' }, '');
    $headActions = el('div', { class: 'row' });
    $chatHead = el('div', { class: 'chat-head' }, el('button', { class: 'btn ghost small back', onclick: () => $app.classList.remove('in-chat') }, '←'), $title, $headActions);
    $msgs = el('div', { class: 'messages' });
    $composerTa = el('textarea', { placeholder: 'Сообщение…', maxlength: 2000, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    const composer = el('div', { class: 'composer' }, $composerTa, el('button', { class: 'btn', onclick: send }, '➤'));
    const chat = el('main', { class: 'chat' }, $chatHead, $msgs, composer);

    $app = el('div', { class: 'app' }, side, chat);
    root.replaceChildren(el('div', { style: 'display:flex;flex-direction:column;height:100%' }, $banner, el('div', { style: 'flex:1;min-height:0;position:relative' }, $app)));
    $app.style.height = '100%';
    connectSocket(); loadConvs(); openGlobal(false);
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---- sidebar ----
  async function loadConvs() {
    try { S.convs = (await api('GET', '/api/dm/conversations')).conversations; } catch {}
    if (!$search.value.trim()) renderSide();
  }
  function renderSide() {
    const g = el('div', { class: 'item' + (S.view.type === 'global' ? ' active' : ''), onclick: () => openGlobal(true) },
      el('div', { class: 'avatar' }, '#'), el('div', { class: 'meta' }, el('b', {}, 'Общая лента'), el('span', {}, 'Все пользователи')));
    $list.replaceChildren(g, el('div', { class: 'section-title' }, 'Личные сообщения'),
      ...S.convs.map((c) => userItem(c.user, c.lastText)),
      S.convs.length ? null : el('div', { class: 'empty', style: 'padding:16px;font-size:13px' }, 'Найдите пользователя в поиске выше'));
  }
  function userItem(u, sub) {
    const active = S.view.type === 'dm' && S.view.peerId === u.id;
    return el('div', { class: 'item' + (active ? ' active' : ''), onclick: () => { $search.value = ''; openDm(u.id); } },
      avatar(u), el('div', { class: 'meta' }, el('b', {}, u.displayName, u.role !== 'user' ? el('span', { class: 'badge' }, u.role) : null), el('span', {}, sub || '@' + u.username)));
  }
  async function onSearch() {
    const s = $search.value.trim();
    if (!s) return renderSide();
    try {
      const { users } = await api('GET', '/api/users?q=' + encodeURIComponent(s));
      $list.replaceChildren(el('div', { class: 'section-title' }, 'Результаты'), ...users.map((u) => userItem(u, '@' + u.username)),
        users.length ? null : el('div', { class: 'empty', style: 'padding:16px' }, 'Никого не найдено'));
    } catch (e) { toast(e.message); }
  }

  // ---- chat views ----
  function openGlobal(showChat) {
    S.view = { type: 'global' }; S.peer = null; $title.textContent = '# Общая лента'; $headActions.replaceChildren();
    if (showChat) $app.classList.add('in-chat');
    S.msgs = []; S.hasMore = true; renderSide(); loadHistory(true);
  }
  async function openDm(id) {
    S.view = { type: 'dm', peerId: id }; S.msgs = []; S.hasMore = true; $app.classList.add('in-chat');
    await loadHistory(true); renderSide();
  }
  async function loadHistory(reset) {
    try {
      const before = !reset && S.msgs.length ? S.msgs[0].id : '';
      const url = S.view.type === 'global' ? '/api/messages?before=' + before : `/api/dm/${S.view.peerId}?before=${before}`;
      const d = await api('GET', url);
      if (S.view.type === 'dm') {
        S.peer = d.peer; S.blocked = d.blocked; $title.textContent = d.peer.displayName + '  @' + d.peer.username;
        $headActions.replaceChildren(el('button', { class: 'btn ghost small', onclick: toggleBlock }, S.blocked ? 'Разблокировать' : 'Заблокировать'));
      }
      S.hasMore = d.messages.length >= 50;
      S.msgs = reset ? d.messages : [...d.messages, ...S.msgs];
      renderMsgs(reset ? 'bottom' : 'keep');
    } catch (e) { toast(e.message); }
  }
  async function toggleBlock() {
    try { await api(S.blocked ? 'DELETE' : 'POST', '/api/blocks/' + S.peer.id); S.blocked = !S.blocked; toast(S.blocked ? 'Пользователь заблокирован' : 'Разблокирован'); loadHistory(true); } catch (e) { toast(e.message); }
  }

  function renderMsgs(scroll) {
    const prevH = $msgs.scrollHeight;
    const nodes = [];
    if (S.hasMore && S.msgs.length) nodes.push(el('button', { class: 'btn ghost small more', onclick: () => loadHistory(false) }, 'Загрузить ещё'));
    if (!S.msgs.length) nodes.push(el('div', { class: 'empty' }, 'Сообщений пока нет. Напишите первым!'));
    for (const m of S.msgs) nodes.push(msgNode(m));
    $msgs.replaceChildren(...nodes);
    if (scroll === 'bottom') $msgs.scrollTop = $msgs.scrollHeight;
    else if (scroll === 'keep') $msgs.scrollTop = $msgs.scrollHeight - prevH;
  }

  function normalize(m) {   // единый формат для feed и dm
    if (m.user) return { ...m, authorId: m.user.id, author: m.user };
    const au = m.senderId === S.me.id ? S.me : S.peer || { id: m.senderId, username: '?', displayName: '?' };
    return { ...m, authorId: m.senderId, author: au };
  }
  function msgNode(raw) {
    const m = normalize(raw); const mine = m.authorId === S.me.id;
    const foot = el('div', { class: 'foot' }, fmt(m.createdAt),
      m.editedAt ? (m.editedByAdmin ? el('span', { class: 'tag-admin' }, 'edited by admin') : 'изменено') : null);
    if (mine && canEdit(m.createdAt)) {
      foot.append(el('a', { onclick: () => editMsg(raw) }, 'ред.'), el('a', { onclick: () => delMsg(raw) }, 'удал.'));
    }
    return el('div', { class: 'msg' + (mine ? ' mine' : '') }, mine ? null : avatar(m.author, true),
      el('div', { class: 'bubble' }, mine || S.view.type === 'dm' ? null : el('div', { class: 'who' }, m.author.displayName, m.author.role !== 'user' ? el('span', { class: 'badge' }, m.author.role) : null),
        el('div', { class: 'txt' }, m.text), foot));
  }
  const path = (id) => S.view.type === 'global' ? '/api/messages/' + id : '/api/dm/msg/' + id;
  async function editMsg(m) {
    const t = await NL.prompt('Изменить сообщение', m.text, true);
    if (t == null || !t.trim() || t === m.text) return;
    try { await api('PATCH', path(m.id), { text: t }); } catch (e) { toast(e.message); }
  }
  async function delMsg(m) {
    if (!confirm('Удалить сообщение?')) return;
    try { await api('DELETE', path(m.id)); } catch (e) { toast(e.message); }
  }
  let sending = false;
  async function send() {
    const text = $composerTa.value.trim();
    if (!text || sending) return;
    sending = true;
    try {
      const captcha = await NL.captcha('send');
      if (S.view.type === 'global') await api('POST', '/api/messages', { text, captcha });
      else await api('POST', '/api/dm/' + S.view.peerId, { text, captcha });
      $composerTa.value = '';
    } catch (e) { toast(e.message); } finally { sending = false; $composerTa.focus(); }
  }

  // ---- realtime ----
  async function connectSocket() {
    if (S.socket) S.socket.disconnect();
    try { await NL.loadScript(NL.API + '/socket.io/socket.io.js'); } catch { return toast('Нет связи с сервером'); }
    const s = (S.socket = io(NL.API || undefined, { auth: { token: NL.token() } }));
    const nearBottom = () => $msgs.scrollHeight - $msgs.scrollTop - $msgs.clientHeight < 120;
    const upsert = (m, wasNear) => { const i = S.msgs.findIndex((x) => x.id === m.id); if (i >= 0) S.msgs[i] = m; else S.msgs.push(m); renderMsgs(wasNear ? 'bottom' : null); };
    s.on('message:new', (m) => { if (S.view.type === 'global') upsert(m, nearBottom() || m.user.id === S.me.id); });
    s.on('message:update', (m) => { if (S.view.type === 'global') upsert(m, false); });
    s.on('message:delete', ({ id }) => { if (S.view.type === 'global') { S.msgs = S.msgs.filter((x) => x.id !== id); renderMsgs(null); } });
    const inThisDm = (m) => S.view.type === 'dm' && (m.senderId === S.view.peerId || m.recipientId === S.view.peerId);
    s.on('dm:new', (m) => { if (inThisDm(m)) upsert(m, true); else if (m.senderId !== S.me.id) toast('Новое личное сообщение'); loadConvs(); });
    s.on('dm:update', (m) => { if (inThisDm(m)) upsert(m, false); loadConvs(); });
    s.on('dm:delete', (m) => { if (inThisDm(m)) { S.msgs = S.msgs.filter((x) => x.id !== m.id); renderMsgs(null); } loadConvs(); });
    s.on('maintenance', ({ enabled }) => { S.cfg.maintenance = enabled; $banner.hidden = !enabled; });
    s.on('connect_error', (e) => { if (e.message === 'unauthorized') logout(); });
    s.on('disconnect', (reason) => { if (reason === 'io server disconnect') logout(); });
    // тики для скрытия кнопок «ред./удал.» после окончания окна
    clearInterval(S.tick); S.tick = setInterval(() => S.msgs.length && renderMsgs(null), 60000);
  }

  // ---- profile ----
  function openProfile() {
    const dn = el('input', { type: 'text', value: S.me.displayName, maxlength: 64 });
    const url = el('input', { type: 'url', placeholder: 'https://… или загрузите файл', value: S.me.avatarUrl.startsWith('data:') ? '' : S.me.avatarUrl });
    let dataUrl = null;
    const preview = el('div', {}, avatar(S.me));
    const file = el('input', { type: 'file', accept: 'image/*', onchange: async () => {
      const f = file.files[0]; if (!f) return;
      try { dataUrl = await resizeImage(f, 160); preview.replaceChildren(avatar({ ...S.me, avatarUrl: dataUrl })); } catch { toast('Не удалось прочитать изображение'); }
    } });
    const err = el('div', { class: 'err' });
    const close = () => m.remove();
    const save = async () => {
      try {
        const body = { displayName: dn.value };
        if (dataUrl) body.avatarUrl = dataUrl; else if (url.value.trim() !== S.me.avatarUrl) body.avatarUrl = url.value.trim();
        S.me = (await api('PATCH', '/api/me', body)).user; close(); showApp();
      } catch (e) { err.textContent = e.message; }
    };
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && close() },
      el('div', { class: 'card' }, el('h3', { class: 'neon-text', style: 'margin-top:0' }, 'Профиль'),
        el('div', { class: 'row', style: 'margin-bottom:12px' }, preview, el('div', {}, el('b', {}, '@' + S.me.username), el('div', { class: 'hint', style: 'text-align:left' }, 'роль: ' + S.me.role))),
        el('div', { class: 'field' }, el('label', {}, 'Отображаемое имя'), dn),
        el('div', { class: 'field' }, el('label', {}, 'Аватар: URL'), url),
        el('div', { class: 'field' }, el('label', {}, 'или файл'), file), err,
        el('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap' },
          el('div', { class: 'row' }, el('button', { class: 'btn danger small', onclick: logout }, 'Выйти'),
            S.isAdmin ? el('a', { class: 'btn ghost small', href: '/admin', style: 'text-decoration:none' }, 'Админ-панель') : null),
          el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: close }, 'Отмена'), el('button', { class: 'btn', onclick: save }, 'Сохранить')))));
    document.body.append(m);
  }
  function resizeImage(file, size) {
    return new Promise((resolve, reject) => {
      const img = new Image(); const fr = new FileReader();
      fr.onload = () => { img.src = fr.result; };
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = size;
        const k = Math.max(size / img.width, size / img.height), w = img.width * k, h = img.height * k;
        c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = fr.onerror = reject; fr.readAsDataURL(file);
    });
  }

  function logout() { NL.setToken(''); if (S.socket) S.socket.disconnect(); clearInterval(S.tick); S.me = null; showAuth(); }

  async function start() {
    try { const r = await api('GET', '/api/me'); S.me = r.user; S.isAdmin = r.isAdmin; showApp(); }
    catch (e) { if (e.status === 401 || e.status === 403) NL.setToken(''); showAuth(); }
  }

  (async () => {
    try { S.cfg = await api('GET', '/api/config'); } catch { root.replaceChildren(el('div', { class: 'empty', style: 'padding:40px' }, 'Сервер недоступен. Проверьте подключение и config.js')); return; }
    await NL.initCaptcha(S.cfg.recaptchaSiteKey);
    if (NL.token()) start(); else showAuth();
  })();
})();
