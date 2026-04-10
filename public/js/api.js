const API = {
  async request(method, url, body) {
    const options = {
      method,
      headers: {},
      cache: 'no-store',
      credentials: 'same-origin'
    };

    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await res.json().catch(() => null)
      : await res.text().catch(() => null);

    if (!res.ok) {
      if (res.status === 401 && typeof App !== 'undefined') {
        window.location.href = '/';
        return null;
      }

      const error = new Error(payload?.error || `${method} ${url}: ${res.status}`);
      error.status = res.status;
      error.data = payload;
      throw error;
    }

    return payload;
  },

  get(url) {
    return API.request('GET', url);
  },

  post(url, body) {
    return API.request('POST', url, body);
  },

  put(url, body) {
    return API.request('PUT', url, body);
  },

  del(url) {
    return API.request('DELETE', url);
  }
};
