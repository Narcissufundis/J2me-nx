/*
 * pipe-host.js — DumbPipe 宿主侧实现（nx.js 适配层，第 3 层）
 *
 * pipe.js（vendor 侧）通过 alert(JSON 信封) 发消息给宿主；宿主通过
 * DumbPipe.receiveMessage({data: {pipeID, message}}) 回送。本文件注册
 * 全部管道类型的 Switch 实现：
 *
 *   mobileInfo     —— 设备信息（屏幕/UA）
 *   JARDownloader  —— 从 SD 卡读取 JAR/JAD（性能：本地读，瞬间"下载"完）
 *   audioplayer    —— 采样音频 -> nx.js WebAudio decodeAudioData
 *   exit           —— 退出应用
 *   alert          —— 控制台提示
 *   reload/gcReload/backgroundCheck/notification/windowOpen/mozActivity/
 *   socket/camera/audiorecorder/locationprovider/contacts 等 —— 桩实现
 *
 * 加载时机：vendor bundle 之后调用 installPipeHost()。
 */
'use strict';

(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : this;

  var pipes = Object.create(null);
  var nextHostPipeID = 1000000; // 与 vendor 侧 nextPipeID 空间隔离

  function sendToVendor(pipeID, message) {
    var DumbPipe = g.DumbPipe;
    if (DumbPipe && DumbPipe.receiveMessage) {
      DumbPipe.receiveMessage({ data: { pipeID: pipeID, message: message } });
    }
  }

  // 宿主信封入口（env-prelude 的 alert 通道调用）
  g.__hostPipeMessage = function (envelope) {
    if (g.__debugPipes) console.log('[pipe<-] ' + envelope.command + ':' + (envelope.type || envelope.pipeID));
    var sender = pipes[envelope.pipeID];
    switch (envelope.command) {
      case 'open':
        var handler = createPipe(envelope.type, envelope.message, envelope.pipeID);
        break;
      case 'message':
        if (sender && sender.onMessage) sender.onMessage(envelope.message);
        break;
      case 'close':
        if (sender && sender.onClose) sender.onClose();
        delete pipes[envelope.pipeID];
        break;
    }
  };

  function reply(pipeID, message) {
    sendToVendor(pipeID, message);
  }

  // ------------------------------------------------------------------
  // 各管道实现
  // ------------------------------------------------------------------

  function createPipe(type, message, pipeID) {
    var handler = { type: type, onMessage: null, onClose: null };

    switch (type) {
      case 'mobileInfo':
        reply(pipeID, {
          screenWidth: g.innerWidth,
          screenHeight: g.innerHeight,
          height: g.innerHeight,
          width: g.innerWidth,
          authType: 'open',
          userAgent: g.navigator.userAgent,
        });
        break;

      case 'JARDownloader':
        // message = { url, jadURL? } 或纯 url 字符串
        var url = typeof message === 'string' ? message : (message && (message.jadURL || message.url));
        g.__loadMidletJar(url).then(function (data) {
          reply(pipeID, { type: 'done', data: data });
        }, function (err) {
          console.error('JARDownloader: ' + err);
          reply(pipeID, { type: 'fail', reason: String(err) });
        });
        break;

      case 'audioplayer':
        // 采样音频：接到 WebAudio。协议见 midp/media.js 的 DumbPipe 消息。
        g.__audioPlayerPipe(handler, pipeID, reply);
        break;

      case 'alert':
        console.log('[MIDlet alert] ' + message);
        break;

      case 'exit':
        console.log('[host] MIDlet 请求退出');
        if (g.__onMidletExit) g.__onMidletExit();
        break;

      case 'reload':
      case 'gcReload':
        console.warn('[host] reload 管道在 Switch 上不可用');
        break;

      case 'backgroundCheck':
        reply(pipeID, { foreground: true });
        break;

      case 'windowOpen':
        console.warn('[host] windowOpen: ' + JSON.stringify(message));
        break;

      case 'socket':
        // 网络：nx.js 有 fetch 但无原生 TCP socket。桩实现：立即失败。
        console.warn('[host] socket 管道未实现（J2ME 网络游戏不可用）');
        reply(pipeID, { type: 'fail', reason: 'sockets not supported on Switch port' });
        break;

      default:
        // notification / mozActivity / camera / audiorecorder / locationprovider /
        // contacts / mozActivityHandler 等：静默桩
        console.warn('[host] 未实现的 DumbPipe 管道: ' + type);
        break;
    }

    pipes[pipeID] = handler;
    return handler;
  }

  function installPipeHost() {
    // DumbPipe.receiveMessage 由 vendor 的 pipe.js 定义；pipe.js 在
    // window.parent === window 时不覆盖 alert，我们的 env-prelude alert
    // 已经接管信封路由，无需再做事。这里只做健康检查 + 补发早期信封。
    if (typeof g.DumbPipe === 'undefined') {
      throw new Error('installPipeHost 必须在 vendor bundle（pipe.js）之后调用');
    }
    // vendor bundle 求值期间的早期信封（mobileInfo 等）此刻才到处理时机
    var pending = g.__pendingPipeEnvelopes || [];
    g.__pendingPipeEnvelopes = [];
    for (var i = 0; i < pending.length; i++) {
      g.__hostPipeMessage(pending[i]);
    }
    if (pending.length && g.__debugPipes) {
      console.log('[host] 补发早期管道信封: ' + pending.length + ' 条');
    }
  }

  g.installPipeHost = installPipeHost;
})();
