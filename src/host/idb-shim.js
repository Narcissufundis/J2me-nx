/*
 * idb-shim.js — IndexedDB 内存实现（nx.js 适配层，第 2 层）
 *
 * PluotSorbet 用 IndexedDB 存三样东西：JIT 方法缓存（已排除）、JAR 存储
 * （libs/jarstore.js）、虚拟文件系统（libs/fs.js）。nx.js 没有 IDB，
 * 这里实现三者实际用到的子集：
 *
 *   indexedDB.open(name, version) / deleteDatabase(name)
 *   IDBDatabase.transaction(storeNames, mode)
 *   createObjectStore(name) / transaction.objectStore(name)
 *   objectStore.get/put/clear/getAll/openCursor
 *   request.result / onsuccess / onerror / onupgradeneeded
 *   transaction.oncomplete
 *
 * 全内存、无持久化。持久化到 SD 的版本在宿主层后续接入（见 README 路线图）。
 * 注意：所有回调都是异步派发（Promise 微任务），与真实 IDB 的时序一致。
 */
'use strict';

(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : this;

  function asyncCall(fn, a, b) {
    Promise.resolve().then(function () { fn(a, b); });
  }

  function IDBRequest() {
    this.result = undefined;
    this.error = null;
    this.readyState = 'pending';
    this.onsuccess = null;
    this.onerror = null;
  }
  IDBRequest.prototype._succeed = function (result) {
    var self = this;
    this.result = result;
    this.readyState = 'done';
    asyncCall(function () {
      if (self.onsuccess) self.onsuccess({ target: self, type: 'success' });
    });
  };
  IDBRequest.prototype._fail = function (err) {
    var self = this;
    this.error = err;
    this.readyState = 'done';
    asyncCall(function () {
      if (self.onerror) self.onerror({ target: self, type: 'error' });
    });
  };

  function IDBObjectStore(db, name) {
    this._db = db;
    this.name = name;
    this._keyPath = (db._storeOptions[name] && db._storeOptions[name].keyPath) || null;
    if (!db._stores[name]) db._stores[name] = new Map();
  }
  IDBObjectStore.prototype._effectiveKey = function (value, key) {
    // 真实 IDB 的 keyPath 模式：put(value) 不带 key 时以 value[keyPath] 为键
    // （libs/fs.js 的 Store.sync 正是这种用法：put(record)，键为 record.pathname）
    if (key !== undefined) return key;
    if (this._keyPath && value && typeof value === 'object') return value[this._keyPath];
    return undefined;
  };
  IDBObjectStore.prototype.get = function (key) {
    var req = new IDBRequest();
    var store = this._db._stores[this.name];
    var self = this;
    asyncCall(function () {
      key = self._effectiveKey(undefined, key);
      if (!store.has(key)) req._succeed(undefined);
      else req._succeed(clone(store.get(key)));
    });
    return req;
  };
  IDBObjectStore.prototype.put = function (value, key) {
    var req = new IDBRequest();
    var store = this._db._stores[this.name];
    var db = this._db;
    var self = this;
    asyncCall(function () {
      var effKey = self._effectiveKey(value, key);
      store.set(effKey, clone(value));
      db._markDirty();
      req._succeed(effKey);
    });
    return req;
  };
  IDBObjectStore.prototype.clear = function () {
    var req = new IDBRequest();
    var store = this._db._stores[this.name];
    var db = this._db;
    asyncCall(function () {
      store.clear();
      db._markDirty();
      req._succeed(undefined);
    });
    return req;
  };
  IDBObjectStore.prototype.getAll = function () {
    var req = new IDBRequest();
    var store = this._db._stores[this.name];
    asyncCall(function () {
      var out = [];
      store.forEach(function (v) { out.push(clone(v)); });
      req._succeed(out);
    });
    return req;
  };
  IDBObjectStore.prototype.openCursor = function () {
    var req = new IDBRequest();
    var store = this._db._stores[this.name];
    asyncCall(function () {
      var entries = [];
      store.forEach(function (v, k) { entries.push({ key: k, value: clone(v) }); });
      var i = 0;
      var cursor = null;
      if (entries.length) {
        cursor = {
          key: entries[0].key,
          value: entries[0].value,
          advance: function () {
            i++;
            if (i < entries.length) {
              cursor.key = entries[i].key;
              cursor.value = entries[i].value;
              asyncCall(function () { if (req.onsuccess) req.onsuccess({ target: req }); });
            } else {
              asyncCall(function () { if (req.onsuccess) req.onsuccess({ target: req }); });
              cursor = null;
            }
          },
        };
        // IDB 惯例：再次 onsuccess 时 result 为 null 表示遍历结束
        var origAdvance = cursor.advance;
        cursor.advance = function () {
          if (i + 1 >= entries.length) {
            i++;
            asyncCall(function () { req._succeed(null); });
            return;
          }
          origAdvance();
        };
      }
      req._succeed(cursor);
    });
    return req;
  };

  // 结构化克隆的近似实现：我们的数据都是 Plain Object / TypedArray / number / string
  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) {
      return new v.constructor(v.buffer.slice(0));
    }
    if (v instanceof ArrayBuffer) return v.slice(0);
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      return new Blob([v.getBytes()], { type: v.type });
    }
    if (Array.isArray(v)) return v.map(clone);
    var out = {};
    for (var k in v) out[k] = clone(v[k]);
    return out;
  }

  function IDBTransaction(db, stores, mode) {
    this._db = db;
    this.mode = mode;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
    this._done = false;
    var self = this;
    // 所有请求排队完毕后（微任务级），触发 complete
    Promise.resolve().then(function () {
      Promise.resolve().then(function () {
        if (self._done) return;
        self._done = true;
        if (self.oncomplete) self.oncomplete({ type: 'complete' });
      });
    });
  }
  IDBTransaction.prototype.objectStore = function (name) {
    if (!this._db._stores[name]) {
      this._db._stores[name] = new Map();
    }
    return new IDBObjectStore(this._db, name);
  };
  IDBTransaction.prototype.abort = function () {
    this._done = true;
    if (this.onabort) this.onabort({ type: 'abort' });
  };

  function IDBDatabase(name, version) {
    this.name = name;
    this.version = version;
    this._stores = Object.create(null);
    this._storeOptions = Object.create(null);
    this.onversionchange = null;
  }
  IDBDatabase.prototype._markDirty = function () {
    var backend = backends[this.name];
    if (backend && backend.save) {
      var self = this;
      Promise.resolve().then(function () { backend.save(self); });
    }
  };
  IDBDatabase.prototype.createObjectStore = function (name, options) {
    if (!this._stores[name]) this._stores[name] = new Map();
    this._storeOptions[name] = options || {};
    // 兼容真实 IDB：调用方可能继续 createIndex（fs.js 建表时调用）
    return {
      name: name,
      options: options,
      createIndex: function () { return { name: arguments[0] }; },
      index: function () { return null; },
    };
  };
  IDBDatabase.prototype.deleteObjectStore = function (name) {
    delete this._stores[name];
    delete this._storeOptions[name];
  };
  IDBDatabase.prototype.transaction = function (storeNames, mode) {
    return new IDBTransaction(this, storeNames, mode || 'readonly');
  };
  IDBDatabase.prototype.close = function () {};

  var databases = Object.create(null);
  var backends = Object.create(null);

  var indexedDB = {
    open: function (name, version) {
      var req = new IDBRequest();
      function finishCreate() {
        var db = new IDBDatabase(name, version || 1);
        // 注入持久化后端预加载的数据（{ storeName: { key: record } }）
        if (backends[name] && backends[name]._data) {
          var data = backends[name]._data;
          for (var sn in data) {
            var m = new Map();
            var obj = data[sn] || {};
            for (var k in obj) m.set(k, obj[k]);
            db._stores[sn] = m;
          }
        }
        databases[name] = db;
        req.result = db;
        // 双层微任务：等调用方（open() 同步返回后）注册完 onupgradeneeded /
        // onsuccess 回调，再触发建表与成功事件
        asyncCall(function () {
          asyncCall(function () {
            // 首次创建触发 onupgradeneeded 建表（事件须带 oldVersion/newVersion，
            // fs.js 的升级逻辑依赖 oldVersion == 0 判断全新建表）
            if (req.onupgradeneeded) {
              req.transaction = new IDBTransaction(db, null, 'versionchange');
              req.onupgradeneeded({
                target: req, type: 'upgradeneeded',
                oldVersion: 0, newVersion: version || 1,
                transaction: req.transaction,
              });
            }
            req._succeed(req.result);
          });
        });
      }
      asyncCall(function () {
        var existing = databases[name];
        if (existing) {
          if (version && existing.version < version) {
            existing.version = version;
            if (req.onupgradeneeded) {
              req.onupgradeneeded({ target: req, type: 'upgradeneeded' });
            }
          }
          req.result = existing;
          req._succeed(req.result);
          return;
        }
        if (backends[name] && backends[name].load) {
          // 持久化预加载完成后才建库（保证 fs Store.init 的 getAll 能读到存档）
          Promise.resolve().then(backends[name].load).then(function (data) {
            if (backends[name]) backends[name]._data = data || {};
            finishCreate();
          }, function () {
            finishCreate();
          });
        } else {
          finishCreate();
        }
      });
      return req;
    },
    deleteDatabase: function (name) {
      var req = new IDBRequest();
      asyncCall(function () {
        delete databases[name];
        req._succeed(undefined);
      });
      return req;
    },
    // 宿主扩展：注册持久化后端（SD 卡存档）
    //   backend.load(): Promise<{ storeName: { key: record } }> | object
    //   backend.save(db): 库内数据变更后回调（_markDirty 触发，微任务级）
    __setPersistence: function (name, backend) {
      backends[name] = backend;
    },
    __getDatabase: function (name) { return databases[name]; },
    __databases: databases,
  };

  g.indexedDB = indexedDB;
  g.IDBKeyRange = g.IDBKeyRange || {
    only: function (v) { return { __only: v }; },
    lowerBound: function (v) { return { __lower: v }; },
    upperBound: function (v) { return { __upper: v }; },
  };
})();
