function renderLogin() {
  root.innerHTML = `
    <div class="topbar" style="justify-content:center;">
      <div class="mark">
        <div class="mark-box">I</div>
        <div>
          <span class="mark-text">ISOM Electric</span>
          <span class="mark-sub">Weekly Timesheet</span>
        </div>
      </div>
    </div>
    <main>
      <div class="screen-title">Welcome back</div>
      <div class="screen-sub">Log in with your phone number and PIN.</div>

      <div id="login-error"></div>

      <form id="login-form">
        <div class="field">
          <label for="phone">Mobile number</label>
          <input id="phone" type="tel" inputmode="tel" placeholder="(864) 555-0123" autocomplete="tel" required />
        </div>
        <div class="field">
          <label for="pin">PIN</label>
          <input id="pin" class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••" autocomplete="current-password" required />
        </div>
        <button type="submit" class="btn btn-primary" id="login-btn">Log in</button>
      </form>
    </main>
  `;

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('phone').value;
    const pin = document.getElementById('pin').value;
    const btn = document.getElementById('login-btn');
    const errorEl = document.getElementById('login-error');
    errorEl.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Logging in...';

    try {
      const data = await api('/auth-login', {
        method: 'POST',
        body: JSON.stringify({ phone, pin }),
      });
      saveSession(data.token, data.employee, data.companies);
      state.currentWeekOf = sundayOf(todayStr());
      render('week');
    } catch (err) {
      errorEl.innerHTML = `<div class="banner banner-warn">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
