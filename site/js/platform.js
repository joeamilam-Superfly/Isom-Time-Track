// Platform-wide tools, visible only to super admins (independent of which
// company they're currently switched into, since super_admin is a
// person-level flag, not a company role).

async function renderPlatform(opts) {
  root.innerHTML = `
    ${topbarHtml()}
    <main>
      ${roleTabsHtml('platform')}
      <div class="screen-title">Platform</div>
      <div class="screen-sub">Super admin tools, not tied to any one company.</div>

      <div class="screen-sub" style="font-weight:600; color:var(--ink); margin-bottom:8px;">Super admins</div>
      <div id="super-admin-list">${loadingHtml()}</div>
      <button class="btn btn-ghost btn-sm" id="grant-super-admin-btn" style="margin: 14px 0 24px;">+ Grant super admin</button>
    </main>
  `;

  attachTopbarHandlers();
  attachRoleTabHandlers();

  document.getElementById('grant-super-admin-btn').addEventListener('click', showGrantSuperAdminDialog);

  loadSuperAdminList();
}

async function loadSuperAdminList() {
  try {
    const data = await api('/super-admin-management');
    renderSuperAdminList(data.superAdmins || []);
  } catch (err) {
    document.getElementById('super-admin-list').innerHTML = errorHtml(err.message);
  }
}

function renderSuperAdminList(superAdmins) {
  const el = document.getElementById('super-admin-list');
  if (superAdmins.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:20px;">No super admins found.</div>`;
    return;
  }

  el.innerHTML = superAdmins.map(s => `
    <div class="employee-row">
      <div>
        <div class="employee-name">${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)}</div>
        <div class="employee-meta">${escapeHtml(s.phone)}</div>
      </div>
      ${s.id !== state.employee.id ? `<button class="btn btn-sm btn-danger" data-revoke="${s.id}">Revoke</button>` : `<span class="status-pill status-admin_approved">You</span>`}
    </div>
  `).join('');

  el.querySelectorAll('[data-revoke]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-revoke');
      if (!confirm('Revoke super admin status from this person?')) return;
      try {
        await api('/super-admin-management', {
          method: 'PUT',
          body: JSON.stringify({ employeeId: id, superAdmin: false }),
        });
        loadSuperAdminList();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function showGrantSuperAdminDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,21,20,0.5);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px;max-width:380px;width:100%;">
      <div style="font-weight:700;font-size:17px;margin-bottom:14px;">Grant super admin</div>
      <div class="screen-sub">This gives someone admin-level access at every company on the platform, including ones they don't already have a role at. They must already exist as an employee somewhere first. Granting this does not remove your own super admin access.</div>
      <div class="field">
        <label for="grant-phone">Their mobile number</label>
        <input id="grant-phone" type="tel" inputmode="tel" placeholder="(864) 555-0123" />
      </div>
      <div id="grant-error"></div>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn btn-ghost" id="grant-cancel">Cancel</button>
        <button class="btn btn-primary" id="grant-save">Grant</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('grant-cancel').addEventListener('click', () => document.body.removeChild(overlay));

  document.getElementById('grant-save').addEventListener('click', async () => {
    const phone = document.getElementById('grant-phone').value.trim();
    const errorEl = document.getElementById('grant-error');
    errorEl.innerHTML = '';

    if (!phone) {
      errorEl.innerHTML = errorHtml('Phone number is required.');
      return;
    }

    try {
      await api('/super-admin-management', {
        method: 'PUT',
        body: JSON.stringify({ phone, superAdmin: true }),
      });
      document.body.removeChild(overlay);
      loadSuperAdminList();
    } catch (err) {
      errorEl.innerHTML = errorHtml(err.message);
    }
  });
}
