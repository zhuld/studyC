/*
 * app.js — 课程页面主逻辑（IIFE，无构建步骤，浏览器直接执行）
 *
 * 职责：
 *   1. 渲染教程：按 lessons.js 提供的课程数据生成三级章节目录（章 / 小节 / 三级小节）
 *      与教材小节正文
 *   2. 教材正文代码块：借 code-blocks.js 的判定规则，给可编译的完整程序加「载入 / 运行」入口
 *   3. 代码工作台：默认隐藏的可拖动、缩放、关闭浮层编辑器（行号 + C 语法高亮 + Tab 缩进），
 *      经工具条「打开代码工作台」按钮或正文代码块的「载入 / 运行」打开
 *   4. 在线编译：调用 Wandbox 的 list.json（编译器列表）与 compile.json（编译并执行），
 *      默认以 C89（ANSI C，即教材描述的标准）提交
 *   5. 阅读辅助：工具条显示当前章节进度，提供字号调整、明暗主题与全屏切换
 *   6. 本地存档：目录、当前章节、字号与主题选择写入 localStorage
 *
 * 依赖：必须晚于 lessons.js 与 code-blocks.js 加载（见 index.html 的脚本顺序）。
 *      课程数据就绪后由 window 事件 "course-content-ready" 触发初始化，
 *      数据加载失败则监听 "course-content-error" 显示提示。
 *
 * 编码约定：统一使用 var 与字符串拼接的 ES5 写法，不依赖构建工具或第三方库。
 */
"use strict";

(function () {

  /* ============================== 常量 ============================== */

  /* Wandbox 公开 API：list.json 取编译器列表，compile.json 提交编译并执行
     （服务端开放 CORS，浏览器可直连，因此本页面无需后端） */
  var WANDBOX_LIST   = "https://wandbox.org/api/list.json";
  var WANDBOX_RUN    = "https://wandbox.org/api/compile.json";
  /* 取不到编译器列表时使用的兜底编译器 */
  var FALLBACK_COMPILER = "gcc-13.2.0-c";
  /* 页面默认采用的 C 标准：教材《The C Programming Language》第 2 版描述的是 ANSI C，
     即 C89；编译器列表里没有 c89 时退回首项（编译器自身的默认标准） */
  var DEFAULT_STD = "c89";
  /* 工作台的初始代码：课程不再附带示例，给一段最小可运行的 hello, world */
  var STARTER_CODE =
    "#include <stdio.h>\n" +
    "\n" +
    "int main(void)\n" +
    "{\n" +
    "    printf(\"hello, world\\n\");\n" +
    "    return 0;\n" +
    "}\n";

  /* ============================== 工具 ============================== */

  /* document.getElementById 的简写 */
  var $ = function (id) { return document.getElementById(id); };

  function scrollBehavior() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto" : "smooth";
  }

  /* 创建元素：cls 为类名（可省略），html 为 innerHTML 片段 */
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls)  n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* HTML 转义：课程数据与用户输出都经此输出，防止尖括号被当成标签解析 */
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ============================== 当前章节 ============================== */

  /* 当前显示的章节对象（不是编号），切换章节时整体替换；
     初值为 window.CHAPTER1（首章：前言与序） */
  var activeLesson = window.CHAPTER1;

  /* ============================== 状态 ============================== */

  var state = {
    compilers: [],          // 可选编译器 [{name, version, stdOpts:[{value,label}]}]
    loadedCode: "",         // 最近一次「载入」的原始代码，供「重置」还原
    running: false          // 编译进行中标记，避免重复提交请求
  };

  var READING_FONT_MIN = 15;
  var READING_FONT_MAX = 21;
  var READING_FONT_STEP = 1;
  var readingProgressFrame = 0;

  window.__krc = state; // 暴露给控制台便于调试

  /* ========================= 语法高亮（C） ========================= */

  /* 着色实现的唯一来源在 highlight.js（UMD：浏览器 window.KRC_HIGHLIGHT，
     Node 下 tools/test_highlight.js require 同一份），这里只取引用；
     脚本缺失时降级为纯转义文本，页面其余功能不受影响 */
  var highlight = (window.KRC_HIGHLIGHT && window.KRC_HIGHLIGHT.highlight) ||
    function (code) { return esc(code); };

  /*
   * 给容器内所有正文代码框（pre.card-code）着色：取 textContent（已还原 &lt; 等实体）
   * 作源码，经 highlight() 生成 tok-* span 后回填。textContent 不受 span 影响，
   * 因此「载入 / 运行 / 复制」等取 textContent 的逻辑不受干扰；重复执行结果相同（幂等）。
   * 须在正文 innerHTML 注入之后调用，renderSections 在加复制按钮前统一跑一次。
   */
  function highlightCodeBlocks(root) {
    Array.prototype.forEach.call(root.querySelectorAll("pre.card-code"), function (pre) {
      pre.innerHTML = highlight(pre.textContent);
    });
  }

  /* ============================== 编辑器 ============================== */

  /* 编辑器与工作台中会反复访问的元素，在 init() 里一次性绑定 */
  var codeEl, hlEl, gutterEl, stdinEl;
  var workbench, workbenchDrag, workbenchResize;

  /* 重绘高亮层与行号列；输入、Tab 缩进、载入代码后调用 */
  function renderEditor() {
    var code = codeEl.value;
    /* 末尾补一个换行使高亮层行数与 textarea、行号列一致，避免末行错位 */
    hlEl.innerHTML = highlight(code) + "\n";
    /* 行号列是纯文本（每行一个数字），与高亮层同样参与滚动同步 */
    var lines = code.split("\n").length;
    var g = "";
    for (var i = 1; i <= lines; i++) g += i + "\n";
    gutterEl.textContent = g;
    syncScroll();
  }

  /* 高亮层与行号列都绝对定位、自身不产生滚动条，
     因此必须跟随 textarea 的滚动位置，否则文字与光标会错位 */
  function syncScroll() {
    hlEl.scrollTop = codeEl.scrollTop;
    hlEl.scrollLeft = codeEl.scrollLeft;
    gutterEl.scrollTop = codeEl.scrollTop;
  }

  /*
   * 载入一段代码到工作台。
   * src    要载入的源码
   * stdin  随之填入的标准输入（可为空）
   * 副作用：若工作台被关闭则先打开。
   */
  function setCode(src, stdin) {
    state.loadedCode = src;
    /* 工作台被关闭时先把它弹出来 */
    if (workbench.hidden) showWorkbench();
    codeEl.value = src;
    stdinEl.value = stdin || "";
    renderEditor();
    codeEl.focus();
    codeEl.setSelectionRange(0, 0);
    setMeta("已载入 · 按 Ctrl+⏎ 运行", "");
  }

  /* Tab 键在编辑器中插入 4 空格；Shift+Tab 为反缩进（仅处理光标所在行行首） */
  function handleTab(e) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    var s = codeEl.selectionStart, t = codeEl.selectionEnd, v = codeEl.value;
    if (e.shiftKey) {
      // 反缩进：行首去掉最多 4 空格
      var ls = v.lastIndexOf("\n", s - 1) + 1;
      if (v.slice(ls, ls + 4) === "    ") {
        codeEl.value = v.slice(0, ls) + v.slice(ls + 4);
        codeEl.setSelectionRange(Math.max(ls, s - 4), Math.max(ls, t - 4));
      }
    } else {
      codeEl.value = v.slice(0, s) + "    " + v.slice(t);
      codeEl.setSelectionRange(s + 4, s + 4);
    }
    renderEditor();
  }

  /*
   * 把工作台移到 (left, top)，并夹在视口内留出 12px 边距。
   * 定位改用 left/top，同时清掉 CSS 中的 right/bottom，避免两套定位互相拉扯。
   */
  function setWindowPosition(left, top) {
    var rect = workbench.getBoundingClientRect();
    var maxLeft = Math.max(12, window.innerWidth - rect.width - 12);
    var maxTop = Math.max(12, window.innerHeight - rect.height - 12);
    workbench.style.left = Math.max(12, Math.min(left, maxLeft)) + "px";
    workbench.style.top = Math.max(12, Math.min(top, maxTop)) + "px";
    workbench.style.right = "auto";
    workbench.style.bottom = "auto";
  }

  /*
   * 工作台开合：打开时取消隐藏并露出重开入口，关闭时反之。
   */
  function showWorkbench() {
    $("workbenchLauncher").hidden = true;
    workbench.hidden = false;
  }

  function hideWorkbench() {
    workbench.hidden = true;
    $("workbenchLauncher").hidden = false;
  }

  /* 工作台交互：关闭/重开、拖动标题栏、右下角缩放，均支持键盘操作 */
  function setupWorkbench() {
    workbench = $("workbench");
    workbenchDrag = $("workbenchDrag");
    workbenchResize = $("workbenchResize");

    /* 关闭后焦点移回「打开代码工作台」按钮，保持键盘可达 */
    $("workbenchClose").addEventListener("click", function () {
      hideWorkbench();
      $("workbenchLauncher").focus();
    });
    $("workbenchLauncher").addEventListener("click", function () {
      showWorkbench();
      workbenchDrag.focus();
    });

    /* 拖动标题栏：按下时先转成 left/top 定位，再用指针捕获跟踪 pointermove，
       这样指针移出窗口也不会丢失拖动 */
    workbenchDrag.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || e.target.closest(".wb-actions, button, select")) return;
      e.preventDefault();
      var rect = workbench.getBoundingClientRect();
      var startX = e.clientX, startY = e.clientY;
      var left = rect.left, top = rect.top;
      setWindowPosition(left, top);
      workbenchDrag.setPointerCapture(e.pointerId);
      function move(ev) {
        setWindowPosition(left + ev.clientX - startX, top + ev.clientY - startY);
      }
      function end() {
        workbenchDrag.removeEventListener("pointermove", move);
        workbenchDrag.removeEventListener("pointerup", end);
        workbenchDrag.removeEventListener("pointercancel", end);
      }
      workbenchDrag.addEventListener("pointermove", move);
      workbenchDrag.addEventListener("pointerup", end);
      workbenchDrag.addEventListener("pointercancel", end);
    });
    /* 无鼠标时的替代方案：方向键移动 16px，按住 Shift 每次 40px */
    workbenchDrag.addEventListener("keydown", function (e) {
      var delta = e.shiftKey ? 40 : 16;
      var rect = workbench.getBoundingClientRect();
      if (e.key === "ArrowLeft") setWindowPosition(rect.left - delta, rect.top);
      else if (e.key === "ArrowRight") setWindowPosition(rect.left + delta, rect.top);
      else if (e.key === "ArrowUp") setWindowPosition(rect.left, rect.top - delta);
      else if (e.key === "ArrowDown") setWindowPosition(rect.left, rect.top + delta);
      else return;
      e.preventDefault();
    });

    /* 右下角缩放：宽高同时受最小尺寸与「到视口边缘 12px」限制 */
    workbenchResize.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var rect = workbench.getBoundingClientRect();
      var startX = e.clientX, startY = e.clientY;
      var startWidth = rect.width, startHeight = rect.height;
      setWindowPosition(rect.left, rect.top);
      workbenchResize.setPointerCapture(e.pointerId);
      function resize(ev) {
        var currentRect = workbench.getBoundingClientRect();
        var minWidth = Math.min(320, window.innerWidth - 24);
        var minHeight = Math.min(280, window.innerHeight - 24);
        var width = Math.max(minWidth, Math.min(startWidth + ev.clientX - startX,
          window.innerWidth - currentRect.left - 12));
        var height = Math.max(minHeight, Math.min(startHeight + ev.clientY - startY,
          window.innerHeight - currentRect.top - 12));
        workbench.style.width = width + "px";
        workbench.style.height = height + "px";
      }
      function end() {
        workbenchResize.removeEventListener("pointermove", resize);
        workbenchResize.removeEventListener("pointerup", end);
        workbenchResize.removeEventListener("pointercancel", end);
      }
      workbenchResize.addEventListener("pointermove", resize);
      workbenchResize.addEventListener("pointerup", end);
      workbenchResize.addEventListener("pointercancel", end);
    });
    /* 缩放手柄的键盘操作：方向键调整对应边，Shift 加速 */
    workbenchResize.addEventListener("keydown", function (e) {
      if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
      var rect = workbench.getBoundingClientRect();
      var delta = e.shiftKey ? 40 : 16;
      var minWidth = Math.min(320, window.innerWidth - 24);
      var minHeight = Math.min(280, window.innerHeight - 24);
      var width = rect.width + (e.key === "ArrowRight" ? delta : e.key === "ArrowLeft" ? -delta : 0);
      var height = rect.height + (e.key === "ArrowDown" ? delta : e.key === "ArrowUp" ? -delta : 0);
      workbench.style.width = Math.max(minWidth, Math.min(width, window.innerWidth - rect.left - 12)) + "px";
      workbench.style.height = Math.max(minHeight, Math.min(height, window.innerHeight - rect.top - 12)) + "px";
      e.preventDefault();
    });

    /* 视口尺寸变化后重新夹紧工作台，防止它被挤出可视区域 */
    window.addEventListener("resize", function () {
      if (workbench.hidden) return;
      var rect = workbench.getBoundingClientRect();
      var width = Math.min(rect.width, window.innerWidth - 24);
      var height = Math.min(rect.height, window.innerHeight - 24);
      workbench.style.width = width + "px";
      workbench.style.height = height + "px";
      setWindowPosition(rect.left, rect.top);
    });
  }

  /* ============================== 输出面板 ============================== */

  /* 更新输出面板右上角的状态文字，cls 用于着色（ok / bad / 空） */
  function setMeta(text, cls) {
    var m = $("outMeta");
    m.textContent = text;
    m.className = "out-meta" + (cls ? " " + cls : "");
  }

  /* 把若干「段落」拼成输出面板的 HTML；全为空时显示占位文案 */
  function outHTML(sections) {
    return sections.map(function (s) {
      if (!s.text) return "";
      return '<span class="out-sec"><span class="out-sec-label">' + esc(s.label) +
        '</span><span class="' + (s.cls || "") + '">' + esc(s.text) + "</span></span>";
    }).join("") || '<span class="out-dim">（无输出）</span>';
  }

  /* ============================ 编译状态 ============================ */

  /* Wandbox 的 status 非 "0" 并不等于编译失败：只有编译器消息里出现
     "error:" 才算真正的编译错误，否则只是程序退出码非 0（见 finishRun） */
  function compileErred(res) {
    return !!res && res.status !== "0" && /error:/i.test(res.compiler_message || "");
  }
  /* ============================ 编译器列表 ============================ */

  /* 从 list.json 中该编译器的 switches 里抽取 C 标准选项，
     过滤出 c89/c99/c11 之类（含 gnu 前缀的变体），并按显示名去重 */
  function buildStdOptions(entry) {
    /* 首项不附加任何 -std=，交由编译器使用它自己的默认标准 */
    var opts = [{ value: "", label: "编译器默认" }];
    (entry.switches || []).forEach(function (sw) {
      if (sw.type === "select" && /std/i.test(sw.name || "")) {
        (sw.options || []).forEach(function (o) {
          if (/^(gnu)?c?\d+$/.test(o.name)) {
            opts.push({ value: o.name, label: o["display-name"] || o.name });
          }
        });
      }
    });
    var seen = {}, uniq = [];
    opts.forEach(function (o) {
      if (!seen[o.label]) { seen[o.label] = 1; uniq.push(o); }
    });
    return uniq;
  }

  /*
   * 拉取 Wandbox 编译器列表填充下拉框。
   * 网络失败时退化为仅含兜底编译器的占位配置，保证页面仍可打开并编译。
   */
  function loadCompilers() {
    var sel = $("compilerSel");
    sel.innerHTML = '<option value="">加载编译器…</option>';

    fetch(WANDBOX_LIST)
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var cList = list.filter(function (e) { return e.language === "C"; });
        if (!cList.length) throw new Error("empty C list");
        state.compilers = cList.map(function (e) {
          return { name: e.name, version: e.version, stdOpts: buildStdOptions(e) };
        });
        sel.innerHTML = "";
        state.compilers.forEach(function (c) {
          var o = document.createElement("option");
          o.value = c.name;
          o.textContent = c.name + "  (" + c.version + ")";
          if (c.name === FALLBACK_COMPILER) o.selected = true;
          sel.appendChild(o);
        });
        if (!sel.value) sel.selectedIndex = 0;
        refreshStdSel();
        setMeta("编译器就绪", "ok");
      })
      .catch(function () {
        state.compilers = [{ name: FALLBACK_COMPILER, version: "13.2.0",
          stdOpts: [{ value: "", label: "编译器默认" }, { value: "c89", label: "C89" },
                    { value: "c99", label: "C99" }, { value: "c11", label: "C11" }] }];
        sel.innerHTML = "";
        var o = document.createElement("option");
        o.value = FALLBACK_COMPILER;
        o.textContent = FALLBACK_COMPILER + "（占位配置）";
        sel.appendChild(o);
        refreshStdSel();
        setMeta("无法获取编译器列表，已用占位配置", "bad");
      });
  }

  /* 当前选中的编译器；列表中找不到（如占位配置）时返回最小可用对象 */
  function currentCompiler() {
    var name = $("compilerSel").value || FALLBACK_COMPILER;
    for (var i = 0; i < state.compilers.length; i++) {
      if (state.compilers[i].name === name) return state.compilers[i];
    }
    return { name: name, version: "", stdOpts: [{ value: "", label: "编译器默认" }] };
  }

  /* 按当前编译器的可用项重建「C 标准」下拉框（切换编译器时调用）；
     默认选中 C89：教材基于 ANSI C，默认以该标准为准 */
  function refreshStdSel() {
    var std = $("stdSel"), c = currentCompiler();
    std.innerHTML = "";
    c.stdOpts.forEach(function (o) {
      var e = document.createElement("option");
      e.value = o.value;
      e.textContent = o.label;
      std.appendChild(e);
    });
    std.value = DEFAULT_STD;
    /* 该编译器未提供 c89 时 std.value 落空（selectedIndex 为 -1），退回首项 */
    if (std.selectedIndex < 0) std.selectedIndex = 0;
  }

  /* ============================ 运行 ============================ */

  /* 把编辑器内容提交给 Wandbox 编译执行；请求期间禁用按钮，避免并发提交 */
  function run() {
    if (state.running) return;
    state.running = true;
    var btn = $("runBtn");
    btn.disabled = true;
    $("out").innerHTML = '<span class="out-placeholder">正在编译并运行…</span>';
    setMeta("编译运行中…", "");

    /* 请求体：编译器名、源码、stdin；仅在选择了具体标准时附加 options */
    var body = {
      compiler: $("compilerSel").value || FALLBACK_COMPILER,
      code: codeEl.value,
      stdin: stdinEl.value
    };
    var std = $("stdSel").value;
    if (std) body.options = std;

    fetch(WANDBOX_RUN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (res) { finishRun(res, null); })
      .catch(function (err) { finishRun(null, err); })
      .then(function () {
        state.running = false;
        btn.disabled = false;
      });
  }

  /* 收尾：渲染编译器消息与程序输出，更新状态文字 */
  function finishRun(res, err) {
    if (err) {
      $("out").innerHTML = outHTML([
        { label: "网络 / 服务错误", text: String(err.message || err), cls: "out-err" }
      ]);
      setMeta("失败", "bad");
      return;
    }

    // status 非 "0" 不一定是编译失败：
    //  · compiler_message 含 "error:" → 真正的编译错误
    //  · 否则只是程序退出码非 0（如 C89 下 main 无 return 的未定义退出码），仍算运行成功
    var compileFailed = compileErred(res);
    var sections = [];
    if (res.compiler_message) {
      sections.push({
        label: compileFailed ? "编译错误" : "编译器消息（警告）",
        text: res.compiler_message,
        cls: compileFailed ? "out-err" : "out-warn"
      });
    }
    var outLabel = "程序输出";
    if (res.signal) outLabel += "（被信号 " + res.signal + " 终止）";
    else if (res.status !== "0" && !compileFailed) outLabel += "（退出码 " + res.status + "）";
    sections.push({ label: outLabel, text: res.program_message || "", cls: "" });
    $("out").innerHTML = outHTML(sections);

    if (compileFailed) {
      setMeta("编译失败", "bad");
      return;
    }
    if (res.signal) {
      setMeta("运行异常 · signal " + res.signal, "bad");
      return;
    }
    setMeta("运行成功 · exit " + res.status, "ok");
  }

  /* ============================ 渲染教程 ============================ */

  /* 收起目录里除 keep 外所有已展开的三级抽屉（keep 传 null 表示全部收起） */
  function closeGroupsExcept(keep) {
    Array.prototype.forEach.call(
      document.querySelectorAll("#chapterNav .chip-group.is-open"),
      function (group) {
        if (group !== keep) setGroupOpen(group, false);
      }
    );
  }

  /*
   * 开合某个小节分组的三级抽屉，并同步父 chip 的 aria-expanded。
   * 采用手风琴语义：展开某个抽屉前先收起目录里其余已展开的三级抽屉，
   * 保证同一时刻至多只有一个三级抽屉是打开的（收起时不动作）。
   */
  function setGroupOpen(group, open) {
    if (open) closeGroupsExcept(group);
    group.classList.toggle("is-open", open);
    var tab = group.querySelector(".chip.has-subs");
    if (tab) tab.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /*
   * 渲染侧栏「小节」列表（三级瀑布目录的第二、三级）：
   *   二级小节（编号两段，如 1.5）直接作为 chip 挂在当前章抽屉下；
   *   三级小节（编号三段，如 1.5.1）按编号前缀收进父节的 .chip-group，
   *   点父节在跳转正文的同时开合其三级抽屉，点三级 chip 直接跳转；
   * 每个 chip 都带 data-outline-topic（供滚动高亮定位）。
   */
  function renderChips() {
    var index = window.CHAPTERS.indexOf(activeLesson);
    var item = document.querySelector('.chapter-item[data-chapter="' + (index + 1) + '"]');
    var nav = item ? item.querySelector(".chips") : null;
    if (!nav) return;
    nav.innerHTML = "";
    /* 无障碍与提示文案按「前言 / 正文章 / 附录」区分：按首节编号前缀判定
       （`0.` → 前言、字母 → 附录），与管线推导编号的规则同源 */
    var prefix = activeLesson.tutorials.length
      ? activeLesson.tutorials[0].number.split(".")[0] : "";
    var kindLabel = prefix === "0" ? "前言" : /^[A-Za-z]$/.test(prefix) ? "附录" : "教材";
    nav.setAttribute("aria-label",
      kindLabel + "小节，共 " + activeLesson.tutorials.length + " 项");
    /* 三级抽屉的 DOM id 由章序号与父节编号派生（1.5 → chapterSubs1-1-5） */
    function subsIdOf(topic) {
      return "chapterSubs" + (index + 1) + "-" + topic.number.replace(/\./g, "-");
    }
    /* 生成一个小节 chip；hasSubs 时附子菜单数量徽标，点击先开合三级抽屉再跳到父节正文 */
    function makeChip(topic, hasSubs) {
      /* 正文小节的 id 由编号派生（1.5.1 → topic-1-5-1），点击时按 id 滚动 */
      var targetId = "topic-" + topic.number.replace(/\./g, "-");
      /* 二级菜单的子菜单数量：编号以「本节编号.」开头的三级小节数，
         判定与下方抽屉挂载规则同源；无子节时不输出徽标 */
      var subCount = 0;
      if (hasSubs) {
        activeLesson.tutorials.forEach(function (other) {
          if (other.number.indexOf(topic.number + ".") === 0) subCount++;
        });
      }
      var c = el("button", "chip",
        '<span class="chip-label">' + esc(topic.number + " " + topic.title) + "</span>" +
        (subCount ? '<span class="chip-count">' + subCount + "</span>" : ""));
      c.type = "button";
      c.setAttribute("data-outline-topic", topic.number);
      c.title = kindLabel === "教材" ? "" : kindLabel + "小节";
      if (hasSubs) {
        c.classList.add("has-subs");
        c.setAttribute("aria-expanded", "false");
        c.setAttribute("aria-controls", subsIdOf(topic));
        c.title = (c.title ? c.title + " · " : "") +
          (subCount ? "含 " + subCount + " 个三级小节，点击开合" : "含三级小节，点击开合");
      }
      c.addEventListener("click", function () {
        /* 带子节的父 chip 是所在 .chip-group 的直接子元素：先切换开合 */
        if (hasSubs) {
          var group = c.parentNode;
          setGroupOpen(group, !group.classList.contains("is-open"));
        }
        /* 点击即选中：立即高亮并锁定，避免平滑滚动途中被侦测竞态改到上一节 */
        selectChip(c, topic.number);
        var target = document.getElementById(targetId);
        if (target) target.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      });
      return c;
    }
    /* 父节编号 → 三级抽屉容器；三段编号的小节据此挂进父节的分组 */
    var subsOf = {};
    activeLesson.tutorials.forEach(function (topic) {
      var segs = topic.number.split(".");
      if (segs.length > 2) {
        var parentGroup = subsOf[segs.slice(0, -1).join(".")];
        /* 父节缺失（数据异常）时不丢条目：落回下面按二级 chip 渲染 */
        if (parentGroup) { parentGroup.appendChild(makeChip(topic, false)); return; }
      }
      var hasChildren = activeLesson.tutorials.some(function (other) {
        return other.number.indexOf(topic.number + ".") === 0;
      });
      if (!hasChildren) { nav.appendChild(makeChip(topic, false)); return; }
      /* 带三级子节的二级小节：包一层 .chip-group（父 chip + 可开合的三级抽屉） */
      var group = el("div", "chip-group");
      var subs = el("div", "chip-subs");
      subs.id = subsIdOf(topic);
      var subsList = el("div", "chips");
      subs.appendChild(subsList);
      group.appendChild(makeChip(topic, true));
      group.appendChild(subs);
      nav.appendChild(group);
      subsOf[topic.number] = subsList;
    });
  }

  /*
   * 教材正文里「带 main 的完整程序」：在其后追加在线编译入口。
   * 判定规则来自 code-blocks.js（与 tools/test_code_blocks.js 共用）。
   */
  function decorateRunnableCode(article) {
    var detect = window.KRC_CODE_BLOCKS;
    if (!detect) return;
    Array.prototype.forEach.call(article.querySelectorAll("pre.card-code"), function (pre) {
      var code = pre.textContent;          // textContent 已还原 &lt; 等实体
      if (!detect.isRunnableProgram(code)) return;

      /* 正文代码没有 stdin 数据，载入后由使用者在工作台自行填写 */
      var bar = el("div", "card-actions");
      var loadBtn = el("button", "btn", "载入编辑器");
      var runBtn = el("button", "btn primary", "▶ 运行");
      loadBtn.type = "button";
      runBtn.type = "button";
      loadBtn.title = "把这段教材代码放进工作台, 可在其中补齐上下文";
      runBtn.title = "载入工作台并在线编译运行";
      loadBtn.addEventListener("click", function () { setCode(code, ""); });
      runBtn.addEventListener("click", function () { setCode(code, ""); run(); });
      bar.appendChild(loadBtn);
      bar.appendChild(runBtn);
      /* 需要 stdin 的程序提前提醒，避免运行时读到空输入而误以为程序有错 */
      if (/\b(?:getchar|scanf|fgets|gets|read)[ \t]*\(/.test(code)) {
        bar.appendChild(el("span", "code-actions-note", "程序会读取 stdin, 请在工作台填写输入"));
      }
      pre.insertAdjacentElement("afterend", bar);
    });
  }

  /* ============================== 代码块复制 ============================== */

  /*
   * 把文本写入剪贴板：优先 Clipboard API（要求安全上下文），
   * 被拒绝或不可用（如 http 局域网访问）时回退到隐藏 textarea + execCommand。
   * 完成后回调 done(ok)，按钮上的文字反馈由调用方负责。
   */
  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(text).then(
          function () { done(true); },
          fallback
        );
      } catch (e) { fallback(); }
    } else {
      fallback();
    }
  }

  /*
   * 给代码块加右上角「复制」按钮：先把 pre 包进 .code-fig 容器作为定位上下文，
   * 按钮因此不会随 pre 的横向滚动移动；复制内容取 pre.textContent，与「载入编辑器」一致。
   * 正文的代码块统一在 renderSections 末尾调用一次，
   * 故须晚于 decorateRunnableCode，以免改变其「载入 / 运行」动作条的插入位置；
   * 已包裹的块直接跳过，避免重复加按钮。
   */
  function addCopyButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll("pre.card-code"), function (pre) {
      if (pre.parentNode && pre.parentNode.classList.contains("code-fig")) return;
      var fig = el("div", "code-fig");
      pre.parentNode.insertBefore(fig, pre);
      fig.appendChild(pre);

      var btn = el("button", "code-copy", "复制");
      btn.type = "button";
      btn.title = "复制代码";
      btn.setAttribute("aria-label", "复制代码");
      var timer = null;
      btn.addEventListener("click", function () {
        copyText(pre.textContent, function (ok) {
          btn.textContent = ok ? "已复制" : "复制失败";
          btn.classList.toggle("copied", ok);
          btn.classList.toggle("copy-fail", !ok);
          if (timer) clearTimeout(timer);
          timer = setTimeout(function () {
            btn.textContent = "复制";
            btn.classList.remove("copied", "copy-fail");
            timer = null;
          }, 1600);
        });
      });
      fig.appendChild(btn);
    });
  }

  /*
   * 渲染正文区：先输出章首导言（以章节名称为标题独立成块），再按教材目录顺序输出各小节。
   * 小节标题的层级由编号段数决定（1.5 → h2，1.5.1 → h3）。
   */
  function renderSections() {
    var wrap = $("sections");
    wrap.innerHTML = "";

    /* 章首导言：标题即章节名；不带 data-outline-topic——目录里没有它的 chip，
       滚动高亮的取样选择器 [data-outline-topic].outline-topic 会自动跳过它 */
    if (activeLesson.intro && activeLesson.intro.length) {
      var introArticle = el("article", "outline-topic topic-intro");
      var introContent = "<h2>" + esc(activeLesson.meta.chapter) + "</h2>";
      activeLesson.intro.forEach(function (paragraph) {
        introContent += paragraph + "\n";
      });
      introArticle.innerHTML = introContent;
      decorateRunnableCode(introArticle);
      wrap.appendChild(introArticle);
    }

    activeLesson.tutorials.forEach(function (topic) {
      /* 编号有三段（如 1.5.1）的是子小节，改用 h3 并施加缩进样式 */
      var isSubsection = topic.number.split(".").length > 2;
      var article = el("article", "outline-topic" + (isSubsection ? " topic-subsection" : ""));
      article.id = "topic-" + topic.number.replace(/\./g, "-");
      article.setAttribute("data-outline-topic", topic.number);
      var heading = isSubsection ? "h3" : "h2";
      /* 标题带上小节号（元信息栏移除后，编号只能由此体现） */
      var content = "<" + heading + ">" + esc(topic.number) + "　" + esc(topic.title) + "</" + heading + ">";
      topic.paragraphs.forEach(function (paragraph) {
        // paragraphs 由 Markdown 解析器转为块级 HTML (<p>/<pre>/<img>/<table>)
        content += paragraph + "\n";
      });
      article.innerHTML = content;
      decorateRunnableCode(article);
      wrap.appendChild(article);
    });

    /* 所有正文渲染完后统一给代码框着色（取 textContent，与「复制 / 载入编辑器」
       读到的是同一份文本），再加右上角「复制」按钮 */
    highlightCodeBlocks(wrap);
    addCopyButtons(wrap);
  }

  function updateReadingProgress() {
    var sections = $("sections");
    var track = $("readingProgress");
    if (!sections || !track) return;

    var rect = sections.getBoundingClientRect();
    var height = rect.height;
    var value = 0;
    if (height > 0) {
      var maxScroll = height - (window.innerHeight || document.documentElement.clientHeight);
      if (maxScroll <= 0) {
        value = rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) ? 100 : 0;
      } else {
        var start = rect.top + window.pageYOffset;
        value = Math.round(((window.pageYOffset - start) / maxScroll) * 100);
      }
    }
    value = Math.max(0, Math.min(100, value));
    track.setAttribute("aria-valuenow", String(value));
    track.setAttribute("aria-valuetext", value + "%");
    $("readingProgressFill").style.width = value + "%";
    $("readingProgressValue").textContent = value + "%";
  }

  function scheduleReadingProgress() {
    if (readingProgressFrame) return;
    readingProgressFrame = window.requestAnimationFrame(function () {
      readingProgressFrame = 0;
      updateReadingProgress();
    });
  }

  function applyReadingFontSize(size, persist) {
    var value = Math.max(READING_FONT_MIN, Math.min(READING_FONT_MAX, size));
    document.documentElement.style.setProperty("--reading-font-size", value + "px");
    $("fontSizeValue").textContent = value + "px";
    $("fontDecrease").disabled = value <= READING_FONT_MIN;
    $("fontIncrease").disabled = value >= READING_FONT_MAX;
    if (persist) {
      try { localStorage.setItem("krc-course-font-size-v1", String(value)); } catch (e) {}
    }
  }

  function applyReadingTheme(theme, persist) {
    var isDark = theme === "dark";
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    $("themeToggle").setAttribute("aria-label",
      isDark ? "切换到浅色主题" : "切换到深色主题");
    $("themeIcon").textContent = isDark ? "☀" : "☾";
    // $("themeLabel").textContent = isDark ? "浅色" : "深色";
    if (persist) {
      try { localStorage.setItem("krc-course-theme-v1", isDark ? "dark" : "light"); } catch (e) {}
    }
  }

  function setupReadingControls() {
    var currentSize = parseInt(
      window.getComputedStyle(document.documentElement)
        .getPropertyValue("--reading-font-size"), 10);
    if (isNaN(currentSize) || currentSize < READING_FONT_MIN || currentSize > READING_FONT_MAX) {
      currentSize = 16;
    }
    applyReadingFontSize(currentSize, false);
    applyReadingTheme(
      document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
      false
    );

    $("fontDecrease").addEventListener("click", function () {
      applyReadingFontSize(currentSize = currentSize - READING_FONT_STEP, true);
    });
    $("fontIncrease").addEventListener("click", function () {
      applyReadingFontSize(currentSize = currentSize + READING_FONT_STEP, true);
    });
    $("themeToggle").addEventListener("click", function () {
      var nextTheme = document.documentElement.getAttribute("data-theme") === "dark"
        ? "light" : "dark";
      applyReadingTheme(nextTheme, true);
    });

    window.addEventListener("scroll", scheduleReadingProgress, { passive: true });
    window.addEventListener("resize", scheduleReadingProgress);
    updateReadingProgress();
  }

  /* ============================ 全屏 ============================ */

  /*
   * 全屏阅读：整页（documentElement）进入全屏，目录与工具条保持可用；
   * 浏览器前缀差异较大（Safari 走 webkit*），因此访问前先探测，缺失即隐藏按钮。
   * 全屏状态可能由 Esc 或浏览器手势改变，故统一以 fullscreenchange 事件回写按钮外观。
   */
  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function setupFullscreenToggle() {
    var btn = $("fullscreenToggle");
    var root = document.documentElement;
    var request = root.requestFullscreen || root.webkitRequestFullscreen;
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    /* 移动端浏览器常不开放非视频元素的全屏，此时不显示该按钮 */
    if (!btn || !request || !exit) {
      if (btn) btn.hidden = true;
      return;
    }

    function sync() {
      var active = !!fullscreenElement();
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      btn.setAttribute("aria-label", active ? "退出全屏" : "进入全屏");
      $("fullscreenIcon").textContent = active ? "⤡" : "⤢";
      // $("fullscreenLabel").textContent = active ? "退出" : "全屏";
    }

    btn.addEventListener("click", function () {
      /* 浏览器可能拒绝请求（如非用户手势触发），失败时静默保持原状态 */
      var action = fullscreenElement() ? exit.call(document) : request.call(root);
      if (action && typeof action.catch === "function") action.catch(function () {});
    });

    ["fullscreenchange", "webkitfullscreenchange"].forEach(function (ev) {
      document.addEventListener(ev, sync);
    });
    sync();
  }

  /* 开合某一章的小节抽屉，并同步章节按钮的 aria-expanded */
  function setChapterOpen(item, open) {
    item.classList.toggle("is-open", open);
    var tab = item.querySelector(".chapter-tab");
    if (tab) tab.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /*
   * 渲染侧栏「章节」瀑布式目录（章 → 小节 → 三级小节）：每章一个条目，内嵌该章的小节抽屉，
   * 抽屉内的三级分组由 renderChips 填充；
   * 当前章节默认展开，其余折叠。点击当前章节就地开合，点击其他章节则切换。
   */
  function renderChapterNav() {
    var nav = $("chapterNav");
    nav.innerHTML = "";
    var activeItem = null;
    window.CHAPTERS.forEach(function (chapter, index) {
      var isActive = chapter === activeLesson;
      var item = el("div", "chapter-item");
      item.setAttribute("data-chapter", String(index + 1));
      /* 编号已由 chapter-tab-no 单独显示：正文章去掉「第 N 章」前缀，
         附录去掉「附录X」前缀，避免与左侧编号重复 */
      var tabTitle = chapter.meta.chapter
        .replace(/^第\s*\d+\s*章\s*/, "")
        .replace(/^附录\s*[A-Z]\s*/, "");
      /* 编号栏：前言 0、正文章 1…8（取自「第 N 章」标题）、附录用 A/B/C（不补零）；
         章节身份直接由标题判定——「附录X」→ 附录、「第 N 章」→ 正文章，其余即前言章 */
      var appxNo = (chapter.meta.chapter.match(/^附录\s*([A-Z])/) || [])[1];
      var mainNo = chapter.meta.chapter.match(/^第\s*(\d+)\s*章/);
      var tabNo = appxNo || (mainNo ? String(parseInt(mainNo[1], 10))
                                    : String(index));
      var subCount = chapter.tutorials.filter(function (t) {
        return t.number.split(".").length === 2;
      }).length;
      var button = el("button", "chapter-tab",
        '<span class="chapter-tab-no">' + esc(tabNo) + "</span>" +
        '<span class="chapter-tab-title">' + esc(tabTitle) + "</span>" +
        /* 一级菜单的子菜单数量：直接挂在本章抽屉下的二级小节数（编号两段）；
           无子节时不输出徽标（保留分支以兼容空章数据） */
        (subCount ? '<span class="chapter-tab-count">' + subCount + "</span>" : ""));
      button.type = "button";
      if (subCount) button.title = "含 " + subCount + " 个小节";
      button.setAttribute("data-chapter", String(index + 1));
      button.setAttribute("aria-current", isActive ? "page" : "false");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "chapterSecs" + (index + 1));
      button.addEventListener("click", function () {
        if (chapter === activeLesson) {
          setChapterOpen(item, !item.classList.contains("is-open"));
          return;
        }
        selectChapter(chapter, true);
      });

      var secs = el("div", "chapter-secs");
      secs.id = "chapterSecs" + (index + 1);
      var chips = el("nav", "chips");
      chips.setAttribute("aria-label", "节目录");
      secs.appendChild(chips);

      item.appendChild(button);
      item.appendChild(secs);
      nav.appendChild(item);
      if (isActive) activeItem = item;
    });
    /* 先以折叠态插入并强制一次布局，再加 is-open，瀑布下落过渡才会真正播放 */
    if (activeItem) {
      void activeItem.offsetHeight;
      setChapterOpen(activeItem, true);
    }
  }

  /*
   * 切换章节：更新标题与文档标题，重渲染目录与正文，
   * 记住当前章节（刷新后回到同一章），并按需滚动回正文顶部。
   */
  function selectChapter(chapter, scrollToTop) {
    activeLesson = chapter;
    var number = window.CHAPTERS.indexOf(chapter) + 1;
    $("chapterName").textContent = chapter.meta.chapter;
    document.title = chapter.meta.chapter + " · C程序设计语言 交互读本";
    renderChapterNav();
    renderChips();
    renderSections();
    setupSpy();
    updateReadingProgress();
    try { localStorage.setItem("krc-course-chapter-v2", String(number)); } catch (e) {}
    if (scrollToTop) {
      $("sections").scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    }
  }

  /* ============================ 滚动高亮 ============================ */

  /*
   * 用 IntersectionObserver 感知正文小节进出视口，回调里按几何选出「当前小节」，
   * 把它的侧栏 chip 标记为 current。判定规则取「顶边已越过视口 25% 横线的最后一个小节」
   * （文档顺序递增，遍历时后者覆盖前者）：既符合「正在阅读哪一节」的直觉，
   * 也能正确处理父节与其三级小节、以及上一长节尾巴仍留在视口的情形，避免高亮错位。
   * 点击 chip 跳转属于明确的用户意图：selectChip 会立即置 current 并锁定高亮，
   * 在用户真实滚动（wheel/触摸/按键）前忽略本回调，防止平滑滚动途中被竞态覆盖。
   */
  function setupSpy() {
    if (!("IntersectionObserver" in window)) return;
    if (setupSpy.observer) setupSpy.observer.disconnect();
    setupSpy.pinned = null;
    var map = {};
    document.querySelectorAll(".chip[data-outline-topic]").forEach(function (c) {
      map[c.getAttribute("data-outline-topic")] = c;
    });
    var topics = Array.prototype.slice.call(
      document.querySelectorAll("[data-outline-topic].outline-topic"));

    /*
     * 把指定小节置为 current，并同步三级抽屉：当前小节所属分组展开
     * （保证高亮条目在侧栏可见），当前小节是叶级二级 chip（不属于任何分组）
     * 时收起全部三级抽屉——选中二级小节时非本级的三级菜单一律关闭。
     */
    function highlight(topic) {
      var chip = map[topic];
      if (!chip || chip.classList.contains("current")) return;
      document.querySelectorAll(".chip").forEach(function (c) { c.classList.remove("current"); });
      chip.classList.add("current");
      var group = chip.closest ? chip.closest(".chip-group") : null;
      if (group) setGroupOpen(group, true);
      else closeGroupsExcept(null);
    }

    /* 选出「顶边已越过 25% 横线的最后一个小节」并高亮 */
    function pickCurrent() {
      if (setupSpy.pinned) return;               /* 点击跳转锁定期间不被动改高亮 */
      var line = window.innerHeight * 0.25;
      var winner = null;
      for (var i = 0; i < topics.length; i++) {
        if (topics[i].getBoundingClientRect().top <= line) winner = topics[i];
      }
      if (winner) highlight(winner.getAttribute("data-outline-topic"));
    }

    /* 用 rAF 合并同一帧内的多次观察回调，避免高频重算 */
    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () { scheduled = false; pickCurrent(); });
    }
    var obs = new IntersectionObserver(schedule, { rootMargin: "-15% 0px -70% 0px" });
    topics.forEach(function (t) { obs.observe(t); });
    setupSpy.observer = obs;

    /* 用户真实滚动输入时解除点击锁定，把高亮交还滚动侦测；
       程序化平滑滚动不触发这些事件，故锁定在跳转全程保持，避免闪烁/错位。 */
    if (!setupSpy._unpinArmed) {
      setupSpy._unpinArmed = true;
      ["wheel", "touchmove", "keydown"].forEach(function (ev) {
        window.addEventListener(ev, function () { setupSpy.pinned = null; }, { passive: true });
      });
    }
  }

  /*
   * 点击 chip：立即把它设为 current（用户意图优先于滚动高亮），并锁定高亮；
   * 锁定直至用户真实滚动，规避平滑滚动途中被滚动侦测的竞态覆盖而错位。
   * 父组的开合由各点击处理器按「切换」语义自行处理，这里不强制展开，
   * 以免父 chip 想收起时又被强行展开；但非本级的三级抽屉一律收起——
   * 选中二级小节时，除它自己所属分组外其余三级抽屉都要关闭
   * （叶级二级 chip 不属于任何分组，故收起全部三级抽屉）。
   * 三级抽屉的被动展开见 highlight()。
   */
  function selectChip(chip, topic) {
    document.querySelectorAll(".chip").forEach(function (c) { c.classList.remove("current"); });
    chip.classList.add("current");
    var group = chip.closest ? chip.closest(".chip-group") : null;
    closeGroupsExcept(group);
    setupSpy.pinned = topic || true;
  }

  /* ============================ 目录收缩 ============================ */

  /*
   * 目录收缩：状态写在 <html> 的 toc-collapsed 类上（CSS 负责布局），
   * 并同步到 localStorage 供下次首屏直接恢复。
   * 开合入口是工具条最左的 #tocToggle（常驻，窄屏下抽屉盖住工具条时另有抽屉内的 #tocClose）；
   * 窄屏下目录是浮层抽屉，点选小节后自动收起。
   */
  function setupTocToggle() {
    var narrow = window.matchMedia("(max-width: 1080px)");

    function apply(collapsed) {
      document.documentElement.classList.toggle("toc-collapsed", collapsed);
      var btn = $("tocToggle");
      if (!btn) return;
      /* 单个按钮兼顾开合，故文案与图标随状态改成下一步动作 */
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.setAttribute("aria-label", collapsed ? "展开目录" : "收起目录");
      btn.setAttribute("title", collapsed ? "展开目录" : "收起目录");
      $("tocToggleIcon").textContent = collapsed ? "»" : "«";
    }

    function persist(collapsed) {
      try { localStorage.setItem("krc-course-toc-collapsed-v1", collapsed ? "1" : "0"); } catch (e) {}
    }

    function setCollapsed(collapsed) {
      apply(collapsed);
      persist(collapsed);
    }

    // 与 <head> 内联脚本写入的初始状态对齐 (仅同步 aria, 不落盘)
    apply(document.documentElement.classList.contains("toc-collapsed"));

    var toggleBtn = $("tocToggle");
    if (toggleBtn) toggleBtn.addEventListener("click", function () {
      setCollapsed(!document.documentElement.classList.contains("toc-collapsed"));
    });
    var closeBtn = $("tocClose");
    if (closeBtn) closeBtn.addEventListener("click", function () { setCollapsed(true); });

    // 窄屏下目录是浮层抽屉: 选中叶级小节后自动收起;
    // 点章条目只展开其小节、点带子节的父节只开合三级抽屉, 两者都保持抽屉打开
    var toc = $("toc");
    if (toc) toc.addEventListener("click", function (e) {
      if (!narrow.matches) return;
      var hit = e.target.closest ? e.target.closest(".chip") : null;
      if (hit && !hit.classList.contains("has-subs")) setCollapsed(true);
    });
  }

  /* ============================ 初始化 ============================ */

  /* 初始化：目录、工作台、章节数据渲染，最后拉起编译器列表 */
  function init() {
    var L = window.CHAPTER1;

    setupTocToggle();

    // 编辑器元素
    codeEl   = $("code");
    hlEl     = $("hl");
    gutterEl = $("gutter");
    stdinEl  = $("stdin");
    setupWorkbench();

    renderChapterNav();
    /* 恢复到上次阅读的章节；存档越界（课程数据变动）时退回首章（前言与序）。
       章节结构从 11 章扩为 12 章后旧存档索引整体错位，故键名升到 v2 作废旧档 */
    var savedChapter = null;
    try { savedChapter = parseInt(localStorage.getItem("krc-course-chapter-v2"), 10); } catch (e) {}
    if (savedChapter > 0 && savedChapter <= window.CHAPTERS.length) {
      L = window.CHAPTERS[savedChapter - 1];
    }
    selectChapter(L, false);
    setupReadingControls();
    setupFullscreenToggle();

    // 编辑器事件
    codeEl.addEventListener("input", renderEditor);
    codeEl.addEventListener("scroll", syncScroll);
    codeEl.addEventListener("keydown", function (e) {
      handleTab(e);
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
    });

    // 按钮
    $("runBtn").addEventListener("click", run);
    $("resetBtn").addEventListener("click", function () {
      if (state.loadedCode != null) {
        setCode(state.loadedCode, stdinEl.value);
        setMeta("已重置为载入时的代码", "");
      }
    });
    $("compilerSel").addEventListener("change", refreshStdSel);

    // 初始载入一段最小可运行的 hello, world，便于直接上手；
    // 工作台默认隐藏（index.html 静态声明），setCode 会自动弹出，故载入后再收起
    setCode(STARTER_CODE, "");
    hideWorkbench();
    setMeta("就绪 · 已载入起始代码", "");

    // 编译器列表
    loadCompilers();
  }

  /* 课程 JSON 加载失败时的兜底提示（放在正文位置并声明为 alert） */
  function showCourseLoadError() {
    var sections = $("sections");
    if (!sections) return;
    sections.setAttribute("role", "alert");
    sections.textContent = "课程内容无法加载，请确认课程 JSON 文件与页面位于同一目录后刷新。";
  }

  /* 课程数据可能先于或晚于本脚本就绪，两种时序都要能进入 init() */
  function startWhenReady() {
    if (window.CHAPTERS) {
      init();
      return;
    }
    if (window.COURSE_CONTENT_ERROR) {
      showCourseLoadError();
      return;
    }
    window.addEventListener("course-content-ready", init, { once: true });
    window.addEventListener("course-content-error", showCourseLoadError, { once: true });
  }

  /* 脚本位于 </body> 前，通常 DOM 已解析完；若仍在加载则等 DOMContentLoaded */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startWhenReady, { once: true });
  } else {
    startWhenReady();
  }

})();
