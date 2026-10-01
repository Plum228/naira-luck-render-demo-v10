async function sendVerificationEmail(to, code) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) throw new Error('Email delivery is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject: 'Naira Luck: подтвердите адрес почты',
      text: `Код подтверждения: ${code}. Срок действия: 10 минут. Если вы не запрашивали код, игнорируйте письмо.`
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Email provider returned status ${response.status}`);
}

module.exports = { sendVerificationEmail };
