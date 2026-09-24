/* -*- Mode: Java; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim: set shiftwidth=4 tabstop=4 autoindent cindent expandtab: */

'use strict';

var FONT_HEIGHT_MULTIPLIER = 1.3;

var currentlyFocusedTextEditor;
(function(Native) {
    if (!inBrowser) {
        return;
    }
    var offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = MIDP.deviceContext.canvas.width;
    offscreenCanvas.height = MIDP.deviceContext.canvas.height;
    // PATCH(j2me-nx-port): 上游依赖 Firefox 壳把画布 CSS 调成设备尺寸；
    // 我们的宿主没有壳，需要确保 offscreenCanvas 与设备画布（getElementById("canvas")）
    // 尺寸一致，否则 Display.WIDTH/HEIGHT（游戏取屏宽高）错误甚至为 0。
    // 放在上游对齐行之后执行，防止 MIDP.deviceContext 异常时尺寸丢失。
    // 注意：不要引用 env-prelude 闭包内的 displayCanvas 变量（作用域不可见）。
    (function () {
      var device = document.getElementById("canvas");
      if (device && device.width > 0 && device.height > 0) {
        offscreenCanvas.width = device.width;
        offscreenCanvas.height = device.height;
      }
      console.log("[gfx-patch] device=" + (device && (device.width + "x" + device.height)) +
        " offscreenCanvas=" + offscreenCanvas.width + "x" + offscreenCanvas.height);
    })();
    var offscreenContext2D = offscreenCanvas.getContext("2d");
    var screenContextInfo = new ContextInfo(offscreenContext2D);

    MIDP.deviceContext.canvas.addEventListener("canvasresize", function() {
        // PATCH(j2me-nx-port): 同值守卫 —— nx.js 画布对 width/height 赋值
        // （含同值）都会重建 Skia surface 清空内容，这里多赋一次等于把游戏
        // 当前帧缓冲整屏抹掉；事件驱动的游戏不会自动重绘，表现为画面错乱。
        var dw = MIDP.deviceContext.canvas.width;
        var dh = MIDP.deviceContext.canvas.height;
        if (offscreenCanvas.width !== dw) offscreenCanvas.width = dw;
        if (offscreenCanvas.height !== dh) offscreenCanvas.height = dh;
        screenContextInfo.currentlyAppliedGraphicsInfo = null;
        offscreenContext2D.save();
    });

    var tempContext = document.createElement("canvas").getContext("2d");
    tempContext.canvas.width = 0;
    tempContext.canvas.height = 0;

    // REVERT(2026-09-22-1638): 撤回 1610gfx 的 drawRGB/drawPixels 性能优化
    // （固定 512 暂存画布 + ImageData 池 + 9 参 drawImage 剪裁）。实机验证
    // 立绘/文字全黑且游戏退出，恢复上游原版：每次 tempContext 重建 +
    // createImageData + putImageData + 3 参 drawImage。
    // REVERT(2026-09-22-1712): Step1 仅池化实验也实机崩溃（step1pool /
    // step1probe 各崩一次，崩点均在 drawRGB putImageData 之前的语句区间，
    // 参数全正常），**结论：ImageData 池化复用在 nx.js 实机不可靠，禁用**。
    // drawRGB 性能优化此路不通，勿再尝试跨调用复用 ImageData/TypedArray。

    Native["com/sun/midp/lcdui/DisplayDeviceContainer.getDisplayDevicesIds0.()[I"] = function(addr) {
        var idsAddr = J2ME.newIntArray(1);
        var ids = J2ME.getArrayFromAddr(idsAddr);
        ids[0] = 1;
        return idsAddr;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.getDisplayName0.(I)Ljava/lang/String;"] = function(addr, id) {
        return J2ME.Constants.NULL;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.isDisplayPrimary0.(I)Z"] = function(addr, id) {
        console.warn("DisplayDevice.isDisplayPrimary0.(I)Z not implemented (" + id + ")");
        return 1;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.isbuildInDisplay0.(I)Z"] = function(addr, id) {
        return 1;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.getDisplayCapabilities0.(I)I"] = function(addr, id) {
        return 0x3ff;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.isDisplayPenSupported0.(I)Z"] = function(addr, id) {
        return 1;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.isDisplayPenMotionSupported0.(I)Z"] = function(addr, id) {
        return 1;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.reverseOrientation0.(I)Z"] = function(addr, id) {
        return 0;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.getReverseOrientation0.(I)Z"] = function(addr, id) {
        return 0;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.getScreenWidth0.(I)I"] = function(addr, id) {
        return offscreenCanvas.width;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.getScreenHeight0.(I)I"] = function(addr, id) {
        return offscreenCanvas.height;
    };

    Native["com/sun/midp/lcdui/DisplayDevice.displayStateChanged0.(II)V"] = function(addr, hardwareId, state) {
        console.warn("DisplayDevice.displayStateChanged0.(II)V not implemented (" + hardwareId + ", " + state + ")");
    };

    Native["com/sun/midp/lcdui/DisplayDevice.gainedForeground0.(II)V"] = function(addr, hardwareId, displayId) {
        hideSplashScreen();

        if (!emoji.loaded) {
          asyncImpl("V", Promise.all(loadingFGPromises));
        }

        if (profile === 2 || profile === 3) {
          // Use setTimeout to make sure our profiling enter/leave stack is not unpaired.
          setTimeout(function () {
            stopAndSaveTimeline();
          }, 0);
        }
    };

    Native["com/sun/midp/lcdui/DisplayDeviceAccess.vibrate0.(IZ)Z"] = function(addr, displayId, on) {
        return 1;
    };

    Native["com/sun/midp/lcdui/DisplayDeviceAccess.isBacklightSupported0.(I)Z"] = function(addr, displayId) {
        return 1;
    };

    // PATCH(j2me-nx-port): 背光灯开关吞掉（Ferrari GT3 高频调用）。此前无实现
    // → VM 每次走"查表失败→抛 Java 异常→console.error"重路径，异常构造/展开
    // 全部白烧 CPU。
    Native["com/sun/midp/lcdui/DisplayDeviceAccess.toggleBacklight0.(I)Z"] = function(addr, displayId) {
        return 1;
    };

    var refreshStr = "refresh";
    Native["com/sun/midp/lcdui/DisplayDevice.refresh0.(IIIIII)V"] = function(addr, hardwareId, displayId, x1, y1, x2, y2) {
        x1 = Math.max(0, x1);
        y1 = Math.max(0, y1);
        x2 = Math.max(0, x2);
        y2 = Math.max(0, y2);

        var maxX = Math.min(offscreenCanvas.width, MIDP.deviceContext.canvas.width);
        x1 = Math.min(maxX, x1);
        x2 = Math.min(maxX, x2);

        var maxY = Math.min(offscreenCanvas.height, MIDP.deviceContext.canvas.height);
        y1 = Math.min(maxY, y1);
        y2 = Math.min(maxY, y2);

        var width = x2 - x1;
        var height = y2 - y1;
        if (width <= 0 || height <= 0) {
            return;
        }

        var ctx = $.ctx;
        window.requestAnimationFrame(function() {
            MIDP.deviceContext.drawImage(offscreenCanvas, x1, y1, width, height, x1, y1, width, height);
            J2ME.Scheduler.enqueue(ctx);
        });
        $.pause(refreshStr);
        $.nativeBailout(J2ME.Kind.Void);
    };

    function swapRB(pixel) {
        return (pixel & 0xff00ff00) | ((pixel >> 16) & 0xff) | ((pixel & 0xff) << 16);
    }

    function ABGRToARGB(abgrData, argbData, width, height, offset, scanlength) {
        var i = 0;
        for (var y = 0; y < height; y++) {
            var j = offset + y * scanlength;

            for (var x = 0; x < width; x++) {
                argbData[j++] = swapRB(abgrData[i++]);
            }
        }
    }

    function ABGRToARGB4444(abgrData, argbData, width, height, offset, scanlength) {
        var i = 0;
        for (var y = 0; y < height; y++) {
            var j = offset + y * scanlength;

            for (var x = 0; x < width; x++) {
                var abgr = abgrData[i++];
                argbData[j++] = (abgr & 0xF0000000) >>> 16 |
                                (abgr & 0x000000F0) << 4 |
                                (abgr & 0x0000F000) >> 8 |
                                (abgr & 0x00F00000) >>> 20;
            }
        }
    }

    var ABGRToRGB565_R_MASK = parseInt("000000000000000011111000", 2);
    var ABGRToRGB565_G_MASK = parseInt("000000001111110000000000", 2);
    var ABGRToRGB565_B_MASK = parseInt("111110000000000000000000", 2);

    function ABGRToRGB565(abgrData, rgbData, width, height, offset, scanlength) {
        var i = 0;
        for (var y = 0; y < height; y++) {
            var j = offset + y * scanlength;

            for (var x = 0; x < width; x++) {
                var abgr = abgrData[i++];
                rgbData[j++] = (abgr & ABGRToRGB565_R_MASK) << 8 |
                               (abgr & ABGRToRGB565_G_MASK) >>> 5 |
                               (abgr & ABGRToRGB565_B_MASK) >>> 19;
            }
        }
    }

    function ARGBToABGR(argbData, abgrData, width, height, offset, scanlength) {
        var i = 0;
        for (var y = 0; y < height; ++y) {
            var j = offset + y * scanlength;

            for (var x = 0; x < width; ++x) {
                abgrData[i++] = swapRB(argbData[j++]);
            }
        }
    }

    function ARGBTo1BGR(argbData, abgrData, width, height, offset, scanlength) {
        var i = 0;
        for (var y = 0; y < height; ++y) {
            var j = offset + y * scanlength;

            for (var x = 0; x < width; ++x) {
                abgrData[i++] = swapRB(argbData[j++]) | 0xFF000000;
            }
        }
    }

    function ARGB4444ToABGR(argbData, abgrData, width, height, offset, scanlength) {
        var i = 0;
        for (var y = 0; y < height; ++y) {
            var j = offset + y * scanlength;

            for (var x = 0; x < width; ++x) {
                var argb = argbData[j++];
                abgrData[i++] = (argb & 0xF000) << 16 |
                                (argb & 0x0F00) >>> 4 |
                                (argb & 0x00F0) << 8 |
                                (argb & 0x000F) << 20;
            }
        }
    }

    function initImageData(imageDataAddr, width, height, isMutable) {
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        var contextInfo = new ContextInfo(canvas.getContext("2d"))
        setNative(imageDataAddr, contextInfo);

        var imageData = getHandle(imageDataAddr);

        imageData.width = width;
        imageData.height = height;

        imageData.isMutable = isMutable;

        return contextInfo.context;
    }

    Native["javax/microedition/lcdui/ImageDataFactory.createImmutableImageDecodeImage.(Ljavax/microedition/lcdui/ImageData;[BII)V"] =
    function(addr, imageDataAddr, bytesAddr, offset, length) {
        var bytes = J2ME.getArrayFromAddr(bytesAddr);
        var ctx = $.ctx;
        asyncImpl("V", new Promise(function(resolve, reject) {
            var blob = new Blob([bytes.subarray(offset, offset + length)], { type: "image/png" });
            var img = new Image();
            img.src = URL.createObjectURL(blob);
            img.onload = function() {
                var context = initImageData(imageDataAddr, img.naturalWidth, img.naturalHeight, 0);
                context.drawImage(img, 0, 0);

                URL.revokeObjectURL(img.src);
                resolve();
            }
            img.onerror = function(e) {
               URL.revokeObjectURL(img.src);
               ctx.setAsCurrentContext();
               reject($.newIllegalArgumentException("error decoding image"));
            }
        }));
    };

    Native["javax/microedition/lcdui/ImageDataFactory.createImmutableImageDataRegion.(Ljavax/microedition/lcdui/ImageData;Ljavax/microedition/lcdui/ImageData;IIIIIZ)V"] =
    function(addr, dataDestAddr, dataSourceAddr, x, y, width, height, transform, isMutable) {
        var context = initImageData(dataDestAddr, width, height, isMutable);
        renderRegion(context, NativeMap.get(dataSourceAddr).context.canvas, x, y, width, height, transform, 0, 0, TOP|LEFT);
    };

    Native["javax/microedition/lcdui/ImageDataFactory.createImmutableImageDataCopy.(Ljavax/microedition/lcdui/ImageData;Ljavax/microedition/lcdui/ImageData;)V"] =
    function(addr, destAddr, sourceAddr) {
        var sourceCanvas = NativeMap.get(sourceAddr).context.canvas;
        var context = initImageData(destAddr, sourceCanvas.width, sourceCanvas.height, 0);
        context.drawImage(sourceCanvas, 0, 0);
    };

    Native["javax/microedition/lcdui/ImageDataFactory.createMutableImageData.(Ljavax/microedition/lcdui/ImageData;II)V"] =
    function(addr, imageDataAddr, width, height) {
        var context = initImageData(imageDataAddr, width, height, 1);
        context.fillStyle = "rgb(255,255,255)"; // white
        context.fillRect(0, 0, width, height);
    };

    Native["javax/microedition/lcdui/ImageDataFactory.createImmutableImageDecodeRGBImage.(Ljavax/microedition/lcdui/ImageData;[IIIZ)V"] =
    function(addr, imageDataAddr, rgbDataAddr, width, height, processAlpha) {
        var rgbData = J2ME.getArrayFromAddr(rgbDataAddr);
        var context = initImageData(imageDataAddr, width, height, 0);
        var ctxImageData = context.createImageData(width, height);
        var abgrData = new Int32Array(ctxImageData.data.buffer);

        if (1 === processAlpha) {
            ARGBToABGR(rgbData, abgrData, width, height, 0, width);
        } else {
            ARGBTo1BGR(rgbData, abgrData, width, height, 0, width);
        }

        context.putImageData(ctxImageData, 0, 0);
    };

    Native["javax/microedition/lcdui/ImageData.getRGB.([IIIIIII)V"] =
    function(addr, rgbDataAddr, offset, scanlength, x, y, width, height) {
        var rgbData = J2ME.getArrayFromAddr(rgbDataAddr);
        var abgrData = new Int32Array(NativeMap.get(addr).context.getImageData(x, y, width, height).data.buffer);
        ABGRToARGB(abgrData, rgbData, width, height, offset, scanlength);
    };

    Native["com/nokia/mid/ui/DirectUtils.makeMutable.(Ljavax/microedition/lcdui/Image;)V"] = function(addr, imageAddr) {
        var imageData = getHandle(getHandle(imageAddr).imageData);
        imageData.isMutable = 1;
    };

    Native["com/nokia/mid/ui/DirectUtils.setPixels.(Ljavax/microedition/lcdui/Image;I)V"] = function(addr, imageAddr, argb) {
        var image = getHandle(imageAddr);
        var width = image.width;
        var height = image.height;

        // NOTE: This function will only ever be called by the variants
        // of `DirectUtils.createImage`. We don't have to worry about
        // the dimensions or the context info because this `Image` and
        // this `ImageData` were just created; nothing can be out of
        // sync yet.
        var ctx = NativeMap.get(image.imageData).context;

        var ctxImageData = ctx.createImageData(width, height);
        var pixels = new Int32Array(ctxImageData.data.buffer);

        var color = swapRB(argb);

        var i = 0;
        for (var y = 0; y < height; ++y) {
            for (var x = 0; x < width; ++x) {
                pixels[i++] = color;
            }
        }

        ctx.putImageData(ctxImageData, 0, 0);
    };

    var FACE_SYSTEM = 0;
    var FACE_MONOSPACE = 32;
    var FACE_PROPORTIONAL = 64;
    var STYLE_PLAIN = 0;
    var STYLE_BOLD = 1;
    var STYLE_ITALIC = 2;
    var STYLE_UNDERLINED = 4;
    var SIZE_SMALL = 8;
    var SIZE_MEDIUM = 0;
    var SIZE_LARGE = 16;

    Native["javax/microedition/lcdui/Font.init.(III)V"] = function(addr, face, style, size) {
        var self = getHandle(addr);
        var defaultSize = config.fontSize ? config.fontSize : Math.max(19, (offscreenCanvas.height / 35) | 0);
        if (size & SIZE_SMALL)
            size = defaultSize / 1.25;
        else if (size & SIZE_LARGE)
            size = defaultSize * 1.25;
        else
            size = defaultSize;
        size |= 0;

        if (style & STYLE_BOLD)
            style = "bold ";
        else if (style & STYLE_ITALIC)
            style = "italic ";
        else
            style = "";

        // PATCH(j2me-nx-port): nx.js canvas 无内置 CJK 字形（Geist Mono/system-ui
        // 均无汉字），中文 J2ME 游戏 drawString 全是空白。app/main.js 启动时从
        // romfs 注册 SimHei 为 FontFace 家族并设 window.__j2meFontFamily =
        // "j2mecjk"（注册失败则不设，回落原 face 保证至少不崩）。
        // 注意：必须是【单个 family + 双引号】——nx.js canvas 的 font 解析器
        // 对 "A,B" 逗号列表解析不可靠（mv2switch 实机结论），逗号列表会整体
        // 解析失败回落默认字体 → 汉字全画成 .notdef 口框（缺字根因）。
        var hostFace = (typeof window !== 'undefined' && window.__j2meFontFamily) || null;
        if (hostFace) {
            face = '"' + hostFace + '"';
        } else if (face & FACE_MONOSPACE)
            face = "monospace";
        else if (face & FACE_PROPORTIONAL)
            face = "sans-serif";
        else
            face = "Arial,Helvetica,sans-serif";

        self.baseline = size | 0;
        self.height = (size * FONT_HEIGHT_MULTIPLIER) | 0;

        var context = document.createElement("canvas").getContext("2d");
        setNative(addr, context);
        context.canvas.width = 0;
        context.canvas.height = 0;
        context.font = style + size + "px " + face;

        // PATCH(j2me-nx-port): nx.js canvas 的 ctx.font 属性【getter 是坏的】，
        // 读回永远是 undefined（setter 正常，探测已证明）。凡是从 ctx.font
        // 读回再赋值的地方（applyGraphics/measureWidth）都会把字体串污染成
        // undefined → 回落系统默认字体（日文）→ 简体特有字（谁开启乐确戏调
        // 统单…）全画成口口。这里用自定义属性 fontCss 存字体串（同 fontSize
        // 的做法，绕开 WebIDL getter），所有读回点一律用 fontCss。
        context.fontCss = style + size + "px " + face;

        // This is a custom property that we set on the context so we can
        // access it in natives.  Note the difference between this value,
        // which represents the size of the font in pixels, and the Font.size
        // field, which stores one of the three font size bit mask constants
        // (SIZE_SMALL, SIZE_MEDIUM, SIZE_LARGE).
        context.fontSize = size;
    };

    // PATCH(j2me-nx-port): 本运行时在 0 尺寸离屏画布上 measureText 返回
    // undefined → stringWidth NPE。宿主注入 window.__hostMeasureText(font, text)
    // （探测 measureText 可用性，不可用则像素扫描），这里优先原生、回落宿主。
    function measureWidth(fontContext, str) {
        var m = fontContext.measureText(str);
        if (m && typeof m.width === "number")
            return m.width;
        var host = (typeof window !== "undefined" && window.__hostMeasureText) || null;
        if (host)
            return host(fontContext.fontCss || fontContext.font, str); // PATCH: 读回坏 getter，见 Font.init 注释
        return str.length * ((fontContext.fontSize / 2) | 0);
    }

    function calcStringWidth(fontContext, str) {
        var emojiLen = 0;

        var plain = str.replace(emoji.regEx, function() {
            emojiLen += fontContext.fontSize;
            return "";
        });

        var len = measureWidth(fontContext, plain) | 0;

        return len + emojiLen;
    }

    var defaultFontAddress;
    function getDefaultFontAddress() {
        if (!defaultFontAddress) {
            var classInfo = CLASSES.loadClass("javax/microedition/lcdui/Font");
            defaultFontAddress = J2ME.allocUncollectableObject(classInfo);
            var methodInfo = classInfo.getMethodByNameString("<init>", "(III)V", false);
            J2ME.preemptionLockLevel++;
            J2ME.getLinkedMethod(methodInfo)(defaultFontAddress, 0, 0, 0);
            release || J2ME.Debug.assert(!U, "Unexpected unwind during createException.");
            J2ME.preemptionLockLevel--;
        }
        return defaultFontAddress;
    }

    Native["javax/microedition/lcdui/Font.getDefaultFont.()Ljavax/microedition/lcdui/Font;"] = function(addr) {
        return getDefaultFontAddress();
    };

    Native["javax/microedition/lcdui/Font.stringWidth.(Ljava/lang/String;)I"] = function(addr, strAddr) {
        var fontContext = NativeMap.get(addr);
        // PATCH: 悬空字体防御（Font 自身被 GC 后 native 数据随 onFinalize 删除）
        if (!fontContext) return J2ME.fromStringAddr(strAddr).length * 8;
        return calcStringWidth(fontContext, J2ME.fromStringAddr(strAddr));
    };

    Native["javax/microedition/lcdui/Font.charWidth.(C)I"] = function(addr, char) {
        var fontContext = NativeMap.get(addr);
        // PATCH(j2me-nx-port): 同 calcStringWidth，measureText 失效时走宿主兜底
        if (!fontContext) return 8; // PATCH: 悬空字体防御
        return measureWidth(fontContext, String.fromCharCode(char)) | 0;
    };

    Native["javax/microedition/lcdui/Font.charsWidth.([CII)I"] = function(addr, charsAddr, offset, len) {
        var fontContext = NativeMap.get(addr);
        return calcStringWidth(fontContext, J2ME.fromJavaChars(charsAddr, offset, len));
    };

    Native["javax/microedition/lcdui/Font.substringWidth.(Ljava/lang/String;II)I"] = function(addr, strAddr, offset, len) {
        var fontContext = NativeMap.get(addr);
        return calcStringWidth(fontContext, J2ME.fromStringAddr(strAddr).slice(offset, offset + len));
    };

    var HCENTER = 1;
    var VCENTER = 2;
    var LEFT = 4;
    var RIGHT = 8;
    var TOP = 16;
    var BOTTOM = 32;
    var BASELINE = 64;

    function withTextAnchor(c, fontContext, anchor, x, str) {
        if (anchor & RIGHT || anchor & HCENTER) {
            var w = calcStringWidth(fontContext, str);

            if (anchor & RIGHT) {
                x -= w;
            } else if (anchor & HCENTER) {
                x -= (w >>> 1) | 0;
            }
        }

        if (anchor & BOTTOM) {
            c.textBaseline = "bottom";
        } else if (anchor & BASELINE) {
            c.textBaseline = "alphabetic";
        } else if (anchor & VCENTER) {
            throw $.newIllegalArgumentException("VCENTER not allowed with text");
        } else {
            c.textBaseline = "top";
        }

        return x;
    }

    /**
     * create the outline of an elliptical arc
     * covering the specified rectangle.
     * @param x the x-coordinate of the center of the ellipse.
     * @param y y-coordinate of the center of the ellipse.
     * @param rw the horizontal radius of the arc.
     * @param rh the vertical radius of the arc.
     * @param arcStart the beginning angle
     * @param arcEnd the ending angle
     * @param closed if true, draw a closed arc sector.
     */
    function createEllipticalArc(c, x, y, rw, rh, arcStart, arcEnd, closed) {
          c.save();
          c.translate(x, y);
          if (closed) {
            c.moveTo(0, 0);
          }
          // draw circle arc which will be stretched into an oval arc
          c.scale(1, rh / rw);
          c.arc(0, 0, rw, arcStart, arcEnd, false);
          if (closed) {
            c.lineTo(0, 0);
          }
          c.restore();
    }

    /**
     * Create a round rectangle path.
     * @param x the x coordinate of the rectangle
     * @param y the y coordinate of the rectangle
     * @param width the width of the rectangle
     * @param height the height of the rectangle
     * @param arcWidth the horizontal diameter of the arc at the four corners
     * @param arcHeight the vertical diameter of the arc at the four corners
     */
    function createRoundRect(c, x, y, width, height, arcWidth, arcHeight) {
        var rw = arcWidth / 2;
        var rh = arcHeight / 2;
        c.moveTo(x + rw, y);
        c.lineTo(x + width - rw, y);
        createEllipticalArc(c, x + width - rw, y + rh, rw, rh, 1.5 * Math.PI, 2 * Math.PI, false);
        c.lineTo(x + width, y + height - rh);
        createEllipticalArc(c, x + width - rw, y + height - rh, rw, rh, 0, 0.5 * Math.PI, false);
        c.lineTo(x + rw, y + height);
        createEllipticalArc(c, x + rw, y + height - rh, rw, rh, 0.5 * Math.PI, Math.PI, false);
        c.lineTo(x, y + rh);
        createEllipticalArc(c, x + rw, y + rh, rw, rh, Math.PI, 1.5 * Math.PI, false);
    }

    Native["javax/microedition/lcdui/Graphics.getDisplayColor.(I)I"] = function(addr, color) {
        return color & 0x00FFFFFF;
    };

    Native["javax/microedition/lcdui/Graphics.resetGC.()V"] = function(addr) {
        NativeMap.get(addr).resetGC();
    };

    Native["javax/microedition/lcdui/Graphics.reset.(IIII)V"] = function(addr, x1, y1, x2, y2) {
        NativeMap.get(addr).reset(x1, y1, x2, y2);
    };

    Native["javax/microedition/lcdui/Graphics.reset.()V"] = function(addr) {
        var info = NativeMap.get(addr);
        info.reset(0, 0, info.contextInfo.context.canvas.width, info.contextInfo.context.canvas.height);
    };

    Native["javax/microedition/lcdui/Graphics.copyArea.(IIIIIII)V"] = function(addr, x_src, y_src, width, height, x_dest, y_dest, anchor) {
        var self = getHandle(addr);
        if (isScreenGraphics(self)) {
            throw $.newIllegalStateException();
        }
        console.warn("javax/microedition/lcdui/Graphics.copyArea.(IIIIIII)V not implemented");
    };

    Native["javax/microedition/lcdui/Graphics.setDimensions.(II)V"] = function(addr, w, h) {
        NativeMap.get(addr).resetNonGC(0, 0, w, h);
    };

    Native["javax/microedition/lcdui/Graphics.translate.(II)V"] = function(addr, x, y) {
        NativeMap.get(addr).translate(x, y);
    };

    Native["javax/microedition/lcdui/Graphics.getTranslateX.()I"] = function(addr) {
        return NativeMap.get(addr).transX;
    };

    Native["javax/microedition/lcdui/Graphics.getTranslateY.()I"] = function(addr) {
        return NativeMap.get(addr).transY;
    };

    Native["javax/microedition/lcdui/Graphics.getMaxWidth.()S"] = function(addr) {
        return NativeMap.get(addr).contextInfo.context.canvas.width;
    };

    Native["javax/microedition/lcdui/Graphics.getMaxHeight.()S"] = function(addr) {
        return NativeMap.get(addr).contextInfo.context.canvas.height;
    };

    Native["javax/microedition/lcdui/Graphics.getCreator.()Ljava/lang/Object;"] = function(addr) {
        var self = getHandle(addr);
        return self.creator;
    };

    Native["javax/microedition/lcdui/Graphics.setCreator.(Ljava/lang/Object;)V"] = function(addr, creatorAddr) {
        var self = getHandle(addr);
        // Per the original, non-native implementation of this method,
        // ignore repeated attempts to set creator.
        if (self.creator === J2ME.Constants.NULL) {
            self.creator = creatorAddr;
        }
    };

    Native["javax/microedition/lcdui/Graphics.getColor.()I"] = function(addr) {
        var info = NativeMap.get(addr);
        return (info.red << 16) | (info.green << 8) | info.blue;
    };

    Native["javax/microedition/lcdui/Graphics.getRedComponent.()I"] = function(addr) {
        return NativeMap.get(addr).red;
    };

    Native["javax/microedition/lcdui/Graphics.getGreenComponent.()I"] = function(addr) {
        return NativeMap.get(addr).green;
    };

    Native["javax/microedition/lcdui/Graphics.getBlueComponent.()I"] = function(addr) {
        return NativeMap.get(addr).blue;
    };

    Native["javax/microedition/lcdui/Graphics.getGrayScale.()I"] = function(addr) {
        var info = NativeMap.get(addr);
        return (info.red*76 + info.green*150 + info.blue*29) >>> 8;
    };

    Native["javax/microedition/lcdui/Graphics.setColor.(III)V"] = function(addr, red, green, blue) {
        if ((red < 0)   || (red > 255)
            || (green < 0) || (green > 255)
            || (blue < 0)  || (blue > 255)) {
            throw $.newIllegalArgumentException("Value out of range");
        }

        NativeMap.get(addr).setPixel(0xFF, red, green, blue);
    };

    Native["javax/microedition/lcdui/Graphics.setColor.(I)V"] = function(addr, rgb) {
        var red = (rgb >>> 16) & 0xFF;
        var green = (rgb >>> 8) & 0xFF;
        var blue = rgb & 0xFF;

        // NOTE: One would probably expect that `Graphics.setColor`
        // would always set the alpha value to 0xFF but that is not
        // the case if the current RGB value is the same as
        // value being set. This is the behavior
        // of the reference implementation so we are copying
        // that behavior.
        var info = NativeMap.get(addr);
        if (red != info.red || green != info.green || blue != info.blue) {
            info.setPixel(0xFF, red, green, blue);
        }
    };

    Native["javax/microedition/lcdui/Graphics.setGrayScale.(I)V"] = function(addr, value) {
        if ((value < 0) || (value > 255)) {
            throw $.newIllegalArgumentException("Gray value out of range");
        }

        // NOTE: One would probably expect that `Graphics.setGrayScale`
        // would always set the alpha value to 0xFF but that is not
        // the case if the red, green, and blue color values are
        // the same as the values being set. This is the behavior
        // of the reference implementation so we are copying
        // that behavior.
        var info = NativeMap.get(addr);
        if (value != info.red || value != info.green || value != info.blue) {
            info.setPixel(0xFF, value, value, value);
        }
    };

    Native["javax/microedition/lcdui/Graphics.getFont.()Ljavax/microedition/lcdui/Font;"] = function(addr) {
        var info = NativeMap.get(addr);
        // PATCH: 悬空字体自愈（Font 被 GC 后 currentFont 失效，见 resolveFontContext）
        resolveFontContext(info);
        return info.currentFont;
    };

    Native["javax/microedition/lcdui/Graphics.setFont.(Ljavax/microedition/lcdui/Font;)V"] = function(addr, fontAddr) {
        NativeMap.get(addr).setFont(fontAddr);
    };

    var SOLID = 0;
    var DOTTED = 1;
    Native["javax/microedition/lcdui/Graphics.setStrokeStyle.(I)V"] = function(addr, style) {
        if ((style !== SOLID) && (style !== DOTTED)) {
            throw $.newIllegalArgumentException("Invalid stroke style");
        }

        // We don't actually implement DOTTED style so this is a no-op
    };

    Native["javax/microedition/lcdui/Graphics.getStrokeStyle.()I"] = function(addr) {
        return SOLID;
    };

    Native["javax/microedition/lcdui/Graphics.getClipX.()I"] = function(addr) {
        var info = NativeMap.get(addr);
        return info.clipX1 - info.transX;
    };

    Native["javax/microedition/lcdui/Graphics.getClipY.()I"] = function(addr) {
        var info = NativeMap.get(addr);
        return info.clipY1 - info.transY;
    };

    Native["javax/microedition/lcdui/Graphics.getClipWidth.()I"] = function(addr) {
        var info = NativeMap.get(addr);
        return info.clipX2 - info.clipX1;
    };

    Native["javax/microedition/lcdui/Graphics.getClipHeight.()I"] = function(addr) {
        var info = NativeMap.get(addr);
        return info.clipY2 - info.clipY1;
    };

    Native["javax/microedition/lcdui/Graphics.getClip.([I)V"] = function(addr, regionAddr) {
        var region = J2ME.getArrayFromAddr(regionAddr);
        var info = NativeMap.get(addr);
        region[0] = info.clipX1 - info.transX;
        region[1] = info.clipY1 - info.transY;
        region[2] = info.clipX2 - info.transX;
        region[3] = info.clipY2 - info.transY;
    };

    Native["javax/microedition/lcdui/Graphics.clipRect.(IIII)V"] = function(addr, x, y, width, height) {
        var info = NativeMap.get(addr);
        info.setClip(x, y, width, height, info.clipX1, info.clipY1, info.clipX2, info.clipY2);
    };

    // DirectGraphics constants
    var TYPE_USHORT_4444_ARGB = 4444;
    var TYPE_USHORT_565_RGB = 565;

    Native["com/nokia/mid/ui/DirectGraphicsImp.setARGBColor.(I)V"] = function(addr, argb) {
        var self = getHandle(addr);
        var alpha = (argb >>> 24);
        var red = (argb >>> 16) & 0xFF;
        var green = (argb >>> 8) & 0xFF;
        var blue = argb & 0xFF;
        NativeMap.get(self.graphics).setPixel(alpha, red, green, blue);
    };

    Native["com/nokia/mid/ui/DirectGraphicsImp.getAlphaComponent.()I"] = function(addr) {
        var self = getHandle(addr);
        return NativeMap.get(self.graphics).alpha;
    };

    Native["com/nokia/mid/ui/DirectGraphicsImp.getPixels.([SIIIIIII)V"] =
    function(addr, pixelsAddr, offset, scanlength, x, y, width, height, format) {
        var self = getHandle(addr);
        var pixels = J2ME.getArrayFromAddr(pixelsAddr);

        if (!pixels) {
            throw $.newNullPointerException("Pixels array is null");
        }

        var converterFunc = null;
        if (format === TYPE_USHORT_4444_ARGB) {
            converterFunc = ABGRToARGB4444;
        } else if (format === TYPE_USHORT_565_RGB) {
            converterFunc = ABGRToRGB565;
        } else {
            throw $.newIllegalArgumentException("Format unsupported");
        }

        var context = NativeMap.get(self.graphics).contextInfo.context;
        var abgrData = new Int32Array(context.getImageData(x, y, width, height).data.buffer);
        converterFunc(abgrData, pixels, width, height, offset, scanlength);
    };

    // PATCH(j2me-nx-port): Nokia DirectGraphics 多边形原补。此前缺失，
    // 游戏每帧调用会抛 "native but does not have an implementation" 异常，
    // 异常 + console.error + error.log 落卡把主线程拖到 15~20fps。
    function nokiaPolygon(c, info, xs, xOffset, ys, yOffset, nPoints) {
        if (nPoints < 1 || !xs || !ys) return;
        c.beginPath();
        c.moveTo(xs[xOffset], ys[yOffset]);
        for (var i = 1; i < nPoints; i++) {
            c.lineTo(xs[xOffset + i], ys[yOffset + i]);
        }
        c.closePath();
        c.fill();
        // 恢复 Graphics 自己的填充色（applyGraphics 只在 GraphicsInfo 变更时重设）
        c.fillStyle = util.rgbaToCSS(info.red, info.green, info.blue, info.alpha / 255);
    }

    Native["com/nokia/mid/ui/DirectGraphicsImp.fillPolygon.([II[IIII)V"] =
    function(addr, xPointsAddr, xOffset, yPointsAddr, yOffset, nPoints, argb) {
        var self = getHandle(addr);
        var xs = J2ME.getArrayFromAddr(xPointsAddr);
        var ys = J2ME.getArrayFromAddr(yPointsAddr);
        var info = NativeMap.get(self.graphics);
        var c = info.getGraphicsContext();
        var alpha = (argb >>> 24);
        var red = (argb >>> 16) & 0xFF;
        var green = (argb >>> 8) & 0xFF;
        var blue = argb & 0xFF;
        c.fillStyle = util.rgbaToCSS(red, green, blue, alpha / 255);
        nokiaPolygon(c, info, xs, xOffset, ys, yOffset, nPoints);
    };

    Native["com/nokia/mid/ui/DirectGraphicsImp.drawPolygon.([II[IIII)V"] =
    function(addr, xPointsAddr, xOffset, yPointsAddr, yOffset, nPoints, argb) {
        var self = getHandle(addr);
        var xs = J2ME.getArrayFromAddr(xPointsAddr);
        var ys = J2ME.getArrayFromAddr(yPointsAddr);
        var info = NativeMap.get(self.graphics);
        var c = info.getGraphicsContext();
        var alpha = (argb >>> 24);
        var red = (argb >>> 16) & 0xFF;
        var green = (argb >>> 8) & 0xFF;
        var blue = argb & 0xFF;
        c.strokeStyle = util.rgbaToCSS(red, green, blue, alpha / 255);
        if (nPoints >= 1 && xs && ys) {
            c.beginPath();
            c.moveTo(xs[xOffset], ys[yOffset]);
            for (var i = 1; i < nPoints; i++) {
                c.lineTo(xs[xOffset + i], ys[yOffset + i]);
            }
            c.closePath();
            c.stroke();
            c.strokeStyle = util.rgbaToCSS(info.red, info.green, info.blue, info.alpha / 255);
        }
    };

    Native["com/nokia/mid/ui/DirectGraphicsImp.drawPixels.([SZIIIIIIII)V"] =
    function(addr, pixelsAddr, transparency, offset, scanlength, x, y, width, height, manipulation, format) {
        var self = getHandle(addr);
        var pixels = J2ME.getArrayFromAddr(pixelsAddr);

        if (!pixels) {
            throw $.newNullPointerException("Pixels array is null");
        }

        var converterFunc = null;
        if (format === TYPE_USHORT_4444_ARGB && transparency && !manipulation) {
            converterFunc = ARGB4444ToABGR;
        } else {
            throw $.newIllegalArgumentException("Format unsupported");
        }

        // REVERT(2026-09-22-1712): 恢复上游原版逐次重建实现（同 drawRGB，池化禁用）
        tempContext.canvas.width = width;
        tempContext.canvas.height = height;
        var imageData = tempContext.createImageData(width, height);
        var abgrData = new Int32Array(imageData.data.buffer);

        converterFunc(pixels, abgrData, width, height, offset, scanlength);

        tempContext.putImageData(imageData, 0, 0);

        var c = NativeMap.get(self.graphics).getGraphicsContext();

        c.drawImage(tempContext.canvas, x, y);
        tempContext.canvas.width = 0;
        tempContext.canvas.height = 0;
    };

    // ==================================================================
    // PATCH(j2me-nx-port 2026-09-23 perfZ7): Nokia DirectGraphics.drawImage（此前**完全没实现**）
    //
    // 实机症状：1.jar（武林Q传）进得去、文字/菜单/软键盘都正常，但**立绘和地图整片全黑**。
    //
    // 机制（重要）：VM 对"Java 声明了、JS 没注册"的 native **既不抛异常也不崩**，而是
    // 返回一个只打一行 console.error 的空函数（见 vendor/pluotsorbet/vm/runtime.ts:904
    // "is native but does not have an implementation"）。所以游戏调用它 = **什么都没画**，
    // 同时每帧打一行错误并落卡（实机日志里 22 次，还拖慢主线程）。
    // 1.jar 的地图/立绘全走这条路：g.class 里 8 处 drawImage 调用点，manipulation 分别是
    //   0 / 8192(FLIP_HORIZONTAL) / 16384(FLIP_VERTICAL) / 90 / 180 / 270
    // —— 典型的"地图块靠翻转+旋转拼角"画法，所以整张地图一起黑，而 fillPolygon（已实现）
    // 画的图形和标准 Graphics 画的文字照常显示。
    //
    // manipulation → MIDP drawRegion transform 的映射照抄同源的 Java 版模拟器源码
    // （D:\新建文件夹\myjump\javasrc\midp\gfx.js 的 nokiaManipulationToMidpTransform，
    //  那边是按真实游戏反汇编对照过的）：
    //   ⚠️ Nokia 的 ROTATE_90 是**逆时针**，等价 MIDP 的 TRANS_ROT270(6)；
    //      ROTATE_270 → TRANS_ROT90(5)。方向若反了，地图块会转错 90°（不会黑）。
    //   带旋转的翻转组合只覆盖参考实现里对照过的两种（FLIP_H|ROT90、FLIP_V|ROT90），
    //   其余组合按"旋转优先"处理（与参考实现一致）。
    // ==================================================================
    var DG_FLIP_HORIZONTAL = 8192;
    var DG_FLIP_VERTICAL = 16384;
    var DG_FLIP_MASK = DG_FLIP_HORIZONTAL | DG_FLIP_VERTICAL;
    var DG_ROTATE_90 = 90;
    var DG_ROTATE_180 = 180;
    var DG_ROTATE_270 = 270;

    function nokiaManipulationToMidpTransform(manipulation) {
        var man = manipulation | 0;
        switch (man) {
            case 0:
                return TRANS_NONE;
            case DG_FLIP_HORIZONTAL:
                return TRANS_MIRROR;
            case DG_FLIP_VERTICAL:
                return TRANS_MIRROR_ROT180;
            case DG_ROTATE_180:
                return TRANS_ROT180;
            case DG_ROTATE_90:
                return TRANS_ROT270;          // Nokia 逆时针 90 == MIDP 顺时针 270
            case DG_ROTATE_270:
                return TRANS_ROT90;
            case DG_FLIP_HORIZONTAL | DG_ROTATE_90:
                return TRANS_MIRROR_ROT90;
            case DG_FLIP_VERTICAL | DG_ROTATE_90:
                return TRANS_MIRROR_ROT270;
            default: {
                var rot = man & ~DG_FLIP_MASK;
                if (rot === DG_ROTATE_90) {
                    return (man & DG_FLIP_HORIZONTAL) ? TRANS_MIRROR_ROT90 : TRANS_ROT270;
                }
                if (rot === DG_ROTATE_180) {
                    return TRANS_ROT180;
                }
                if (rot === DG_ROTATE_270) {
                    return TRANS_ROT90;
                }
                var flipH = (man & DG_FLIP_HORIZONTAL) !== 0;
                var flipV = (man & DG_FLIP_VERTICAL) !== 0;
                if (flipH && flipV) {
                    return TRANS_ROT180;
                }
                if (flipH) {
                    return TRANS_MIRROR;
                }
                if (flipV) {
                    return TRANS_MIRROR_ROT180;
                }
                return TRANS_NONE;
            }
        }
    }

    Native["com/nokia/mid/ui/DirectGraphicsImp.drawImage.(Ljavax/microedition/lcdui/Image;IIII)V"] =
    function(addr, imageAddr, x, y, anchor, manipulation) {
        if (imageAddr === J2ME.Constants.NULL) {
            throw $.newNullPointerException("image is null");
        }

        var self = getHandle(addr);
        var image = getHandle(imageAddr);
        var imageData = getHandle(image.imageData);
        var transform = nokiaManipulationToMidpTransform(manipulation);
        renderRegion(NativeMap.get(self.graphics).getGraphicsContext(),
                     NativeMap.get(image.imageData).context.canvas,
                     0, 0, imageData.width, imageData.height, transform, x, y, anchor);
    };

    // DirectGraphics.drawPixels(byte[] pixels, byte[] transparencyMask, ...)：1bit 单色位图。
    // 1.jar 没用到，但按参考实现补齐 —— 这类"缺 native"的坑一旦被别的游戏踩到，
    // 表现同样是"整块画面没了"，而且每帧刷日志。
    Native["com/nokia/mid/ui/DirectGraphicsImp.drawPixels.([B[BIIIIIIII)V"] =
    function(addr, pixelsAddr, maskAddr, offset, scanlength, x, y, width, height, manipulation, format) {
        var self = getHandle(addr);
        var pixels = J2ME.getArrayFromAddr(pixelsAddr);
        if (!pixels) {
            throw $.newNullPointerException("Pixels array is null");
        }
        var mask = maskAddr === J2ME.Constants.NULL ? null : J2ME.getArrayFromAddr(maskAddr);
        var man = manipulation | 0;
        var rotation = man & ~DG_FLIP_MASK;
        // TYPE_BYTE_1_GRAY(1) / TYPE_BYTE_1_GRAY_VERTICAL(-1)
        if ((format !== 1 && format !== -1) || width < 0 || height < 0 ||
            (rotation !== 0 && rotation !== DG_ROTATE_90 && rotation !== DG_ROTATE_180 &&
             rotation !== DG_ROTATE_270) || (format === -1 && scanlength <= 0)) {
            throw $.newIllegalArgumentException("Unsupported monochrome format, size or manipulation");
        }
        if (!width || !height) {
            return;
        }

        // 先把源数组边界全查完，再分配/改目标（参考实现的做法）
        var firstRow = format === -1 ? Math.floor(offset / scanlength) : 0;
        var firstColumn = format === -1 ? offset % scanlength : 0;
        for (var row = 0; row < height; row++) {
            var first = format === -1 ? Math.floor((firstRow + row) / 8) * scanlength + firstColumn :
                Math.floor((offset + row * scanlength) / 8);
            var last = format === -1 ? first + width - 1 :
                Math.floor((offset + row * scanlength + width - 1) / 8);
            if (first < 0 || last >= pixels.length || (mask && last >= mask.length)) {
                throw $.newArrayIndexOutOfBoundsException("Monochrome pixel or mask array too small");
            }
        }

        if (tempContext.canvas.width < width) tempContext.canvas.width = width;
        if (tempContext.canvas.height < height) tempContext.canvas.height = height;
        var imageData = tempContext.createImageData(width, height);
        var rgba = imageData.data;
        var out = 0;
        for (var sy = 0; sy < height; sy++) {
            for (var sx = 0; sx < width; sx++) {
                var index, bit;
                if (format === -1) {
                    index = Math.floor((firstRow + sy) / 8) * scanlength + firstColumn + sx;
                    bit = (firstRow + sy) & 7;
                } else {
                    var pixel = offset + sy * scanlength + sx;
                    index = Math.floor(pixel / 8);
                    bit = 7 - (pixel & 7);
                }
                var gray = ((pixels[index] >>> bit) & 1) ? 0 : 255;
                rgba[out++] = gray;
                rgba[out++] = gray;
                rgba[out++] = gray;
                rgba[out++] = (!mask || ((mask[index] >>> bit) & 1)) ? 255 : 0;
            }
        }
        tempContext.putImageData(imageData, 0, 0);

        var c = NativeMap.get(self.graphics).getGraphicsContext();
        var flipH = (man & DG_FLIP_HORIZONTAL) !== 0;
        var flipV = (man & DG_FLIP_VERTICAL) !== 0;
        var dw = (rotation === DG_ROTATE_90 || rotation === DG_ROTATE_270) ? height : width;
        var dh = (rotation === DG_ROTATE_90 || rotation === DG_ROTATE_270) ? width : height;
        c.save();
        try {
            // Nokia：先逆时针旋转，再在旋转后的图像轴上翻转
            c.translate(x + (flipH ? dw : 0), y + (flipV ? dh : 0));
            c.scale(flipH ? -1 : 1, flipV ? -1 : 1);
            if (rotation === DG_ROTATE_90) {
                c.translate(0, width);
                c.rotate(-Math.PI / 2);
            } else if (rotation === DG_ROTATE_180) {
                c.translate(width, height);
                c.rotate(Math.PI);
            } else if (rotation === DG_ROTATE_270) {
                c.translate(height, 0);
                c.rotate(Math.PI / 2);
            }
            c.drawImage(tempContext.canvas, 0, 0, width, height, 0, 0, width, height);
        } finally {
            c.restore();
        }
        tempContext.canvas.width = 0;
        tempContext.canvas.height = 0;
    };

    // DirectGraphics.fillTriangle / drawTriangle：坐标 + ARGB 直填。
    Native["com/nokia/mid/ui/DirectGraphicsImp.fillTriangle.(IIIIIII)V"] =
    function(addr, x1, y1, x2, y2, x3, y3, argb) {
        var self = getHandle(addr);
        var info = NativeMap.get(self.graphics);
        var c = info.getGraphicsContext();
        var alpha = (argb >>> 24) & 0xFF;
        var red = (argb >>> 16) & 0xFF;
        var green = (argb >>> 8) & 0xFF;
        var blue = argb & 0xFF;
        c.fillStyle = util.rgbaToCSS(red, green, blue, alpha / 255);
        c.beginPath();
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        c.lineTo(x3, y3);
        c.closePath();
        c.fill();
        c.fillStyle = util.rgbaToCSS(info.red, info.green, info.blue, info.alpha / 255);
    };

    Native["com/nokia/mid/ui/DirectGraphicsImp.drawTriangle.(IIIIIII)V"] =
    function(addr, x1, y1, x2, y2, x3, y3, argb) {
        var self = getHandle(addr);
        var info = NativeMap.get(self.graphics);
        var c = info.getGraphicsContext();
        var alpha = (argb >>> 24) & 0xFF;
        var red = (argb >>> 16) & 0xFF;
        var green = (argb >>> 8) & 0xFF;
        var blue = argb & 0xFF;
        c.strokeStyle = util.rgbaToCSS(red, green, blue, alpha / 255);
        c.beginPath();
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        c.lineTo(x3, y3);
        c.closePath();
        c.stroke();
        c.strokeStyle = util.rgbaToCSS(info.red, info.green, info.blue, info.alpha / 255);
    };

    // getNativePixelFormat：只报我们**确实支持**的格式，免得游戏照着返回值去调
    // drawPixels 反而撞上 IllegalArgumentException（见上面那几条的限制）。
    Native["com/nokia/mid/ui/DirectGraphicsImp.getNativePixelFormat.()I"] = function(addr) {
        return TYPE_USHORT_4444_ARGB;
    };

    // 剩下这 4 条本移植确实没实现，实测游戏里也没碰到过。统一收成
    // addUnimplementedNative = "只告警一次 + 不画 + 不抛异常"：
    // VM 对缺失 native 的默认行为是**每次调用**打一行 console.error 并落卡
    // （runtime.ts:904），一帧几十次调用时等于白扔帧率 —— 这正是这次"立绘地图全黑"
    // 顺带暴露出来的第二个代价。以后哪个游戏真需要，按上面的 drawImage 照着补。
    // ⚠️ 描述符必须一个字符都不错：写错了不是"报错"，而是**静默不生效**
    // （ImplKey 对不上 = VM 认为没实现）。tests/nokia-natives.test.mjs 会逐条核对。
    addUnimplementedNative("com/nokia/mid/ui/DirectGraphicsImp.drawElementBorder.(IIIIIZ)V");
    addUnimplementedNative("com/nokia/mid/ui/DirectGraphicsImp.drawPixels.([IZIIIIIIII)V");
    addUnimplementedNative("com/nokia/mid/ui/DirectGraphicsImp.getPixels.([B[BIIIIIII)V");
    addUnimplementedNative("com/nokia/mid/ui/DirectGraphicsImp.getPixels.([IIIIIIII)V");

    Native["javax/microedition/lcdui/Graphics.render.(Ljavax/microedition/lcdui/Image;III)Z"] =
    function(addr, imageAddr, x, y, anchor) {
        var image = getHandle(imageAddr);
        renderRegion(NativeMap.get(addr).getGraphicsContext(), NativeMap.get(image.imageData).context.canvas,
                     0, 0, image.width, image.height, TRANS_NONE, x, y, anchor);
        return 1;
    };

    Native["javax/microedition/lcdui/Graphics.drawRegion.(Ljavax/microedition/lcdui/Image;IIIIIIII)V"] =
    function(addr, srcAddr, x_src, y_src, width, height, transform, x_dest, y_dest, anchor) {
        if (srcAddr === J2ME.Constants.NULL) {
            throw $.newNullPointerException("src image is null");
        }

        var src = getHandle(srcAddr);
        renderRegion(NativeMap.get(addr).getGraphicsContext(), NativeMap.get(src.imageData).context.canvas,
                     x_src, y_src, width, height, transform, x_dest, y_dest, anchor);
    };

    Native["javax/microedition/lcdui/Graphics.drawImage.(Ljavax/microedition/lcdui/Image;III)V"] =
    function(addr, imageAddr, x, y, anchor) {
        if (imageAddr === J2ME.Constants.NULL) {
            throw $.newNullPointerException("image is null");
        }

        var image = getHandle(imageAddr);
        var imageData = getHandle(image.imageData);
        renderRegion(NativeMap.get(addr).getGraphicsContext(), NativeMap.get(image.imageData).context.canvas,
                     0, 0, imageData.width, imageData.height, TRANS_NONE, x, y, anchor);
    };

    // PATCH(j2me-nx-port): 悬空字体自愈 —— Java 侧 Graphics 全 native、不持
    // Font 强引用，GraphicsInfo.currentFont 只存裸地址；游戏 setFont 后若没
    // 有把 Font 存进字段，GC 回收该 Font 时 onFinalize 会删掉 NativeMap 条目
    // → 地址悬空 → 该 Graphics 的所有绘制每帧抛 TypeError（实机 2026-09-21
    // 封神榜：fillRect "Cannot read properties of undefined (reading
    // 'fontCss')" 每帧 12 次、全程黑屏；偏紧启动 jheap 128MB 固定档 GC 时机
    // 不同于满配，故只在坏启动档复现）。统一回落默认字体并告警一次。
    var danglingFontWarned = false;
    function resolveFontContext(info) {
        var fc = NativeMap.get(info.currentFont);
        if (!fc) {
            getDefaultFontAddress();
            if (defaultFontAddress && NativeMap.get(defaultFontAddress)) {
                info.currentFont = defaultFontAddress;
                fc = NativeMap.get(defaultFontAddress);
            }
            if (!danglingFontWarned) {
                danglingFontWarned = true;
                try { console.warn("[gfx] 悬空字体已回落默认字体（Font 对象被 GC，Graphics 持裸地址失效）"); } catch (e) { /* 忽略 */ }
            }
        }
        return fc;
    }

    function GraphicsInfo(contextInfo) {
        this.contextInfo = contextInfo;

        // non-GC info
        this.transX = 0;
        this.transY = 0;
        this.clipX1 = 0;
        this.clipY1 = 0;
        this.clipX2 = contextInfo.context.canvas.width;
        this.clipY2 = contextInfo.context.canvas.height;

        // GC info
        this.currentFont = getDefaultFontAddress();
        this.alpha = 0xFF;
        this.red = 0x00;
        this.green = 0x00;
        this.blue = 0x00;
    }

    GraphicsInfo.prototype.setFont = function(font) {
        if (J2ME.Constants.NULL === font) {
            font = getDefaultFontAddress();
        }

        if (this.currentFont !== font) {
            this.currentFont = font;
            if (this.contextInfo.currentlyAppliedGraphicsInfo === this) {
                this.contextInfo.currentlyAppliedGraphicsInfo = null;
            }
        }
    }

    GraphicsInfo.prototype.setPixel = function(alpha, red, green, blue) {
        if (this.alpha !== alpha || this.red !== red || this.green !== green || this.blue !== blue) {
            this.alpha = alpha;
            this.red = red;
            this.green = green;
            this.blue = blue;

            if (this.contextInfo.currentlyAppliedGraphicsInfo === this) {
                this.contextInfo.currentlyAppliedGraphicsInfo = null;
            }
        }
    }

    GraphicsInfo.prototype.resetGC = function() {
        this.setFont(J2ME.Constants.NULL);
        this.setPixel(0xFF, 0x00, 0x00, 0x00);
    }

    GraphicsInfo.prototype.reset = function(x1, y1, x2, y2) {
        this.resetGC();
        this.resetNonGC(x1, y1, x2, y2);
    }

    GraphicsInfo.prototype.resetNonGC = function(x1, y1, x2, y2) {
        this.translate(-this.transX, -this.transY);
        this.setClip(x1, y1, x2 - x1, y2 - y1, 0, 0, this.contextInfo.context.canvas.width, this.contextInfo.context.canvas.height);
    }

    GraphicsInfo.prototype.translate = function(x, y) {
        x = x | 0;
        y = y | 0;
        if (x !== 0 || y !== 0) {
            this.transX += x;
            this.transY += y;

            if (this.contextInfo.currentlyAppliedGraphicsInfo === this) {
                this.contextInfo.currentlyAppliedGraphicsInfo = null;
            }
        }
    }

    GraphicsInfo.prototype.setClip = function(x, y, width, height, minX, minY, maxX, maxY) {
        var newX1 = x + this.transX;
        var newY1 = y + this.transY;
        var newX2 = newX1 + width;
        var newY2 = newY1 + height;

        newX1 = Math.max(minX, newX1) & 0x7fff;
        newY1 = Math.max(minY, newY1) & 0x7fff;
        newX2 = Math.min(maxX, newX2) & 0x7fff;
        newY2 = Math.min(maxY, newY2) & 0x7fff;

        if (width <= 0 || height <= 0 || newX2 <= newX1 || newY2 <= newY1) {
            newX1 = newY1 = newX2 = newY2 = 0;
        }

        if (this.clipX1 === newX1 && this.clipY1 === newY1 && this.clipX2 === newX2 && this.clipY2 === newY2) {
            return;
        }

        if (this.contextInfo.currentlyAppliedGraphicsInfo === this) {
            this.contextInfo.currentlyAppliedGraphicsInfo = null;
        }

        this.clipX1 = newX1;
        this.clipY1 = newY1;
        this.clipX2 = newX2;
        this.clipY2 = newY2;
    }

    GraphicsInfo.prototype.getGraphicsContext = function() {
        if (this.contextInfo.currentlyAppliedGraphicsInfo !== this) {
            this.contextInfo.applyGraphics(this);
        }

        return this.contextInfo.context;
    }

    function ContextInfo(ctx) {
        this.currentlyAppliedGraphicsInfo = null;
        this.context = ctx;
        ctx.save();
    }

    ContextInfo.prototype.applyGraphics = function(graphicsInfo) {
        this.context.restore();
        this.context.save();

        this.context.textAlign = "left";

        this.context.fillStyle = this.context.strokeStyle = util.rgbaToCSS(graphicsInfo.red, graphicsInfo.green, graphicsInfo.blue, graphicsInfo.alpha / 255);
        // PATCH(j2me-nx-port): 不能读回 ctx.font（nx.js 的 font getter 坏，见
        // Font.init 处注释），用 fontCss 自定义属性；防御性回落 font。
        var appliedFont = resolveFontContext(graphicsInfo);
        if (appliedFont) {
            this.context.font = appliedFont.fontCss || appliedFont.font;
        }

        this.context.beginPath();
        this.context.rect(graphicsInfo.clipX1, graphicsInfo.clipY1, graphicsInfo.clipX2 - graphicsInfo.clipX1, graphicsInfo.clipY2 - graphicsInfo.clipY1);
        this.context.clip();
        this.context.translate(graphicsInfo.transX, graphicsInfo.transY);

        this.currentlyAppliedGraphicsInfo = graphicsInfo;
    };

    Native["javax/microedition/lcdui/Graphics.initScreen0.(I)V"] = function(addr, displayId) {
        var self = getHandle(addr);
        self.displayId = displayId;
        setNative(addr, new GraphicsInfo(screenContextInfo));
        self.creator = J2ME.Constants.NULL;
    };

    Native["javax/microedition/lcdui/Graphics.initImage0.(Ljavax/microedition/lcdui/Image;)V"] =
    function(addr, imgAddr) {
        var self = getHandle(addr);
        var img = getHandle(imgAddr);
        self.displayId = -1;
        setNative(addr, new GraphicsInfo(NativeMap.get(img.imageData)));
        self.creator = J2ME.Constants.NULL;
    };

    function isScreenGraphics(g) {
        return g.displayId !== -1;
    }

    Native["javax/microedition/lcdui/Graphics.setClip.(IIII)V"] = function(addr, x, y, w, h) {
        var info = NativeMap.get(addr);
        info.setClip(x, y, w, h, 0, 0, info.contextInfo.context.canvas.width, info.contextInfo.context.canvas.height);
    };

    function drawString(info, str, x, y, anchor) {
        var c = info.getGraphicsContext();
        var fontContext = resolveFontContext(info); // PATCH: 悬空字体自愈，见 resolveFontContext 注释
        var fontSize = fontContext ? fontContext.fontSize : 12;
        // PATCH(j2me-nx-port): 文字诊断钩子——宿主据此记录游戏实际绘制的
        // 文本/字体/锚点，并逐字检测豆腐块（见 app/main.js __j2meTextSpy）。
        try {
            if (typeof window !== 'undefined' && window.__j2meTextSpy) {
                window.__j2meTextSpy(str, fontContext && (fontContext.fontCss || fontContext.font), anchor);
            }
        } catch (eSpy) { /* 诊断绝不影响渲染 */ }

        var finalText;
        if (!emoji.regEx.test(str)) {
            // No emojis are present.
            finalText = str;
        } else {
            // Emojis are present. Handle all the text up to the last emoji.
            var match;
            var lastIndex = 0;
            emoji.regEx.lastIndex = 0;
            while (match = emoji.regEx.exec(str)) {
                var text = str.substring(lastIndex, match.index);
                var match0 = match[0];
                lastIndex = match.index + match0.length;

                var textX = withTextAnchor(c, fontContext, anchor, x, text);

                c.fillText(text, textX, y);

                // Calculate the string width.
                x += measureWidth(c, text) | 0;

                var emojiData = emoji.getData(match0, fontSize);
                c.drawImage(emojiData.img, emojiData.x, 0, emoji.squareSize, emoji.squareSize, x, y, fontSize, fontSize);
                x += fontSize;
            }
            finalText = str.substring(lastIndex);
        }

        // Now handle all the text after the final emoji. If there were no
        // emojis present, this is the entire string.
        if (finalText) {
            var textX = withTextAnchor(c, fontContext, anchor, x, finalText);
            c.fillText(finalText, textX, y);
        }
    }

    Native["javax/microedition/lcdui/Graphics.drawString.(Ljava/lang/String;III)V"] =
    function(addr, strAddr, x, y, anchor) {
        drawString(NativeMap.get(addr), J2ME.fromStringAddr(strAddr), x, y, anchor);
    };

    Native["javax/microedition/lcdui/Graphics.drawSubstring.(Ljava/lang/String;IIIII)V"] =
    function(addr, strAddr, offset, len, x, y, anchor) {
        drawString(NativeMap.get(addr), J2ME.fromStringAddr(strAddr).substr(offset, len), x, y, anchor);
    };

    Native["javax/microedition/lcdui/Graphics.drawChars.([CIIIII)V"] =
    function(addr, dataAddr, offset, len, x, y, anchor) {
        drawString(NativeMap.get(addr), J2ME.fromJavaChars(dataAddr, offset, len), x, y, anchor);
    };

    Native["javax/microedition/lcdui/Graphics.drawChar.(CIII)V"] = function(addr, jChr, x, y, anchor) {
        var chr = String.fromCharCode(jChr);
        var info = NativeMap.get(addr);

        var c = info.getGraphicsContext();

        var fctx = resolveFontContext(info); // PATCH: 悬空字体自愈
        if (fctx) x = withTextAnchor(c, fctx, anchor, x, chr);

        c.fillText(chr, x, y);
    };

    Native["javax/microedition/lcdui/Graphics.fillTriangle.(IIIIII)V"] = function(addr, x1, y1, x2, y2, x3, y3) {
        var c = NativeMap.get(addr).getGraphicsContext();

        var dx1 = (x2 - x1) || 1;
        var dy1 = (y2 - y1) || 1;
        var dx2 = (x3 - x1) || 1;
        var dy2 = (y3 - y1) || 1;

        c.beginPath();
        c.moveTo(x1, y1);
        c.lineTo(x1 + dx1, y1 + dy1);
        c.lineTo(x1 + dx2, y1 + dy2);
        c.closePath();
        c.fill();
    };

    Native["javax/microedition/lcdui/Graphics.drawRect.(IIII)V"] = function(addr, x, y, w, h) {
        if (w < 0 || h < 0) {
            return;
        }

        var c = NativeMap.get(addr).getGraphicsContext();

        w = w || 1;
        h = h || 1;

        c.strokeRect(x, y, w, h);
    };

    Native["javax/microedition/lcdui/Graphics.drawRoundRect.(IIIIII)V"] = function(addr, x, y, w, h, arcWidth, arcHeight) {
        if (w < 0 || h < 0) {
            return;
        }

        var c = NativeMap.get(addr).getGraphicsContext();

        w = w || 1;
        h = h || 1;

        c.beginPath();
        createRoundRect(c, x, y, w, h, arcWidth, arcHeight);
        c.stroke();
    };

    Native["javax/microedition/lcdui/Graphics.fillRect.(IIII)V"] = function(addr, x, y, w, h) {
        if (w <= 0 || h <= 0) {
            return;
        }

        var c = NativeMap.get(addr).getGraphicsContext();

        w = w || 1;
        h = h || 1;

        c.fillRect(x, y, w, h);
    };

    Native["javax/microedition/lcdui/Graphics.fillRoundRect.(IIIIII)V"] = function(addr, x, y, w, h, arcWidth, arcHeight) {
        if (w <= 0 || h <= 0) {
            return;
        }

        var c = NativeMap.get(addr).getGraphicsContext();

        w = w || 1;
        h = h || 1;

        c.beginPath();
        createRoundRect(c, x, y, w, h, arcWidth, arcHeight);
        c.fill();
    };

    Native["javax/microedition/lcdui/Graphics.drawArc.(IIIIII)V"] = function(addr, x, y, width, height, startAngle, arcAngle) {
        if (width < 0 || height < 0) {
            return;
        }

        var c = NativeMap.get(addr).getGraphicsContext();

        var endRad = -startAngle * 0.0175;
        var startRad = endRad - arcAngle * 0.0175;
        c.beginPath();
        createEllipticalArc(c, x, y, width / 2, height / 2, startRad, endRad, false);
        c.stroke();
    };

    Native["javax/microedition/lcdui/Graphics.fillArc.(IIIIII)V"] = function(addr, x, y, width, height, startAngle, arcAngle) {
        if (width <= 0 || height <= 0) {
            return;
        }

        var c = NativeMap.get(addr).getGraphicsContext();

        var endRad = -startAngle * 0.0175;
        var startRad = endRad - arcAngle * 0.0175;
        c.beginPath();
        c.moveTo(x, y);
        createEllipticalArc(c, x, y, width / 2, height / 2, startRad, endRad, true);
        c.moveTo(x, y);
        c.fill();
    };

    var TRANS_NONE = 0;
    var TRANS_MIRROR_ROT180 = 1;
    var TRANS_MIRROR = 2;
    var TRANS_ROT180 = 3;
    var TRANS_MIRROR_ROT270 = 4;
    var TRANS_ROT90 = 5;
    var TRANS_ROT270 = 6;
    var TRANS_MIRROR_ROT90 = 7;

    function renderRegion(dstContext, srcCanvas, sx, sy, sw, sh, transform, absX, absY, anchor) {
        var w, h;
        switch (transform) {
            case TRANS_NONE:
            case TRANS_ROT180:
            case TRANS_MIRROR:
            case TRANS_MIRROR_ROT180:
                w = sw;
                h = sh;
                break;
            case TRANS_ROT90:
            case TRANS_ROT270:
            case TRANS_MIRROR_ROT90:
            case TRANS_MIRROR_ROT270:
                w = sh;
                h = sw;
                break;
        }

        // Make `absX` and `absY` the top-left coordinates where we will
        // place the image in absolute coordinates
        if (0 !== (anchor & HCENTER)) {
            absX -= ((w >>> 1) | 0);
        } else if (0 !== (anchor & RIGHT)) {
            absX -= w;
        }
        if (0 !== (anchor & VCENTER)) {
            absY -= ((h >>> 1) | 0);
        } else if (0 !== (anchor & BOTTOM)) {
            absY -= h;
        }

        var x, y;
        switch (transform) {
            case TRANS_NONE:
                x = absX;
                y = absY;
                break;
            case TRANS_ROT90:
                dstContext.rotate(Math.PI / 2);
                x = absY;
                y = -absX - w;
                break;
            case TRANS_ROT180:
                dstContext.rotate(Math.PI);
                x = -absX - w;
                y = -absY - h;
                break;
            case TRANS_ROT270:
                dstContext.rotate(Math.PI * 1.5);
                x = -absY - h;
                y = absX;
                break;
            case TRANS_MIRROR:
                dstContext.scale(-1, 1);
                x = -absX - w;
                y = absY;
                break;
            case TRANS_MIRROR_ROT90:
                dstContext.rotate(Math.PI / 2);
                dstContext.scale(-1, 1);
                x = -absY - h;
                y = -absX - w;
                break;
            case TRANS_MIRROR_ROT180:
                dstContext.scale(1, -1);
                x = absX;
                y = -absY - h;
                break;
            case TRANS_MIRROR_ROT270:
                dstContext.rotate(Math.PI * 1.5);
                dstContext.scale(-1, 1);
                x = absY;
                y = absX;
                break;
        }

        dstContext.drawImage(srcCanvas, sx, sy, sw, sh, x, y, sw, sh);

        switch (transform) {
            case TRANS_NONE:
                break;
            case TRANS_ROT90:
                dstContext.rotate(Math.PI * 1.5);
                break;
            case TRANS_ROT180:
                dstContext.rotate(Math.PI);
                break;
            case TRANS_ROT270:
                dstContext.rotate(Math.PI / 2);
                break;
            case TRANS_MIRROR:
                dstContext.scale(-1, 1);
                break;
            case TRANS_MIRROR_ROT90:
                dstContext.scale(-1, 1);
                dstContext.rotate(Math.PI * 1.5);
                break;
            case TRANS_MIRROR_ROT180:
                dstContext.scale(1, -1);
                break;
            case TRANS_MIRROR_ROT270:
                dstContext.scale(-1, 1);
                dstContext.rotate(Math.PI / 2);
                break;
        }
    };

    Native["javax/microedition/lcdui/Graphics.drawLine.(IIII)V"] = function(addr, x1, y1, x2, y2) {
        var c = NativeMap.get(addr).getGraphicsContext();

        // If we're drawing a completely vertical line that is
        // 1 pixel thick, we should draw it at half-pixel offsets.
        // Otherwise, half of the line's thickness lies to the left
        // of the pixel and half to the right.
        if (x1 === x2) {
            x1 += 0.5;
            x2 += 0.5;
        }

        // If we're drawing a completely horizontal line that is
        // 1 pixel thick, we should draw it at half-pixel offsets.
        // Otherwise, half of the line's thickness lies above
        // the pixel and half below.
        if (y1 === y2) {
            y1 += 0.5;
            y2 += 0.5;
        }

        c.beginPath();
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        c.stroke();
        c.closePath();
    };

    Native["javax/microedition/lcdui/Graphics.drawRGB.([IIIIIIIZ)V"] =
    function(addr, rgbDataAddr, offset, scanlength, x, y, width, height, processAlpha) {
        // PATCH(j2me-nx-port): w/h<=0 直接 no-op（真机行为），并对异常值落探针——
        // 2026-09-22 法拉利实机首现 createImageData: Invalid width or height，
        // 需要区分"合法 0 尺寸调用"与"JIT 编译码传参损坏"。
        if (!(width > 0 && height > 0)) {
            if (jsGlobal && jsGlobal.__sdMark) {
                jsGlobal.__sdMark("[drawRGB-guard] w=" + width + " h=" + height +
                    " scan=" + scanlength + " off=" + offset + " x=" + x + " y=" + y);
            }
            return;
        }
        var rgbData = J2ME.getArrayFromAddr(rgbDataAddr);
        // REVERT(2026-09-22-1729): step2keep（画布保尺寸+9参剪裁，ImageData 全新）
        // 实机文字全乱码+立刻闪退 → 撤回。结论：nx.js 上 drawRGB 的画布必须
        // **每次重建并清零**，9 参 drawImage(canvas) 与保尺寸画布均不可用；
        // 上游"逐次重建+清零+3 参 drawImage"是本运行时唯一实机验证安全的
        // drawRGB 实现，性能优化勿再触碰此函数。
        tempContext.canvas.height = height;
        tempContext.canvas.width = width;
        var imageData = tempContext.createImageData(width, height);
        var abgrData = new Int32Array(imageData.data.buffer);

        if (1 === processAlpha) {
            ARGBToABGR(rgbData, abgrData, width, height, offset, scanlength);
        } else {
            ARGBTo1BGR(rgbData, abgrData, width, height, offset, scanlength);
        }

        tempContext.putImageData(imageData, 0, 0);

        var c = NativeMap.get(addr).getGraphicsContext();

        c.drawImage(tempContext.canvas, x, y);
        tempContext.canvas.width = 0;
        tempContext.canvas.height = 0;
    };

    var textEditorId = 0,
        textEditorResolve = null,
        dirtyEditors = [];

    function wakeTextEditorThread(textEditorAddr) {
        dirtyEditors.push(textEditorAddr);
        if (textEditorResolve) {
            textEditorResolve();
            textEditorResolve = null;
        }
    }

    function getTextEditorCaretPosition(nativeTextEditor, textEditor) {
        if (nativeTextEditor.isAttached()) {
            return nativeTextEditor.getSelectionStart();
        }
        if (textEditor.caretPosition !== null) {
            return textEditor.caretPosition;
        }
        return 0;
    }

    function setTextEditorCaretPosition(nativeTextEditor, textEditor, index) {
        if (nativeTextEditor.isAttached()) {
            nativeTextEditor.setSelectionRange(index, index);
        } else {
            textEditor.caretPosition = index;
        }
    };

    Native["com/nokia/mid/ui/TextEditor.init.(Ljava/lang/String;IIII)V"] =
    function(addr, textAddr, maxSize, constraints, width, height) {
        var self = getHandle(addr);

        if (constraints !== 0) {
            console.warn("TextEditor.constraints not implemented");
        }

        var textEditor = TextEditorProvider.getEditor(constraints, null, ++textEditorId);
        setNative(addr, textEditor);
        textEditor.setBackgroundColor(0xFFFFFFFF | 0); // opaque white
        textEditor.setForegroundColor(0xFF000000 | 0); // opaque black

        textEditor.setAttribute("maxlength", maxSize);
        textEditor.setSize(width, height);
        textEditor.setVisible(false);
        textEditor.setFont(self.font);

        textEditor.setContent(J2ME.fromStringAddr(textAddr));
        setTextEditorCaretPosition(textEditor, self, textEditor.getContentSize());

        textEditor.oninput(function(e) {
            wakeTextEditorThread(addr);
        });
    };

    Native["com/nokia/mid/ui/CanvasItem.attachNativeImpl.()V"] = function(addr) {
        var self = getHandle(addr);
        var textEditor = NativeMap.get(addr);
        if (textEditor) {
            textEditor.attach();
            if (self.caretPosition !== 0) {
                textEditor.setSelectionRange(self.caretPosition, self.caretPosition);
                self.caretPosition = null;
            }
        }
    };

    Native["com/nokia/mid/ui/CanvasItem.detachNativeImpl.()V"] = function(addr) {
        var self = getHandle(addr);
        var textEditor = NativeMap.get(addr);
        if (textEditor) {
            self.caretPosition = textEditor.getSelectionStart();
            textEditor.detach();
        }
    };

    Native["javax/microedition/lcdui/Display.setTitle.(Ljava/lang/String;)V"] = function(addr, titleAddr) {
        document.getElementById("display_title").textContent = J2ME.fromStringAddr(titleAddr);
    };

    Native["com/nokia/mid/ui/CanvasItem.setSize.(II)V"] = function(addr, width, height) {
        NativeMap.get(addr).setSize(width, height);
    };

    Native["com/nokia/mid/ui/CanvasItem.setVisible.(Z)V"] = function(addr, visible) {
        NativeMap.get(addr).setVisible(visible ? true : false);
    };

    Native["com/nokia/mid/ui/CanvasItem.getWidth.()I"] = function(addr) {
        return NativeMap.get(addr).getWidth();
    };

    Native["com/nokia/mid/ui/CanvasItem.getHeight.()I"] = function(addr) {
        return NativeMap.get(addr).getHeight();
    };

    Native["com/nokia/mid/ui/CanvasItem.setPosition0.(II)V"] = function(addr, x, y) {
        NativeMap.get(addr).setPosition(x, y);
    };

    Native["com/nokia/mid/ui/CanvasItem.getPositionX.()I"] = function(addr) {
        return NativeMap.get(addr).getLeft();
    };

    Native["com/nokia/mid/ui/CanvasItem.getPositionY.()I"] = function(addr) {
        return NativeMap.get(addr).getTop();
    };

    Native["com/nokia/mid/ui/CanvasItem.isVisible.()Z"] = function(addr) {
        return NativeMap.get(addr).visible ? 1 : 0;
    };

    Native["com/nokia/mid/ui/TextEditor.setConstraints.(I)V"] = function(addr, constraints) {
        var textEditor = NativeMap.get(addr);
        setNative(addr, TextEditorProvider.getEditor(constraints, textEditor, textEditor.id));
    };

    Native["com/nokia/mid/ui/TextEditor.getConstraints.()I"] = function(addr) {
        return NativeMap.get(addr).constraints;
    };

    Native["com/nokia/mid/ui/TextEditor.setFocus.(Z)V"] = function(addr, shouldFocus) {
        var textEditor = NativeMap.get(addr);
        var promise;
        if (shouldFocus && (currentlyFocusedTextEditor !== textEditor)) {
            promise = textEditor.focus();
            currentlyFocusedTextEditor = textEditor;
        } else if (!shouldFocus && (currentlyFocusedTextEditor === textEditor)) {
            promise = textEditor.blur();
            currentlyFocusedTextEditor = null;
        } else {
            return;
        }
        asyncImpl("V", promise);
    };

    Native["com/nokia/mid/ui/TextEditor.hasFocus.()Z"] = function(addr) {
        return (NativeMap.get(addr) === currentlyFocusedTextEditor) ? 1 : 0;
    };

    Native["com/nokia/mid/ui/TextEditor.setCaret.(I)V"] = function(addr, index) {
        var self = getHandle(addr);
        var textEditor = NativeMap.get(addr);

        if (index < 0 || index > textEditor.getContentSize()) {
            throw $.newStringIndexOutOfBoundsException();
        }

        setTextEditorCaretPosition(textEditor, self, index);
    };

    Native["com/nokia/mid/ui/TextEditor.getCaretPosition.()I"] = function(addr) {
        var self = getHandle(addr);
        var nativeTextEditor = NativeMap.get(addr);
        return getTextEditorCaretPosition(nativeTextEditor, self);
    };

    Native["com/nokia/mid/ui/TextEditor.getBackgroundColor.()I"] = function(addr) {
        return NativeMap.get(addr).getBackgroundColor();
    };
    Native["com/nokia/mid/ui/TextEditor.getForegroundColor.()I"] = function(addr) {
        return NativeMap.get(addr).getForegroundColor();
    };
    Native["com/nokia/mid/ui/TextEditor.setBackgroundColor.(I)V"] = function(addr, backgroundColor) {
        NativeMap.get(addr).setBackgroundColor(backgroundColor);
    };
    Native["com/nokia/mid/ui/TextEditor.setForegroundColor.(I)V"] = function(addr, foregroundColor) {
        NativeMap.get(addr).setForegroundColor(foregroundColor);
    };

    Native["com/nokia/mid/ui/TextEditor.getContent.()Ljava/lang/String;"] = function(addr) {
        return J2ME.newString(NativeMap.get(addr).getContent());
    };

    Native["com/nokia/mid/ui/TextEditor.setContent.(Ljava/lang/String;)V"] = function(addr, contentAddr) {
        var self = getHandle(addr);
        var nativeTextEditor = NativeMap.get(addr);
        var content = J2ME.fromStringAddr(contentAddr);
        nativeTextEditor.setContent(content);
        setTextEditorCaretPosition(nativeTextEditor, self, nativeTextEditor.getContentSize());
    };

    addUnimplementedNative("com/nokia/mid/ui/TextEditor.getLineMarginHeight.()I", 0);
    addUnimplementedNative("com/nokia/mid/ui/TextEditor.getVisibleContentPosition.()I", 0);

    Native["com/nokia/mid/ui/TextEditor.getContentHeight.()I"] = function(addr) {
        return NativeMap.get(addr).getContentHeight();
    };

    Native["com/nokia/mid/ui/TextEditor.insert.(Ljava/lang/String;I)V"] = function(addr, textAddr, pos) {
        var self = getHandle(addr);
        var nativeTextEditor = NativeMap.get(addr);
        var text = J2ME.fromStringAddr(textAddr);
        var len = util.toCodePointArray(text).length;
        if (nativeTextEditor.getContentSize() + len > nativeTextEditor.getAttribute("maxlength")) {
            throw $.newIllegalArgumentException();
        }
        nativeTextEditor.setContent(nativeTextEditor.getSlice(0, pos) + text + nativeTextEditor.getSlice(pos));
        setTextEditorCaretPosition(nativeTextEditor, self, pos + len);
    };

    Native["com/nokia/mid/ui/TextEditor.delete.(II)V"] = function(addr, offset, length) {
        var self = getHandle(addr);
        var nativeTextEditor = NativeMap.get(addr);
        var old = nativeTextEditor.getContent();

        var size = nativeTextEditor.getContentSize();
        if (offset < 0 || offset > size || length < 0 || offset + length > size) {
            throw $.newStringIndexOutOfBoundsException("offset/length invalid");
        }

        nativeTextEditor.setContent(nativeTextEditor.getSlice(0, offset) + nativeTextEditor.getSlice(offset + length));
        setTextEditorCaretPosition(nativeTextEditor, self, offset);
    };

    Native["com/nokia/mid/ui/TextEditor.getMaxSize.()I"] = function(addr) {
        return parseInt(NativeMap.get(addr).getAttribute("maxlength"));
    };

    Native["com/nokia/mid/ui/TextEditor.setMaxSize.(I)I"] = function(addr, maxSize) {
        var nativeTextEditor = NativeMap.get(addr);
        if (nativeTextEditor.getContentSize() > maxSize) {
            var self = getHandle(addr);
            var nativeTextEditor = NativeMap.get(addr);

            var oldCaretPosition = getTextEditorCaretPosition(nativeTextEditor, self);

            nativeTextEditor.setContent(nativeTextEditor.getSlice(0, maxSize));

            if (oldCaretPosition > maxSize) {
                setTextEditorCaretPosition(nativeTextEditor, self, maxSize);
            }
        }

        nativeTextEditor.setAttribute("maxlength", maxSize);

        // The return value is the assigned size, which could be less than
        // the size that was requested, although in this case we always set it
        // to the requested size.
        return maxSize;
    };

    Native["com/nokia/mid/ui/TextEditor.size.()I"] = function(addr) {
        return NativeMap.get(addr).getContentSize();
    };

    Native["com/nokia/mid/ui/TextEditor.setFont.(Ljavax/microedition/lcdui/Font;)V"] = function(addr, fontAddr) {
        var self = getHandle(addr);
        self.font = fontAddr;
        var nativeTextEditor = NativeMap.get(addr);
        nativeTextEditor.setFont(fontAddr);
    };

    Native["com/nokia/mid/ui/TextEditorThread.getNextDirtyEditor.()Lcom/nokia/mid/ui/TextEditor;"] = function(addr) {
        if (dirtyEditors.length) {
            return dirtyEditors.shift();
        }

        asyncImpl("Lcom/nokia/mid/ui/TextEditor;", new Promise(function(resolve, reject) {
            textEditorResolve = function() {
                resolve(dirtyEditors.shift());
            }
        }));
    };

    var curDisplayableId = 0;
    var nextMidpDisplayableId = 1;
    var PLAIN = 0;

    Native["javax/microedition/lcdui/DisplayableLFImpl.initialize0.()V"] = function(addr) {
    };

    Native["javax/microedition/lcdui/DisplayableLFImpl.deleteNativeResource0.(I)V"] = function(addr, nativeId) {
        var el = document.getElementById("displayable-" + nativeId);
        // PATCH(j2me-nx-port): el.parentElement 可能为空（元素未挂到 DOM，
        // 本移植 Canvas 走离屏画布路径）——直接 removeChild 会抛错炸事件泵。
        if (el && el.parentElement) {
            el.parentElement.removeChild(el);
            if (currentlyFocusedTextEditor) {
                currentlyFocusedTextEditor.focus();
            }
        } else if (currentlyFocusedTextEditor) {
            currentlyFocusedTextEditor.blur();
        }
    };

    Native["javax/microedition/lcdui/DisplayableLFImpl.setTitle0.(ILjava/lang/String;)V"] =
    function(addr, nativeId, titleAddr) {
        document.getElementById("display_title").textContent = J2ME.fromStringAddr(titleAddr);
    };

    // PATCH(j2me-nx-port): Ticker（Displayable 顶部滚动文字条）。本移植走离屏
    // 画布，无 DOM ticker 区域可渲染——只吞掉调用（此前每帧刷 implKey error，
    // DuckTales 实测）。内容有变化时打一条 console.info 供诊断（桥接有限流）。
    var __lastTickerText = null;
    Native["javax/microedition/lcdui/DisplayableLFImpl.setTicker0.(ILjava/lang/String;)V"] =
    function(addr, nativeId, tickerAddr) {
        var text = tickerAddr ? J2ME.fromStringAddr(tickerAddr) : null;
        if (text !== __lastTickerText) {
            __lastTickerText = text;
            if (text) console.info("[ticker] nativeId=" + nativeId + " text=" + text);
        }
    };

    Native["javax/microedition/lcdui/CanvasLFImpl.createNativeResource0.(Ljava/lang/String;Ljava/lang/String;)I"] =
    function(addr, titleAddr, tickerAddr) {
        console.warn("javax/microedition/lcdui/CanvasLFImpl.createNativeResource0.(Ljava/lang/String;Ljava/lang/String;)I not implemented");
        curDisplayableId = nextMidpDisplayableId++;
        return curDisplayableId;
    };

    Native["javax/microedition/lcdui/AlertLFImpl.createNativeResource0.(Ljava/lang/String;Ljava/lang/String;I)I"] =
    function(addr, titleAddr, tickerAddr, type) {
        var nativeId = nextMidpDisplayableId++;
        var alertTemplateNode = document.getElementById("lcdui-alert");
        var el = alertTemplateNode.cloneNode(true);
        el.id = "displayable-" + nativeId;
        el.querySelector('h1.title').textContent = J2ME.fromStringAddr(titleAddr);
        alertTemplateNode.parentNode.appendChild(el);

        return nativeId;
    };

    Native["javax/microedition/lcdui/AlertLFImpl.setNativeContents0.(ILjavax/microedition/lcdui/ImageData;[ILjava/lang/String;)Z"] =
    function(addr, nativeId, imgIdAddr, indicatorBoundsAddr, textAddr) {
        var el = document.getElementById("displayable-" + nativeId);
        el.querySelector('p.text').textContent = J2ME.fromStringAddr(textAddr);

        return 0;
    };

    Native["javax/microedition/lcdui/AlertLFImpl.showNativeResource0.(I)V"] = function(addr, nativeId) {
        var el = document.getElementById("displayable-" + nativeId);
        el.style.display = 'block';
        el.classList.add('visible');
        if (currentlyFocusedTextEditor) {
            currentlyFocusedTextEditor.blur();
        }

        curDisplayableId = nativeId;
    };

    var INDEFINITE = -1;
    var CONTINUOUS_RUNNING = 2;

    Native["javax/microedition/lcdui/GaugeLFImpl.createNativeResource0.(ILjava/lang/String;IZII)I"] =
    function(addr, ownerId, labelAddr, layout, interactive, maxValue, initialValue) {
        if (labelAddr !== J2ME.Constants.NULL) {
            console.error("Expected null label");
        }

        if (layout !== PLAIN) {
            console.error("Expected PLAIN layout");
        }

        if (interactive) {
            console.error("Expected not interactive gauge");
        }

        if (maxValue !== INDEFINITE) {
            console.error("Expected INDEFINITE maxValue");
        }

        if (initialValue !== CONTINUOUS_RUNNING) {
            console.error("Expected CONTINUOUS_RUNNING initialValue")
        }

        var el = document.getElementById("displayable-" + ownerId);
        el.querySelector("progress").style.display = "inline";

        return nextMidpDisplayableId++;
    };

    Native["javax/microedition/lcdui/TextFieldLFImpl.createNativeResource0.(ILjava/lang/String;ILcom/sun/midp/lcdui/DynamicCharacterArray;ILjava/lang/String;)I"] =
    function(addr, ownerId, labelAddr, layout, bufferAddr, constraints, initialInputModeAddr) {
        // PATCH(j2me-nx-port 2026-09-23): 这里原本只打一句 not implemented 就返回 id。
        // 它是**唯一**能在游戏进入文本输入时被回调到的地方——LCDUI 里 TextBox 就是
        // Form+TextField 实现的（LFFactoryImpl.getTextBoxFormLF），TextField 建控件时
        // 必过这里。于是把它变成"通知宿主"的钩子：宿主据此在游戏内自动弹出系统键盘。
        // 实机验证方式：tools/textinput-test/TextTest.java 显示 TextBox 时必打这一行。
        var nativeId = nextMidpDisplayableId++;
        try {
            var g = (typeof globalThis !== "undefined") ? globalThis : this;
            if (g && typeof g.__hostTextInput === "function") {
                g.__hostTextInput({
                    event: "create",
                    nativeId: nativeId,
                    ownerId: ownerId,
                    layout: layout,
                    constraints: constraints,
                });
            }
        } catch (e) { /* 通知失败绝不影响控件创建 */ }
        return nativeId;
    };

    // PATCH(j2me-nx-port 2026-09-23): TextFieldLFImpl 这几个原生在 JS 侧一直没注册，
    // Java 一调用就报 "is native but does not have an implementation"（实机日志里
    // 读文本框内容时会刷这条错）。我们不需要原生控件——文本存在 Java 侧的
    // DynamicCharacterArray 里，控件只是渲染用——所以补成"无操作/无待取输入"的桩。
    addUnimplementedNative("javax/microedition/lcdui/TextFieldLFImpl.getString0.(ILcom/sun/midp/lcdui/DynamicCharacterArray;)Z", false);
    addUnimplementedNative("javax/microedition/lcdui/TextFieldLFImpl.setString0.(ILcom/sun/midp/lcdui/DynamicCharacterArray;)V");
    addUnimplementedNative("javax/microedition/lcdui/TextFieldLFImpl.setMaxSize0.(II)V");
    addUnimplementedNative("javax/microedition/lcdui/TextFieldLFImpl.setConstraints0.(II)V");
    addUnimplementedNative("javax/microedition/lcdui/TextFieldLFImpl.getCaretPosition0.(I)I", 0);

    Native["javax/microedition/lcdui/ImageItemLFImpl.createNativeResource0.(ILjava/lang/String;ILjavax/microedition/lcdui/ImageData;Ljava/lang/String;I)I"] =
    function(addr, ownerId, labelAddr, layout, imageDataAddr, altTextAddr, appearanceMode) {
        console.warn("javax/microedition/lcdui/ImageItemLFImpl.createNativeResource0.(ILjava/lang/String;ILjavax/microedition/lcdui/ImageData;Ljava/lang/String;I)I not implemented");
        return nextMidpDisplayableId++;
    };

    addUnimplementedNative("javax/microedition/lcdui/FormLFImpl.setScrollPosition0.(I)V");
    addUnimplementedNative("javax/microedition/lcdui/FormLFImpl.getScrollPosition0.()I", 0);

    addUnimplementedNative(
        "javax/microedition/lcdui/FormLFImpl.createNativeResource0.(Ljava/lang/String;Ljava/lang/String;)I",
        function() { return nextMidpDisplayableId++ }
    );

    addUnimplementedNative("javax/microedition/lcdui/FormLFImpl.showNativeResource0.(IIII)V");
    // PATCH(j2me-nx-port 2026-09-23): 这里原本返回 0（addUnimplementedNative 的桩）。
    // 后果是实机 fatal：Form（含游戏取名用的 Form+TextField 界面）一收到方向键，
    // FormLFImpl.uTraverse → uScrollViewport 用 0 视口高度算出 -1 下标 →
    // ArrayIndexOutOfBoundsException，事件泵被吞掉保活 → 游戏看着像"卡住"。
    // 现场（C:\Users\Admin\error.log）：
    //   java.lang.ArrayIndexOutOfBoundsException: -1
    //     at FormLFImpl.uScrollViewport(...) bci=236
    //     at FormLFImpl.uTraverse(I)V bci=649
    //     at FormLFImpl.uCallKeyPressed(I)V
    // 改成返回真实屏幕高度（与 getScreenHeight0 同源：设备画布高度）。
    Native["javax/microedition/lcdui/FormLFImpl.getViewportHeight0.()I"] = function(addr) {
        try {
            var c = MIDP.deviceContext && MIDP.deviceContext.canvas;
            if (c && c.height) return c.height;
        } catch (e) { /* 回落 */ }
        return 320;
    };

    addUnimplementedNative(
        "javax/microedition/lcdui/StringItemLFImpl.createNativeResource0.(ILjava/lang/String;ILjava/lang/String;ILjavax/microedition/lcdui/Font;)I",
        function() { return nextMidpDisplayableId++ }
    );

    Native["javax/microedition/lcdui/ItemLFImpl.setSize0.(III)V"] = function(addr, nativeId, w, h) {
        console.warn("javax/microedition/lcdui/ItemLFImpl.setSize0.(III)V not implemented");
    };

    Native["javax/microedition/lcdui/ItemLFImpl.setLocation0.(III)V"] = function(addr, nativeId, x, y) {
        console.warn("javax/microedition/lcdui/ItemLFImpl.setLocation0.(III)V not implemented");
    };

    Native["javax/microedition/lcdui/ItemLFImpl.show0.(I)V"] = function(addr, nativeId) {
        console.warn("javax/microedition/lcdui/ItemLFImpl.show0.(I)V not implemented");
    };

    Native["javax/microedition/lcdui/ItemLFImpl.hide0.(I)V"] = function(addr, nativeId) {
        console.warn("javax/microedition/lcdui/ItemLFImpl.hide0.(I)V not implemented");
    };

    addUnimplementedNative("javax/microedition/lcdui/ItemLFImpl.getMinimumWidth0.(I)I", 10);
    addUnimplementedNative("javax/microedition/lcdui/ItemLFImpl.getMinimumHeight0.(I)I", 10);
    addUnimplementedNative("javax/microedition/lcdui/ItemLFImpl.getPreferredWidth0.(II)I", 10);
    addUnimplementedNative("javax/microedition/lcdui/ItemLFImpl.getPreferredHeight0.(II)I", 10);
    addUnimplementedNative("javax/microedition/lcdui/ItemLFImpl.delete0.(I)V");

    var BACK = 2;
    var CANCEL = 3;
    var OK = 4;
    var STOP = 6;
    var EXIT = 7;

    // PATCH(j2me-nx-port 2026-09-23): 当前界面的 LCDUI 命令表 + 宿主软键（ZL/ZR）直通入口。
    //
    // 【为什么必须有它】实机"游戏取名打得进字、按游戏自己的确定却没反应"的真凶就在下面：
    //   本移植的 DOM 垫片（src/host/env-prelude.js）里 getElementById 对**任意 id** 都返回
    //   一个自动创建的元素（永远 truthy），于是 updateCommands 里
    //       var el = document.getElementById("displayable-" + curDisplayableId);
    //       if (el) { ... el.querySelector(".button0/.button1").onclick = ... }
    //   这个分支**恒真**：命令的 onclick 被挂到 #displayable-N 的 .button0/.button1 上，而
    //   src/host/switch-input.js 的 fireSoftButton() 点的是 #header-ok-button / #back-button
    //   —— 那两个按钮的 onclick 只在"else 分支"里赋值，而 else 分支永远跑不到。
    //   结果：ZL/ZR 对**所有** Command 界面（取名 Form/TextBox、Alert、List）都无效，游戏里
    //   按"确定"毫无反应；命令 handler 根本不执行，游戏自然"读不到"那个已经写进模型的名字。
    // 修法：命令表留在 JS 侧，并给宿主一个直通入口 __lcdInvokeCommand(kind)；switch-input.js
    //   优先走它，DOM click 只作回落（下面也顺手把 header/back 按钮的 onclick 补上）。
    var lcdCommands = [];

    function lcdCommandList() {
        return lcdCommands.map(function(c) {
            return {
                id: c.id,
                type: c.commandType,
                label: c.shortLabel ? J2ME.fromStringAddr(c.shortLabel) : "",
            };
        });
    }

    // kind = "ok"（ZR/右软键）| "back"（ZL/左软键），选法与键盘机软键一致：
    //   右软键优先 type==OK；界面上只有一个命令时就是它；否则取优先级**最靠后**的那个
    //   （命令表已按 priority 升序排过，"确定/继续"通常排在后面）。
    //   左软键优先 BACK/CANCEL/STOP/EXIT；否则取优先级最靠前的那个（"返回/退出"）。
    function lcdPickCommand(list, kind) {
        var wanted = (kind === "back") ? [BACK, CANCEL, STOP, EXIT] : [OK];
        for (var i = 0; i < list.length; i++) {
            for (var w = 0; w < wanted.length; w++) {
                if (list[i].commandType === wanted[w]) return list[i];
            }
        }
        if (!list.length) return null;
        return (kind === "back") ? list[0] : list[list.length - 1];
    }

    function lcdInvokeCommand(kind) {
        var pick = lcdPickCommand(lcdCommands, kind);
        if (!pick) return false;
        try {
            MIDP.sendCommandEvent(pick.id);
            return true;
        } catch (e) {
            console.warn("[lcdcmd] 触发命令失败: " + (e && e.message));
            return false;
        }
    }

    (function () {
        var g = (typeof globalThis !== "undefined") ? globalThis
              : (typeof window !== "undefined" ? window : null);
        if (!g) return;
        g.__lcdCommands = lcdCommandList;        // 诊断用：当前界面有哪些命令
        g.__lcdInvokeCommand = lcdInvokeCommand; // 宿主软键入口（ZL/ZR）
    })();

    Native["javax/microedition/lcdui/NativeMenu.updateCommands.([Ljavax/microedition/lcdui/Command;I[Ljavax/microedition/lcdui/Command;I)V"] =
    function(addr, itemCommandsAddr, numItemCommands, commandsAddr, numCommands) {
        if (numItemCommands !== 0) {
            console.error("NativeMenu.updateCommands: item commands not yet supported");
        }

        // 先清空：本函数下面的 `commandsAddr === NULL` 分支会提前 return（界面没有命令），
        // 不清空就会把上一个界面的命令留着，软键会去打一个已经不存在的命令。
        lcdCommands = [];

        var el = document.getElementById("displayable-" + curDisplayableId);

        if (!el) {
            document.getElementById("sidebar").querySelector("nav ul").innerHTML = "";
        }

        if (commandsAddr === J2ME.Constants.NULL) {
            return;
        }

        var commands = J2ME.getArrayFromAddr(commandsAddr);

        var validCommands = [];

        for (var i = 0; i < commands.length; i++) {
            if (commands[i]) {
                validCommands.push(getHandle(commands[i]));
            }
        }

        validCommands.sort(function(a, b) {
            return a.priority - b.priority;
        });

        // 记下来，供宿主软键（ZL/ZR）直通触发 —— 见本函数上方的 PATCH 注释。
        lcdCommands = validCommands.slice(0);

        function sendEvent(command) {
            MIDP.sendCommandEvent(command.id);
        }

        // 顺手把 #header-ok-button / #back-button 的 onclick 也挂上：
        // 旧代码只在 `!el` 的 else 分支里挂，而那个分支在本移植恒不成立（见上方注释），
        // 于是 switch-input.js 的 DOM click 回落路径一直是空点。这里补上，两条路都能用。
        try {
            var okPick = lcdPickCommand(validCommands, "ok");
            var backPick = lcdPickCommand(validCommands, "back");
            var headerBtnFallback = document.getElementById("header-ok-button");
            var backBtnFallback = document.getElementById("back-button");
            headerBtnFallback.onclick = okPick ? function(e) {
                if (e && e.preventDefault) e.preventDefault();
                sendEvent(okPick);
            } : null;
            backBtnFallback.onclick = backPick ? function(e) {
                if (e && e.preventDefault) e.preventDefault();
                sendEvent(backPick);
            } : null;
        } catch (eBtn) { /* DOM 垫片异常不影响直通路径 */ }

        if (el) {
            if (numCommands > 2 && validCommands.length > 2) {
                console.error("NativeMenu.updateCommands: max two commands supported");
            }

            validCommands.slice(0, 2).forEach(function(command, i) {
                var button = el.querySelector(".button" + i);
                button.style.display = 'inline';
                button.textContent = J2ME.fromStringAddr(command.shortLabel);

                var commandType = command.commandType;
                if (numCommands === 1 || commandType === OK) {
                    button.classList.add('recommend');
                    button.classList.remove('cancel');
                } else if (commandType === CANCEL || commandType === BACK || commandType === STOP) {
                    button.classList.add('cancel');
                    button.classList.remove('recommend');
                }

                button.onclick = function(e) {
                    e.preventDefault();
                    sendEvent(command);
                };
            });
        } else {
            var menu = document.getElementById("sidebar").querySelector("nav ul");

            var okCommand = null;
            var backCommand = null;

            var isSidebarEmpty = true;
            validCommands.forEach(function(command) {
                var commandType = command.commandType;
                // Skip the OK command which will shown in the header.
                if (commandType === OK) {
                    okCommand = command;
                    return;
                }
                // Skip the BACK command which will shown in the footer.
                if (commandType === BACK) {
                    backCommand = command;
                    return;
                }
                var li = document.createElement("li");
                var text = J2ME.fromStringAddr(command.shortLabel);
                var a = document.createElement("a");
                a.textContent = text;
                li.appendChild(a);

                li.onclick = function(e) {
                    e.preventDefault();

                    window.location.hash = "";

                    sendEvent(command);
                };

                menu.appendChild(li);
                isSidebarEmpty = false;
            });

            document.getElementById("header-drawer-button").style.display =
                isSidebarEmpty ? "none" : "block";

            // If existing, the OK command will be shown in the header.
            var headerBtn = document.getElementById("header-ok-button");
            if (okCommand) {
                headerBtn.style.display = "block";
                headerBtn.onclick = sendEvent.bind(headerBtn, okCommand);
            } else {
                headerBtn.style.display = "none";
            }

            // If existing, the BACK command will be shown in the footer.
            var backBtn = document.getElementById("back-button");
            if (backCommand) {
                backBtn.style.display = "block";
                backBtn.onclick = sendEvent.bind(backBtn, backCommand);
            } else {
                backBtn.style.display = "none";
            }
        }
    };
})(Native);

// PATCH(j2me-nx-port): 帧时间三分账探针——把全部 lcdui native 包上计时，
// 累积到 jsGlobal.__gfxMsAcc（present 循环每 300 帧读取清零）。
// 定位"卡顿到底花在解释器、LCDUI 绘制原语还是其他"的关键证据。
(function () {
    var g = typeof globalThis !== "undefined" ? globalThis : null;
    if (!g) return;
    var keys = Object.keys(Native);
    var wrapped = 0;
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf("lcdui/") < 0) continue;
        var orig = Native[k];
        if (typeof orig !== "function") continue;
        (function (fn) {
            Native[k] = function () {
                var t0 = Date.now();
                try {
                    return fn.apply(this, arguments);
                } finally {
                    g.__gfxMsAcc = (g.__gfxMsAcc || 0) + (Date.now() - t0);
                }
            };
        })(orig);
        wrapped++;
    }
    if (typeof console !== "undefined" && console.log) {
        console.log("[gfx-timing] 已包装 " + wrapped + " 个 lcdui native（帧时间三分账）");
    }
})();
