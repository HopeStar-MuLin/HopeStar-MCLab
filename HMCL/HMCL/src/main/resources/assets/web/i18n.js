/* WebUI 多语言
   ─────────────────────────────────────────────────────────
   语言包放在 assets/web/i18n/<locale>.json，键是中文原文。

   为什么拿原文当键：新加一句界面直接写中文就行，忘了翻译也只是原样显示，
   不会冒出空白或者 i18n.key.xxx 这种东西，也不会因为改了个变量名就整片失效。

   加载用同步 XHR：语言包必须在本脚本之后、DOM 解析之前到手，
   否则英文用户会先看到满屏中文再刷地变过来。文件在本地，几毫秒的事。
*/
(function () {
  'use strict';

  /// 当前语言翻译表。null 表示"不需要"或"没加载到"——两种情况都显示中文原文
  var TABLE = null;
  var LOCALE = 'zh-Hans';

  function query(name) {
    try {
      return new URLSearchParams(location.search).get(name) || '';
    } catch (e) {
      return '';
    }
  }

  function readTable(locale) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'i18n/' + encodeURIComponent(locale) + '.json', false);
      xhr.send(null);
      // tauri:// 协议下成功也可能是 status 0
      if (xhr.status === 200 || xhr.status === 0) {
        var text = xhr.responseText;
        if (text && text.length > 2) {
          return JSON.parse(text);
        }
      }
    } catch (e) {
      console.warn('[i18n] 语言包读取失败：' + locale, e);
    }
    return null;
  }

  /// 中文分两种：简体直接用原文，繁体要读 zh-Hant 包。
  ///
  /// 不能只认 `zh-Hans` / `zh-Hant` 这种标准标签：设置里选「跟随系统」时拿到的
  /// 可能是 `zh-CN`、`zh-TW`、`zh-HK`，只比对字面值会把中文用户判错。
  function resolve(locale) {
    if (!locale) {
      return null;
    }
    var lower = String(locale).toLowerCase();
    if (lower.indexOf('zh') === 0) {
      var traditional = lower.indexOf('zh-hant') === 0 || lower.indexOf('zh-tw') === 0
          || lower.indexOf('zh-hk') === 0 || lower.indexOf('zh-mo') === 0;
      if (traditional) {
        var t = readTable('zh-Hant');
        if (t) {
          LOCALE = 'zh-Hant';
          return t;
        }
      }
      // 简体就是原文；繁体包没读到时也退回原文，显示简体总比显示英文强
      return null;
    }
    var order = [locale, 'en'];
    for (var i = 0; i < order.length; i++) {
      var table = readTable(order[i]);
      if (table) {
        LOCALE = order[i];
        return table;
      }
    }
    return null;
  }

  TABLE = resolve(query('lang'));

  // 让 `<html lang>` 跟着走：中文环境里读屏和字体回退都看这个
  if (TABLE && LOCALE) {
    document.documentElement.lang = LOCALE;
  }

  /// 翻译一个字符串。表里没有就原样返回 —— 这也是"没翻译"最安全的降级方式。
  function t(text) {
    if (!TABLE || text == null) {
      return text;
    }
    var key = String(text).trim();
    return TABLE[key] || text;
  }

  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1 };

  function translateNode(node) {
    var raw = node.nodeValue;
    if (!raw) {
      return;
    }
    var text = raw.trim();
    if (!text) {
      return;
    }
    var hit = TABLE[text];
    if (!hit) {
      return;
    }
    // 只换文字本身，前后的空白和换行留着，别把排版弄乱
    node.nodeValue = raw.replace(text, hit);
  }

  /// 把一棵子树里的文本节点、placeholder、title 全过一遍
  function apply(root) {
    if (!TABLE || !root) {
      return;
    }

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentNode;
        if (!parent || SKIP[parent.nodeName]) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    for (var i = 0; i < nodes.length; i++) {
      translateNode(nodes[i]);
    }

    var tagged = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title]') : [];
    for (var j = 0; j < tagged.length; j++) {
      var el = tagged[j];
      var ph = el.getAttribute('placeholder');
      if (ph && TABLE[ph.trim()]) {
        el.setAttribute('placeholder', TABLE[ph.trim()]);
      }
      var ti = el.getAttribute('title');
      if (ti && TABLE[ti.trim()]) {
        el.setAttribute('title', TABLE[ti.trim()]);
      }
    }

    if (root === document.body && document.title && TABLE[document.title.trim()]) {
      document.title = TABLE[document.title.trim()];
    }
  }

  window.t = t;
  window.__HMCL_I18N__ = {
    locale: function () { return LOCALE; },
    active: function () { return !!TABLE; },
    t: t,
    apply: apply
  };

  // 静态 HTML 里的文案在 DOM 就绪后统一换一遍
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      apply(document.body);
    });
  } else {
    apply(document.body);
  }
})();
