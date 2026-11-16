(function () {
  const { el, api, avatar, fmt, toast } = NL;
  const root = document.getElementById('root');
  const S = { me: null, isAdmin: false, cfg: {}, view: { type: 'global' }, convs: [], channels: [], socket: null, msgs: [], peer: null };

  const getCheckSVG = (color) => {
    if (!color) return null;
    const span = document.createElement('span');
    span.className = `badge-check check-${color}`;
    span.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-1.9 14.5l-4.6-4.6 1.4-1.4 3.2 3.2 7.2-7.2 1.4 1.4-8.6 8.6z"/></svg>`;
    return span;
  };

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
    document.querySelectorAll('.side-drawer, .side-overlay').forEach(e => e.remove());

    $list = el('div', { class: 'list' });
    
    const me = el('div', { class: 'me', onclick: openProfile }, 
      avatar(S.me, true), 
      el('div', { style: 'min-width:0; display:flex; flex-direction:column;' }, 
        el('b', { style: 'display:flex; align-items:center; gap:4px' }, S.me.displayName, getCheckSVG(S.me.checkmark)), 
        el('small', {}, '@' + S.me.username)
      )
    );
    
    const side = el('aside', { class: 'sidebar' },
      el('div', { class: 'side-head' }, me, el('span', { class: 'neon-text' }, 'NL')),
      el('div', { class: 'search' }, el('input', { type: 'search', placeholder: 'Поиск...' })), $list);

    $title = el('h2', { class: 'neon-text' }, '');
    $headActions = el('div', { class: 'row' });
    
    $chatHead = el('div', { class: 'chat-head' }, 
      el('span', { class: 'back-btn', onclick: () => $app.classList.remove('in-chat') }, '←'),
      el('span', { class: 'hamburger', onclick: () => toggleMenu() }, '☰'),
      $title, $headActions
    );
    
    const storiesBar = el('div', { class: 'stories-bar' });
    loadStories(storiesBar);

    $msgs = el('div', { class: 'messages' });
    $composerTa = el('textarea', { placeholder: 'Сообщение...', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    const composer = el('div', { class: 'composer' }, $composerTa, el('button', { class: 'btn', onclick: send }, '➤'));
    
    const chat = el('main', { class: 'chat' }, $chatHead, storiesBar, $msgs, composer);

    const drawer = el('div', { class: 'side-drawer' },
      el('h2', { class: 'neon-text', style: 'margin-top:0' }, 'Меню'),
      el('div', { class: 'menu-item', onclick: () => { toggleMenu(); openProfile(); } }, 'Профиль'),
      (S.me.checkmark === 'green' || S.me.username === 'CEBA') 
        ? el('div', { class: 'menu-item', onclick: () => { toggleMenu(); createChannel(); } }, 'Создать канал') 
        : null,
      S.isAdmin ? el('div', { class: 'menu-item', onclick: () => location.href='/admin' }, 'Админ-панель') : null,
      el('div', { class: 'menu-item', onclick: logout }, 'Выйти')
    );
    const overlay = el('div', { class: 'side-overlay', onclick: toggleMenu });
    document.body.append(drawer, overlay);

    $app = el('div', { class: 'app' }, side, chat);
    root.replaceChildren($app);
    
    connectSocket(); 
    loadChannels(); // <--- Загружаем каналы
    loadConvs(); 
    openGlobal(false);
  }

  function toggleMenu() {
    document.querySelector('.side-drawer').classList.toggle('open');
    document.querySelector('.side-overlay').classList.toggle('open');
  }

  // --- ЗАГРУЗКА КАНАЛОВ ---
  async function loadChannels() {
    try { S.channels = (await api('GET', '/api/channels')).channels; } catch(e) { console.error(e); }
    renderSide();
  }

  async function loadStories(container) {
    try {
      const { stories } = await api('GET', '/api/stories');
      if (S.me.checkmark === 'green' || S.me.username === 'CEBA') {
        container.append(el('div', { class: 'story-item', onclick: createStory }, el('div', { class: 'story-avatar add' }, '+'), el('div', { class: 'story-name' }, 'Добавить')));
      }
      
      stories.forEach(st => {
        const storyUser = { id: st.user_id, username: st.username, displayName: st.display_name, avatarUrl: st.avatar_url, checkmark: st.checkmark };
        let av = avatar(storyUser, false);
        if (st.content.startsWith('data:image')) {
           av.innerHTML = `<img src="${st.content}" />`;
        }
        container.append(el('div', { class: 'story-item', onclick: () => openStory(st, storyUser) }, av, el('div', { class: 'story-name' }, storyUser.displayName)));
      });
    } catch(e) {}
  }

  function openStory(st, storyUser) {
    const isImage = st.content.startsWith('data:image');
    const contentEl = isImage ? el('img', { src: st.content }) : el('div', { class: 'text-story' }, st.content);

    const modal = el('div', { class: 'story-modal' },
      el('div', { class: 'story-modal-head' },
        avatar(storyUser, false),
        el('b', { style: 'display:flex; align-items:center; gap:4px' }, storyUser.displayName, getCheckSVG(storyUser.checkmark)),
        el('div', { style: 'flex:1' }),
        el('span', { class: 'close', onclick: () => modal.remove() }, '✕')
      ),
      el('div', { class: 'story-modal-content' }, contentEl),
      el('div', { class: 'story-modal-foot' },
        (st.user_id === S.me.id || S.me.username === 'CEBA') 
          ? el('button', { class: 'btn danger', onclick: async () => {
              if (confirm('Удалить историю?')) {
                try { await api('DELETE', '/api/stories/' + st.id); toast('Удалено'); modal.remove(); document.querySelector('.stories-bar').innerHTML=''; loadStories(document.querySelector('.stories-bar')); } catch(e) { toast(e.message); }
              }
            } }, 'Удалить историю')
          : null
      )
    );
    document.body.append(modal);
  }

  async function createStory() {
    const textInput = el('input', { type: 'text', placeholder: 'Текст истории' });
    const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'margin-top:10px' });
    let base64 = null;
    fileInput.onchange = async () => {
      const f = fileInput.files[0]; if (!f) return;
      try { base64 = await resizeImage(f, 400); textInput.value = 'Картинка'; } catch { toast('Ошибка'); }
    };

    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Новая история'), textInput, fileInput,
      el('button', { class: 'btn', style: 'margin-top:15px; width:100%', onclick: async () => {
        const content = base64 || textInput.value.trim();
        if (!content) return;
        try { await api('POST', '/api/stories', { content }); toast('Добавлено'); m.remove(); document.querySelector('.stories-bar').innerHTML=''; loadStories(document.querySelector('.stories-bar')); } catch(e) { toast(e.message); }
      } }, 'Опубликовать')));
    document.body.append(m);
  }

  // --- СОЗДАНИЕ КАНАЛА ---
  function createChannel() {
    const name = el('input', { type: 'text', placeholder: 'Название канала' });
    const desc = el('input', { type: 'text', placeholder: 'Описание' });
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Создать канал'), name, desc,
      el('button', { class: 'btn', style: 'margin-top:15px; width:100%', onclick: async () => {
        if (!name.value.trim()) return toast('Введите название', 'error');
        try { 
          await api('POST', '/api/channels', { name: name.value, description: desc.value }); 
          toast('Канал создан'); 
          m.remove(); 
          loadChannels(); // <--- Обновляем список каналов в меню
        } catch(e) { toast(e.message); }
      } }, 'Создать')));
    document.body.append(m);
  }

  function renderSide() {
    const g = el('div', { class: 'item' + (S.view.type === 'global' ? ' active' : ''), onclick: () => openGlobal(true) }, el('div', { class: 'avatar' }, '#'), el('div', { class: 'meta' }, el('b', {}, 'Общая лента')));
    
    // Рендерим каналы
    const channelItems = S.channels.map(c => 
      el('div', { class: 'item', onclick: () => toast('Вход в канал ' + c.name + ' пока в разработке') }, 
        el('div', { class: 'avatar', style: 'background:#1b241b; color:#ccff00; font-weight:bold;' }, '📢'), 
        el('div', { class: 'meta' }, 
          el('b', {}, c.name, getCheckSVG(c.checkmark)),
          el('span', {}, c.description || 'Канал')
        )
      )
    );

    $list.replaceChildren(g, ...channelItems, ...S.convs.map((c) => userItem(c.user, c.lastText)));
  }

  function userItem(u, sub) {
    return el('div', { class: 'item' + (S.view.type === 'dm' && S.view.peerId === u.id ? ' active' : ''), onclick: () => openDm(u.id) },
      avatar(u), el('div', { class: 'meta' }, 
        el('b', {}, u.displayName, getCheckSVG(u.checkmark)), 
        el('span', {}, sub || '@' + u.username)));
  }

  async function loadConvs() { try { S.convs = (await api('GET', '/api/dm/conversations')).conversations; } catch {} renderSide(); }

  function openGlobal(showChat) { 
    S.view = { type: 'global' }; 
    $title.textContent = '# Общая лента'; 
    $headActions.replaceChildren(); 
    S.msgs = []; renderSide(); loadHistory(); 
    if (showChat) $app.classList.add('in-chat');
  }
  
  async function openDm(id) { 
    S.view = { type: 'dm', peerId: id }; 
    $title.textContent = 'Загрузка...'; 
    S.msgs = []; await loadHistory(); renderSide(); 
    $app.classList.add('in-chat');
  }

  async function loadHistory() {
    const url = S.view.type === 'global' ? '/api/messages' : '/api/dm/' + S.view.peerId;
    const d = await api('GET', url);
    if (S.view.type === 'dm') {
      S.peer = d.peer;
      $title.textContent = d.peer.displayName;
    }
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
        !mine ? el('div', { class: 'who' }, author.displayName, getCheckSVG(author.checkmark)) : null,
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
    const url = el('input', { type: 'url', placeholder: 'URL аватарки', value: S.me.avatarUrl.startsWith('data:') ? '' : S.me.avatarUrl });
    let dataUrl = null;
    const preview = el('div', {}, avatar(S.me));
    const file = el('input', { type: 'file', accept: 'image/*', style: 'margin-top:10px', onchange: async () => {
      const f = file.files[0]; if (!f) return;
      try { dataUrl = await resizeImage(f, 160); preview.replaceChildren(avatar({ ...S.me, avatarUrl: dataUrl })); } catch { toast('Ошибка'); }
    } });
    
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text' }, 'Профиль'),
      el('div', { style: 'margin-bottom:10px' }, preview),
      el('div', { class: 'field' }, el('label', {}, 'Имя'), dn),
      el('div', { class: 'field' }, el('label', {}, 'URL Аватарки'), url),
      el('div', { class: 'field' }, el('label', {}, 'Или загрузите файл'), file),
      el('button', { class: 'btn', style: 'margin-top:10px; width:100%', onclick: async () => {
        try { 
          const body = { displayName: dn.value };
          if (dataUrl) body.avatarUrl = dataUrl;
          else if (url.value.trim() !== S.me.avatarUrl) body.avatarUrl = url.value.trim();
          S.me = (await api('PATCH', '/api/me', body)).user; m.remove(); showApp(); 
        } catch(e) { toast(e.message); }
      } }, 'Сохранить')));
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

  function logout() { NL.setToken(''); location.reload(); }

  async function start() {
    try { const r = await api('GET', '/api/me'); S.me = r.user; S.isAdmin = r.isAdmin; showApp(); } catch (e) { showAuth(); }
  }

  (async () => {
    try { S.cfg = await api('GET', '/api/config'); } catch { root.replaceChildren('Сервер недоступен'); return; }
    if (NL.token()) start(); else showAuth();
  })();
})();