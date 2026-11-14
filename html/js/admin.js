// NeonLink Admin (доступ только для username === 'CEBA'; реальная защита — на сервере, middleware adminOnly)
(function () {
  const { el, api, fmt, toast } = NL;
  const root = document.getElementById('root');
  const content = el('div');
  let tab = 'users', maintenanceBox;

  async function init() {
    try {
      const r = await api('GET', '/api/me');
      if (!r.isAdmin || r.user.username !== 'CEBA') throw new Error('Доступ запрещён');
    } catch (e) {
      root.replaceChildren(el('div', { class: 'auth-wrap' }, el('div', { class: 'card auth-card' },
        el('h1', { class: 'neon-text' }, 'Admin'), el('div', { class: 'err', style: 'text-align:center' }, e.message === 'Доступ запрещён' ? e.message : 'Требуется вход'),
        el('div', { style: 'text-align:center' }, el('a', { href: '/' }, '← В мессенджер'))))); return;
    }
    const tabs = el('div', { class: 'atabs' });
    const names = { users: 'Пользователи', feed: 'Общая лента', dm: 'Личные чаты', audit: 'Audit log' };
    const draw = () => tabs.replaceChildren(...Object.entries(names).map(([k, v]) =>
      el('button', { class: 'btn ghost small' + (tab === k ? ' active' : ''), onclick: () => { tab = k; draw(); render(); } }, v)));
    maintenanceBox = el('div', { class: 'emergency' });
    root.replaceChildren(el('div', { class: 'admin' },
      el('header', {}, el('h1', { class: 'neon-text' }, 'NeonLink · Admin'), el('a', { class: 'btn ghost small', href: '/', style: 'text-decoration:none' }, '← Мессенджер')),
      maintenanceBox, tabs, content));
    draw(); loadMaintenance(); render();
  }

  async function loadMaintenance() {
    const { maintenance } = await api('GET', '/api/admin/maintenance');
    maintenanceBox.className = 'emergency' + (maintenance ? ' on' : '');
    maintenanceBox.replaceChildren(
      el('span', {}, maintenance ? '🚨 Экстренный режим ВКЛЮЧЁН: регистрация и отправка сообщений заблокированы для всех, кроме админов' : 'Экстренный режим выключен'),
      el('button', { class: 'btn' + (maintenance ? '' : ' danger'), onclick: async () => {
        if (!confirm(maintenance ? 'Выключить экстренный режим?' : 'Включить экстренный режим?')) return;
        await api('POST', '/api/admin/maintenance', { enabled: !maintenance }); loadMaintenance();
      } }, maintenance ? 'Выключить' : 'Включить'));
  }

  const render = () => { content.replaceChildren(el('div', { class: 'empty' }, 'Загрузка…')); ({ users, feed, dm, audit })[tab]().catch((e) => toast(e.message)); };
  const table = (head, rows) => el('div', { class: 'tbl-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
  const pager = (page, pages, go) => el('div', { class: 'pager' },
    el('button', { class: 'btn ghost small', disabled: page <= 1, onclick: () => go(page - 1) }, '←'), `стр. ${page} / ${pages}`,
    el('button', { class: 'btn ghost small', disabled: page >= pages, onclick: () => go(page + 1) }, '→'));

  // ---------- users ----------
  async function users(q = '') {
    const { users } = await api('GET', '/api/admin/users?q=' + encodeURIComponent(q));
    const search = el('input', { type: 'search', placeholder: 'Поиск…', value: q, onkeydown: (e) => e.key === 'Enter' && users2(search.value) });
    const users2 = (v) => users_(v);
    const rows = users.map((u) => el('tr', {},
      el('td', {}, u.id), el('td', {}, u.username), el('td', {}, u.display_name),
      el('td', {}, u.avatar_url ? el('code', {}, u.avatar_url.startsWith('data:') ? '(uploaded)' : u.avatar_url.slice(0, 40)) : '—'),
      el('td', {}, u.role), el('td', {}, u.is_blocked ? '🚫' : '✓'), el('td', {}, fmt(u.created_at)),
      el('td', {}, el('div', { class: 'row', style: 'flex-wrap:wrap' },
        el('button', { class: 'btn ghost small', onclick: () => editUser(u) }, 'Изменить'),
        el('button', { class: 'btn ghost small', onclick: () => resetPw(u) }, 'Пароль'),
        el('button', { class: 'btn ghost small', onclick: async () => { await api('PATCH', '/api/admin/users/' + u.id, { isBlocked: !u.is_blocked }).catch((e) => toast(e.message)); render(); } }, u.is_blocked ? 'Разблок.' : 'Блок'),
        el('button', { class: 'btn danger small', onclick: async () => { if (confirm(`Удалить ${u.username} и все его сообщения?`)) { await api('DELETE', '/api/admin/users/' + u.id).catch((e) => toast(e.message)); render(); } } }, 'Удалить')))));
    content.replaceChildren(el('div', { class: 'filters' }, search), table(['ID', 'Username', 'Имя', 'Аватар', 'Роль', 'Статус', 'Создан', ''], rows));
  }
  const users_ = (q) => users(q).catch((e) => toast(e.message));

  async function editUser(u) {
    const f = { username: el('input', { value: u.username }), displayName: el('input', { value: u.display_name }),
      avatarUrl: el('input', { value: u.avatar_url.startsWith('data:') ? '' : u.avatar_url, placeholder: 'https://…' }),
      role: el('select', {}, ['user', 'admin', 'owner'].map((r) => el('option', { value: r, selected: r === u.role }, r))) };
    const blocked = el('input', { type: 'checkbox', style: 'width:auto' }); blocked.checked = u.is_blocked;
    const err = el('div', { class: 'err' });
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text', style: 'margin-top:0' }, 'Редактирование #' + u.id),
      ...[['username', 'Username'], ['displayName', 'Display name'], ['avatarUrl', 'Avatar URL'], ['role', 'Роль']].map(([k, l]) => el('div', { class: 'field' }, el('label', {}, l), f[k])),
      el('label', { class: 'row', style: 'margin-bottom:10px' }, blocked, 'Заблокирован'), err,
      el('div', { class: 'row', style: 'justify-content:flex-end' }, el('button', { class: 'btn ghost', onclick: () => m.remove() }, 'Отмена'),
        el('button', { class: 'btn', onclick: async () => {
          const body = { username: f.username.value, displayName: f.displayName.value, role: f.role.value, isBlocked: blocked.checked };
          if (f.avatarUrl.value !== (u.avatar_url.startsWith('data:') ? '' : u.avatar_url)) body.avatarUrl = f.avatarUrl.value.trim();
          try { await api('PATCH', '/api/admin/users/' + u.id, body); m.remove(); render(); } catch (e) { err.textContent = e.message; }
        } }, 'Сохранить'))));
    document.body.append(m);
  }
  async function resetPw(u) {
    const pw = await NL.prompt(`Новый пароль для ${u.username} (мин. 8 символов)`);
    if (!pw) return;
    try { await api('POST', `/api/admin/users/${u.id}/reset-password`, { password: pw }); toast('Пароль изменён'); } catch (e) { toast(e.message); }
  }

  // ---------- message tables (feed / dm) ----------
  async function msgEdit(url, old) {
    const t = await NL.prompt('Изменить текст (будет помечено «edited by admin»)', old, true);
    if (t == null || !t.trim()) return false;
    try { await api('PATCH', url, { text: t }); return true; } catch (e) { toast(e.message); return false; }
  }
  const msgRow = (id, who, text, at, editedByAdmin, editUrl, delUrl, reload) => el('tr', {},
    el('td', {}, id), el('td', {}, who), el('td', { style: 'white-space:pre-wrap;word-break:break-word;max-width:480px' }, text, editedByAdmin ? el('span', { class: 'tag-admin' }, '  [edited by admin]') : null),
    el('td', {}, fmt(at)), el('td', {}, el('div', { class: 'row' },
      el('button', { class: 'btn ghost small', onclick: async () => (await msgEdit(editUrl, text)) && reload() }, 'Изменить'),
      el('button', { class: 'btn danger small', onclick: async () => { if (confirm('Удалить сообщение?')) { await api('DELETE', delUrl).catch((e) => toast(e.message)); reload(); } } }, 'Удалить'))));

  async function feed(page = 1) {
    const d = await api('GET', '/api/admin/feed?page=' + page);
    const go = (p) => feed(p).catch((e) => toast(e.message));
    content.replaceChildren(el('div', { class: 'hint' }, `Всего: ${d.total}`),
      table(['ID', 'Автор', 'Текст', 'Время', ''], d.messages.map((m) => msgRow(m.id, '@' + m.user.username, m.text, m.createdAt, m.editedByAdmin, '/api/admin/feed/' + m.id, '/api/admin/feed/' + m.id, () => go(page)))),
      pager(d.page, d.pages, go));
  }

  async function dm() {
    const { pairs } = await api('GET', '/api/admin/dm/pairs');
    content.replaceChildren(table(['Пользователь A', 'Пользователь B', 'Сообщений', 'Последнее', ''], pairs.map((p) => el('tr', {},
      el('td', {}, '@' + p.a_name), el('td', {}, '@' + p.b_name), el('td', {}, p.cnt), el('td', {}, fmt(p.last_at)),
      el('td', {}, el('button', { class: 'btn ghost small', onclick: () => openPair(p) }, 'Открыть'))))));
  }
  async function openPair(p, page = 1) {
    const d = await api('GET', `/api/admin/dm/${p.a_id}/${p.b_id}?page=${page}`);
    const names = { [p.a_id]: '@' + p.a_name, [p.b_id]: '@' + p.b_name };
    const go = (n) => openPair(p, n).catch((e) => toast(e.message));
    content.replaceChildren(el('div', { class: 'row', style: 'margin-bottom:10px' }, el('button', { class: 'btn ghost small', onclick: render }, '← К списку'),
      el('b', {}, `${names[p.a_id]} ↔ ${names[p.b_id]}`)),
      table(['ID', 'От', 'Текст', 'Время', ''], d.messages.map((m) => msgRow(m.id, names[m.senderId], m.text, m.createdAt, m.editedByAdmin, '/api/admin/dm/msg/' + m.id, '/api/admin/dm/msg/' + m.id, () => go(page)))),
      pager(d.page, d.pages, go));
  }

  // ---------- audit ----------
  async function audit() {
    const action = el('select', {}, el('option', { value: '' }, 'Все действия'), ...['login', 'login_failed', 'register', 'message_send', 'message_edit', 'message_delete', 'dm_send', 'dm_edit', 'dm_delete', 'profile_update',
      'admin_user_update', 'admin_user_delete', 'admin_password_reset', 'admin_feed_edit', 'admin_feed_delete', 'admin_dm_view', 'admin_dm_edit', 'admin_dm_delete', 'admin_maintenance'].map((a) => el('option', { value: a }, a)));
    const uname = el('input', { type: 'search', placeholder: 'Username…' });
    const load = async () => {
      const d = await api('GET', `/api/admin/audit?action=${encodeURIComponent(action.value)}&username=${encodeURIComponent(uname.value)}`);
      body.replaceChildren(...d.logs.map((l) => el('tr', {}, el('td', {}, l.id), el('td', {}, fmt(l.created_at)), el('td', {}, l.username || '—'), el('td', {}, l.action),
        el('td', {}, el('code', {}, JSON.stringify(l.details))), el('td', {}, l.ip || ''))));
    };
    const body = el('tbody');
    action.onchange = () => load().catch((e) => toast(e.message));
    uname.onkeydown = (e) => e.key === 'Enter' && load().catch((x) => toast(x.message));
    content.replaceChildren(el('div', { class: 'filters' }, action, uname, el('button', { class: 'btn small', onclick: () => load().catch((e) => toast(e.message)) }, 'Обновить')),
      el('div', { class: 'hint' }, 'Последние 200 записей'),
      el('div', { class: 'tbl-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['ID', 'Время', 'Пользователь', 'Действие', 'Детали', 'IP'].map((h) => el('th', {}, h)))), body)));
    await load();
  }

  init();
})();
