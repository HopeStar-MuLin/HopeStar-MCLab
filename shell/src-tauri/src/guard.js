// 在页面脚本之前注入，把 WebView2 的「浏览器」行为关掉，只留「应用」行为。
//
// 走 initialization_script 而不是页面里的 addEventListener：后者要等 DOM 就绪，
// 而 F5 这类键在文档加载完之前就能按下去，那时候页面还没挂上监听。
(function () {
    'use strict';

    // 整个应用是单页的，任何「刷新」都会把入口 URL 上的 port/token 一起丢掉，
    // 而且核心进程还在跑，刷新之后页面连不回去。所以刷新类按键一个都不留。
    function isReload(e) {
        var key = (e.key || '').toLowerCase();
        return e.key === 'F5' || ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'r');
    }

    // 浏览器功能键：开发者工具、查找、打印、保存、源码、放大镜
    function isBrowserChrome(e) {
        var key = (e.key || '').toLowerCase();
        var ctrl = e.ctrlKey || e.metaKey;
        if (e.key === 'F3' || e.key === 'F7' || e.key === 'F11' || e.key === 'F12') {
            return true;
        }
        if (!ctrl) {
            return false;
        }
        if (e.shiftKey && (key === 'i' || key === 'j' || key === 'c' || key === 'n' || key === 't')) {
            return true;
        }
        // u 源码 / p 打印 / s 保存 / f 查找 / g 下一个 / o 打开文件 / h 历史 / d 收藏
        // w 关窗口 / t 新标签 / n 新窗口 —— 都是浏览器动作，应用里没有对应概念，
        // 关窗口一律走标题栏那个 ✕
        return key === 'u' || key === 'p' || key === 's' || key === 'f' ||
            key === 'g' || key === 'o' || key === 'h' || key === 'd' ||
            key === 'w' || key === 't' || key === 'n';
    }

    // Ctrl +/-/0 缩放，以及 Ctrl + 滚轮
    function isZoom(e) {
        var ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl) {
            return false;
        }
        return e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '0';
    }

    window.addEventListener('keydown', function (e) {
        if (isReload(e) || isBrowserChrome(e) || isZoom(e)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    // Alt+← / Alt+→ 是浏览器前进后退，应用里没有导航历史
    window.addEventListener('keydown', function (e) {
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    window.addEventListener('wheel', function (e) {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
        }
    }, { passive: false });

    // 右键菜单：页面自己画的菜单不受影响（它们的监听照常触发），
    // 这里挡的是 WebView2 自带的「重新加载 / 检查 / 另存为」那一套。
    window.addEventListener('contextmenu', function (e) {
        e.preventDefault();
    }, true);

    // 拖进来的文件会让 WebView 直接导航过去，把整个应用「顶掉」。
    // 一律拦在默认行为上；以后要做「拖入整合包自动导入」，
    // 应该在这里派发自定义事件，而不是放行默认行为。
    window.addEventListener('dragover', function (e) { e.preventDefault(); }, true);
    window.addEventListener('drop', function (e) { e.preventDefault(); }, true);

    // 中键：自动滚动圆盘 + 可能的「新标签打开链接」
    window.addEventListener('mousedown', function (e) {
        if (e.button === 1) {
            e.preventDefault();
        }
    }, true);
    window.addEventListener('auxclick', function (e) {
        if (e.button === 1) {
            e.preventDefault();
        }
    }, true);

    // 图片/链接的默认拖拽会产生一个「幽灵图」，看着像网页
    window.addEventListener('dragstart', function (e) {
        if (!e.target || !e.target.closest || !e.target.closest('[draggable="true"]')) {
            e.preventDefault();
        }
    }, true);

    // 不允许开新窗口：外链应该交给系统浏览器（页面里有 openLink 走 Java）
    window.open = function () { return null; };
})();
