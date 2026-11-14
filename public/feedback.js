// Sends the feedback form to Telly. Nothing else on this page needs JavaScript.
const form = document.getElementById('feedback-form');
const result = document.getElementById('feedback-result');
const button = document.getElementById('feedback-send');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = form.message.value.trim();
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, page: document.referrer ? new URL(document.referrer).pathname : '/feedback' }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'That didn’t send. Try again in a moment.');
    form.message.value = '';
    result.textContent = 'Thanks for letting us know.';
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});
