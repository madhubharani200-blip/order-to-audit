/* app.js — shared utilities for all pages */
const API = '';  // same origin

/* ── Auth helpers ─────────────────────────────────────────────────────── */
function getToken()   { return localStorage.getItem('token'); }
function getUser()    { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } }
function logout()     { localStorage.removeItem('token'); localStorage.removeItem('user'); location.href = '/login.html'; }

function requireAuth(allowedRoles) {
  const token = getToken();
  const user = getUser();
  if (!token || !user) { location.href = '/login.html'; return null; }
  if (allowedRoles && !allowedRoles.includes(user.role)) { location.href = '/login.html'; return null; }
  return user;
}

/* ── Fetch wrapper ────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (res.status === 401) { logout(); return; }
  return res;
}

async function apiJSON(path, opts) {
  const res = await api(path, opts);
  if (!res) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ── Offline banner ───────────────────────────────────────────────────── */
function showOffline(msg = 'You appear to be offline. Please check your connection.') {
  let banner = document.getElementById('offline-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.className = 'offline-banner show';
    document.body.appendChild(banner);
  }
  banner.textContent = msg;
  banner.classList.add('show');
  setTimeout(() => banner.classList.remove('show'), 6000);
}

/* ── Nav bar builder ──────────────────────────────────────────────────── */
function buildNav() {
  const user = getUser();
  if (!user) return;
  const role = user.role;
  const page = location.pathname.split('/').pop();

  const links = [];
  if (['salesman','admin','owner'].includes(role))
    links.push({ href: 'orders.html', label: 'Orders' });
  if (['admin','owner'].includes(role))
    links.push({ href: 'admin.html', label: 'Admin' });
  if (['production','admin','owner'].includes(role))
    links.push({ href: 'production.html', label: 'Production' });
  if (['admin','production','auditor','owner'].includes(role))
    links.push({ href: 'stock.html', label: 'Stock' });
  if (['auditor','owner','admin'].includes(role))
    links.push({ href: 'reports.html', label: 'Reports' });

  const nav = document.getElementById('top-nav');
  if (!nav) return;
  nav.innerHTML = `
    <span class="brand">Kaveri Crunch</span>
    ${links.map(l => `<a href="${l.href}" class="${page === l.href ? 'active' : ''}">${l.label}</a>`).join('')}
    <span class="spacer"></span>
    <span style="font-size:.82rem;opacity:.8">${user.displayName || user.username} (${role})</span>
    <button id="logoutBtn" onclick="logout()">Logout</button>
  `;
}

/* ── Formatting helpers ───────────────────────────────────────────────── */
function paisaToRs(p) { return (p / 100).toFixed(2); }
function fmtRs(p) { return '₹' + paisaToRs(p); }
function statusBadge(s) {
  const map = {
    draft:'badge-grey',pending:'badge-yellow',approved:'badge-blue',
    confirmed:'badge-blue',dispatched:'badge-green',cancelled:'badge-red',
    issued:'badge-green',partially_paid:'badge-yellow',paid:'badge-green',
    credit_note:'badge-red',completed:'badge-green',
    partially_dispatched:'badge-yellow',
  };
  return `<span class="badge ${map[s]||'badge-grey'}">${s}</span>`;
}

/* ── Table builder ────────────────────────────────────────────────────── */
function buildTable(rows, cols, { empty = 'No data' } = {}) {
  if (!rows.length) return `<p class="text-secondary">${empty}</p>`;
  const ths = cols.map(c => `<th class="${c.num?'num':''}">${c.label}</th>`).join('');
  const trs = rows.map(r => {
    const tds = cols.map(c => `<td class="${c.num?'num':''}">${c.render ? c.render(r) : (r[c.key]??'')}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

/* ── Init ─────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  buildNav();
});
