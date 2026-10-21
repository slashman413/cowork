class APIClient {
  constructor() {
    this.baseUrl = '/api';
  }

  async request(endpoint, options = {}) {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      if (!response.ok) {
        // Surface the server's structured error. Endpoints reject with a JSON
        // body like { error: "Field \"X\" is required" }; without this the caller
        // only ever sees an opaque "API Error: 400 Bad Request" and can't tell
        // why the request failed (e.g. a blank required interaction field).
        let detail = '';
        try {
          const body = await response.clone().json();
          detail = body?.error || body?.message || '';
        } catch {
          try {
            const text = (await response.clone().text()).trim();
            const preMatch = text.match(/<pre>(.*?)<\/pre>/is);
            if (preMatch) {
              detail = preMatch[1].trim();
            } else if (text.startsWith('<')) {
              detail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            } else {
              detail = text;
            }
          } catch { /* ignore */ }
        }
        throw new Error(detail || `API Error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error fetching ${endpoint}:`, error);
      throw error;
    }
  }

  get(endpoint) {
    return this.request(endpoint, { method: 'GET' });
  }

  post(endpoint, data) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  patch(endpoint, data) {
    return this.request(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  put(endpoint, data) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  del(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }
}

window.api = new APIClient();
