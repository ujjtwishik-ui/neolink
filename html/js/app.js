(function () {
  const { el, api, avatar, fmt, toast } = NL;
  const root = document.getElementById('root');
  const S = { me: null, isAdmin: false, cfg: {}, view: { type: 'global' }, convs: [], channels: [], socket: null, msgs: [], peer: null, currentChannel: null };

  const getSVG = (name, size = 20) => {
    const icons = {
      channel: `<path fill="currentColor" d="M12 11.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4.5 4.5l-2.5-2.5 2.5-2.5V16zM12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"/>`,
      settings: `<path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>`,
      trash: `<path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>`,
      exit: `<path fill="currentColor" d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>`,
      link: `<path fill="currentColor" d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>`,
      plus: `<path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>`,
      send: `<path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>`,
      close: `<path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>`
    };
    return `<svg viewBox="0 0 24 24" style="width:${size}px; height:${size}px; display:inline-block; vertical-align:middle; fill:currentColor;">${icons[name] || ''}</svg>`;
  };

  const getCheckSVG = (color) => {
    if (!color) return null;
    const s = document.createElement('span'); s.className = `badge-check check-${color}`;
    s.innerHTML = `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-1.9 14.5l-4.6-4.6 1.4-1.4 3.2 3.2 7.2-7.2 1.4 1.4-8.6 8.6z"/></svg>`;
    return s;
  };

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
    
    const fabBtn = el('div', { class: 'fab-btn', onclick: openAddMenu }, el('div', { html: getSVG('plus', 28) }));
    
    const side = el('aside', { class: 'sidebar' },
      el('div', { class: 'side-head' }, me, el('span', { class: 'neon-text' }, 'NL')),
      el('div', { class: 'search' }, el('input', { type: 'search', placeholder: 'Поиск...' })), $list, fabBtn);

    $title = el('h2', { class: 'neon-text' }, '');
    $headActions = el('div', { class: 'row', style: 'gap: 8px;' });
    $chatHead = el('div', { class: 'chat-head' }, 
      el('span', { class: 'back-btn', onclick: () => $app.classList.remove('in-chat') }, '←'),
      el('span', { class: 'hamburger', onclick: () => toggleMenu() }, el('div', { html: `<svg viewBox="0 0 24 24" style="width:24px;height:24px;fill:var(--lime1);"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>` })),
      $title, $headActions);

    const storiesBar = el('div', { class: 'stories-bar' }); loadStories(storiesBar);
    $msgs = el('div', { class: 'messages' });
    $composerTa = el('textarea', { placeholder: 'Сообщение...', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    const chat = el('main', { class: 'chat' }, $chatHead, storiesBar, $msgs, el('div', { class: 'composer' }, $composerTa, el('button', { class: 'btn', onclick: send }, el('div', { html: getSVG('send', 20) }))));

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

  function openAddMenu() {
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Действия'),
      el('button', { class: 'btn', style: 'width:100%; margin-bottom:10px', onclick: () => { m.remove(); createChannel(); } }, 'Создать канал'),
      el('button', { class: 'btn ghost', style: 'width:100%; margin-bottom:10px', onclick: () => { m.remove(); joinChannel(); } }, 'Войти по коду канала'),
      el('button', { class: 'btn ghost', style: 'width:100%; margin-bottom:10px', onclick: () => { m.remove(); findUser(); } }, 'Найти человека (Начать чат)'),
      el('button', { class: 'btn ghost', style: 'width:100%', onclick: () => m.remove() }, 'Отмена')
    ));
    document.body.append(m);
  }

  function findUser() {
    const un = el('input', { placeholder: 'Введите @username' });
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Поиск человека'), un,
      el('button', { class: 'btn', style: 'margin-top:15px; width:100%', onclick: async () => {
        try { 
          const res = await api('GET', '/api/users?q=' + encodeURIComponent(un.value.trim())); 
          if (!res.users.length) return toast('Пользователь не найден');
          m.remove();
          openDm(res.users[0].id);
        } catch(e) { toast(e.message); }
      } }, 'Найти и написать')));
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

  async function loadChannels() { 
    try { S.channels = (await api('GET', '/api/channels')).channels; } catch {} 
    renderSide(); 
  }

  function renderSide() {
    const g = el('div', { class: 'item' + (S.view.type === 'global' ? ' active' : ''), onclick: () => openGlobal(true) }, el('div', { class: 'avatar' }, '#'), el('div', { class: 'meta' }, el('b', {}, 'Общая лента')));
    
    const channelItems = S.channels.map(c => {
      const av = c.avatar_url ? el('img', { src: c.avatar_url, style: 'width:100%; height:100%; border-radius:50%' }) : el('div', { class: 'avatar', style: 'background:#1b241b; color:#ccff00; display:flex; align-items:center; justify-content:center;' }, el('div', { html: getSVG('channel', 24) }));
      return el('div', { class: 'item' + (S.view.type === 'channel' && S.view.channelId === c.id ? ' active' : ''), onclick: () => openChannel(c) }, 
        av, el('div', { class: 'meta' }, el('b', {}, c.name, getCheckSVG(c.checkmark)), el('span', {}, c.description || 'Канал')));
    });
    $list.replaceChildren(g, ...channelItems, ...S.convs.map((c) => userItem(c.user, c.lastText)));
  }

  function userItem(u, sub) {
    return el('div', { class: 'item' + (S.view.type === 'dm' && S.view.peerId === u.id ? ' active' : ''), onclick: () => openDm(u.id) }, avatar(u), el('div', { class: 'meta' }, el('b', {}, u.displayName, getCheckSVG(u.checkmark)), el('span', {}, sub || '@' + u.username)));
  }

  function openGlobal(showChat) {
    S.view = { type: 'global' }; $title.textContent = '# Общая лента'; $headActions.replaceChildren(); S.msgs = []; renderSide(); loadHistory(); if (showChat) $app.classList.add('in-chat');
  }
  
  async function openDm(id) {
    S.view = { type: 'dm', peerId: id }; $title.textContent = 'Загрузка...'; $headActions.replaceChildren(); S.msgs = []; await loadHistory(); renderSide(); $app.classList.add('in-chat');
  }

  async function openChannel(c) {
    S.view = { type: 'channel', channelId: c.id }; $title.textContent = c.name; S.currentChannel = c;
    
    // Если я создатель или CEBA - показываем шестеренку, код и удаление.
    if (c.owner_id === S.me.id || S.me.username === 'CEBA') {
      $headActions.replaceChildren(
        el('button', { class: 'btn ghost small', onclick: () => editMyChannel(c), title: 'Настройки' }, el('div', { html: getSVG('settings', 18) })),
        el('button', { class: 'btn ghost small', onclick: () => alert('Код приглашения: ' + c.invite_code), title: 'Код' }, el('div', { html: getSVG('link', 18) })),
        el('button', { class: 'btn danger small', onclick: () => deleteMyChannel(c.id), title: 'Удалить' }, el('div', { html: getSVG('trash', 18) }))
      );
    } else {
      // Для обычных юзеров - кнопка выхода
      $headActions.replaceChildren(el('button', { class: 'btn danger small', onclick: () => leaveChannel(c.id), title: 'Выйти' }, el('div', { html: getSVG('exit', 18) })));
    }

    S.msgs = []; await loadHistory(); renderSide(); $app.classList.add('in-chat');
    if (S.socket) S.socket.emit('join:channel', c.id);
  }

  function editMyChannel(c) {
    const name = el('input', { value: c.name }); const desc = el('input', { value: c.description || '' }); let dUrl = null;
    const file = el('input', { type: 'file', accept: 'image/*', style: 'margin-top:10px' });
    file.onchange = async () => { if (file.files[0]) { dUrl = await resizeImage(file.files[0], 160); toast('Файл загружен'); } };

    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Настройки канала'), name, desc, el('label', {}, 'Аватарка (картинка):'), file,
      el('button', { class: 'btn', style: 'margin-top:15px; width:100%', onclick: async () => {
        try {
          const b = { name: name.value, description: desc.value };
          if (dUrl) b.avatar_url = dUrl;
          await api('PATCH', '/api/channels/' + c.id, b); 
          toast('Сохранено'); m.remove(); await loadChannels(); openChannel({...c, name: name.value, description: desc.value, avatar_url: dUrl || c.avatar_url});
        } catch(e) { toast(e.message); }
      } }, 'Сохранить')));
    document.body.append(m);
  }

  async function deleteMyChannel(id) {
    if (!confirm('Удалить канал навсегда? Это действие необратимо.')) return;
    try { 
      await api('DELETE', '/api/channels/' + id); 
      toast('Канал удален'); 
      await loadChannels(); // Дожидаемся обновления
      openGlobal(true); 
    } catch(e) { toast(e.message); }
  }

  async function leaveChannel(id) {
    if (!confirm('Вы уверены, что хотите выйти из канала?')) return;
    try { 
      await api('DELETE', '/api/channels/' + id + '/leave'); 
      toast('Вы вышли'); 
      await loadChannels(); // Дожидаемся обновления
      openGlobal(true); 
    } catch(e) { toast(e.message); }
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
      if (S.me.checkmark === 'green' || S.me.username === 'CEBA') container.append(el('div', { class: 'story-item', onclick: createStory }, el('div', { class: 'story-avatar add' }, el('div', { html: getSVG('plus', 24) })), el('div', { class: 'story-name' }, 'Добавить')));
      stories.forEach(st => {
        const storyUser = { id: st.user_id, username: st.username, displayName: st.display_name, avatarUrl: st.avatar_url, checkmark: st.checkmark };
        let av = avatar(storyUser, false); if (st.content.startsWith('data:image')) av.innerHTML = `<img src="${st.content}" />`;
        container.append(el('div', { class: 'story-item', onclick: () => openStory(st, storyUser) }, av, el('div', { class: 'story-name' }, storyUser.displayName)));
      });
    } catch(e) {}
  }
  
  function openStory(st, storyUser) {
    const modal = el('div', { class: 'story-modal' }, el('div', { class: 'story-modal-head' }, avatar(storyUser, false), el('b', {}, storyUser.displayName, getCheckSVG(storyUser.checkmark)), el('div', { style: 'flex:1' }), el('span', { class: 'close', onclick: () => modal.remove(), style: 'display:flex' }, el('div', { html: getSVG('close', 24) }))),
      el('div', { class: 'story-modal-content' }, st.content.startsWith('data:image') ? el('img', { src: st.content }) : el('div', { class: 'text-story' }, st.content)),
      el('div', { class: 'story-modal-foot' }, (st.user_id === S.me.id || S.me.username === 'CEBA') ? el('button', { class: 'btn danger', onclick: async () => { await api('DELETE', '/api/stories/' + st.id); modal.remove(); document.querySelector('.stories-bar').innerHTML=''; loadStories(document.querySelector('.stories-bar')); } }, el('div', { html: getSVG('trash', 18) })) : null));
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