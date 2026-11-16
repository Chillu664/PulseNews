function doPost(event) {
  const properties = PropertiesService.getScriptProperties();
  const expectedSecret = properties.getProperty('SUPPORT_SHARED_SECRET');
  const recipient = properties.getProperty('SUPPORT_EMAIL_TO');
  const payload = JSON.parse(event.postData.contents);

  if (!expectedSecret || payload.secret !== expectedSecret) {
    return jsonResponse({ ok: false, error: 'Unauthorized request.' });
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  const ticketId = typeof payload.id === 'string' ? payload.id : '';
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) ||
      !name || name.length > 80 || /[\r\n]/.test(name) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !subject || subject.length > 120 || /[\r\n]/.test(subject) ||
      !message || message.length > 5000) {
    return jsonResponse({ ok: false, error: 'Invalid support message.' });
  }

  const body = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Subject: ${subject}`,
    `Reference: ${ticketId}`,
    `Received: ${payload.createdAt || ''}`,
    '',
    message
  ].join('\n');

  GmailApp.sendEmail(recipient, `PulseNews support: ${subject}`, body, {
    replyTo: email,
    name: 'PulseNews Support'
  });
  return jsonResponse({ ok: true });
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
