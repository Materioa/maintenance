(function () {
  "use strict";

  var CONFIG = {
    oldHost: "materioa.vercel.app",
    newHost: "getmaterio.app",
    prefix: "materio-handoff:",
    version: 2,
    maxAgeMs: 2 * 60 * 1000,        // payload must be consumed within 2 minutes
    clockSkewMs: 30 * 1000,         // tolerate small clock differences
    maxRawChars: 700 * 1024,        // hard cap on window.name payload size
    maxEntriesPerStore: 150,
    maxKeyLen: 128,
    maxValueLen: 64 * 1024,
    maxPrevNameLen: 256,
    requireReferrer: true,          // reject payloads when referrer is missing
    doneKey: "materio_migrated_from"
  };

  var LS_EXACT = ["m_last_force_clear", "theme", "activeTab", "insightroomSettings"];
  var CK_EXACT = ["theme", "activeTab", "insightroomSettings"];

  // Anything that looks like a credential is never migrated. Users re-login instead.
  var SENSITIVE = /(token|auth|jwt|secret|passw|credential|bearer|api[_-]?key|session)/i;

  // Optional per-key value validators. Unknown keys fall back to length checks only.
  var VALIDATORS = {
    theme: function (v) { return /^[a-z-]{1,20}$/.test(v); },
    activeTab: function (v) { return /^[\w-]{1,40}$/.test(v); },
    insightroomSettings: function (v) {
      try {
        var o = JSON.parse(v);
        return o !== null && typeof o === "object" && !Array.isArray(o);
      } catch (e) { return false; }
    }
  };

  /* ---------- helpers ---------- */

  function isAllowedKey(store, key) {
    if (typeof key !== "string" || !key || key.length > CONFIG.maxKeyLen) return false;
    if (key === CONFIG.doneKey || SENSITIVE.test(key)) return false;
    if (store === "ls") {
      return key.indexOf("materio_") === 0 || key.indexOf("m_v4_") === 0 || LS_EXACT.indexOf(key) !== -1;
    }
    if (store === "ck") {
      return /^[A-Za-z0-9_\-]+$/.test(key) &&
        (key.indexOf("materio_") === 0 || CK_EXACT.indexOf(key) !== -1);
    }
    return false;
  }

  function isValidValue(store, key, value) {
    if (typeof value !== "string" || value.length > CONFIG.maxValueLen) return false;
    // Blocks cookie attribute injection via ";" and header/control characters.
    if (store === "ck" && !/^[A-Za-z0-9._~%+\-=:]*$/.test(value)) return false;
    var fn = Object.prototype.hasOwnProperty.call(VALIDATORS, key) ? VALIDATORS[key] : null;
    return fn ? fn(value) : true;
  }

  function encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function decode(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  // Detects accidental corruption only. It is NOT a security control.
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  function hasCookie(name) {
    return ("; " + document.cookie).indexOf("; " + name + "=") !== -1;
  }

  /* ---------- sender (old host) ---------- */

  function collectLocal() {
    var out = {}, n = 0;
    try {
      for (var i = 0; i < localStorage.length && n < CONFIG.maxEntriesPerStore; i++) {
        var k = localStorage.key(i);
        if (!isAllowedKey("ls", k)) continue;
        var v = localStorage.getItem(k);
        if (!isValidValue("ls", k, v)) continue;
        out[k] = v;
        n++;
      }
    } catch (e) { }
    return out;
  }

  function collectCookies() {
    var out = {}, n = 0;
    try {
      var parts = document.cookie ? document.cookie.split(";") : [];
      for (var i = 0; i < parts.length && n < CONFIG.maxEntriesPerStore; i++) {
        var raw = parts[i].trim();
        var idx = raw.indexOf("=");
        if (idx < 1) continue;
        var name = raw.slice(0, idx);
        var val = raw.slice(idx + 1);
        if (!isAllowedKey("ck", name) || !isValidValue("ck", name, val)) continue;
        out[name] = val;
        n++;
      }
    } catch (e) { }
    return out;
  }

  function send() {
    var target = new URL(window.location.href);
    target.protocol = "https:";
    target.host = CONFIG.newHost; // also drops any custom port

    try {
      var ls = collectLocal();
      var ck = collectCookies();
      if (Object.keys(ls).length || Object.keys(ck).length) {
        var prev = String(window.name || "");
        if (prev.indexOf(CONFIG.prefix) === 0 || prev.length > CONFIG.maxPrevNameLen) prev = "";

        var body = JSON.stringify({ ls: ls, ck: ck, prev: prev });
        var envelope = JSON.stringify({
          v: CONFIG.version,
          ts: Date.now(),
          src: window.location.host,
          sum: fnv1a(body),
          body: body
        });
        var packed = CONFIG.prefix + encode(envelope);
        if (packed.length <= CONFIG.maxRawChars) window.name = packed;
      }
    } catch (e) { /* never block the redirect */ }

    window.location.replace(target.toString());
  }

  /* ---------- receiver (new host) ---------- */

  function referrerOk() {
    var ref = document.referrer;
    if (!ref) return !CONFIG.requireReferrer;
    try {
      return new URL(ref).origin === "https://" + CONFIG.oldHost;
    } catch (e) { return false; }
  }

  function alreadyMigrated() {
    try { return window.localStorage.getItem(CONFIG.doneKey) !== null; }
    catch (e) { return false; }
  }

  function restoreLocal(map) {
    var n = 0;
    if (!map || typeof map !== "object") return 0;
    Object.keys(map).slice(0, CONFIG.maxEntriesPerStore).forEach(function (k) {
      var v = map[k];
      if (!isAllowedKey("ls", k) || !isValidValue("ls", k, v)) return;
      try {
        // Newer data on the new host always wins.
        if (window.localStorage.getItem(k) === null) {
          window.localStorage.setItem(k, v);
          n++;
        }
      } catch (e) { }
    });
    return n;
  }

  function restoreCookies(map) {
    var n = 0;
    if (!map || typeof map !== "object") return 0;
    Object.keys(map).slice(0, CONFIG.maxEntriesPerStore).forEach(function (name) {
      var v = map[name];
      if (!isAllowedKey("ck", name) || !isValidValue("ck", name, v)) return;
      if (hasCookie(name)) return;
      try {
        var maxAge = name === "materio_anon_id" ? 2 * 365 * 86400 : 365 * 86400;
        document.cookie = name + "=" + v + "; Max-Age=" + maxAge + "; Path=/; SameSite=Lax; Secure";
        n++;
      } catch (e) { }
    });
    return n;
  }

  function receive() {
    var raw = String(window.name || "");
    if (raw.indexOf(CONFIG.prefix) !== 0) return;

    // Clear first so the payload never lingers, even if validation throws.
    try { window.name = ""; } catch (e) { }

    if (raw.length > CONFIG.maxRawChars) return;
    if (alreadyMigrated()) return;   // one-time use, blocks replays
    if (!referrerOk()) return;       // main defense against forged window.name

    var env = JSON.parse(decode(raw.slice(CONFIG.prefix.length)));
    if (!env || typeof env !== "object") return;
    if (env.v !== CONFIG.version || env.src !== CONFIG.oldHost) return;
    if (typeof env.ts !== "number" || typeof env.body !== "string" || typeof env.sum !== "string") return;
    if (env.sum !== fnv1a(env.body)) return;

    var age = Date.now() - env.ts;
    if (!isFinite(age) || age < -CONFIG.clockSkewMs || age > CONFIG.maxAgeMs) return;

    var data = JSON.parse(env.body);
    if (!data || typeof data !== "object") return;

    var lsCount = restoreLocal(data.ls);
    var ckCount = restoreCookies(data.ck);

    try {
      window.localStorage.setItem(CONFIG.doneKey, CONFIG.oldHost + "@" + Date.now());
    } catch (e) { }

    // Give back whatever window.name the page had before the handoff.
    if (typeof data.prev === "string" && data.prev.length <= CONFIG.maxPrevNameLen &&
        data.prev.indexOf(CONFIG.prefix) !== 0) {
      try { window.name = data.prev; } catch (e) { }
    }

    try {
      window.dispatchEvent(new CustomEvent("materio:handoff-complete", {
        detail: { localStorage: lsCount, cookies: ckCount }
      }));
    } catch (e) { }
  }

  /* ---------- entry ---------- */

  try {
    if (window.location.hostname === CONFIG.oldHost) {
      send();
    } else if (window.location.hostname === CONFIG.newHost) {
      receive();
    }
  } catch (e) {
    try {
      if (String(window.name || "").indexOf(CONFIG.prefix) === 0) window.name = "";
    } catch (e2) { }
  }
})();
