const headers = () => ({
  Authorization: `Bearer ${k.value}`,
  'content-type': 'application/json',
});

const commandHeaders = () => {
  const commandId = crypto.randomUUID();
  return {
    ...headers(),
    'Idempotency-Key': commandId,
    'X-Correlation-Id': commandId,
  };
};

async function go() {
  const response = await fetch('/api/v1/jobs', {
    method: 'POST',
    headers: commandHeaders(),
    body: JSON.stringify({
      startUrls: u.value.split(/\n/).filter(Boolean),
      mode: m.value,
      maxPages: +p.value,
      maxDepth: +d.value,
      browser: b.value,
    }),
  });
  o.textContent = await response.text();
  try {
    j.value = JSON.parse(o.textContent).id;
  } catch {}
}

async function st() {
  const status = await fetch(`/api/v1/jobs/${j.value}`, { headers: headers() });
  const results = await fetch(`/api/v1/jobs/${j.value}/results`, { headers: headers() });
  o.textContent = `${await status.text()}\n${await results.text()}`;
}

async function cn() {
  const response = await fetch(`/api/v1/jobs/${j.value}/cancel`, {
    method: 'POST',
    headers: commandHeaders(),
  });
  o.textContent = await response.text();
}
