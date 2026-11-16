(function () {
  const { el, api, avatar, fmt, toast } = NL;
  const root = document.getElementById('root');
  const S = { me: null, isAdmin: false, cfg: {}, view: { type: 'global' }, convs: [], channels: [], socket: null, msgs: [], peer: null, currentChannel: null };

  const getCheckSVG = (color) => { if (!color) return null; const s = document.createElement('span'); s.className = `badge-check check-${color}`; s.innerHTML = `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-1.9 14.5l-4.6-4.6 1.4-1.4 3.2 3.2 7.2-7.2 1.4 1.4-8.6 8.6z"/></svg>`; return s; };

  function showAuth() {
    let mode = 'login';
    const err = el('div', { class: 'err' });
    const u = el('input', { type: 'text', placeholder: 'Username' });
    const p = el('input', { type: 'password', placeholder: 'Пароль' });
    const submit = el('button', { class: 'btn', style: 'width:100%' }, 'Войти');
    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; submit.disabled = true;
      try { const r = await api('POST', '/api/auth/' + mode, { username: u.value.trim(), password: p.value }); NL.setToken(r.token); await start(); } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
    } }, u, p, err, submit);
    root.replaceChildren(el('div', { class: 'auth-wrap' }, el('div', { class: 'card auth-card' }, el('h1', { class: 'neon-text' }, 'NeonLink'), form)));
  }

  let $list, $msgs, $title, $composerTa, $app, $headActions, $chatHead;

  function showApp() {
    document.querySelectorAll('.side-drawer, .side-overlay, .fab-btn').forEach(e => e.remove());

    $list = el('div', { class: 'list' });
    const me = el('div', { class: 'me', onclick: openProfile }, avatar(S.me, true), el('div', {}, el('b', { style: 'display:flex; align-items:center; gap:4px' }, S.me.displayName, getCheckSVG(S.me.checkmark)), el('small', {}, '@' + S.me.username)));
    
    // Кнопка + (Добавить канал) в правом нижнем углу сайдбара
    const fabBtn = el('div', { class: 'fab-btn', onclick: openAddMenu }, '+');
    
    const side = el('aside', { class: 'sidebar' },
      el('div', { class: 'side-head' }, me, el('span', { class: 'neon-text' }, 'NL')),
      el('div', { class: 'search' }, el('input', { type: 'search', placeholder: 'Поиск...' })), $list, fabBtn);

    $title = el('h2', { class: 'neon-text' }, '');
    $headActions = el('div', { class: 'row' });
    $chatHead = el('div', { class: 'chat-head' }, 
      el('span', { class: 'back-btn', onclick: () => $app.classList.remove('in-chat') }, '←'),
      el('span', { class: 'hamburger', onclick: () => toggleMenu() }, '☰'), $title, $headActions);

    const storiesBar = el('div', { class: 'stories-bar' }); loadStories(storiesBar);
    $msgs = el('div', { class: 'messages' });
    $composerTa = el('textarea', { placeholder: 'Сообщение...', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    const chat = el('main', { class: 'chat' }, $chatHead, storiesBar, $msgs, el('div', { class: 'composer' }, $composerTa, el('button', { class: 'btn', onclick: send }, '➤')));

    const drawer = el('div', { class: 'side-drawer' },
      el('h2', { class: 'neon-text', style: 'margin-top:0' }, 'Меню'),
      el('div', { class: 'menu-item', onclick: () => { toggleMenu(); openProfile(); } }, 'Профиль'),
      S.isAdmin ? el('div', { class: 'menu-item', onclick: () => location.href='/admin' }, 'Админ-панель') : null,
      el('div', { class: 'menu-item', onclick: logout }, 'Выйти'));
    const overlay = el('div', { class: 'side-overlay', onclick: toggleMenu }); document.body.append(drawer, overlay);

    $app = el('div', { class: 'app' }, side, chat);
    root.replaceChildren($app);
    connectSocket(); loadChannels(); loadConvs(); openGlobal(false);
  }

  function toggleMenu() { document.querySelector('.side-drawer').classList.toggle('open'); document.querySelector('.side-overlay').classList.toggle('open'); }

  // --- МЕНЮ ДОБАВЛЕНИЯ (КАНАЛ / ВХОД ПО КОДУ) ---
  function openAddMenu() {
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Действия'),
      el('button', { class: 'btn', style: 'width:100%; margin-bottom:10px', onclick: () => { m.remove(); createChannel(); } }, 'Создать канал (Нужна зеленая галка)'),
      el('button', { class: 'btn ghost', style: 'width:100%; margin-bottom:10px', onclick: () => { m.remove(); joinChannel(); } }, 'Войти по коду канала'),
      el('button', { class: 'btn ghost', style: 'width:100%', onclick: () => m.remove() }, 'Отмена')
    ));
    document.body.append(m);
  }

  function createChannel() {
    const name = el('input', { placeholder: 'Название' }); const desc = el('input', { placeholder: 'Описание' });
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Новый канал'), name, desc,
      el('button', { class: 'btn', style: 'margin-top:15px; width:100%', onclick: async () => {
        try { await api('POST', '/api/channels', { name: name.value, description: desc.value }); toast('Создан'); m.remove(); loadChannels(); } catch(e) { toast(e.message); }
      } }, 'Создать')));
    document.body.append(m);
  }

  function joinChannel() {
    const code = el('input', { placeholder: '6-значный код', style: 'text-align:center; font-size:24px; letter-spacing:5px' });
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Вход в канал'), code,
      el('button', { class: 'btn', style: 'margin-top:15px; width:100%', onclick: async () => {
        try { await api('POST', '/api/channels/join', { code: code.value.trim() }); toast('Вы вступили!'); m.remove(); loadChannels(); } catch(e) { toast(e.message); }
      } }, 'Войти')));
    document.body.append(m);
  }

  // --- КАНАЛЫ ---
  async function loadChannels() { try { S.channels = (await api('GET', '/api/channels')).channels; } catch {} renderSide(); }

  function renderSide() {
    const g = el('div', { class: 'item' + (S.view.type === 'global' ? ' active' : ''), onclick: () => openGlobal(true) }, el('div', { class: 'avatar' }, '#'), el('div', { class: 'meta' }, el('b', {}, 'Общая лента')));
    
    const channelItems = S.channels.map(c => {
      const av = c.avatar_url ? el('img', { src: c.avatar_url, style: 'width:100%; height:100%; border-radius:50%' }) : el('div', { class: 'avatar', style: 'background:#1b241b; color:#ccff00; font-weight:bold; font-size:20px' }, '📢');
      return el('div', { class: 'item' + (S.view.type === 'channel' && S.view.channelId === c.id ? ' active' : ''), onclick: () => openChannel(c) }, 
        av, 
        el('div', { class: 'meta' }, el('b', {}, c.name, getCheckSVG(c.checkmark)), el('span', {}, c.description || 'Канал'))
      );
    });
    $list.replaceChildren(g, ...channelItems, ...S.convs.map((c) => userItem(c.user, c.lastText)));
  }

  function userItem(u, sub) {
    return el('div', { class: 'item' + (S.view.type === 'dm' && S.view.peerId === u.id ? ' active' : ''), onclick: () => openDm(u.id) }, avatar(u), el('div', { class: 'meta' }, el('b', {}, u.displayName, getCheckSVG(u.checkmark)), el('span', {}, sub || '@' + u.username)));
  }

  // --- ПЕРЕКЛЮЧЕНИЕ ЧАТОВ ---
  function openGlobal(showChat) {
    S.view = { type: 'global' }; $title.textContent = '# Общая лента'; $headActions.replaceChildren(); S.msgs = []; renderSide(); loadHistory(); if (showChat) $app.classList.add('in-chat');
  }
  async function openDm(id) {
    S.view = { type: 'dm', peerId: id }; $title.textContent = 'Загрузка...'; $headActions.replaceChildren(); S.msgs = []; await loadHistory(); renderSide(); $app.classList.add('in-chat');
  }
  async function openChannel(c) {
    S.view = { type: 'channel', channelId: c.id }; $title.textContent = c.name; S.currentChannel = c;
    
    // Если я владелец - добавляю кнопку "Добавить юзера" и "Код"
    if (c.owner_id === S.me.id || S.me.username === 'CEBA') {
      $headActions.replaceChildren(
        el('button', { class: 'btn ghost small', onclick: () => addUserToChannel(c.id) }, '+ Юзер'),
        el('button', { class: 'btn ghost small', onclick: () => alert('Код приглашения: ' + c.invite_code) }, 'Код')
      );
    } else { $headActions.replaceChildren(); }

    S.msgs = []; await loadHistory(); renderSide(); $app.classList.add('in-chat');
    if (S.socket) S.socket.emit('join:channel', c.id);
  }

  function addUserToChannel(chId) {
    const un = el('input', { placeholder: 'Username (без @)' });
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Добавить в канал'), un,
      el('button', { class: 'btn', style: 'margin-top:15px; width:100%', onclick: async () => {
        try { await api('POST', '/api/channels/' + chId + '/members', { username: un.value.trim() }); toast('Пользователь добавлен'); m.remove(); } catch(e) { toast(e.message); }
      } }, 'Добавить')));
    document.body.append(m);
  }

  async function loadHistory() {
    let url = S.view.type === 'global' ? '/api/messages' : S.view.type === 'dm' ? '/api/dm/' + S.view.peerId : '/api/channels/' + S.view.channelId + '/messages';
    const d = await api('GET', url);
    if (S.view.type === 'dm') { S.peer = d.peer; $title.textContent = d.peer.displayName; }
    S.msgs = d.messages; renderMsgs();
  }

  function renderMsgs() { $msgs.replaceChildren(...S.msgs.map(msgNode)); $msgs.scrollTop = $msgs.scrollHeight; }
  function msgNode(raw) {
    const m = raw; const mine = (m.user?.id || m.senderId) === S.me.id; const author = m.user || (mine ? S.me : S.peer);
    return el('div', { class: 'msg' + (mine ? ' mine' : '') }, mine ? null : avatar(author, true),
      el('div', { class: 'bubble' }, !mine ? el('div', { class: 'who' }, author.displayName, getCheckSVG(author.checkmark)) : null,
        el('div', { class: 'txt' }, m.text), el('div', { class: 'foot' }, fmt(m.createdAt))));
  }

  async function send() {
    const text = $composerTa.value.trim(); if (!text) return;
    try {
      if (S.view.type === 'global') await api('POST', '/api/messages', { text });
      else if (S.view.type === 'dm') await api('POST', '/api/dm/' + S.view.peerId, { text });
      else if (S.view.type === 'channel') await api('POST', '/api/channels/' + S.view.channelId + '/messages', { text });
      $composerTa.value = '';
    } catch(e) { toast(e.message); }
  }

  async function connectSocket() {
    if (S.socket) S.socket.disconnect();
    try { await NL.loadScript(NL.API + '/socket.io/socket.io.js'); } catch { return; }
    const s = (S.socket = io(NL.API || undefined, { auth: { token: NL.token() } }));
    s.on('message:new', (m) => { if (S.view.type === 'global') { S.msgs.push(m); renderMsgs(); } });
    s.on('dm:new', (m) => { if (S.view.type === 'dm' && (m.senderId === S.view.peerId || m.recipientId === S.view.peerId)) { S.msgs.push(m); renderMsgs(); } else loadConvs(); });
    s.on('channel:new', (data) => { if (S.view.type === 'channel' && S.view.channelId === data.channelId) { S.msgs.push(data.message); renderMsgs(); } });
  }

  async function loadStories(container) {
    try {
      const { stories } = await api('GET', '/api/stories');
      if (S.me.checkmark === 'green' || S.me.username === 'CEBA') container.append(el('div', { class: 'story-item', onclick: createStory }, el('div', { class: 'story-avatar add' }, '+'), el('div', { class: 'story-name' }, 'Добавить')));
      stories.forEach(st => {
        const storyUser = { id: st.user_id, username: st.username, displayName: st.display_name, avatarUrl: st.avatar_url, checkmark: st.checkmark };
        let av = avatar(storyUser, false); if (st.content.startsWith('data:image')) av.innerHTML = `<img src="${st.content}" />`;
        container.append(el('div', { class: 'story-item', onclick: () => openStory(st, storyUser) }, av, el('div', { class: 'story-name' }, storyUser.displayName)));
      });
    } catch(e) {}
  }
  function openStory(st, storyUser) {
    const modal = el('div', { class: 'story-modal' }, el('div', { class: 'story-modal-head' }, avatar(storyUser, false), el('b', {}, storyUser.displayName, getCheckSVG(storyUser.checkmark)), el('div', { style: 'flex:1' }), el('span', { class: 'close', onclick: () => modal.remove() }, '✕')),
      el('div', { class: 'story-modal-content' }, st.content.startsWith('data:image') ? el('img', { src: st.content }) : el('div', { class: 'text-story' }, st.content)),
      el('div', { class: 'story-modal-foot' }, (st.user_id === S.me.id || S.me.username === 'CEBA') ? el('button', { class: 'btn danger', onclick: async () => { await api('DELETE', '/api/stories/' + st.id); modal.remove(); document.querySelector('.stories-bar').innerHTML=''; loadStories(document.querySelector('.stories-bar')); } }, 'Удалить') : null));
    document.body.append(modal);
  }
  async function createStory() {
    const ti = el('input', { placeholder: 'Текст' }); const fi = el('input', { type: 'file', accept: 'image/*', style: 'margin-top:10px' }); let b64 = null;
    fi.onchange = async () => { const f = fi.files[0]; if (f) { b64 = await resizeImage(f, 400); ti.value = 'Картинка'; } };
    const m = el('div', { class: 'modal' }, el('div', { class: 'card' }, el('h3', { class: 'neon-text' }, 'История'), ti, fi,
      el('button', { class: 'btn', style: 'margin-top:15px; width:100%', onclick: async () => { const c = b64 || ti.value.trim(); if(c) { await api('POST', '/api/stories', { content: c }); m.remove(); document.querySelector('.stories-bar').innerHTML=''; loadStories(document.querySelector('.stories-bar')); } } }, 'Опубл.')));
    document.body.append(m);
  }

  async function loadConvs() { try { S.convs = (await api('GET', '/api/dm/conversations')).conversations; } catch {} renderSide(); }
  function openProfile() {
    const dn = el('input', { value: S.me.displayName }); const url = el('input', { value: S.me.avatarUrl.startsWith('data:') ? '' : S.me.avatarUrl }); let dUrl = null;
    const m = el('div', { class: 'modal' }, el('div', { class: 'card' }, el('h3', { class: 'neon-text' }, 'Профиль'), dn, url, el('input', { type: 'file', onchange: async (e) => { if (e.target.files[0]) dUrl = await resizeImage(e.target.files[0], 160); } }),
      el('button', { class: 'btn', style: 'margin-top:10px; width:100%', onclick: async () => { const b = { displayName: dn.value }; if(dUrl) b.avatarUrl = dUrl; else if(url.value !== S.me.avatarUrl) b.avatarUrl = url.value; S.me = (await api('PATCH', '/api/me', b)).user; m.remove(); showApp(); } }, 'Сохр.')));
    document.body.append(m);
  }
  function resizeImage(file, size) { return new Promise((res) => { const img = new Image(); const fr = new FileReader(); fr.onload = () => { img.src = fr.result; }; img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = size; const k = Math.max(size / img.width, size / img.height); c.getContext('2d').drawImage(img, (size - img.width * k) / 2, (size - img.height * k) / 2, img.width * k, img.height * k); res(c.toDataURL('image/jpeg', 0.85)); }; fr.readAsDataURL(file); }); }
  
  function logout() { NL.setToken(''); location.reload(); }
  async function start() { try { const r = await api('GET', '/api/me'); S.me = r.user; S.isAdmin = r.isAdmin; showApp(); } catch (e) { showAuth(); } }
  (async () => { try { S.cfg = await api('GET', '/api/config'); } catch { root.replaceChildren('Сервер недоступен'); return; } if (NL.token()) start(); else showAuth(); })();
})();