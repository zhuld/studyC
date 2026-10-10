/*
 * highlight.js — C 源码语法高亮（纯文本 → 带 tok-* 类的 HTML）
 *
 * 供 app.js(浏览器) 与 tools/test_highlight.js(Node) 共用, 保证编辑器高亮层、
 * 正文代码框(pre.card-code)与回归测试使用同一份着色规则。不依赖 DOM。
 *
 * 单趟正则按「注释 → 字符串/字符 → 预处理行 → 数字 → 标识符」的优先级交替匹配,
 * 每段先转义再包 span, 因此注释与字面量内部的词不会被后续分组重复着色:
 *   · 注释 tok-cm: 块注释可跨行, 行注释到行尾为止
 *   · 字符串 tok-str: 不跨行; 未闭合的双引号只染到行尾(C 字符串本就不跨行)
 *   · 字符 tok-str: 不跨行且必须同行闭合, 避免正文里的英文撇号(如语法说明
 *     中的 *'s)被当成未闭合字面量而误染后续内容
 *   · 预处理行 tok-pp(不跨行) / 数字 tok-num / 关键字 tok-kw / 类型 tok-ty / 函数 tok-fn
 *
 * 返回值不带尾换行: 正文代码框回填后与原文行数一致; 编辑器高亮层需与行号列对齐,
 * 由 app.js 的 renderEditor() 自行补一个换行。
 *
 * 浏览器: window.KRC_HIGHLIGHT.highlight(code)；Node: require("./highlight.js").highlight
 */
/* UMD 包装：浏览器挂到 window.KRC_HIGHLIGHT，Node 下走 module.exports，
   使页面与测试共用同一份着色逻辑 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.KRC_HIGHLIGHT = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* HTML 转义：每段文本先转义再包 span，防止源码里的 < & 被当成标签解析 */
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* C 关键字；末尾另附几个常见的 C++ 词，使混入 class/new 等词的片段
     也不会被误判成普通标识符 */
  var KEYWORDS = ("auto break case char const continue default do double else enum extern " +
    "float for goto if inline int long register restrict return short signed sizeof static " +
    "struct switch typedef union unsigned void volatile while _Bool _Atomic _Thread_local " +
    "asm constexpr class namespace new operator template this throw try catch using").split(/\s+/);
  /* 常用标准库类型名（单独着色） */
  var TYPES = ("int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t ssize_t " +
    "ptrdiff_t FILE bool intptr_t uintptr_t").split(/\s+/);
  /* 词表转哈希集合，便于逐词 O(1) 查询 */
  var KW_SET = {}, TY_SET = {};
  KEYWORDS.forEach(function (k) { KW_SET[k] = 1; });
  TYPES.forEach(function (t) { TY_SET[t] = 1; });

  /* 分组依次为: 注释 | 字符串 | 字符 | 预处理行 | 数字 | 标识符。
     字符串/字符都要求在本行内闭合（未闭合的 " 允许染到行尾），
     预处理行的 # 之后只允许空格/制表符，不跨行 */
  var TOKEN_RE = new RegExp(
    "(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)" +                          // 1 注释
    "|(\"(?:\\\\.|[^\"\\\\\\n])*\"?)" +                                 // 2 字符串
    "|('(?:\\\\.|[^'\\\\\\n])*')" +                                     // 3 字符
    "|(#[ \\t]*\\w+)" +                                                // 4 预处理行
    "|(\\b\\d+\\.?\\d*[uUlLfF]*\\b)" +                                 // 5 数字
    "|([A-Za-z_]\\w*)",                                                // 6 标识符
    "g");

  /*
   * 把 C 源码转换为带 tok-* 类的高亮 HTML（每段先 esc 再包 span，避免二次解析）。
   * 返回值末尾不补换行，正文代码框与编辑器各自决定如何对齐行数。
   */
  function highlight(code) {
    var out = "", last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(code)) !== null) {
      out += esc(code.slice(last, m.index));
      if (m[1] != null)      out += '<span class="tok-cm">'  + esc(m[1]) + "</span>";
      else if (m[2] != null) out += '<span class="tok-str">' + esc(m[2]) + "</span>";
      else if (m[3] != null) out += '<span class="tok-str">' + esc(m[3]) + "</span>";
      else if (m[4] != null) out += '<span class="tok-pp">'  + esc(m[4]) + "</span>";
      else if (m[5] != null) out += '<span class="tok-num">' + esc(m[5]) + "</span>";
      else {
        var w = m[6];
        if (KW_SET[w])       out += '<span class="tok-kw">'  + esc(w) + "</span>";
        else if (TY_SET[w])  out += '<span class="tok-ty">'  + esc(w) + "</span>";
        /* 后跟左括号的标识符按函数名着色（纯启发式，无符号表） */
        else if (code[TOKEN_RE.lastIndex] === "(") out += '<span class="tok-fn">' + esc(w) + "</span>";
        else out += esc(w);
      }
      last = TOKEN_RE.lastIndex;
    }
    out += esc(code.slice(last));
    return out;
  }

  return { highlight: highlight };
});