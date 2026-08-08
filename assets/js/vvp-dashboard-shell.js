/* Shared practitioner dashboard shell: auth check, sidebar credential card,
   topbar profile chip + avatar upload, sign-out, calendar nav toggle, and
   the Senna AI assistant panel. Pages call initVvpDashboardShell() once and
   get back { sb, userId, practitionerId, profile, practitioner, displayName }
   to continue with their own page-specific data loading. */

function vvpInitials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function initVvpDashboardShell() {
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const checking = document.getElementById('checking');
  const shell = document.getElementById('shell');

  return sb.auth.getSession().then(({ data }) => {
    if (!data.session) { window.location.href = 'login.html'; return Promise.reject(new Error('no-session')); }
    const userId = data.session.user.id;

    return sb.from('profiles').select('role, full_name').eq('id', userId).single().then(({ data: profile, error }) => {
      if (error || !profile || (profile.role !== 'practitioner' && profile.role !== 'admin')) {
        window.location.href = 'login.html';
        return Promise.reject(new Error('not-a-practitioner'));
      }

      return sb.from('practitioners')
        .select('id, full_name, avatar_url, booking_url, calendar_id, commission_level, commission_id')
        .eq('user_id', userId).single().then(({ data: prac }) => {
          const displayName = (prac && prac.full_name) || profile.full_name || data.session.user.email;
          const practitionerId = prac ? prac.id : null;

          const nameEl = document.getElementById('profile-name');
          if (nameEl) nameEl.textContent = displayName;
          const roleEl = document.getElementById('profile-role');
          if (roleEl) roleEl.textContent = profile.role === 'admin' ? 'Admin' : 'Practitioner';

          const avatarBtn = document.getElementById('avatar-btn');
          if (avatarBtn) {
            if (prac && prac.avatar_url) {
              avatarBtn.style.backgroundImage = "url('" + prac.avatar_url + "')";
              avatarBtn.textContent = '';
            } else {
              avatarBtn.textContent = vvpInitials(displayName);
            }
          }

          if (prac && (prac.booking_url || prac.calendar_id)) {
            const calLink = document.getElementById('calendar-nav-link');
            if (calLink) {
              if (prac.booking_url) {
                calLink.href = prac.booking_url;
              } else {
                calLink.href = 'practitioner-dashboard.html#upcoming-events-list';
                calLink.removeAttribute('target');
              }
              calLink.hidden = false;
              const soonEl = document.getElementById('calendar-nav-soon');
              if (soonEl) soonEl.hidden = true;
            }
          }

          if (prac && prac.commission_level) {
            const credCard = document.getElementById('credential-card');
            if (credCard) {
              credCard.hidden = false;
              document.getElementById('credential-level').innerHTML =
                '<svg viewBox="0 0 24 24" fill="var(--vvp-gold)" style="width:14px;height:14px;"><path d="M12 2l2.9 6.3L22 9l-5 4.9L18.2 21 12 17.6 5.8 21 7 13.9 2 9l7.1-.7Z"/></svg> ' +
                prac.commission_level + ' Accredited';
              document.getElementById('credential-id').textContent = prac.commission_id ? ('ID: ' + prac.commission_id) : '';

              sb.from('practitioner_certifications').select('name, level').eq('practitioner_id', prac.id).then(({ data: certs }) => {
                if (!certs || !certs.length) return;
                document.getElementById('credential-certs').innerHTML = certs.map((c) =>
                  '<span>' + c.name + (c.level ? ' — ' + c.level : '') + '</span>'
                ).join('');
              });
            }
          }

          if (checking) checking.hidden = true;
          if (shell) shell.hidden = false;

          wireVvpAvatarUpload(sb, practitionerId);
          wireVvpSignOut(sb);
          wireVvpSenna(sb, practitionerId);

          return { sb, userId, practitionerId, profile, practitioner: prac, displayName };
        });
    });
  });
}

function wireVvpAvatarUpload(sb, practitionerId) {
  const avatarBtn = document.getElementById('avatar-btn');
  const avatarInput = document.getElementById('avatar-input');
  if (!avatarBtn || !avatarInput) return;

  avatarBtn.addEventListener('click', () => avatarInput.click());

  avatarInput.addEventListener('change', function () {
    const file = this.files[0];
    if (!file || !practitionerId) return;
    const ext = file.name.split('.').pop();
    const path = 'practitioner/' + practitionerId + '/avatar.' + ext;

    sb.storage.from('avatars').upload(path, file, { upsert: true }).then(({ error }) => {
      if (error) { alert('Photo upload failed: ' + error.message); return; }
      const { data: pub } = sb.storage.from('avatars').getPublicUrl(path);
      const url = pub.publicUrl + '?t=' + Date.now();
      sb.from('practitioners').update({ avatar_url: url }).eq('id', practitionerId).then(() => {
        avatarBtn.style.backgroundImage = "url('" + url + "')";
        avatarBtn.textContent = '';
      });
    });
  });
}

function wireVvpSignOut(sb) {
  const btn = document.getElementById('sign-out-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    sb.auth.signOut().then(() => { window.location.href = 'login.html'; });
  });
}

function wireVvpSenna(sb, practitionerId) {
  const toggleBtn = document.getElementById('senna-toggle-btn');
  const sennaPanel = document.getElementById('senna-panel');
  if (!toggleBtn || !sennaPanel) return;

  const sennaMessages = document.getElementById('senna-messages');
  const sennaForm = document.getElementById('senna-form');
  const sennaInput = document.getElementById('senna-input');
  const sennaSendBtn = document.getElementById('senna-send-btn');
  const sennaClientSelect = document.getElementById('senna-client-select');
  let sennaClientsLoaded = false;

  toggleBtn.addEventListener('click', () => {
    sennaPanel.hidden = false;
    if (!sennaClientsLoaded && practitionerId) {
      sennaClientsLoaded = true;
      sb.from('clients').select('id, full_name').eq('practitioner_id', practitionerId)
        .order('full_name').then(({ data }) => {
          (data || []).forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.full_name;
            sennaClientSelect.appendChild(opt);
          });
        });
    }
  });

  const closeBtn = document.getElementById('senna-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => { sennaPanel.hidden = true; });

  function addSennaMessage(text, cls) {
    const emptyNote = sennaMessages.querySelector('.senna-empty');
    if (emptyNote) emptyNote.remove();
    const bubble = document.createElement('div');
    bubble.className = 'senna-msg ' + cls;
    bubble.textContent = text;
    sennaMessages.appendChild(bubble);
    sennaMessages.scrollTop = sennaMessages.scrollHeight;
  }

  if (sennaForm) {
    sennaForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = sennaInput.value.trim();
      if (!text) return;

      addSennaMessage(text, 'user');
      sennaInput.value = '';
      sennaInput.disabled = true;
      sennaSendBtn.disabled = true;

      const clientId = sennaClientSelect.value || undefined;

      sb.functions.invoke('senna-assistant', { body: { message: text, client_id: clientId } })
        .then(({ data, error }) => {
          sennaInput.disabled = false;
          sennaSendBtn.disabled = false;
          sennaInput.focus();
          if (error) {
            addSennaMessage("Senna couldn't respond: " + error.message, 'error');
            return;
          }
          if (data && data.error) {
            addSennaMessage("Senna couldn't respond: " + data.error, 'error');
            return;
          }
          addSennaMessage((data && data.reply) || '(No response)', 'assistant');
        });
    });
  }
}
