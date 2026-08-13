class SSEClient {
  constructor(url, handlers = {}) {
    this.url = url;
    this.handlers = handlers;
    this.eventSource = null;
    this.reconnectTimeout = null;
    this.reconnectDelay = 1000;
    // Cap the MANUAL reconnect backoff low. This path only runs when the browser
    // has fully given up (readyState CLOSED); a transient blip is handled by the
    // browser's own fast native reconnect (see onerror), so there is no reason to
    // ever stretch the badge out to the old 30s ceiling.
    this.maxReconnectDelay = 8000;
  }

  connect() {
    if (this.eventSource) {
      this.eventSource.close();
    }

    this.updateStatus('connecting');
    this.eventSource = new EventSource(this.url);

    this.eventSource.onopen = () => {
      this.updateStatus('connected');
      this.reconnectDelay = 1000;
      if (this.handlers.onConnect) this.handlers.onConnect();
    };

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (this.handlers.onMessage) this.handlers.onMessage(data);
        
        if (data.type && this.handlers[data.type]) {
          this.handlers[data.type](data.payload);
        }
      } catch (error) {
        console.error('Error parsing SSE message:', error);
      }
    };

    this.eventSource.onerror = () => {
      // EventSource fires onerror on any hiccup — including transient blips it will
      // recover from on its own. If it is still CONNECTING, the browser is already
      // auto-reconnecting (fast, using the server's `retry:` hint); tearing it down
      // here and starting our own exponential backoff is what used to strand the
      // badge on "Connecting…" for up to the old 30s ceiling. So only take over the
      // reconnect when the stream is truly CLOSED.
      if (this.eventSource && this.eventSource.readyState === EventSource.CONNECTING) {
        this.updateStatus('connecting');
        return; // let the native reconnect finish; onopen/onmessage will flip to connected
      }
      if (this.eventSource) this.eventSource.close();
      this.updateStatus('disconnected');
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    
    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  updateStatus(status) {
    if (this.handlers.onStatusChange) {
      this.handlers.onStatusChange(status);
    }
  }

  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    clearTimeout(this.reconnectTimeout);
    this.updateStatus('disconnected');
  }
}

window.SSEClient = SSEClient;
