const configuredApiBaseUrl = typeof window.PULSENEWS_API_BASE_URL === 'string'
  ? window.PULSENEWS_API_BASE_URL.trim().replace(/\/+$/, '')
  : '';
const localServerMode = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const apiBaseUrl = localServerMode ? '' : configuredApiBaseUrl;

async function requestJson(url, options = {}) {
  const requestUrl = apiBaseUrl
    ? `${apiBaseUrl}${url.startsWith('/') ? url : `/${url}`}`
    : url;
  const response = await fetch(requestUrl, {
    ...options,
    credentials: 'include',
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

const donationForm = document.querySelector('#donation-form');
if (donationForm) {
  const donationStatus = document.querySelector('#donation-status');
  const donationButton = document.querySelector('#donation-checkout');
  requestJson('/api/donation')
    .then(({ enabled }) => {
      if (!enabled) {
        setFormStatus(donationStatus, 'Mobile Money checkout is not configured yet. The MTN number is +233551539602.');
        return;
      }
      setFormStatus(donationStatus, 'Secure MTN Mobile Money checkout is ready.');
    })
    .catch((error) => setFormStatus(donationStatus, error.message, true));

  donationForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (typeof window.FlutterwaveCheckout !== 'function') {
      setFormStatus(donationStatus, 'The secure checkout could not load. Refresh the page and try again.', true);
      return;
    }
    const formData = new FormData(donationForm);
    const amount = Number(formData.get('amount'));
    const name = String(formData.get('name') || '').trim();
    const email = String(formData.get('email') || '').trim();
    const phone = String(formData.get('phone') || '').trim();
    donationButton.disabled = true;
    setFormStatus(donationStatus, 'Preparing secure checkout…');
    try {
      const prepared = await requestJson('/api/donation/init', {
        method: 'POST',
        body: JSON.stringify({ amount, name, email, phone })
      });
      window.FlutterwaveCheckout({
        public_key: prepared.publicKey,
        tx_ref: prepared.txRef,
        amount: prepared.amount,
        currency: 'GHS',
        payment_options: 'mobilemoneyghana',
        customer: {
          email: email || 'donor@pulsenews.app',
          name: name || 'PulseNews supporter',
          phonenumber: prepared.phone
        },
        customizations: {
          title: 'PulseNews Donation',
          description: 'Support PulseNews independent journalism',
          logo: `${window.location.origin}/favicon.ico`
        },
        callback: async (response) => {
          if (response.status !== 'successful') {
            setFormStatus(donationStatus, 'Payment was cancelled or not completed.', true);
            donationButton.disabled = false;
            return;
          }
          setFormStatus(donationStatus, 'Verifying your payment…');
          try {
            await requestJson('/api/donation/verify', {
              method: 'POST',
              body: JSON.stringify({ transactionId: response.transaction_id, txRef: prepared.txRef })
            });
            setFormStatus(donationStatus, `Thank you. Your GHS ${prepared.amount.toFixed(2)} donation was received.`);
            donationForm.reset();
          } catch (error) {
            setFormStatus(donationStatus, error.message, true);
          } finally {
            donationButton.disabled = false;
          }
        },
        onclose: () => donationButton.disabled = false
      });
    } catch (error) {
      setFormStatus(donationStatus, error.message, true);
      donationButton.disabled = false;
    }
  });
}
