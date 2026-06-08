// temp marker
/**
 * TradiumDatafeed — simple UDF REST + WebSocket adapter.
 * Exposes: searchSymbols, getHistoryKLineData, subscribe, unsubscribe.
 */

(function (global) {
  'use strict';

  var FRAME_TYPES = { ERROR: 1, CANDLES: 5 };

  function isAuthError(status) {
    return status === 401 || status === 403;
  }

  function isWsAuthClose(code, reason) {
    if (code === 1008) return true;
    if (code >= 4000 && code <= 4099) return true;
    var text = String(reason || '').toLowerCase();
    return text.indexOf('auth') !== -1 ||
      text.indexOf('token') !== -1 ||
      text.indexOf('unauthorized') !== -1 ||
      text.indexOf('expired') !== -1;
  }

  function TradiumDatafeed(options) {
    options = options || {};
    this.udfUrl = options.udfUrl || '';
    this.wsUrl = options.wsUrl || '';
    this.debug = Boolean(options.debug);
    this.barsPerRequest = options.barsPerRequest || 500;

    this.connectionUserId = options.connectionUserId || '';
    this.connectionGroupId = options.connectionGroupId || '';
    this.defaultCurrencyCode = options.defaultCurrencyCode || 'USD';

    this.getAccessToken = typeof options.getAccessToken === 'function'
      ? options.getAccessToken
      : function () { return null; };
    this.onRefreshToken = typeof options.onRefreshToken === 'function'
      ? options.onRefreshToken
      : null;

    this.onAuthFailure = options.onAuthFailure || function () {};
    this.onConnect = options.onConnect || function () {};
    this.onDisconnect = options.onDisconnect || function () {};
    this.onError = options.onError || console.error;

    this.ws = null;
    this.connectionState = 'disconnected';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.maxReconnectDelay = options.maxReconnectDelay || 5000;
    this.isActive = false;

    this._refreshPromise = null;
    this._subscriptions = {};
    this._proCallbacks = {};
  }

  TradiumDatafeed.prototype.log = function () {
    if (!this.debug) return;
    console.log.apply(console, ['[TradiumDatafeed]'].concat([].slice.call(arguments)));
  };

  TradiumDatafeed.prototype._buildHeaders = function () {
    var headers = { Accept: 'application/json' };
    var token = this.getAccessToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  };

  TradiumDatafeed.prototype._extractAccessToken = function (value) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (value && typeof value === 'object') {
      if (typeof value.accessToken === 'string' && value.accessToken.length > 0) return value.accessToken;
      if (value.data && typeof value.data.accessToken === 'string' && value.data.accessToken.length > 0) return value.data.accessToken;
    }
    return null;
  };

  TradiumDatafeed.prototype._refreshAccessToken = function () {
    var self = this;
    if (!this.onRefreshToken) return Promise.resolve(null);
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = Promise.resolve()
      .then(function () { return self.onRefreshToken(); })
      .then(function (value) { return self._extractAccessToken(value); })
      .catch(function (err) {
        self.onError('[Auth] refresh callback failed:', err);
        return null;
      })
      .finally(function () {
        self._refreshPromise = null;
      });
    return this._refreshPromise;
  };

  TradiumDatafeed.prototype._withCommonParams = function (params, endpoint) {
    var next = Object.assign({}, params || {});
    if (this.connectionUserId) next['connection-user-id'] = this.connectionUserId;
    if (this.connectionGroupId) next['connection-group-id'] = this.connectionGroupId;
    if ((endpoint === '/history' || endpoint === '/symbols') && !next.currencyCode && this.defaultCurrencyCode) {
      next.currencyCode = this.defaultCurrencyCode;
    }
    return next;
  };

  TradiumDatafeed.prototype.periodToResolution = function (period) {
    var m = period.multiplier;
    switch (period.timespan) {
      case 'second': return m + 'S';
      case 'minute': return String(m);
      case 'hour': return String(m * 60);
      case 'day': return m + 'D';
      case 'week': return m + 'W';
      case 'month': return m + 'M';
      case 'year': return (m * 12) + 'M';
      default: return '1D';
    }
  };

  TradiumDatafeed.prototype.udfBarsToCandles = function (data) {
    if (!data || data.s !== 'ok' || !Array.isArray(data.t) || data.t.length === 0) return [];
    var out = [];
    for (var i = 0; i < data.t.length; i++) {
      var ts = data.t[i];
      out.push({
        timestamp: ts > 1e12 ? ts : ts * 1000,
        open: data.o[i],
        high: data.h[i],
        low: data.l[i],
        close: data.c[i],
        volume: data.v ? data.v[i] : 0,
        turnover: 0
      });
    }
    return out;
  };

  TradiumDatafeed.prototype._buildUrl = function (endpoint, params) {
    var url = this.udfUrl + endpoint;
    if (!params) return url;
    var query = Object.keys(params)
      .filter(function (k) { return params[k] != null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return query ? (url + '?' + query) : url;
  };

  TradiumDatafeed.prototype._request = function (endpoint, params) {
    var self = this;
    var requestParams = this._withCommonParams(params, endpoint);
    var url = this._buildUrl(endpoint, requestParams);

    function runFetch() {
      return fetch(url, { method: 'GET', headers: self._buildHeaders() });
    }

    return runFetch().then(function (res) {
      if (isAuthError(res.status)) {
        return self._refreshAccessToken().then(function (accessToken) {
          if (!accessToken) {
            self.onAuthFailure({ source: 'rest', status: res.status });
            throw new Error('Unauthorized and refresh failed');
          }
          return runFetch().then(function (retryRes) {
            if (!retryRes.ok) throw new Error('Request failed: ' + retryRes.status);
            return retryRes.json();
          });
        });
      }
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      return res.json();
    });
  };

  TradiumDatafeed.prototype.searchSymbols = function (search) {
    return this._request('/search', { query: search || '', limit: 30 })
      .then(function (results) {
        if (!Array.isArray(results)) return [];
        return results.map(function (item) {
          var sym = item.symbol || item.ticker || '';
          var exchange = item.exchange || '';
          var ticker = sym.indexOf(':') !== -1 ? sym : (exchange ? exchange + ':' + sym : sym);
          return {
            ticker: ticker,
            name: item.description || item.name || '',
            shortName: sym.split(':').pop() || sym,
            exchange: exchange || ticker.split(':')[0] || '',
            pricePrecision: item.pricePrecision || 2,
            volumePrecision: item.volumePrecision || 0
          };
        });
      })
      .catch(function () { return []; });
  };

  TradiumDatafeed.prototype.getHistoryKLineData = function (symbol, period, from, to) {
    var self = this;
    var ticker = symbol.ticker || symbol;
    var resolution = this.periodToResolution(period);
    return this._request('/history', {
      symbol: ticker,
      resolution: resolution,
      from: Math.floor(from / 1000),
      to: Math.floor(to / 1000),
      countback: this.barsPerRequest
    })
      .then(function (data) { return self.udfBarsToCandles(data); })
      .catch(function (err) {
        self.onError('[UDF] getHistoryKLineData error:', err);
        return [];
      });
  };

  TradiumDatafeed.prototype.subscribe = function (symbol, period, callback) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;
    this._proCallbacks[key] = callback;

    var self = this;
    var wsCallback = function (_sym, _res, candle) {
      if (!self._proCallbacks[key]) return;
      self._proCallbacks[key](candle);
    };

    if (!this._subscriptions[key]) this._subscriptions[key] = new Set();
    this._subscriptions[key].add(wsCallback);

    if (!this.isActive) this.connect();
    if (this.connectionState === 'connected') this._sendSubscribe([ticker], [resolution]);
  };

  TradiumDatafeed.prototype.unsubscribe = function (symbol, period) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;
    delete this._proCallbacks[key];
    delete this._subscriptions[key];
    if (this.connectionState === 'connected') this._sendUnsubscribe([ticker], [resolution]);
  };

  TradiumDatafeed.prototype.connect = function () {
    this.isActive = true;
    this.reconnectAttempts = 0;
    this._connectWs();
  };

  TradiumDatafeed.prototype.disconnect = function () {
    this.isActive = false;
    this._closeWs();
    this._subscriptions = {};
    this._proCallbacks = {};
  };

  TradiumDatafeed.prototype._buildWsUrl = function () {
    if (!this.wsUrl) return null;
    var token = this.getAccessToken();
    var url = this.wsUrl;
    if (token) {
      var sep = url.indexOf('?') === -1 ? '?' : '&';
      url += sep + 'token=' + encodeURIComponent(token);
    }
    return url;
  };

  TradiumDatafeed.prototype._connectWs = function () {
    if (!this.isActive || this.connectionState !== 'disconnected') return;
    var url = this._buildWsUrl();
    if (!url) return;

    this.connectionState = 'connecting';

    var self = this;
    var socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = function () {
      if (self.ws !== socket) return;
      self.connectionState = 'connected';
      self.reconnectAttempts = 0;
      self._resubscribeAll();
      self.onConnect();
    };

    socket.onmessage = function (event) {
      if (self.ws !== socket) return;
      if (event.data === 'pong') return;
      try {
        var data = JSON.parse(event.data);
        self._handleMessage(data);
      } catch (e) {
        self.onError('[WS] parse error:', e);
      }
    };

    socket.onerror = function () {
      self.onError('[WS] error');
    };

    socket.onclose = function (event) {
      if (self.ws !== socket) return;
      self.connectionState = 'disconnected';
      self.ws = null;
      self.onDisconnect({ code: event.code, reason: event.reason });

      if (isWsAuthClose(event.code, event.reason)) {
        self._refreshAccessToken().then(function () {
          self._scheduleReconnect();
        });
      } else {
        self._scheduleReconnect();
      }
    };
  };

  TradiumDatafeed.prototype._closeWs = function () {
    if (this.ws) {
      try { this.ws.close(); } catch (_e) {}
      this.ws = null;
    }
    this.connectionState = 'disconnected';
  };

  TradiumDatafeed.prototype._scheduleReconnect = function () {
    if (!this.isActive) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    var self = this;
    var base = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    setTimeout(function () {
      if (!self.isActive || self.connectionState !== 'disconnected') return;
      self.reconnectAttempts++;
      self._connectWs();
    }, base);
  };

  TradiumDatafeed.prototype._send = function (msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  };

  TradiumDatafeed.prototype._sendSubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: symbols, sr: resolutions, u: [], ur: [] });
  };

  TradiumDatafeed.prototype._sendUnsubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: [], sr: [], u: symbols, ur: resolutions });
  };

  TradiumDatafeed.prototype._resubscribeAll = function () {
    var symbols = [];
    var resolutions = [];
    Object.keys(this._subscriptions).forEach(function (key) {
      var parts = key.split('|');
      symbols.push(parts[0]);
      resolutions.push(parts[1]);
    });
    if (symbols.length > 0) this._sendSubscribe(symbols, resolutions);
  };

  TradiumDatafeed.prototype._handleMessage = function (data) {
    if (data.f === FRAME_TYPES.ERROR) {
      this.onError('[WS] server error:', data);
      return;
    }
    if (data.f !== FRAME_TYPES.CANDLES) return;

    var self = this;
    if (Array.isArray(data.c)) {
      data.c.forEach(function (item) {
        self._emitCandle(String(item.id || item.s || ''), String(item.r || ''), item);
      });
      return;
    }
    var symbol = String(data.id || data.s || '');
    if (symbol) this._emitCandle(symbol, String(data.r || ''), data);
  };

  TradiumDatafeed.prototype._emitCandle = function (symbol, resolution, raw) {
    if (!raw) return;
    var ts = raw.t || raw.timestamp;
    var candle = {
      timestamp: ts > 1e12 ? ts : ts * 1000,
      open: raw.o != null ? raw.o : raw.open,
      high: raw.h != null ? raw.h : raw.high,
      low: raw.l != null ? raw.l : raw.low,
      close: raw.c != null ? raw.c : raw.close,
      volume: (raw.v != null ? raw.v : raw.volume) || 0,
      turnover: 0
    };
    var key = symbol + '|' + resolution;
    var callbacks = this._subscriptions[key];
    if (!callbacks) return;
    callbacks.forEach(function (cb) { cb(symbol, resolution, candle); });
  };

  global.TradiumDatafeed = TradiumDatafeed;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
/**
 * TradiumDatafeed — simple UDF REST + WebSocket adapter.
 * Exposes: searchSymbols, getHistoryKLineData, subscribe, unsubscribe.
 * Auth is callback-driven:
 * - getAccessToken(): string | null
 * - onRefreshToken(): Promise<string | { accessToken?: string } | null>
 */

(function (global) {
  'use strict';

  var FRAME_TYPES = { ERROR: 1, CANDLES: 5 };

  function isAuthError(status) {
    return status === 401 || status === 403;
  }

  function isWsAuthClose(code, reason) {
    if (code === 1008) return true;
    if (code >= 4000 && code <= 4099) return true;
    var text = String(reason || '').toLowerCase();
    return text.indexOf('auth') !== -1 ||
      text.indexOf('token') !== -1 ||
      text.indexOf('unauthorized') !== -1 ||
      text.indexOf('expired') !== -1;
  }

  function TradiumDatafeed(options) {
    options = options || {};
    this.udfUrl = options.udfUrl || '';
    this.wsUrl = options.wsUrl || '';
    this.debug = Boolean(options.debug);
    this.barsPerRequest = options.barsPerRequest || 500;

    this.connectionUserId = options.connectionUserId || '';
    this.connectionGroupId = options.connectionGroupId || '';
    this.defaultCurrencyCode = options.defaultCurrencyCode || 'USD';

    this.getAccessToken = typeof options.getAccessToken === 'function'
      ? options.getAccessToken
      : function () { return null; };
    this.onRefreshToken = typeof options.onRefreshToken === 'function'
      ? options.onRefreshToken
      : null;

    this.onAuthFailure = options.onAuthFailure || function () {};
    this.onConnect = options.onConnect || function () {};
    this.onDisconnect = options.onDisconnect || function () {};
    this.onError = options.onError || console.error;

    this.ws = null;
    this.connectionState = 'disconnected';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.maxReconnectDelay = options.maxReconnectDelay || 5000;
    this.isActive = false;

    this._refreshPromise = null;
    this._subscriptions = {};
    this._proCallbacks = {};
  }

  TradiumDatafeed.prototype.log = function () {
    if (!this.debug) return;
    console.log.apply(console, ['[TradiumDatafeed]'].concat([].slice.call(arguments)));
  };

  TradiumDatafeed.prototype._buildHeaders = function () {
    var headers = { Accept: 'application/json' };
    var token = this.getAccessToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  };

  TradiumDatafeed.prototype._extractAccessToken = function (value) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (value && typeof value === 'object') {
      if (typeof value.accessToken === 'string' && value.accessToken.length > 0) return value.accessToken;
      if (value.data && typeof value.data.accessToken === 'string' && value.data.accessToken.length > 0) return value.data.accessToken;
    }
    return null;
  };

  TradiumDatafeed.prototype._refreshAccessToken = function () {
    var self = this;
    if (!this.onRefreshToken) return Promise.resolve(null);
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = Promise.resolve()
      .then(function () { return self.onRefreshToken(); })
      .then(function (value) { return self._extractAccessToken(value); })
      .catch(function (err) {
        self.onError('[Auth] refresh callback failed:', err);
        return null;
      })
      .finally(function () {
        self._refreshPromise = null;
      });
    return this._refreshPromise;
  };

  TradiumDatafeed.prototype._withCommonParams = function (params, endpoint) {
    var next = Object.assign({}, params || {});
    if (this.connectionUserId) next['connection-user-id'] = this.connectionUserId;
    if (this.connectionGroupId) next['connection-group-id'] = this.connectionGroupId;
    if ((endpoint === '/history' || endpoint === '/symbols') && !next.currencyCode && this.defaultCurrencyCode) {
      next.currencyCode = this.defaultCurrencyCode;
    }
    return next;
  };

  TradiumDatafeed.prototype.periodToResolution = function (period) {
    var m = period.multiplier;
    switch (period.timespan) {
      case 'second': return m + 'S';
      case 'minute': return String(m);
      case 'hour': return String(m * 60);
      case 'day': return m + 'D';
      case 'week': return m + 'W';
      case 'month': return m + 'M';
      case 'year': return (m * 12) + 'M';
      default: return '1D';
    }
  };

  TradiumDatafeed.prototype.udfBarsToCandles = function (data) {
    if (!data || data.s !== 'ok' || !Array.isArray(data.t) || data.t.length === 0) return [];
    var out = [];
    for (var i = 0; i < data.t.length; i++) {
      var ts = data.t[i];
      out.push({
        timestamp: ts > 1e12 ? ts : ts * 1000,
        open: data.o[i],
        high: data.h[i],
        low: data.l[i],
        close: data.c[i],
        volume: data.v ? data.v[i] : 0,
        turnover: 0
      });
    }
    return out;
  };

  TradiumDatafeed.prototype._buildUrl = function (endpoint, params) {
    var url = this.udfUrl + endpoint;
    if (!params) return url;
    var query = Object.keys(params)
      .filter(function (k) { return params[k] != null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return query ? (url + '?' + query) : url;
  };

  TradiumDatafeed.prototype._request = function (endpoint, params) {
    var self = this;
    var requestParams = this._withCommonParams(params, endpoint);
    var url = this._buildUrl(endpoint, requestParams);

    function runFetch() {
      return fetch(url, { method: 'GET', headers: self._buildHeaders() });
    }

    return runFetch().then(function (res) {
      if (isAuthError(res.status)) {
        return self._refreshAccessToken().then(function (accessToken) {
          if (!accessToken) {
            self.onAuthFailure({ source: 'rest', status: res.status });
            throw new Error('Unauthorized and refresh failed');
          }
          return runFetch().then(function (retryRes) {
            if (!retryRes.ok) throw new Error('Request failed: ' + retryRes.status);
            return retryRes.json();
          });
        });
      }
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      return res.json();
    });
  };

  TradiumDatafeed.prototype.searchSymbols = function (search) {
    return this._request('/search', { query: search || '', limit: 30 })
      .then(function (results) {
        if (!Array.isArray(results)) return [];
        return results.map(function (item) {
          var sym = item.symbol || item.ticker || '';
          var exchange = item.exchange || '';
          var ticker = sym.indexOf(':') !== -1 ? sym : (exchange ? exchange + ':' + sym : sym);
          return {
            ticker: ticker,
            name: item.description || item.name || '',
            shortName: sym.split(':').pop() || sym,
            exchange: exchange || ticker.split(':')[0] || '',
            pricePrecision: item.pricePrecision || 2,
            volumePrecision: item.volumePrecision || 0
          };
        });
      })
      .catch(function () { return []; });
  };

  TradiumDatafeed.prototype.getHistoryKLineData = function (symbol, period, from, to) {
    var self = this;
    var ticker = symbol.ticker || symbol;
    var resolution = this.periodToResolution(period);
    return this._request('/history', {
      symbol: ticker,
      resolution: resolution,
      from: Math.floor(from / 1000),
      to: Math.floor(to / 1000),
      countback: this.barsPerRequest
    })
      .then(function (data) { return self.udfBarsToCandles(data); })
      .catch(function (err) {
        self.onError('[UDF] getHistoryKLineData error:', err);
        return [];
      });
  };

  TradiumDatafeed.prototype.subscribe = function (symbol, period, callback) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;
    this._proCallbacks[key] = callback;

    var self = this;
    var wsCallback = function (_sym, _res, candle) {
      if (!self._proCallbacks[key]) return;
      self._proCallbacks[key](candle);
    };

    if (!this._subscriptions[key]) this._subscriptions[key] = new Set();
    this._subscriptions[key].add(wsCallback);

    if (!this.isActive) this.connect();
    if (this.connectionState === 'connected') this._sendSubscribe([ticker], [resolution]);
  };

  TradiumDatafeed.prototype.unsubscribe = function (symbol, period) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;
    delete this._proCallbacks[key];
    delete this._subscriptions[key];
    if (this.connectionState === 'connected') this._sendUnsubscribe([ticker], [resolution]);
  };

  TradiumDatafeed.prototype.connect = function () {
    this.isActive = true;
    this.reconnectAttempts = 0;
    this._connectWs();
  };

  TradiumDatafeed.prototype.disconnect = function () {
    this.isActive = false;
    this._closeWs();
    this._subscriptions = {};
    this._proCallbacks = {};
  };

  TradiumDatafeed.prototype._buildWsUrl = function () {
    if (!this.wsUrl) return null;
    var token = this.getAccessToken();
    var url = this.wsUrl;
    if (token) {
      var sep = url.indexOf('?') === -1 ? '?' : '&';
      url += sep + 'token=' + encodeURIComponent(token);
    }
    return url;
  };

  TradiumDatafeed.prototype._connectWs = function () {
    if (!this.isActive || this.connectionState !== 'disconnected') return;
    var url = this._buildWsUrl();
    if (!url) return;

    this.connectionState = 'connecting';

    var self = this;
    var socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = function () {
      if (self.ws !== socket) return;
      self.connectionState = 'connected';
      self.reconnectAttempts = 0;
      self._resubscribeAll();
      self.onConnect();
    };

    socket.onmessage = function (event) {
      if (self.ws !== socket) return;
      if (event.data === 'pong') return;
      try {
        var data = JSON.parse(event.data);
        self._handleMessage(data);
      } catch (e) {
        self.onError('[WS] parse error:', e);
      }
    };

    socket.onerror = function () {
      self.onError('[WS] error');
    };

    socket.onclose = function (event) {
      if (self.ws !== socket) return;
      self.connectionState = 'disconnected';
      self.ws = null;
      self.onDisconnect({ code: event.code, reason: event.reason });

      if (isWsAuthClose(event.code, event.reason)) {
        self._refreshAccessToken().then(function () {
          self._scheduleReconnect();
        });
      } else {
        self._scheduleReconnect();
      }
    };
  };

  TradiumDatafeed.prototype._closeWs = function () {
    if (this.ws) {
      try { this.ws.close(); } catch (_e) {}
      this.ws = null;
    }
    this.connectionState = 'disconnected';
  };

  TradiumDatafeed.prototype._scheduleReconnect = function () {
    if (!this.isActive) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    var self = this;
    var base = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    setTimeout(function () {
      if (!self.isActive || self.connectionState !== 'disconnected') return;
      self.reconnectAttempts++;
      self._connectWs();
    }, base);
  };

  TradiumDatafeed.prototype._send = function (msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  };

  TradiumDatafeed.prototype._sendSubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: symbols, sr: resolutions, u: [], ur: [] });
  };

  TradiumDatafeed.prototype._sendUnsubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: [], sr: [], u: symbols, ur: resolutions });
  };

  TradiumDatafeed.prototype._resubscribeAll = function () {
    var symbols = [];
    var resolutions = [];
    Object.keys(this._subscriptions).forEach(function (key) {
      var parts = key.split('|');
      symbols.push(parts[0]);
      resolutions.push(parts[1]);
    });
    if (symbols.length > 0) this._sendSubscribe(symbols, resolutions);
  };

  TradiumDatafeed.prototype._handleMessage = function (data) {
    if (data.f === FRAME_TYPES.ERROR) {
      this.onError('[WS] server error:', data);
      return;
    }
    if (data.f !== FRAME_TYPES.CANDLES) return;

    var self = this;
    if (Array.isArray(data.c)) {
      data.c.forEach(function (item) {
        self._emitCandle(String(item.id || item.s || ''), String(item.r || ''), item);
      });
      return;
    }
    var symbol = String(data.id || data.s || '');
    if (symbol) this._emitCandle(symbol, String(data.r || ''), data);
  };

  TradiumDatafeed.prototype._emitCandle = function (symbol, resolution, raw) {
    if (!raw) return;
    var ts = raw.t || raw.timestamp;
    var candle = {
      timestamp: ts > 1e12 ? ts : ts * 1000,
      open: raw.o != null ? raw.o : raw.open,
      high: raw.h != null ? raw.h : raw.high,
      low: raw.l != null ? raw.l : raw.low,
      close: raw.c != null ? raw.c : raw.close,
      volume: (raw.v != null ? raw.v : raw.volume) || 0,
      turnover: 0
    };
    var key = symbol + '|' + resolution;
    var callbacks = this._subscriptions[key];
    if (!callbacks) return;
    callbacks.forEach(function (cb) { cb(symbol, resolution, candle); });
  };

  global.TradiumDatafeed = TradiumDatafeed;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
/**
 * TradiumDatafeed — simple UDF REST + WebSocket adapter.
 * Exposes: searchSymbols, getHistoryKLineData, subscribe, unsubscribe.
 * Auth is callback-driven:
 * - getAccessToken(): string | null
 * - onRefreshToken(): Promise<string | { accessToken?: string } | null>
 */

(function (global) {
  'use strict';

  var FRAME_TYPES = { ERROR: 1, CANDLES: 5 };

  function isAuthError(status) {
    return status === 401 || status === 403;
  }

  function isWsAuthClose(code, reason) {
    if (code === 1008) return true;
    if (code >= 4000 && code <= 4099) return true;
    var text = String(reason || '').toLowerCase();
    return text.indexOf('auth') !== -1 ||
      text.indexOf('token') !== -1 ||
      text.indexOf('unauthorized') !== -1 ||
      text.indexOf('expired') !== -1;
  }

  function TradiumDatafeed(options) {
    options = options || {};
    this.udfUrl = options.udfUrl || '';
    this.wsUrl = options.wsUrl || '';
    this.debug = Boolean(options.debug);
    this.barsPerRequest = options.barsPerRequest || 500;

    this.getAccessToken = typeof options.getAccessToken === 'function'
      ? options.getAccessToken
      : function () { return null; };
    this.onRefreshToken = typeof options.onRefreshToken === 'function'
      ? options.onRefreshToken
      : null;

    this.onAuthFailure = options.onAuthFailure || function () {};
    this.onConnect = options.onConnect || function () {};
    this.onDisconnect = options.onDisconnect || function () {};
    this.onError = options.onError || console.error;

    this.ws = null;
    this.connectionState = 'disconnected';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.maxReconnectDelay = options.maxReconnectDelay || 5000;
    this.isActive = false;

    this._refreshPromise = null;
    this._subscriptions = {};
    this._proCallbacks = {};
  }

  TradiumDatafeed.prototype.log = function () {
    if (!this.debug) return;
    console.log.apply(console, ['[TradiumDatafeed]'].concat([].slice.call(arguments)));
  };

  TradiumDatafeed.prototype._buildHeaders = function () {
    var headers = { Accept: 'application/json' };
    var token = this.getAccessToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  };

  TradiumDatafeed.prototype._extractAccessToken = function (value) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (value && typeof value === 'object') {
      if (typeof value.accessToken === 'string' && value.accessToken.length > 0) return value.accessToken;
      if (value.data && typeof value.data.accessToken === 'string' && value.data.accessToken.length > 0) return value.data.accessToken;
    }
    return null;
  };

  TradiumDatafeed.prototype._refreshAccessToken = function () {
    var self = this;
    if (!this.onRefreshToken) return Promise.resolve(null);
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = Promise.resolve()
      .then(function () { return self.onRefreshToken(); })
      .then(function (value) { return self._extractAccessToken(value); })
      .catch(function (err) {
        self.onError('[Auth] refresh callback failed:', err);
        return null;
      })
      .finally(function () {
        self._refreshPromise = null;
      });
    return this._refreshPromise;
  };

  TradiumDatafeed.prototype.periodToResolution = function (period) {
    var m = period.multiplier;
    switch (period.timespan) {
      case 'second': return m + 'S';
      case 'minute': return String(m);
      case 'hour': return String(m * 60);
      case 'day': return m + 'D';
      case 'week': return m + 'W';
      case 'month': return m + 'M';
      case 'year': return (m * 12) + 'M';
      default: return '1D';
    }
  };

  TradiumDatafeed.prototype.udfBarsToCandles = function (data) {
    if (!data || data.s !== 'ok' || !Array.isArray(data.t) || data.t.length === 0) return [];
    var out = [];
    for (var i = 0; i < data.t.length; i++) {
      var ts = data.t[i];
      out.push({
        timestamp: ts > 1e12 ? ts : ts * 1000,
        open: data.o[i],
        high: data.h[i],
        low: data.l[i],
        close: data.c[i],
        volume: data.v ? data.v[i] : 0,
        turnover: 0
      });
    }
    return out;
  };

  TradiumDatafeed.prototype._buildUrl = function (endpoint, params) {
    var url = this.udfUrl + endpoint;
    if (!params) return url;
    var query = Object.keys(params)
      .filter(function (k) { return params[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return query ? (url + '?' + query) : url;
  };

  TradiumDatafeed.prototype._request = function (endpoint, params) {
    var self = this;
    var url = this._buildUrl(endpoint, params);

    function runFetch() {
      var headers = self._buildHeaders();
      self.log('REST request', endpoint, 'auth=', Boolean(headers.Authorization));
      return fetch(url, { method: 'GET', headers: headers });
    }

    return runFetch().then(function (res) {
      if (isAuthError(res.status)) {
        return self._refreshAccessToken().then(function (accessToken) {
          if (!accessToken) {
            self.onAuthFailure({ source: 'rest', status: res.status });
            throw new Error('Unauthorized and refresh failed');
          }
          return runFetch().then(function (retryRes) {
            if (!retryRes.ok) throw new Error('Request failed: ' + retryRes.status);
            return retryRes.json();
          });
        });
      }
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      return res.json();
    });
  };

  TradiumDatafeed.prototype.searchSymbols = function (search) {
    return this._request('/search', { query: search || '', limit: 30 })
      .then(function (results) {
        if (!Array.isArray(results)) return [];
        return results.map(function (item) {
          var sym = item.symbol || item.ticker || '';
          var exchange = item.exchange || '';
          var ticker = sym.indexOf(':') !== -1 ? sym : (exchange ? exchange + ':' + sym : sym);
          return {
            ticker: ticker,
            name: item.description || item.name || '',
            shortName: sym.split(':').pop() || sym,
            exchange: exchange || ticker.split(':')[0] || '',
            pricePrecision: item.pricePrecision || 2,
            volumePrecision: item.volumePrecision || 0
          };
        });
      })
      .catch(function () { return []; });
  };

  TradiumDatafeed.prototype.getHistoryKLineData = function (symbol, period, from, to) {
    var self = this;
    var ticker = symbol.ticker || symbol;
    var resolution = this.periodToResolution(period);
    return this._request('/history', {
      symbol: ticker,
      resolution: resolution,
      from: Math.floor(from / 1000),
      to: Math.floor(to / 1000),
      countback: this.barsPerRequest
    })
      .then(function (data) { return self.udfBarsToCandles(data); })
      .catch(function (err) {
        self.onError('[UDF] getHistoryKLineData error:', err);
        return [];
      });
  };

  TradiumDatafeed.prototype.subscribe = function (symbol, period, callback) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;
    this._proCallbacks[key] = callback;

    var self = this;
    var wsCallback = function (_sym, _res, candle) {
      if (!self._proCallbacks[key]) return;
      self._proCallbacks[key](candle);
    };

    if (!this._subscriptions[key]) this._subscriptions[key] = new Set();
    this._subscriptions[key].add(wsCallback);

    if (!this.isActive) this.connect();
    if (this.connectionState === 'connected') this._sendSubscribe([ticker], [resolution]);
  };

  TradiumDatafeed.prototype.unsubscribe = function (symbol, period) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;
    delete this._proCallbacks[key];
    delete this._subscriptions[key];
    if (this.connectionState === 'connected') this._sendUnsubscribe([ticker], [resolution]);
  };

  TradiumDatafeed.prototype.connect = function () {
    this.isActive = true;
    this.reconnectAttempts = 0;
    this._connectWs();
  };

  TradiumDatafeed.prototype.disconnect = function () {
    this.isActive = false;
    this._closeWs();
    this._subscriptions = {};
    this._proCallbacks = {};
  };

  TradiumDatafeed.prototype._buildWsUrl = function () {
    if (!this.wsUrl) return null;
    var token = this.getAccessToken();
    if (!token) return this.wsUrl;
    var sep = this.wsUrl.indexOf('?') === -1 ? '?' : '&';
    return this.wsUrl + sep + 'token=' + encodeURIComponent(token);
  };

  TradiumDatafeed.prototype._connectWs = function () {
    if (!this.isActive || this.connectionState !== 'disconnected') return;
    var url = this._buildWsUrl();
    if (!url) return;

    this.connectionState = 'connecting';
    this.log('Connecting:', url);

    var self = this;
    var socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = function () {
      if (self.ws !== socket) return;
      self.connectionState = 'connected';
      self.reconnectAttempts = 0;
      self._resubscribeAll();
      self.onConnect();
    };

    socket.onmessage = function (event) {
      if (self.ws !== socket) return;
      if (event.data === 'pong') return;
      try {
        var data = JSON.parse(event.data);
        self._handleMessage(data);
      } catch (e) {
        self.onError('[WS] parse error:', e);
      }
    };

    socket.onerror = function () {
      self.onError('[WS] error');
    };

    socket.onclose = function (event) {
      if (self.ws !== socket) return;
      self.connectionState = 'disconnected';
      self.ws = null;
      self.onDisconnect({ code: event.code, reason: event.reason });

      if (isWsAuthClose(event.code, event.reason)) {
        self._refreshAccessToken().then(function () {
          self._scheduleReconnect();
        });
      } else {
        self._scheduleReconnect();
      }
    };
  };

  TradiumDatafeed.prototype._closeWs = function () {
    if (this.ws) {
      try { this.ws.close(); } catch (_e) {}
      this.ws = null;
    }
    this.connectionState = 'disconnected';
  };

  TradiumDatafeed.prototype._scheduleReconnect = function () {
    if (!this.isActive) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    var self = this;
    var base = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    setTimeout(function () {
      if (!self.isActive || self.connectionState !== 'disconnected') return;
      self.reconnectAttempts++;
      self._connectWs();
    }, base);
  };

  TradiumDatafeed.prototype._send = function (msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  };

  TradiumDatafeed.prototype._sendSubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: symbols, sr: resolutions, u: [], ur: [] });
  };

  TradiumDatafeed.prototype._sendUnsubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: [], sr: [], u: symbols, ur: resolutions });
  };

  TradiumDatafeed.prototype._resubscribeAll = function () {
    var symbols = [];
    var resolutions = [];
    Object.keys(this._subscriptions).forEach(function (key) {
      var parts = key.split('|');
      symbols.push(parts[0]);
      resolutions.push(parts[1]);
    });
    if (symbols.length > 0) this._sendSubscribe(symbols, resolutions);
  };

  TradiumDatafeed.prototype._handleMessage = function (data) {
    if (data.f === FRAME_TYPES.ERROR) {
      this.onError('[WS] server error:', data);
      return;
    }
    if (data.f !== FRAME_TYPES.CANDLES) return;

    var self = this;
    if (Array.isArray(data.c)) {
      data.c.forEach(function (item) {
        self._emitCandle(String(item.id || item.s || ''), String(item.r || ''), item);
      });
      return;
    }
    var symbol = String(data.id || data.s || '');
    if (symbol) this._emitCandle(symbol, String(data.r || ''), data);
  };

  TradiumDatafeed.prototype._emitCandle = function (symbol, resolution, raw) {
    if (!raw) return;
    var ts = raw.t || raw.timestamp;
    var candle = {
      timestamp: ts > 1e12 ? ts : ts * 1000,
      open: raw.o != null ? raw.o : raw.open,
      high: raw.h != null ? raw.h : raw.high,
      low: raw.l != null ? raw.l : raw.low,
      close: raw.c != null ? raw.c : raw.close,
      volume: (raw.v != null ? raw.v : raw.volume) || 0,
      turnover: 0
    };
    var key = symbol + '|' + resolution;
    var callbacks = this._subscriptions[key];
    if (!callbacks) return;
    callbacks.forEach(function (cb) { cb(symbol, resolution, candle); });
  };

  global.TradiumDatafeed = TradiumDatafeed;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
/**
 * TradiumDatafeed — simple UDF REST + WebSocket adapter.
 * Exposes: searchSymbols, getHistoryKLineData, subscribe, unsubscribe.
 * Auth is callback-driven:
 * - getAccessToken(): string | null
 * - onRefreshToken(): Promise<string | { accessToken?: string } | null>
 */

(function (global) {
  'use strict';

  var FRAME_TYPES = { ERROR: 1, CANDLES: 5 };

  function isAuthError(status) {
    return status === 401 || status === 403;
  }

  function isWsAuthClose(code, reason) {
    if (code === 1008) return true;
    if (code >= 4000 && code <= 4099) return true;
    var text = String(reason || '').toLowerCase();
    return text.indexOf('auth') !== -1 ||
      text.indexOf('token') !== -1 ||
      text.indexOf('unauthorized') !== -1 ||
      text.indexOf('expired') !== -1;
  }

  function TradiumDatafeed(options) {
    options = options || {};
    this.udfUrl = options.udfUrl || '';
    this.wsUrl = options.wsUrl || '';
    this.debug = Boolean(options.debug);
    this.barsPerRequest = options.barsPerRequest || 500;

    this.getAccessToken = typeof options.getAccessToken === 'function'
      ? options.getAccessToken
      : function () { return null; };
    this.onRefreshToken = typeof options.onRefreshToken === 'function'
      ? options.onRefreshToken
      : null;

    this.onAuthFailure = options.onAuthFailure || function () {};
    this.onConnect = options.onConnect || function () {};
    this.onDisconnect = options.onDisconnect || function () {};
    this.onError = options.onError || console.error;

    this.ws = null;
    this.connectionState = 'disconnected';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.maxReconnectDelay = options.maxReconnectDelay || 5000;
    this.isActive = false;

    this._refreshPromise = null;
    this._subscriptions = {};
    this._proCallbacks = {};
  }

  TradiumDatafeed.prototype.log = function () {
    if (!this.debug) return;
    console.log.apply(console, ['[TradiumDatafeed]'].concat([].slice.call(arguments)));
  };

  TradiumDatafeed.prototype._buildHeaders = function () {
    var headers = { Accept: 'application/json' };
    var token = this.getAccessToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  };

  TradiumDatafeed.prototype._extractAccessToken = function (value) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (value && typeof value === 'object') {
      if (typeof value.accessToken === 'string' && value.accessToken.length > 0) return value.accessToken;
      if (value.data && typeof value.data.accessToken === 'string' && value.data.accessToken.length > 0) return value.data.accessToken;
    }
    return null;
  };

  TradiumDatafeed.prototype._refreshAccessToken = function () {
    var self = this;
    if (!this.onRefreshToken) {
      return Promise.resolve(null);
    }
    if (this._refreshPromise) {
      return this._refreshPromise;
    }
    this._refreshPromise = Promise.resolve()
      .then(function () { return self.onRefreshToken(); })
      .then(function (value) { return self._extractAccessToken(value); })
      .catch(function (err) {
        self.onError('[Auth] refresh callback failed:', err);
        return null;
      })
      .finally(function () {
        self._refreshPromise = null;
      });
    return this._refreshPromise;
  };

  TradiumDatafeed.prototype.periodToResolution = function (period) {
    var m = period.multiplier;
    switch (period.timespan) {
      case 'second': return m + 'S';
      case 'minute': return String(m);
      case 'hour': return String(m * 60);
      case 'day': return m + 'D';
      case 'week': return m + 'W';
      case 'month': return m + 'M';
      case 'year': return (m * 12) + 'M';
      default: return '1D';
    }
  };

  TradiumDatafeed.prototype.udfBarsToCandles = function (data) {
    if (!data || data.s !== 'ok' || !Array.isArray(data.t) || data.t.length === 0) return [];
    var out = [];
    for (var i = 0; i < data.t.length; i++) {
      var ts = data.t[i];
      out.push({
        timestamp: ts > 1e12 ? ts : ts * 1000,
        open: data.o[i],
        high: data.h[i],
        low: data.l[i],
        close: data.c[i],
        volume: data.v ? data.v[i] : 0,
        turnover: 0
      });
    }
    return out;
  };

  TradiumDatafeed.prototype._buildUrl = function (endpoint, params) {
    var url = this.udfUrl + endpoint;
    if (!params) return url;
    var query = Object.keys(params)
      .filter(function (k) { return params[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return query ? (url + '?' + query) : url;
  };

  TradiumDatafeed.prototype._request = function (endpoint, params) {
    var self = this;
    var url = this._buildUrl(endpoint, params);

    function runFetch() {
      return fetch(url, { method: 'GET', headers: self._buildHeaders() });
    }

    return runFetch().then(function (res) {
      if (isAuthError(res.status)) {
        return self._refreshAccessToken().then(function (accessToken) {
          if (!accessToken) {
            self.onAuthFailure({ source: 'rest', status: res.status });
            throw new Error('Unauthorized and refresh failed');
          }
          return runFetch().then(function (retryRes) {
            if (!retryRes.ok) throw new Error('Request failed: ' + retryRes.status);
            return retryRes.json();
          });
        });
      }
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      return res.json();
    });
  };

  TradiumDatafeed.prototype.searchSymbols = function (search) {
    return this._request('/search', { query: search || '', limit: 30 })
      .then(function (results) {
        if (!Array.isArray(results)) return [];
        return results.map(function (item) {
          var sym = item.symbol || item.ticker || '';
          var exchange = item.exchange || '';
          var ticker = sym.indexOf(':') !== -1 ? sym : (exchange ? exchange + ':' + sym : sym);
          return {
            ticker: ticker,
            name: item.description || item.name || '',
            shortName: sym.split(':').pop() || sym,
            exchange: exchange || ticker.split(':')[0] || '',
            pricePrecision: item.pricePrecision || 2,
            volumePrecision: item.volumePrecision || 0
          };
        });
      })
      .catch(function () { return []; });
  };

  TradiumDatafeed.prototype.getHistoryKLineData = function (symbol, period, from, to) {
    var self = this;
    var ticker = symbol.ticker || symbol;
    var resolution = this.periodToResolution(period);
    return this._request('/history', {
      symbol: ticker,
      resolution: resolution,
      from: Math.floor(from / 1000),
      to: Math.floor(to / 1000),
      countback: this.barsPerRequest
    })
      .then(function (data) { return self.udfBarsToCandles(data); })
      .catch(function (err) {
        self.onError('[UDF] getHistoryKLineData error:', err);
        return [];
      });
  };

  TradiumDatafeed.prototype.subscribe = function (symbol, period, callback) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;
    this._proCallbacks[key] = callback;

    var self = this;
    var wsCallback = function (_sym, _res, candle) {
      if (!self._proCallbacks[key]) return;
      self._proCallbacks[key](candle);
    };

    if (!this._subscriptions[key]) this._subscriptions[key] = new Set();
    this._subscriptions[key].add(wsCallback);

    if (!this.isActive) this.connect();
    if (this.connectionState === 'connected') this._sendSubscribe([ticker], [resolution]);
  };

  TradiumDatafeed.prototype.unsubscribe = function (symbol, period) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;
    delete this._proCallbacks[key];
    delete this._subscriptions[key];
    if (this.connectionState === 'connected') this._sendUnsubscribe([ticker], [resolution]);
  };

  TradiumDatafeed.prototype.connect = function () {
    this.isActive = true;
    this.reconnectAttempts = 0;
    this._connectWs();
  };

  TradiumDatafeed.prototype.disconnect = function () {
    this.isActive = false;
    this._closeWs();
    this._subscriptions = {};
    this._proCallbacks = {};
  };

  TradiumDatafeed.prototype._buildWsUrl = function () {
    if (!this.wsUrl) return null;
    var token = this.getAccessToken();
    if (!token) return this.wsUrl;
    var sep = this.wsUrl.indexOf('?') === -1 ? '?' : '&';
    return this.wsUrl + sep + 'token=' + encodeURIComponent(token);
  };

  TradiumDatafeed.prototype._connectWs = function () {
    if (!this.isActive || this.connectionState !== 'disconnected') return;
    var url = this._buildWsUrl();
    if (!url) return;

    this.connectionState = 'connecting';
    this.log('Connecting:', url);

    var self = this;
    var socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = function () {
      if (self.ws !== socket) return;
      self.connectionState = 'connected';
      self.reconnectAttempts = 0;
      self._resubscribeAll();
      self.onConnect();
    };

    socket.onmessage = function (event) {
      if (self.ws !== socket) return;
      if (event.data === 'pong') return;
      try {
        var data = JSON.parse(event.data);
        self._handleMessage(data);
      } catch (e) {
        self.onError('[WS] parse error:', e);
      }
    };

    socket.onerror = function () {
      self.onError('[WS] error');
    };

    socket.onclose = function (event) {
      if (self.ws !== socket) return;
      self.connectionState = 'disconnected';
      self.ws = null;
      self.onDisconnect({ code: event.code, reason: event.reason });

      if (isWsAuthClose(event.code, event.reason)) {
        self._refreshAccessToken().then(function () {
          self._scheduleReconnect();
        });
      } else {
        self._scheduleReconnect();
      }
    };
  };

  TradiumDatafeed.prototype._closeWs = function () {
    if (this.ws) {
      try { this.ws.close(); } catch (_e) {}
      this.ws = null;
    }
    this.connectionState = 'disconnected';
  };

  TradiumDatafeed.prototype._scheduleReconnect = function () {
    if (!this.isActive) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    var self = this;
    var base = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    setTimeout(function () {
      if (!self.isActive || self.connectionState !== 'disconnected') return;
      self.reconnectAttempts++;
      self._connectWs();
    }, base);
  };

  TradiumDatafeed.prototype._send = function (msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  };

  TradiumDatafeed.prototype._sendSubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: symbols, sr: resolutions, u: [], ur: [] });
  };

  TradiumDatafeed.prototype._sendUnsubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: [], sr: [], u: symbols, ur: resolutions });
  };

  TradiumDatafeed.prototype._resubscribeAll = function () {
    var symbols = [];
    var resolutions = [];
    Object.keys(this._subscriptions).forEach(function (key) {
      var parts = key.split('|');
      symbols.push(parts[0]);
      resolutions.push(parts[1]);
    });
    if (symbols.length > 0) this._sendSubscribe(symbols, resolutions);
  };

  TradiumDatafeed.prototype._handleMessage = function (data) {
    if (data.f === FRAME_TYPES.ERROR) {
      this.onError('[WS] server error:', data);
      return;
    }
    if (data.f !== FRAME_TYPES.CANDLES) return;

    var self = this;
    if (Array.isArray(data.c)) {
      data.c.forEach(function (item) {
        self._emitCandle(String(item.id || item.s || ''), String(item.r || ''), item);
      });
      return;
    }
    var symbol = String(data.id || data.s || '');
    if (symbol) this._emitCandle(symbol, String(data.r || ''), data);
  };

  TradiumDatafeed.prototype._emitCandle = function (symbol, resolution, raw) {
    if (!raw) return;
    var ts = raw.t || raw.timestamp;
    var candle = {
      timestamp: ts > 1e12 ? ts : ts * 1000,
      open: raw.o != null ? raw.o : raw.open,
      high: raw.h != null ? raw.h : raw.high,
      low: raw.l != null ? raw.l : raw.low,
      close: raw.c != null ? raw.c : raw.close,
      volume: (raw.v != null ? raw.v : raw.volume) || 0,
      turnover: 0
    };
    var key = symbol + '|' + resolution;
    var callbacks = this._subscriptions[key];
    if (!callbacks) return;
    callbacks.forEach(function (cb) { cb(symbol, resolution, candle); });
  };

  global.TradiumDatafeed = TradiumDatafeed;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
/**
 * TradiumDatafeed — UDF REST + WebSocket adapter
 * Implements klinecharts-pro Datafeed interface:
 *   searchSymbols, getHistoryKLineData, subscribe, unsubscribe
 */

(function (global) {
  'use strict';

  var FRAME_TYPES = { ERROR: 1, CANDLES: 5 };

  // Storage keys matching the main app
  var STORAGE_KEYS = {
    ACCESS_TOKEN: 'tradesea_access_token',
    REFRESH_TOKEN: 'tradesea_refresh_token',
    ACCESS_TOKEN_EXPIRY: 'tradesea_access_token_expiry',
    REFRESH_TOKEN_EXPIRY: 'tradesea_refresh_token_expiry'
  };

  // Token refresh state
  var _isRefreshing = false;
  var _refreshPromise = null;
  var _lastRefreshTime = 0;
  var MIN_REFRESH_INTERVAL = 5000;

  function _getAccessToken() {
    try { return localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN); } catch (e) { return null; }
  }

  function _getRefreshToken() {
    try { return localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN); } catch (e) { return null; }
  }

  function _storeTokens(accessToken, refreshToken, accessTokenValidityInMillis, refreshTokenValidityInMillis) {
    try {
      var now = Date.now();
      if (accessToken) {
        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
        if (accessTokenValidityInMillis) {
          localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN_EXPIRY, String(now + accessTokenValidityInMillis));
        }
      }
      if (refreshToken) {
        localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
        if (refreshTokenValidityInMillis) {
          localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN_EXPIRY, String(now + refreshTokenValidityInMillis));
        }
      }
    } catch (e) {
      console.error('[TradiumDatafeed] Failed to store tokens:', e);
    }
  }

  function _getAuthHeaders() {
    var headers = { 'Accept': 'application/json' };
    var token = _getAccessToken();
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    return headers;
  }

  function _isAuthError(status) {
    return status === 401 || status === 403;
  }

  function _doTokenRefresh(refreshUrl) {
    var now = Date.now();
    if (now - _lastRefreshTime < MIN_REFRESH_INTERVAL) {
      return Promise.resolve({ success: false, error: new Error('Rate limited') });
    }

    if (_isRefreshing && _refreshPromise) {
      return _refreshPromise;
    }

    _isRefreshing = true;
    _lastRefreshTime = now;

    _refreshPromise = new Promise(function (resolve) {
      var refreshToken = _getRefreshToken();
      if (!refreshToken) {
        resolve({ success: false, error: new Error('No refresh token') });
        _isRefreshing = false;
        _refreshPromise = null;
        return;
      }

      fetch(refreshUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + refreshToken
        }
      })
        .then(function (res) {
          if (!res.ok) {
            resolve({ success: false, error: new Error('Refresh failed: ' + res.status) });
            return;
          }
          return res.json().then(function (data) {
            if (data.data && data.data.accessToken) {
              _storeTokens(
                data.data.accessToken,
                data.data.refreshToken,
                data.data.accessTokenValidityInMillis,
                data.data.refreshTokenValidityInMillis
              );
            }
            resolve({ success: true, data: data });
          });
        })
        .catch(function (err) {
          resolve({ success: false, error: err });
        })
        .finally(function () {
          _isRefreshing = false;
          _refreshPromise = null;
        });
    });

    return _refreshPromise;
  }

  // Constructor
  function TradiumDatafeed(options) {
    options = options || {};
    this.udfUrl = options.udfUrl || '';
    this.wsUrl = options.wsUrl || '';
    this.refreshTokenUrl = options.refreshTokenUrl || '';
    this.debug = options.debug || false;
    this.barsPerRequest = options.barsPerRequest || 500;

    this.onAuthFailure = options.onAuthFailure || function () {};
    this.onConnect = options.onConnect || function () {};
    this.onDisconnect = options.onDisconnect || function () {};
    this.onError = options.onError || console.error;

    this.ws = null;
    this.connectionState = 'disconnected';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.heartbeatTimer = null;
    this.isActive = false;

    this._subscriptions = {};
    this._proCallbacks = {};
  }

  TradiumDatafeed.prototype.log = function () {
    if (this.debug) console.log.apply(console, ['[TradiumDatafeed]'].concat([].slice.call(arguments)));
  };

  // Period conversion
  TradiumDatafeed.prototype.periodToResolution = function (period) {
    var m = period.multiplier;
    switch (period.timespan) {
      case 'minute': return String(m);
      case 'hour': return String(m * 60);
      case 'day': return m + 'D';
      case 'week': return m + 'W';
      case 'month': return m + 'M';
      case 'year': return (m * 12) + 'M';
      default: return '1D';
    }
  };

  // Convert UDF response to candles
  TradiumDatafeed.prototype.udfBarsToCandles = function (data) {
    if (!data || data.s !== 'ok' || !data.t || !data.t.length) return [];
    var result = [];
    for (var i = 0; i < data.t.length; i++) {
      var ts = data.t[i];
      result.push({
        timestamp: ts > 1e12 ? ts : ts * 1000,
        open: data.o[i],
        high: data.h[i],
        low: data.l[i],
        close: data.c[i],
        volume: data.v ? data.v[i] : 0,
        turnover: 0
      });
    }
    return result;
  };

  // REST request with auth
  TradiumDatafeed.prototype._request = function (endpoint, params) {
    var self = this;
    var url = this.udfUrl + endpoint;
    
    if (params) {
      var query = Object.keys(params)
        .filter(function (k) { return params[k] != null; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
        .join('&');
      if (query) url += '?' + query;
    }

    var doFetch = function () {
      return fetch(url, {
        method: 'GET',
        headers: _getAuthHeaders()
      });
    };

    return doFetch().then(function (res) {
      if (_isAuthError(res.status) && self.refreshTokenUrl) {
        return _doTokenRefresh(self.refreshTokenUrl).then(function (result) {
          if (result.success) {
            return doFetch().then(function (retryRes) {
              if (!retryRes.ok) throw new Error('Request failed: ' + retryRes.status);
              return retryRes.json();
            });
          }
          self.onAuthFailure({ source: 'rest', status: res.status });
          throw new Error('Auth failed');
        });
      }
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      return res.json();
    });
  };

  // Search symbols
  TradiumDatafeed.prototype.searchSymbols = function (search) {
    return this._request('/search', { query: search || '', limit: 30 })
      .then(function (results) {
        if (!Array.isArray(results)) return [];
        return results.map(function (item) {
          var sym = item.symbol || item.ticker || '';
          var exchange = item.exchange || '';
          var ticker = sym.indexOf(':') !== -1 ? sym : (exchange ? exchange + ':' + sym : sym);
          return {
            ticker: ticker,
            name: item.description || item.name || '',
            shortName: sym.split(':').pop() || sym,
            exchange: exchange || ticker.split(':')[0] || '',
            pricePrecision: item.pricePrecision || 2,
            volumePrecision: item.volumePrecision || 0
          };
        });
      })
      .catch(function () { return []; });
  };

  // Get history data
  TradiumDatafeed.prototype.getHistoryKLineData = function (symbol, period, from, to) {
    var self = this;
    var ticker = symbol.ticker || symbol;
    var resolution = this.periodToResolution(period);

    return this._request('/history', {
      symbol: ticker,
      resolution: resolution,
      from: Math.floor(from / 1000),
      to: Math.floor(to / 1000),
      countback: this.barsPerRequest
    })
      .then(function (data) {
        return self.udfBarsToCandles(data);
      })
      .catch(function (err) {
        self.onError('[UDF] getHistoryKLineData error:', err);
        return [];
      });
  };

  // Subscribe to real-time updates
  TradiumDatafeed.prototype.subscribe = function (symbol, period, callback) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;

    this._proCallbacks[key] = callback;

    var self = this;
    var wsCallback = function (_sym, _res, candle) {
      if (self._proCallbacks[key]) {
        self._proCallbacks[key](candle);
      }
    };

    if (!this._subscriptions[key]) {
      this._subscriptions[key] = new Set();
    }
    this._subscriptions[key].add(wsCallback);

    if (!this.isActive) this.connect();

    if (this.connectionState === 'connected') {
      this._sendSubscribe([ticker], [resolution]);
    }

    this.log('subscribe:', ticker, resolution);
  };

  // Unsubscribe
  TradiumDatafeed.prototype.unsubscribe = function (symbol, period) {
    var resolution = this.periodToResolution(period);
    var ticker = symbol.ticker || symbol;
    var key = ticker + '|' + resolution;

    delete this._proCallbacks[key];
    delete this._subscriptions[key];

    if (this.connectionState === 'connected') {
      this._sendUnsubscribe([ticker], [resolution]);
    }

    this.log('unsubscribe:', ticker, resolution);
  };

  // WebSocket methods
  TradiumDatafeed.prototype.connect = function () {
    this.isActive = true;
    this.reconnectAttempts = 0;
    this._connectWs();
  };

  TradiumDatafeed.prototype.disconnect = function () {
    this.isActive = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connectionState = 'disconnected';
    this._subscriptions = {};
    this._proCallbacks = {};
  };

  TradiumDatafeed.prototype._connectWs = function () {
    if (!this.wsUrl || this.connectionState !== 'disconnected' || !this.isActive) return;

    var url = this.wsUrl;
    var token = _getAccessToken();
    if (token) {
      url += (url.indexOf('?') !== -1 ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }

    this.connectionState = 'connecting';
    this.log('Connecting to', url);

    var self = this;
    var socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = function () {
      self.connectionState = 'connected';
      self.reconnectAttempts = 0;
      self.log('Connected');
      self._resubscribeAll();
      self.onConnect();
    };

    socket.onmessage = function (event) {
      if (event.data === 'pong') return;
      try {
        var data = JSON.parse(event.data);
        self._handleMessage(data);
      } catch (e) {
        self.onError('[WS] parse error:', e);
      }
    };

    socket.onerror = function () {
      self.onError('[WS] error');
    };

    socket.onclose = function (event) {
      self.connectionState = 'disconnected';
      self.ws = null;
      self.log('Disconnected:', event.code);
      self.onDisconnect({ code: event.code });
      self._scheduleReconnect();
    };
  };

  TradiumDatafeed.prototype._scheduleReconnect = function () {
    if (!this.isActive || this.reconnectAttempts >= this.maxReconnectAttempts) return;
    var delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 5000);
    var self = this;
    setTimeout(function () {
      if (self.isActive && self.connectionState === 'disconnected') {
        self.reconnectAttempts++;
        self._connectWs();
      }
    }, delay);
  };

  TradiumDatafeed.prototype._sendSubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: symbols, sr: resolutions, u: [], ur: [] });
  };

  TradiumDatafeed.prototype._sendUnsubscribe = function (symbols, resolutions) {
    this._send({ f: FRAME_TYPES.CANDLES, s: [], sr: [], u: symbols, ur: resolutions });
  };

  TradiumDatafeed.prototype._send = function (msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      this.log('Sent:', msg);
    }
  };

  TradiumDatafeed.prototype._resubscribeAll = function () {
    var symbols = [], resolutions = [];
    Object.keys(this._subscriptions).forEach(function (key) {
      var parts = key.split('|');
      symbols.push(parts[0]);
      resolutions.push(parts[1]);
    });
    if (symbols.length) {
      this._sendSubscribe(symbols, resolutions);
    }
  };

  TradiumDatafeed.prototype._handleMessage = function (data) {
    if (data.f === FRAME_TYPES.ERROR) {
      this.onError('[WS] Server error:', data);
      return;
    }
    if (data.f === FRAME_TYPES.CANDLES) {
      this._processCandleMessage(data);
    }
  };

  TradiumDatafeed.prototype._processCandleMessage = function (data) {
    var self = this;

    if (data.c && Array.isArray(data.c)) {
      data.c.forEach(function (item) {
        self._emitCandle(String(item.id || item.s || ''), String(item.r || ''), item);
      });
      return;
    }

    var symbol = String(data.id || data.s || '');
    if (symbol) {
      this._emitCandle(symbol, String(data.r || ''), data);
    }
  };

  TradiumDatafeed.prototype._emitCandle = function (symbol, resolution, raw) {
    if (!raw) return;

    var ts = raw.t || raw.timestamp;
    var candle = {
      timestamp: ts > 1e12 ? ts : ts * 1000,
      open: raw.o != null ? raw.o : raw.open,
      high: raw.h != null ? raw.h : raw.high,
      low: raw.l != null ? raw.l : raw.low,
      close: raw.c != null ? raw.c : raw.close,
      volume: (raw.v != null ? raw.v : raw.volume) || 0,
      turnover: 0
    };

    var key = symbol + '|' + resolution;
    var callbacks = this._subscriptions[key];
    if (callbacks) {
      callbacks.forEach(function (cb) { cb(symbol, resolution, candle); });
    }
  };

  global.TradiumDatafeed = TradiumDatafeed;

})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
