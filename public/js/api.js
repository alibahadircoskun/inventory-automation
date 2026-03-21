const API = {
  async get(url) {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 401) { window.location.href = '/'; return null; }
      throw new Error(`GET ${url}: ${res.status}`);
    }
    return res.json();
  },
  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      if (res.status === 401) { window.location.href = '/'; return null; }
      throw new Error(`POST ${url}: ${res.status}`);
    }
    return res.json();
  },
  async put(url, body) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      if (res.status === 401) { window.location.href = '/'; return null; }
      throw new Error(`PUT ${url}: ${res.status}`);
    }
    return res.json();
  },
  async del(url) {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      if (res.status === 401) { window.location.href = '/'; return null; }
      throw new Error(`DELETE ${url}: ${res.status}`);
    }
    return res.json();
  }
};
