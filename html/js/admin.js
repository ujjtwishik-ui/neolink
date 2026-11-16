(function () {
  const { el, api, fmt, toast } = NL;
  const root = document.getElementById('root');
  const content = el('div');
  let tab = 'users', maintenanceBox;

  const getCheckSVG = (color) => { if (!color) return null; const s = document.createElement('span'); s.className = `badge-check check-${color}`; s.innerHTML = `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-1.9 14.5l-4.6-4.6 1.4-1.4 3.2 3.2 7.2-7.2 1.4 1.4-8.6 8.6z"/></svg>`; return s; };

  async function init() {
    try { const r = await api('GET', '/api/me'); if (!r.isAdmin) throw 0; } catch { return root.replaceChildren('Доступ запрещен'); }
    const tabs = el('div', { class: 'atabs' });
    const names = { users: 'Пользователи', channels: 'Каналы', feed: 'Общая лента', audit: 'Audit log' };
    const draw = () => tabs.replaceChildren(...Object.entries(names).map(([k, v]) => el('button', { class: 'btn ghost small' + (tab === k ? ' active' : ''), onclick: () => { tab = k; draw(); render(); } }, v)));
    maintenanceBox = el('div', { class: 'emergency' });
    root.replaceChildren(el('div', { class: 'admin' }, el('header', {}, el('h1', { class: 'neon-text' }, 'NeonLink Admin'), el('a', { class: 'btn ghost small', href: '/' }, '← Назад')), maintenanceBox, tabs, content));
    draw(); loadMaintenance(); render();
  }

  async function loadMaintenance() {
    const { maintenance } = await api('GET', '/api/admin/maintenance');
    maintenanceBox.className = 'emergency' + (maintenance ? ' on' : '');
    maintenanceBox.replaceChildren(el('span', {}, maintenance ? '🚨 ВКЛ' : 'Выкл'), el('button', { class: 'btn small', onclick: async () => { await api('POST', '/api/admin/maintenance', { enabled: !maintenance }); loadMaintenance(); } }, 'Сменить'));
  }

  const render = () => { content.replaceChildren('Загрузка...'); ({ users, channels, feed, audit })[tab]().catch((e) => toast(e.message)); };
  const table = (head, rows) => el('div', { class: 'tbl-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows)));

  async function users() {
    const { users } = await api('GET', '/api/admin/users');
    const rows = users.map((u) => el('tr', {}, el('td', {}, u.id), el('td', {}, u.username), el('td', {}, u.display_name),
      el('td', {}, u.checkmark ? getCheckSVG(u.checkmark) : '—'), el('td', {}, u.role),
      el('td', {}, el('div', { class: 'row' }, el('button', { class: 'btn ghost small', onclick: () => editUser(u) }, 'Ред.')))));
    content.replaceChildren(table(['ID', 'Username', 'Имя', 'Галка', 'Роль', ''], rows));
  }

  async function editUser(u) {
    const f = { username: el('input', { value: u.username }), displayName: el('input', { value: u.display_name }),
      checkmark: el('select', {}, [['', 'Нет'], ['green', 'Зеленая'], ['blue', 'Синяя'], ['gold', 'Золотая']].map(([v, l]) => el('option', { value: v, selected: u.checkmark === v }, l))) };
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' }, el('h3', {}, 'Ред. юзера'),
      el('div', {}, 'Username', f.username), el('div', {}, 'Имя', f.displayName), el('div', {}, 'Галка', f.checkmark),
      el('button', { class: 'btn', onclick: async () => { await api('PATCH', '/api/admin/users/' + u.id, { username: f.username.value, displayName: f.displayName.value, checkmark: f.checkmark.value || null }); m.remove(); render(); } }, 'Сохр.')));
    document.body.append(m);
  }

  async function channels() {
    const { channels } = await api('GET', '/api/admin/channels');
    const rows = channels.map(c => el('tr', {}, el('td', {}, c.id), el('td', {}, c.name), el('td', {}, '@' + c.owner_name), el('td', {}, c.invite_code || '—'),
      el('td', {}, c.checkmark ? getCheckSVG(c.checkmark) : '—'),
      el('td', {}, el('div', { class: 'row' },
        el('button', { class: 'btn ghost small', onclick: () => editChannel(c) }, 'Ред.'),
        el('button', { class: 'btn danger small', onclick: async () => { if (confirm('Удалить?')) { await api('DELETE', '/api/admin/channels/' + c.id); render(); } } }, 'Удал.')
      ))));
    content.replaceChildren(table(['ID', 'Название', 'Создатель', 'Код', 'Галка', 'Действия'], rows));
  }

  async function editChannel(c) {
    const f = { name: el('input', { value: c.name }), desc: el('input', { value: c.description || '' }), avatar: el('input', { value: c.avatar_url || '', placeholder: 'URL аватарки' }),
      checkmark: el('select', {}, [['', 'Нет'], ['green', 'Зеленая'], ['blue', 'Синяя'], ['gold', 'Золотая']].map(([v, l]) => el('option', { value: v, selected: c.checkmark === v }, l))) };
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' }, el('h3', {}, 'Ред. канала'),
      el('div', {}, 'Название', f.name), el('div', {}, 'Описание', f.desc), el('div', {}, 'Аватар (URL)', f.avatar), el('div', {}, 'Галка', f.checkmark),
      el('button', { class: 'btn', style: 'margin-top:10px', onclick: async () => { await api('PATCH', '/api/admin/channels/' + c.id, { name: f.name.value, description: f.desc.value, avatar_url: f.avatar.value, checkmark: f.checkmark.value || null }); m.remove(); render(); } }, 'Сохр.')));
    document.body.append(m);
  }

  async function feed() {
    const d = await api('GET', '/api/admin/feed');
    content.replaceChildren(table(['ID', 'Автор', 'Текст', 'Действия'], d.messages.map((m) => el('tr', {}, el('td', {}, m.id), el('td', {}, '@' + m.user.username), el('td', {}, m.text),
      el('td', {}, el('button', { class: 'btn danger small', onclick: async () => { if (confirm('Удалить?')) { await api('DELETE', '/api/admin/feed/' + m.id); render(); } } }, 'Удал.'))))));
  }

  async function audit() {
    const d = await api('GET', '/api/admin/audit');
    content.replaceChildren(table(['ID', 'Кто', 'Действие'], d.logs.map(l => el('tr', {}, el('td', {}, l.id), el('td', {}, l.username || '—'), el('td', {}, l.action)))));
  }

  init();
})();