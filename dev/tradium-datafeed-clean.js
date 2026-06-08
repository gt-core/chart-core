/**
 * Clean TradiumDatafeed for dev.
 * Ensures connection-user-id, connection-group-id and currencyCode are injected.
 */

(function (global) {
  'use strict';

  var FRAME_TYPES = { ERROR: 1, CANDLES: 5 };

  function isAuthError(status) {
    return status === 401 || status === 403;
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
    this.getAccessToken = typeof options.getAccessToken === 'function' ? options.getAccessToken : function () { return null; };
    this.onRefreshToken = typeof options.onRefreshToken === 'function' ? options.onRefreshToken : null;
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

  TradiumDatafeed.prototype._buildHeaders = function () {
    var token = this.getAccessToken();
    var headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  };

  TradiumDatafeed.prototype._extractAccessToken = function (value) {
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      if (typeof value.accessToken === 'string' && value.accessToken) return value.accessToken;
      if (value.data && typeof value.data.accessToken === 'string' && value.data.accessToken) return value.data.accessToken;
    }
    return null;
  };

  TradiumDatafeed.prototype._refreshAccessToken = function () {
    var self = this;
    if (!this.onRefreshToken) return Promise.resolve(null);
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = Promise.resolve()
      .then(function () { return self.onRefreshToken(); })
      .then(function (v) { return self._extractAccessToken(v); })
      .catch(function () { return null; })
      .finally(function () { self._refreshPromise = null; });
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

  TradiumDatafeed.prototype._buildUrl = function (endpoint, params) {
    var query = Object.keys(params || {})
      .filter(function (k) { return params[k] != null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return this.udfUrl + endpoint + (query ? '?' + query : '');
  };

  TradiumDatafeed.prototype._request = function (endpoint, params) {
    var self = this;
    var requestParams = this._withCommonParams(params, endpoint);
    var url = this._buildUrl(endpoint, requestParams);
    var runFetch = function () { return fetch(url, { method: 'GET', headers: self._buildHeaders() }); };

    return runFetch().then(function (res) {
      if (isAuthError(res.status)) {
        return self._refreshAccessToken().then(function (accessToken) {
          if (!accessToken) {
            self.onAuthFailure({ source: 'rest', status: res.status });
            throw new Error('Unauthorized');
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
    }).then(function (data) {
      return self.udfBarsToCandles(data);
    }).catch(function (err) {
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
      if (self._proCallbacks[key]) self._proCallbacks[key](candle);
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

  TradiumDatafeed.prototype._buildWsUrl = function () {
    if (!this.wsUrl) return null;

    var token = this.getAccessToken();
    var userId = this.connectionUserId ? encodeURIComponent(this.connectionUserId) : '';
    var groupId = this.connectionGroupId ? encodeURIComponent(this.connectionGroupId) : '';

    try {
      var parsed = new URL(this.wsUrl);
      var segments = parsed.pathname.split('/').filter(Boolean);
      if (userId && segments[segments.length - 2] !== userId && segments[segments.length - 1] !== userId) {
        segments.push(userId);
      }
      if (groupId && segments[segments.length - 1] !== groupId) {
        segments.push(groupId);
      }
      parsed.pathname = '/' + segments.join('/');
      if (token) parsed.searchParams.set('token', token);
      return parsed.toString();
    } catch (_e) {
      var url = this.wsUrl.replace(/\/+$/, '');
      if (userId && url.slice(-(userId.length + 1)) !== '/' + userId) {
        url += '/' + userId;
      }
      if (groupId && url.slice(-(groupId.length + 1)) !== '/' + groupId) {
        url += '/' + groupId;
      }
      if (token) {
        url += (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
      }
      return url;
    }
  };

  TradiumDatafeed.prototype.connect = function () {
    if (this.connectionState !== 'disconnected') return;
    this.isActive = true;
    this.connectionState = 'connecting';
    var url = this._buildWsUrl();
    if (!url) {
      this.connectionState = 'disconnected';
      return;
    }
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
      if (self.ws !== socket || event.data === 'pong') return;
      try {
        var data = JSON.parse(event.data);
        self._handleMessage(data);
      } catch (e) {
        self.onError('[WS] parse error:', e);
      }
    };
    socket.onclose = function () {
      if (self.ws !== socket) return;
      self.connectionState = 'disconnected';
      self.ws = null;
      self._scheduleReconnect();
    };
    socket.onerror = function () { self.onError('[WS] error'); };
  };

  TradiumDatafeed.prototype.disconnect = function () {
    this.isActive = false;
    if (this.ws) {
      try { this.ws.close(); } catch (_e) {}
      this.ws = null;
    }
    this.connectionState = 'disconnected';
    this._subscriptions = {};
    this._proCallbacks = {};
  };

  TradiumDatafeed.prototype._scheduleReconnect = function () {
    var self = this;
    if (!this.isActive || this.reconnectAttempts >= this.maxReconnectAttempts) return;
    var delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    setTimeout(function () {
      if (!self.isActive || self.connectionState !== 'disconnected') return;
      self.reconnectAttempts++;
      self.connect();
    }, delay);
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
    var self = this;
    if (data.f !== FRAME_TYPES.CANDLES) return;
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
