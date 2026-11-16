async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The server returned an unreadable response.');
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function setFormStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

const supportForm = document.querySelector('#support-form');
if (supportForm) {
  const supportStatus = document.querySelector('#support-status');
  supportForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(supportForm);
    const submit = supportForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    setFormStatus(supportStatus, 'Sending your message…');
    try {
      const result = await requestJson('/api/support', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(formData))
      });
      supportForm.reset();
      setFormStatus(supportStatus, `Message emailed successfully. Your reference number is ${result.ticketId}.`);
    } catch (error) {
      setFormStatus(supportStatus, error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
}

const accountForm = document.querySelector('#account-form');
if (accountForm) {
  const accountTitle = document.querySelector('#account-title');
  const accountNameInput = document.querySelector('#account-name-input');
  const accountNameLabel = document.querySelector('#name-label');
  const accountPassword = document.querySelector('#account-password');
  const accountSubmit = document.querySelector('#account-submit');
  const accountStatus = document.querySelector('#account-status');
  const accountSession = document.querySelector('#account-session');
  const switchButton = document.querySelector('#account-switch');
  const switchPrompt = document.querySelector('#account-switch-prompt');
  let signingUp = false;

  function setAccountMode(isSignup) {
    signingUp = isSignup;
    accountTitle.textContent = isSignup ? 'Create your account' : 'Sign in';
    accountNameInput.hidden = !isSignup;
    accountNameInput.required = isSignup;
    accountNameLabel.hidden = !isSignup;
    accountPassword.autocomplete = isSignup ? 'new-password' : 'current-password';
    accountSubmit.textContent = isSignup ? 'Create account' : 'Sign in';
    switchPrompt.textContent = isSignup ? 'Already have an account?' : 'New to PulseNews?';
    switchButton.textContent = isSignup ? 'Sign in' : 'Create an account';
    setFormStatus(accountStatus, '');
  }

  switchButton.addEventListener('click', () => setAccountMode(!signingUp));
  accountForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    accountSubmit.disabled = true;
    setFormStatus(accountStatus, signingUp ? 'Creating your account…' : 'Signing you in…');
    const formData = new FormData(accountForm);
    try {
      const endpoint = signingUp ? '/api/auth/signup' : '/api/auth/login';
      const result = await requestJson(endpoint, {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(formData))
      });
      accountForm.hidden = true;
      document.querySelector('#account-name').textContent = result.user.name;
      accountSession.hidden = false;
      switchButton.hidden = true;
      switchPrompt.hidden = true;
      accountTitle.textContent = 'Welcome to PulseNews';
    } catch (error) {
      setFormStatus(accountStatus, error.message, true);
    } finally {
      accountSubmit.disabled = false;
    }
  });

  document.querySelector('#sign-out').addEventListener('click', async () => {
    try {
      await requestJson('/api/auth/logout', { method: 'POST', body: '{}' });
      accountSession.hidden = true;
      accountForm.hidden = false;
      switchButton.hidden = false;
      switchPrompt.hidden = false;
      accountForm.reset();
      setAccountMode(false);
    } catch (error) {
      setFormStatus(accountStatus, error.message, true);
    }
  });

  requestJson('/api/auth/me')
    .then(({ user }) => {
      if (!user) return;
      accountForm.hidden = true;
      document.querySelector('#account-name').textContent = user.name;
      accountSession.hidden = false;
      switchButton.hidden = true;
      switchPrompt.hidden = true;
      accountTitle.textContent = 'Welcome to PulseNews';
    })
    .catch((error) => setFormStatus(accountStatus, error.message, true));
}

const donationLink = document.querySelector('#donation-checkout');
if (donationLink) {
  const donationStatus = document.querySelector('#donation-status');
  requestJson('/api/donation')
    .then(({ checkoutUrl }) => {
      if (!checkoutUrl) {
        setFormStatus(donationStatus, 'Secure checkout is not configured yet. Contact us if you would like to support PulseNews.');
        return;
      }
      donationLink.href = checkoutUrl;
      donationLink.hidden = false;
      setFormStatus(donationStatus, 'Your contribution will be processed by our secure payment provider.');
    })
    .catch((error) => setFormStatus(donationStatus, error.message, true));
}
