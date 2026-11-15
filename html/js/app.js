(function () {
  const { el, api, avatar, fmt, toast } = NL;
  const root = document.getElementById('root');
  const S = { me: null, isAdmin: false, cfg: {}, view: { type: 'global' }, convs: [], socket: null, msgs: [], oldest: null, hasMore: true, peer: null, blocked: false };

  const isStaff = () => S.me && (S.me.role === 'admin' || S.me.role === 'owner');
  const canEdit = (createdAt) => Date.now() - new Date(createdAt) < (S.cfg.editWindowMs || 900000);

  function showAuth() {
    let mode = 'login';
    const err = el('div', { class: 'err' });
    const u = el('input', { type: 'text', placeholder: 'Username' });
    const p = el('input', { type: 'password', placeholder: 'Пароль' });
    const submit = el('button', { class: 'btn', style: 'width:100%' }, 'Войти');
    
    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; submit.disabled = true;
      try {
        const r = await api('POST', '/api/auth/' + mode, { username: u.value.trim(), password: p.value });
        NL.setToken(r.token); await start();
      } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
    } }, u, p, err, submit);
    root.replaceChildren(el('div', { class: 'auth-wrap' }, el('div', { class: 'card auth-card' }, el('h1', { class: 'neon-text' }, 'NeonLink'), form)));
  }

  let $list, $msgs, $title, $composerTa, $app, $headActions, $chatHead;

  function showApp() {
    $list = el('div', { class: 'list' });
    const me = el('div', { class: 'me', onclick: openProfile }, avatar(S.me, true), el('div', { style: 'min-width:0' }, el('b', {}, S.me.displayName), el('small', {}, '@' + S.me.username)));
    const side = el('aside', { class: 'sidebar' },
      el('div', { class: 'side-head' }, me, el('span', { class: 'neon-text' }, 'NL')),
      el('div', { class: 'search' }, el('input', { type: 'search', placeholder: 'Поиск...' })), $list);

    $title = el('h2', { class: 'neon-text' }, '');
    $headActions = el('div', { class: 'row' });
    
    // Гамбургер и панель историй
    $chatHead = el('div', { class: 'chat-head' }, 
      el('span', { class: 'hamburger', onclick: () => toggleMenu() }, '☰'),
      $title, $headActions
    );
    
    const storiesBar = el('div', { class: 'stories-bar' });
    loadStories(storiesBar);

    $msgs = el('div', { class: 'messages' });
    $composerTa = el('textarea', { placeholder: 'Сообщение...', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    const composer = el('div', { class: 'composer' }, $composerTa, el('button', { class: 'btn', onclick: send }, '➤'));
    
    const chat = el('main', { class: 'chat' }, $chatHead, storiesBar, $msgs, composer);

    // Шторка меню
    const drawer = el('div', { class: 'side-drawer' },
      el('h2', { class: 'neon-text', style: 'margin-top:0' }, 'Меню'),
      el('div', { class: 'menu-item', onclick: () => { toggleMenu(); openProfile(); } }, '⚙️ Профиль'),
      S.isAdmin ? el('div', { class: 'menu-item', onclick: () => location.href='/admin' }, '🛡️ Админка') : null,
      el('div', { class: 'menu-item', onclick: logout }, '🚪 Выйти')
    );
    const overlay = el('div', { class: 'side-overlay', onclick: toggleMenu });
    document.body.append(drawer, overlay);

    $app = el('div', { class: 'app' }, side, chat);
    root.replaceChildren($app);
    connectSocket(); loadConvs(); openGlobal(false);
  }

  function toggleMenu() {
    document.querySelector('.side-drawer').classList.toggle('open');
    document.querySelector('.side-overlay').classList.toggle('open');
  }

  async function loadStories(container) {
    try {
      const { stories } = await api('GET', '/api/stories');
      if (S.me.checkmark === 'green' || S.me.username === 'CEBA') {
        container.append(el('div', { class: 'story-item', onclick: createStory }, el('div', { class: 'story-avatar add' }, '+'), el('div', { class: 'story-name' }, 'Добавить')));
      }
      stories.forEach(st => {
        container.append(el('div', { class: 'story-item', onclick: () => alert('История: ' + st.content) },
          avatar(st, false), el('div', { class: 'story-name' }, st.display_name)));
      });
    } catch(e) {}
  }

  async function createStory() {
    const text = await NL.prompt('Текст истории', '', true);
    if (!text) return;
    try { await api('POST', '/api/stories', { content: text }); toast('Добавлено'); location.reload(); } catch(e) { toast(e.message); }
  }

  function renderSide() {
    const g = el('div', { class: 'item' + (S.view.type === 'global' ? ' active' : ''), onclick: () => openGlobal(true) }, el('div', { class: 'avatar' }, '#'), el('div', { class: 'meta' }, el('b', {}, 'Общая лента')));
    $list.replaceChildren(g, ...S.convs.map((c) => userItem(c.user, c.lastText)));
  }

  function userItem(u, sub) {
    return el('div', { class: 'item' + (S.view.type === 'dm' && S.view.peerId === u.id ? ' active' : ''), onclick: () => openDm(u.id) },
      avatar(u), el('div', { class: 'meta' }, 
        el('b', {}, u.displayName, u.checkmark ? el('span', { class: 'badge-check check-' + u.checkmark }, '✔') : null), 
        el('span', {}, sub || '@' + u.username)));
  }

  async function loadConvs() { try { S.convs = (await api('GET', '/api/dm/conversations')).conversations; } catch {} renderSide(); }

  function openGlobal(showChat) { S.view = { type: 'global' }; $title.textContent = '# Общая лента'; $headActions.replaceChildren(); S.msgs = []; renderSide(); loadHistory(true); }
  async function openDm(id) { S.view = { type: 'dm', peerId: id }; S.msgs = []; await loadHistory(true); renderSide(); }

  async function loadHistory() {
    const d = await api('GET', S.view.type === 'global' ? '/api/messages' : '/api/dm/' + S.view.peerId);
    if (S.view.type === 'dm') $title.textContent = d.peer.displayName;
    S.msgs = d.messages; renderMsgs();
  }

  function renderMsgs() {
    $msgs.replaceChildren(...S.msgs.map(msgNode));
    $msgs.scrollTop = $msgs.scrollHeight;
  }

  function msgNode(raw) {
    const m = raw; const mine = (m.user?.id || m.senderId) === S.me.id;
    const author = m.user || (mine ? S.me : S.peer);
    return el('div', { class: 'msg' + (mine ? ' mine' : '') }, mine ? null : avatar(author, true),
      el('div', { class: 'bubble' }, 
        !mine ? el('div', { class: 'who' }, author.displayName, author.checkmark ? el('span', { class: 'badge-check check-' + author.checkmark }, '✔') : null) : null,
        el('div', { class: 'txt' }, m.text), el('div', { class: 'foot' }, fmt(m.createdAt))));
  }

  async function send() {
    const text = $composerTa.value.trim(); if (!text) return;
    try {
      if (S.view.type === 'global') await api('POST', '/api/messages', { text });
      else await api('POST', '/api/dm/' + S.view.peerId, { text });
      $composerTa.value = '';
    } catch(e) { toast(e.message); }
  }

  async function connectSocket() {
    if (S.socket) S.socket.disconnect();
    try { await NL.loadScript(NL.API + '/socket.io/socket.io.js'); } catch { return; }
    const s = (S.socket = io(NL.API || undefined, { auth: { token: NL.token() } }));
    s.on('message:new', (m) => { if (S.view.type === 'global') { S.msgs.push(m); renderMsgs(); } });
    s.on('dm:new', (m) => { if (S.view.type === 'dm' && (m.senderId === S.view.peerId || m.recipientId === S.view.peerId)) { S.msgs.push(m); renderMsgs(); } else loadConvs(); });
  }

  function openProfile() {
    const dn = el('input', { type: 'text', value: S.me.displayName });
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Профиль'), dn,
      el('button', { class: 'btn', style: 'margin-top:10px; width:100%', onclick: async () => {
        try { S.me = (await api('PATCH', '/api/me', { displayName: dn.value })).user; m.remove(); showApp(); } catch(e) { toast(e.message); }
      } }, 'Сохранить')));
    document.body.append(m);
  }

  function logout() { NL.setToken(''); location.reload(); }

  async function start() {
    try { const r = await api('GET', '/api/me'); S.me = r.user; S.isAdmin = r.isAdmin; showApp(); } catch (e) { showAuth(); }
  }

  (async () => {
    try { S.cfg = await api('GET', '/api/config'); } catch { root.replaceChildren('Сервер недоступен'); return; }
    if (NL.token()) start(); else showAuth();
  })();
})();