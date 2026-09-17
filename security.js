(() => {
  let currentUser = null;
  const allowed = {
    Administrator: ['Dashboard','Live Radar','Targets','Sensors','Alerts','GSM Status','System Status','Event History','Settings','Admin'],
    Operator: ['Dashboard','Live Radar','Targets','Sensors','Alerts','GSM Status','System Status','Event History'],
    Viewer: ['Dashboard','Live Radar','Targets','Sensors','Alerts','GSM Status','System Status']
  };
  const api = async (url, options = {}) => { const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data; };
  function showMessage(message) { if (typeof showToast === 'function') showToast(message); else alert(message); }
  function profile() { return `<div class="side-status" style="bottom:25px"><strong>${currentUser.username.toUpperCase()}</strong><span>${currentUser.role}</span><button class="secondary" style="width:100%;margin-top:10px;padding:7px" id="logoutButton">LOGOUT</button></div>`; }
  function applyRole() {
    document.querySelectorAll('#nav button').forEach(button => button.style.display = allowed[currentUser.role].includes(button.dataset.page) ? '' : 'none');
    document.querySelector('.side-status').outerHTML = profile();
    document.getElementById('logoutButton').onclick = logout;
    document.querySelector('.topbar').insertAdjacentHTML('beforeend', `<div class="connection" id="profileHeader"><b>${currentUser.username.toUpperCase()}</b><br><span>${currentUser.role}</span></div>`);
    if (!allowed[currentUser.role].includes(page)) go('Dashboard');
  }
  async function login(event) {
    event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('button[type=submit]'); submit.disabled = true;
    try { const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: form.username.value, password: form.password.value }) }); currentUser = data.user; document.getElementById('login').classList.add('hidden'); document.getElementById('app').classList.remove('hidden'); applyRole(); render(); if (currentUser.mustChangePassword) showMessage('This account is using its initial password. Ask an administrator to reset it before production use.'); }
    catch (error) { showMessage(error.message); } finally { submit.disabled = false; }
  }
  async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } finally { currentUser = null; document.getElementById('app').classList.add('hidden'); document.getElementById('login').classList.remove('hidden'); document.getElementById('loginForm').reset(); } }
  async function manageUsers() {
    const host = document.querySelector('#content .card'); const data = await api('/api/users');
    host.innerHTML = `<div class="section-title"><h3>USER MANAGEMENT</h3><button class="secondary" id="createUser">CREATE USER</button></div><div class="table-scroll"><table><thead><tr><th>USERNAME</th><th>ROLE</th><th>STATUS</th><th>LAST LOGIN</th><th>ACTIONS</th></tr></thead><tbody>${data.users.map(user => `<tr><td>${user.username}</td><td>${user.role}</td><td><span class="badge ${user.enabled ? '' : 'critical'}">${user.enabled ? 'ACTIVE' : 'DISABLED'}</span></td><td>${user.lastLogin ? new Date(user.lastLogin).toLocaleString() : 'Never'}</td><td><button class="secondary" data-action="toggle" data-id="${user.id}">${user.enabled ? 'DISABLE' : 'ENABLE'}</button> <button class="secondary" data-action="role" data-id="${user.id}">ROLE</button> <button class="secondary" data-action="reset" data-id="${user.id}">RESET PASSWORD</button></td></tr>`).join('')}</tbody></table></div>`;
    host.querySelector('#createUser').onclick = async () => { const username = prompt('Username (3–32 letters, numbers, . _ or -):'); if (!username) return; const password = prompt('Temporary password (at least 8 characters):'); if (!password) return; const role = prompt('Role: Administrator, Operator, or Viewer', 'Viewer'); if (!role) return; try { await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role }) }); showMessage('User created.'); manageUsers(); } catch (error) { showMessage(error.message); } };
    host.querySelectorAll('[data-action]').forEach(button => button.onclick = async () => { const id = button.dataset.id, action = button.dataset.action; try { if (action === 'toggle') { if (!confirm('Change this account status?')) return; await api(`/api/users/${id}/toggle`, { method: 'PATCH' }); } if (action === 'role') { const role = prompt('New role: Administrator, Operator, or Viewer'); if (!role || !confirm('Change this user’s role?')) return; await api(`/api/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }); } if (action === 'reset') { const password = prompt('New temporary password (at least 8 characters):'); if (!password || !confirm('Reset this user’s password?')) return; await api(`/api/users/${id}/reset-password`, { method: 'PATCH', body: JSON.stringify({ password }) }); } showMessage('User updated.'); manageUsers(); } catch (error) { showMessage(error.message); } });
  }
  const originalRenderForRbac = render;
  render = function () { originalRenderForRbac(); if (currentUser && page === 'Admin' && currentUser.role === 'Administrator') manageUsers().catch(error => showMessage(error.message)); };
  const oldForm = document.getElementById('loginForm'); const form = oldForm.cloneNode(true); oldForm.replaceWith(form);
  form.innerHTML = `<div class="eyebrow">SECURE MONITORING PORTAL</div><h1>DOPPLER RADAR SYSTEM</h1><p>Sign in to access the monitoring dashboard.</p><div class="field"><label for="username">USERNAME</label><input id="username" name="username" autocomplete="username" required></div><div class="field"><label for="password">PASSWORD</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><button class="primary" type="submit">LOGIN</button>`;
  form.addEventListener('submit', login);
  fetch('/api/auth/session').then(response => response.ok ? response.json() : null).then(data => { if (data?.user) { currentUser = data.user; document.getElementById('splash').classList.add('hidden'); document.getElementById('login').classList.add('hidden'); document.getElementById('app').classList.remove('hidden'); applyRole(); render(); } });
})();
