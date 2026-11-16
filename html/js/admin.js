(function () {
  const { el, api, fmt, toast } = NL;
  const root = document.getElementById('root');
  const content = el('div');
  let tab = 'users', maintenanceBox;

  // НОВАЯ ИДЕАЛЬНАЯ ГАЛОЧКА
  const getCheckSVG = (color) => {
    if (!color) return null;
    const span = document.createElement('span');
    span.className = `badge-check check-${color}`;
    span.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-1.9 14.5l-4.6-4.6 1.4-1.4 3.2 3.2 7.2-7.2 1.4 1.4-8.6 8.6z"/></svg>`;
    return span;
  };

  async function init() {
    try {
      const r = await api('GET', '/api/me');
      if (!r.isAdmin || r.user.username !== 'CEBA') throw new Error('Доступ запрещён');
    } catch (e) {
      root.replaceChildren(el('div', { class: 'auth-wrap' }, el('div', { class: 'card auth-card' },
        el('h1', { class: 'neon-text' }, 'Admin'), el('div', { class: 'err', style: 'text-align:center' }, 'Требуется вход' ),
        el('div', { style: 'text-align:center' }, el('a', { href: '/' }, '← В мессенджер'))))); return;
    }
    const tabs = el('div', { class: 'atabs' });
    const names = { users: 'Пользователи', channels: 'Каналы', feed: 'Общая лента', dm: 'Личные чаты', audit: 'Audit log' };
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
      el('span', {}, maintenance ? '🚨 Экстренный режим ВКЛ' : 'Экстренный режим выключен'),
      el('button', { class: 'btn' + (maintenance ? '' : ' danger'), onclick: async () => {
        if (!confirm('Сменить режим?')) return;
        await api('POST', '/api/admin/maintenance', { enabled: !maintenance }); loadMaintenance();
      } }, maintenance ? 'Выключить' : 'Включить'));
  }

  const render = () => { content.replaceChildren(el('div', { class: 'empty', style: 'text-align:center; padding:20px' }, 'Загрузка…')); ({ users, channels, feed, dm, audit })[tab]().catch((e) => toast(e.message)); };
  const table = (head, rows) => el('div', { class: 'tbl-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows)));

  async function users() {
    const { users } = await api('GET', '/api/admin/users');
    const rows = users.map((u) => el('tr', {},
      el('td', {}, u.id), el('td', {}, u.username), el('td', {}, u.display_name),
      el('td', {}, u.checkmark ? getCheckSVG(u.checkmark) : '—'),
      el('td', {}, u.role), el('td', {}, u.is_blocked ? '🚫' : '✓'),
      el('td', {}, el('div', { class: 'row', style: 'flex-wrap:wrap; gap:5px' },
        el('button', { class: 'btn ghost small', onclick: () => editUser(u) }, 'Изменить'),
        el('button', { class: 'btn ghost small', onclick: async () => { await api('PATCH', '/api/admin/users/' + u.id, { isBlocked: !u.is_blocked }).catch((e) => toast(e.message)); render(); } }, u.is_blocked ? 'Разблок.' : 'Блок')))));
    content.replaceChildren(table(['ID', 'Username', 'Имя', 'Галка', 'Роль', 'Статус', ''], rows));
  }

  async function editUser(u) {
    const f = { 
      username: el('input', { value: u.username }), 
      displayName: el('input', { value: u.display_name }),
      checkmark: el('select', {}, 
        el('option', { value: '', selected: !u.checkmark }, 'Нет'),
        el('option', { value: 'green', selected: u.checkmark === 'green' }, 'Зеленая ✔'),
        el('option', { value: 'blue', selected: u.checkmark === 'blue' }, 'Синяя ✔'),
        el('option', { value: 'gold', selected: u.checkmark === 'gold' }, 'Золотая ✔')
      ) 
    };
    const m = el('div', { class: 'modal', onclick: (e) => e.target === m && m.remove() }, el('div', { class: 'card' },
      el('h3', { class: 'neon-text', style: 'margin-top:0' }, 'Редактирование #' + u.id),
      el('div', { class: 'field' }, el('label', {}, 'Username'), f.username),
      el('div', { class: 'field' }, el('label', {}, 'Имя'), f.displayName),
      el('div', { class: 'field' }, el('label', {}, 'Галочка'), f.checkmark),
      el('div', { class: 'row', style: 'justify-content:flex-end; gap:8px' }, el('button', { class: 'btn ghost', onclick: () => m.remove() }, 'Отмена'),
        el('button', { class: 'btn', onclick: async () => {
          await api('PATCH', '/api/admin/users/' + u.id, { username: f.username.value, displayName: f.displayName.value, checkmark: f.checkmark.value || null });
          m.remove(); render();
        } }, 'Сохранить'))));
    document.body.append(m);
  }

  async function channels() {
    const { channels } = await api('GET', '/api/admin/channels');
    const rows = channels.map(c => el('tr', {},
      el('td', {}, c.id), el('td', {}, c.name), el('td', {}, '@' + c.owner_name),
      el('td', {}, c.checkmark ? getCheckSVG(c.checkmark) : '—'),
      el('td', {}, el('button', { class: 'btn ghost small', onclick: () => {
        const newMark = prompt('Галочка (green, blue, gold, пусто):', c.checkmark || '');
        if (newMark !== null) api('PATCH', '/api/admin/channels/' + c.id, { checkmark: newMark.trim() || null }).then(render);
      } }, 'Изменить'))
    ));
    content.replaceChildren(table(['ID', 'Название', 'Владелец', 'Галка', ''], rows));
  }

  async function feed(page = 1) {
    const d = await api('GET', '/api/admin/feed?page=' + page);
    content.replaceChildren(table(['ID', 'Автор', 'Текст', 'Время', ''], d.messages.map((m) => el('tr', {},
      el('td', {}, m.id), el('td', {}, '@' + m.user.username), el('td', {}, m.text),
      el('td', {}, fmt(m.createdAt)),
      el('td', {}, el('div', { class: 'row', style: 'gap:5px' },
        el('button', { class: 'btn ghost small', onclick: () => {
          const t = prompt('Новый текст:', m.text); if (t) api('PATCH', '/api/admin/feed/' + m.id, { text: t }).then(render);
        } }, 'Ред.'),
        el('button', { class: 'btn danger small', onclick: () => { if (confirm('Удалить?')) api('DELETE', '/api/admin/feed/' + m.id).then(render); } }, 'Удал.')))))));
  }

  async function dm() {
    const { pairs } = await api('GET', '/api/admin/dm/pairs');
    content.replaceChildren(table(['A', 'B', 'Кол-во', 'Последнее'], pairs.map((p) => el('tr', {},
      el('td', {}, '@' + p.a_name), el('td', {}, '@' + p.b_name), el('td', {}, p.cnt), el('td', {}, fmt(p.last_at))))));
  }

  async function audit() {
    const d = await api('GET', '/api/admin/audit');
    content.replaceChildren(table(['ID', 'Время', 'Кто', 'Действие', 'Детали'], d.logs.map(l => el('tr', {},
      el('td', {}, l.id), el('td', {}, fmt(l.created_at)), el('td', {}, l.username || '—'), el('td', {}, l.action), el('td', {}, JSON.stringify(l.details))))));
  }

  init();
})();