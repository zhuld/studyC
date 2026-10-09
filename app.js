/*
 * app.js — 课程页面主逻辑（IIFE，无构建步骤，浏览器直接执行）
 *
 * 职责：
 *   1. 渲染教程：按 lessons.js 提供的课程数据生成章节目录、PDF 小节正文、示例/练习卡片
 *   2. 教材正文代码块：借 code-blocks.js 的判定规则，给可编译的完整程序加「载入 / 运行」入口
 *   3. 代码工作台：可拖动、缩放、关闭的浮层编辑器（行号 + C 语法高亮 + Tab 缩进）
 *   4. 在线编译：调用 Wandbox 的 list.json（编译器列表）与 compile.json（编译并执行），
 *      默认以 C89（ANSI C，即教材描述的标准）提交
 *   5. 自动判题：程序输出与课程数据中的标准答案归一化后逐字比对，通过即盖章
 *   6. 本地存档：主题、目录收缩状态、当前章节、判题进度分别写入 localStorage
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
  /* 判题进度存档键；主题、目录收缩、当前章节各有独立键
     （见 index.html 首屏脚本与 setupTocToggle） */
  var STORE_KEY      = "krc-ch1-progress-v1";

  /* ============================== 工具 ============================== */

  /* document.getElementById 的简写 */
  var $ = function (id) { return document.getElementById(id); };

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

  /* 判题归一化：CRLF→LF、去每行行尾空白、去首尾空行 */
  function normalize(s) {
    return String(s == null ? "" : s)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(function (l) { return l.replace(/[ \t]+$/, ""); })
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
  }

  /* ============================== 进度 ============================== */

  /* 已通过项：sections / exercises 以专题或习题编号为键，值为通过时间戳 */
  var progress = { sections: {}, exercises: {} };
  /* 当前显示的章节对象（不是编号），切换章节时整体替换 */
  var activeLesson = window.CHAPTER1;

  /* 读取存档；数据损坏或 localStorage 不可用时保持空进度，不阻断渲染 */
  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === "object") {
          progress.sections  = p.sections  || {};
          progress.exercises = p.exercises || {};
        }
      }
    } catch (e) { /* 隐私模式等场景忽略 */ }
  }

  /* 写入存档；存储不可用（隐私模式、配额已满）时静默忽略 */
  function saveProgress() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch (e) {}
  }

  /* ============================== 状态 ============================== */

  var state = {
    compilers: [],          // 可选编译器 [{name, version, stdOpts:[{value,label}]}]
    currentJudge: null,     // 当前载入的判题上下文 {kind, id, key, expected, short}；为 null 表示不判题
    loadedCode: "",         // 最近一次「载入」的原始代码，供「重置」还原
    running: false          // 编译进行中标记，避免重复提交请求
  };

  window.__krc = state; // 暴露给控制台便于调试

  /* ========================= 语法高亮（C） ========================= */

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

  /*
   * 把 C 源码转换为带 tok-* 类的高亮 HTML（每段先 esc 再包 span，避免二次解析）。
   * 单趟正则按「注释 → 字符串/字符 → 预处理行 → 数字 → 标识符」的优先级交替匹配，
   * 因此注释与字面量内部的词不会被后面的分组重复着色。
   * 返回值末尾补一个换行，使高亮层行数与 textarea 一致，避免末行错位。
   */
  function highlight(code) {
    var re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?)|(#\s*\w+)|(\b\d+\.?\d*[uUlLfF]*\b)|([A-Za-z_]\w*)/g;
    var out = "", last = 0, m;
    while ((m = re.exec(code)) !== null) {
      out += esc(code.slice(last, m.index));
      if (m[1] != null)      out += '<span class="tok-cm">'  + esc(m[1]) + "</span>";
      else if (m[2] != null) out += '<span class="tok-str">' + esc(m[2]) + "</span>";
      else if (m[3] != null) out += '<span class="tok-pp">'  + esc(m[3]) + "</span>";
      else if (m[4] != null) out += '<span class="tok-num">' + esc(m[4]) + "</span>";
      else {
        var w = m[5];
        if (KW_SET[w])       out += '<span class="tok-kw">'  + esc(w) + "</span>";
        else if (TY_SET[w])  out += '<span class="tok-ty">'  + esc(w) + "</span>";
        /* 后跟左括号的标识符按函数名着色（纯启发式，无符号表） */
        else if (code[re.lastIndex] === "(") out += '<span class="tok-fn">' + esc(w) + "</span>";
        else out += esc(w);
      }
      last = re.lastIndex;
    }
    out += esc(code.slice(last));
    return out + "\n";
  }

  /* ============================== 编辑器 ============================== */

  /* 编辑器与工作台中会反复访问的元素，在 init() 里一次性绑定 */
  var codeEl, hlEl, gutterEl, stdinEl;
  var workbench, workbenchDrag, workbenchResize;

  /* 重绘高亮层与行号列；输入、Tab 缩进、载入代码后调用 */
  function renderEditor() {
    var code = codeEl.value;
    hlEl.innerHTML = highlight(code);
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
   * src      要载入的源码
   * stdin    随之填入的标准输入（可为空）
   * judgeCtx 判题上下文；载入示例/正文代码时传 null，表示运行后不判题
   * 副作用：若工作台被关闭则先打开，并清空上一次的判题结果。
   */
  function setCode(src, stdin, judgeCtx) {
    state.loadedCode = src;
    state.currentJudge = judgeCtx || null;
    if ($("workbench").hidden) {
      $("workbench").hidden = false;
      $("workbenchLauncher").hidden = true;
    }
    codeEl.value = src;
    stdinEl.value = stdin || "";
    renderEditor();
    codeEl.focus();
    codeEl.setSelectionRange(0, 0);
    clearJudge();
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

  /* 工作台交互：关闭/重开、拖动标题栏、右下角缩放，均支持键盘操作 */
  function setupWorkbench() {
    workbench = $("workbench");
    workbenchDrag = $("workbenchDrag");
    workbenchResize = $("workbenchResize");

    /* 关闭后焦点移回「打开代码工作台」按钮，保持键盘可达 */
    $("workbenchClose").addEventListener("click", function () {
      workbench.hidden = true;
      $("workbenchLauncher").hidden = false;
      $("workbenchLauncher").focus();
    });
    $("workbenchLauncher").addEventListener("click", function () {
      workbench.hidden = false;
      $("workbenchLauncher").hidden = true;
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

  /* 清空判题结果区（切换章节、重新运行、载入代码时都会调用） */
  function clearJudge() {
    var j = $("judge");
    j.hidden = true;
    j.className = "judge";
    j.innerHTML = "";
  }

  /* 显示判题结果；ok 决定套用 pass 还是 fail 样式 */
  function showJudge(ok, html) {
    var j = $("judge");
    j.hidden = false;
    j.className = "judge " + (ok ? "pass" : "fail");
    j.innerHTML = html;
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
   * 网络失败时退化为仅含兜底编译器的占位配置，保证页面仍可运行与判题。
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
     默认选中 C89：教材基于 ANSI C，示例与练习都以该标准为准 */
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

  /* ============================ 运行 / 判题 ============================ */

  /* 把编辑器内容提交给 Wandbox 编译执行；请求期间禁用按钮，避免并发提交 */
  function run() {
    if (state.running) return;
    state.running = true;
    var btn = $("runBtn");
    btn.disabled = true;
    btn.classList.add("busy");
    clearJudge();
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
        btn.classList.remove("busy");
      });
  }

  /* 收尾：渲染编译器消息与程序输出，更新状态文字，并触发判题 */
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
    var ranOk = !compileFailed && !res.signal;
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
      judge(false, "");
      return;
    }
    if (res.signal) {
      setMeta("运行异常 · signal " + res.signal, "bad");
      judge(false, "");
      return;
    }
    setMeta("运行成功 · exit " + res.status, "ok");
    judge(true, res.program_message || "");
  }

  /*
   * 用当前判题上下文比对输出：与标准答案归一化后逐字比较，一致即通过。
   * ranOk 为 false（编译失败或被信号终止）时只提示中止，不判对错；
   * 没有判题上下文（载入的是示例或正文代码）时直接返回。
   */
  function judge(ranOk, output) {
    var ctx = state.currentJudge;
    if (!ctx) return;
    var card = document.querySelector('[data-judge-card="' + ctx.key + '"]');
    var statusEl = card ? card.querySelector(".ex-status") : null;

    if (!ranOk) {
      showJudge(false, "<b>判题中止</b>：程序没有成功编译/运行，请先修好编译错误。");
      if (statusEl) {
        statusEl.className = "ex-status fail";
        statusEl.textContent = "✖ 编译未通过，改好再试。";
      }
      return;
    }

    var actual = normalize(output);
    var expect = normalize(ctx.expected);
    var pass = actual === expect;

    if (pass) {
      showJudge(true, "<b>✓ 判题通过</b>　输出与标准答案一致，盖章！");
      markDone(ctx);
      if (statusEl) {
        statusEl.className = "ex-status pass";
        statusEl.textContent = "✓ 已通过";
      }
      bigStamp(ctx.short || "完成");
    } else {
      showJudge(false,
        "<b>✗ 输出不一致</b>　对照（标准答案 / 你的输出）：" +
        '<span class="diff">' + esc(expect || "（空）") +
        "\n────────────\n" + (actual || "（空）") + "</span>");
      if (statusEl) {
        statusEl.className = "ex-status fail";
        statusEl.textContent = "✖ 输出与答案不一致，看工作台对照区。";
      }
    }
  }

  /* ============================ 盖章动画 ============================ */

  /* 判题通过时在整页浮层盖一枚大印章，动画结束后自行移除节点 */
  function bigStamp(text) {
    var layer = $("stampLayer");
    var s = el("div", "big-stamp", esc(text));
    layer.appendChild(s);
    // 触发退场
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { s.classList.add("out"); });
    });
    setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 1500);
  }

  /* ============================ 进度标记 ============================ */

  /* 记录一项通过（写入时间戳并落盘）；已通过的项目不重复写 */
  function markDone(ctx) {
    var bucket = ctx.kind === "section" ? progress.sections : progress.exercises;
    if (!bucket[ctx.id]) {
      bucket[ctx.id] = Date.now();
      saveProgress();
      refreshProgressUI();
    }
  }

  /* 依据 progress 给目录项与卡片打上 done/pass 标记；
     覆盖三类元素：侧栏 chip、正文小节、示例/习题卡片，以及章末习题 */
  function refreshProgressUI() {
    document.querySelectorAll(".chip[data-practice-sec]").forEach(function (c) {
      c.classList.toggle("done", !!progress.sections[c.getAttribute("data-practice-sec")]);
    });
    document.querySelectorAll(".outline-topic[data-practice-section], .supplement-topic[data-sec]").forEach(function (s) {
      var sectionId = s.getAttribute("data-practice-section") || s.getAttribute("data-sec");
      s.classList.toggle("done", !!progress.sections[sectionId]);
    });
    document.querySelectorAll('.card.ex[data-judge-card^="section:"]').forEach(function (card) {
      var key = card.getAttribute("data-judge-card").slice("section:".length);
      var done = !!progress.sections[key];
      card.classList.toggle("done", done);
      var status = card.querySelector(".ex-status");
      if (done && status && !status.classList.contains("pass")) {
        status.className = "ex-status pass";
        status.textContent = "✓ 已通过";
      }
    });
    document.querySelectorAll(".ex[data-ex]").forEach(function (s) {
      var done = !!progress.exercises[s.getAttribute("data-ex")];
      s.classList.toggle("done", done);
      var st = s.querySelector(".ex-status");
      if (done && st && !st.classList.contains("pass")) {
        st.className = "ex-status pass";
        st.textContent = "✓ 已通过";
      }
    });
  }

  /* ============================ 渲染教程 ============================ */

  /*
   * 渲染侧栏「小节」列表：PDF 目录小节 → 目录外的补充专题 → 章末习题入口。
   * 瀑布式目录把小节嵌在所属章节条目内，故这里只填当前章节的抽屉；
   * 每个 chip 都带 data-outline-topic（供滚动高亮定位），
   * 带练习的还会带 data-practice-sec（供进度标记）。
   */
  function renderChips() {
    var index = window.CHAPTERS.indexOf(activeLesson);
    var item = document.querySelector('.chapter-item[data-chapter="' + (index + 1) + '"]');
    var nav = item ? item.querySelector(".chips") : null;
    if (!nav) return;
    nav.innerHTML = "";
    /* 附录没有原书页码（page 为 null），提示与无障碍文案相应改写 */
    var isAppendix = activeLesson.meta.kind === "appendix";
    nav.setAttribute("aria-label",
      (isAppendix ? "附录小节，共 " : "PDF目录小节，共 ") +
      activeLesson.tutorials.length + " 项");
    activeLesson.tutorials.forEach(function (topic) {
      /* 正文小节的 id 由编号派生（1.5.1 → pdf-topic-1-5-1），点击时按 id 滚动 */
      var targetId = "pdf-topic-" + topic.number.replace(/\./g, "-");
      var c = el("button", "chip", esc(topic.number + " " + topic.title));
      c.type = "button";
      c.setAttribute("data-outline-topic", topic.number);
      if (topic.practiceSectionId) {
        c.setAttribute("data-practice-sec", topic.practiceSectionId);
      }
      c.title = topic.page
        ? "PDF 第 " + topic.page + " 页"
        : (isAppendix ? "附录小节" : "");
      c.addEventListener("click", function () {
        var target = document.getElementById(targetId);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      nav.appendChild(c);
    });
    activeLesson.extraSections.forEach(function (section) {
      var targetId = "extra-sec-" + section.id.replace(/\./g, "-");
      var topicId = "extra:" + section.id;
      var c = el("button", "chip", esc("补充 " + section.id + " " + section.title));
      c.type = "button";
      c.setAttribute("data-outline-topic", topicId);
      c.setAttribute("data-practice-sec", section.id);
      c.title = "课程补充专题（不在 PDF 目录中）";
      c.addEventListener("click", function () {
        var target = document.getElementById(targetId);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      nav.appendChild(c);
    });
    if (activeLesson.bookExercises.length) {
      var c2 = el("button", "chip", "章末习题");
      c2.type = "button";
      c2.addEventListener("click", function () {
        var t = $("exercisesHead");
        if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      nav.appendChild(c2);
    }
  }

  /* 示例卡片的标题栏：左侧书名/小节标签，右侧固定的 sample 角标 */
  function sampleCardHTML(label) {
    return '<div class="card-tag"><span>' + esc(label) + "</span><span>sample</span></div>";
  }

  /*
   * 教材正文里「带 main 的完整程序」：在其后追加在线编译入口。
   * 判定规则来自 code-blocks.js（与 tools/test_code_blocks.js 共用），
   * 示例卡自带按钮，故跳过 .card 内的代码块。
   */
  function decorateRunnableCode(article) {
    var detect = window.KRC_CODE_BLOCKS;
    if (!detect) return;
    Array.prototype.forEach.call(article.querySelectorAll("pre.card-code"), function (pre) {
      if (pre.closest(".card")) return;
      var code = pre.textContent;          // textContent 已还原 &lt; 等实体
      if (!detect.isRunnableProgram(code)) return;

      /* 正文代码没有 stdin 数据，因此以「不判题」的方式载入 */
      var bar = el("div", "card-actions code-actions");
      var loadBtn = el("button", "btn", "载入编辑器");
      var runBtn = el("button", "btn primary", "▶ 运行");
      loadBtn.type = "button";
      runBtn.type = "button";
      loadBtn.title = "把这段教材代码放进工作台, 可在其中补齐上下文";
      runBtn.title = "载入工作台并在线编译运行";
      loadBtn.addEventListener("click", function () { setCode(code, "", null); });
      runBtn.addEventListener("click", function () { setCode(code, "", null); run(); });
      bar.appendChild(loadBtn);
      bar.appendChild(runBtn);
      /* 需要 stdin 的程序提前提醒，避免运行时读到空输入而误以为程序有错 */
      if (/\b(?:getchar|scanf|fgets|gets|read)[ \t]*\(/.test(code)) {
        bar.appendChild(el("span", "code-actions-note", "程序会读取 stdin, 请在工作台填写输入"));
      }
      pre.insertAdjacentElement("afterend", bar);
    });
  }

  /*
   * 渲染正文区：按 PDF 目录顺序输出各小节，再输出目录之外的补充专题。
   * 小节标题的层级由编号段数决定（1.5 → h2，1.5.1 → h3）。
   */
  function renderSections() {
    var wrap = $("sections");
    wrap.innerHTML = "";
    /* 专题编号 → 专题对象，用于按 tutorial.practiceSectionId 找到配套示例/练习 */
    var practiceSections = {};
    activeLesson.sections.forEach(function (section) {
      practiceSections[section.id] = section;
    });

    /* 把某专题的示例卡片与练习卡片追加到指定容器（正文小节或补充专题） */
    function appendPractice(section, container) {
      var sample = el("div", "card");
      sample.innerHTML = sampleCardHTML(section.sample.label) +
        '<pre class="card-code">' + esc(section.sample.code) + "</pre>" +
        '<div class="card-actions">' +
        '<button type="button" class="btn" data-act="load-sample">载入编辑器</button>' +
        '<button type="button" class="btn primary" data-act="run-sample">▶ 运行示例</button>' +
        "</div>";
      sample.querySelector('[data-act="load-sample"]').addEventListener("click", function () {
        setCode(section.sample.code, section.sample.stdin, null);
      });
      sample.querySelector('[data-act="run-sample"]').addEventListener("click", function () {
        setCode(section.sample.code, section.sample.stdin, null);
        run();
      });
      container.appendChild(sample);

      var ex = el("div", "card ex");
      ex.setAttribute("data-judge-card", "section:" + section.id);
      ex.innerHTML = '<div class="card-tag"><span>练习 ' + esc(section.id) +
        "</span><span>exercise</span></div>" +
        '<p class="ex-prompt">' + section.exercise.prompt + "</p>" +
        '<div class="card-actions">' +
        '<button type="button" class="btn" data-act="load-ex">载入题目</button>' +
        '<button type="button" class="btn primary" data-act="judge">▶ 运行判题</button>' +
        '<button type="button" class="btn ghost" data-act="hint">提示</button>' +
        "</div>" +
        '<div class="ex-status"></div>';
      var hintBox = null;
      /* 提示默认折叠，首次点击才插入 DOM */
      ex.querySelector('[data-act="load-ex"]').addEventListener("click", function () {
        setCode(section.exercise.starter, section.exercise.stdin, {
          kind: "section", id: section.id, key: "section:" + section.id,
          expected: section.exercise.expected, short: section.id
        });
      });
      ex.querySelector('[data-act="judge"]').addEventListener("click", function () {
        /* 直接判题时若工作台里不是这道题（例如刚看过示例），先载入题目的起始代码 */
        if (!state.currentJudge || state.currentJudge.key !== "section:" + section.id) {
          setCode(section.exercise.starter, section.exercise.stdin, {
            kind: "section", id: section.id, key: "section:" + section.id,
            expected: section.exercise.expected, short: section.id
          });
        }
        run();
      });
      ex.querySelector('[data-act="hint"]').addEventListener("click", function () {
        if (!hintBox) {
          hintBox = el("div", "ex-status pass ex-hint", "💡 " + esc(section.exercise.hint));
          ex.appendChild(hintBox);
        } else {
          hintBox.style.display = hintBox.style.display === "none" ? "block" : "none";
        }
      });
      container.appendChild(ex);
    }

    activeLesson.tutorials.forEach(function (topic) {
      /* 编号有三段（如 1.5.1）的是子小节，改用 h3 并施加缩进样式 */
      var isSubsection = topic.number.split(".").length > 2;
      var article = el("article", "outline-topic" + (isSubsection ? " pdf-subsection" : ""));
      article.id = "pdf-topic-" + topic.number.replace(/\./g, "-");
      article.setAttribute("data-outline-topic", topic.number);
      var heading = isSubsection ? "h3" : "h2";
      /* 标题带上小节号（元信息栏移除后，编号只能由此体现） */
      var content = "<" + heading + ">" + esc(topic.number) + "　" + esc(topic.title) + "</" + heading + ">";
      topic.paragraphs.forEach(function (paragraph) {
        // paragraphs 由 tools/md_to_course.py 生成: 本身即块级 HTML (<p>/<pre>/<img>)
        content += paragraph + "\n";
      });
      (topic.theory || []).forEach(function (paragraph) {
        content += '<div class="practice-theory">' + paragraph + "</div>";
      });
      article.innerHTML = content;
      decorateRunnableCode(article);
      if (topic.practiceSectionId) {
        var practice = practiceSections[topic.practiceSectionId];
        article.setAttribute("data-practice-section", practice.id);
        appendPractice(practice, article);
      }
      wrap.appendChild(article);
    });

    if (activeLesson.extraSections.length) {
      var extraHeading = el("h2", "chapter-supplement-title", "课程补充专题（PDF 目录之外）");
      wrap.appendChild(extraHeading);
      activeLesson.extraSections.forEach(function (section) {
        var article = el("article", "sec supplement-topic");
        article.id = "extra-sec-" + section.id.replace(/\./g, "-");
        article.setAttribute("data-sec", section.id);
        article.setAttribute("data-outline-topic", "extra:" + section.id);
        var content = '<p class="sec-no">补充 ' + esc(section.id) +
          " · 课程专题</p><h2>" + esc(section.title) + "</h2>";
        section.theory.forEach(function (paragraph) { content += paragraph; });
        article.innerHTML = content;
        decorateRunnableCode(article);
        appendPractice(section, article);
        wrap.appendChild(article);
      });
    }
  }

  /* 渲染章末习题区；本章没有习题时隐藏整块标题 */
  function renderBookExercises() {
    var wrap = $("exercises");
    wrap.innerHTML = "";
    $("exercisesHead").hidden = !activeLesson.bookExercises.length;
    activeLesson.bookExercises.forEach(function (x) {
      var card = el("article", "ex");
      card.id = "ex-" + x.id.replace("-", "-");
      card.setAttribute("data-ex", x.id);
      card.setAttribute("data-judge-card", "exercise:" + x.id);

      card.innerHTML =
        '<div class="ex-top"><span class="ex-id">' + esc(x.id) + "</span><h3>" +
        esc(x.title) + "</h3></div>" +
        '<p class="ex-prompt">' + x.prompt + "</p>" +
        '<div class="card-actions">' +
        '<button type="button" class="btn" data-act="load-ex">载入题目</button>' +
        '<button type="button" class="btn primary" data-act="judge">▶ 运行判题</button>' +
        '<button type="button" class="btn ghost" data-act="hint">提示</button>' +
        "</div>" +
        '<div class="ex-status"></div>';

      /* 每次点击都新建上下文，避免与专题练习的判题状态互相污染 */
      function ctx() {
        return {
          kind: "exercise", id: x.id, key: "exercise:" + x.id,
          expected: x.expected, short: x.id
        };
      }
      card.querySelector('[data-act="load-ex"]').addEventListener("click", function () {
        setCode(x.starter, x.stdin, ctx());
      });
      card.querySelector('[data-act="judge"]').addEventListener("click", function () {
        if (!state.currentJudge || state.currentJudge.key !== "exercise:" + x.id) {
          setCode(x.starter, x.stdin, ctx());
        }
        run();
      });
      var hintBox = null;
      card.querySelector('[data-act="hint"]').addEventListener("click", function () {
        if (!hintBox) {
          hintBox = el("div", "ex-status pass ex-hint", "💡 " + esc(x.hint));
          card.appendChild(hintBox);
        } else {
          hintBox.style.display = hintBox.style.display === "none" ? "block" : "none";
        }
      });

      wrap.appendChild(card);
    });
  }

  /* 开合某一章的小节抽屉，并同步章节按钮的 aria-expanded */
  function setChapterOpen(item, open) {
    item.classList.toggle("is-open", open);
    var tab = item.querySelector(".chapter-tab");
    if (tab) tab.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /*
   * 渲染侧栏「章节」瀑布式目录：每章一个条目，内嵌该章的小节抽屉；
   * 当前章节默认展开，其余折叠。点击当前章节就地开合，点击其他章节则切换。
   */
  function renderChapterNav() {
    var nav = $("chapterNav");
    nav.innerHTML = "";
    var activeItem = null;
    window.CHAPTERS.forEach(function (chapter, index) {
      var isActive = chapter === activeLesson;
      var isAppendix = chapter.meta.kind === "appendix";
      var item = el("div", "chapter-item");
      item.setAttribute("data-chapter", String(index + 1));
      /* 编号已由 chapter-tab-no 单独显示：正文章去掉「第 N 章」前缀，
         附录去掉「附录X」前缀，避免与左侧编号重复 */
      var tabTitle = chapter.meta.chapter
        .replace(/^第\s*\d+\s*章\s*/, "")
        .replace(/^附录\s*[A-Z]\s*/, "");
      /* 编号栏：正文章 01…08，附录用 A/B/C */
      var tabNo = isAppendix
        ? ((chapter.meta.chapter.match(/^附录\s*([A-Z])/) || [])[1] || "")
        : String(index + 1).padStart(2, "0");
      var button = el("button", "chapter-tab",
        '<span class="chapter-tab-no">' + esc(tabNo) + "</span>" +
        '<span class="chapter-tab-title">' + esc(tabTitle) + "</span>" +
        '<span class="chapter-tab-caret" aria-hidden="true">⌄</span>');
      button.type = "button";
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
   * 切换章节：更新标题与文档标题，重渲染目录/正文/习题与进度标记，
   * 记住当前章节（刷新后回到同一章），并按需滚动回正文顶部。
   */
  function selectChapter(chapter, scrollToTop) {
    activeLesson = chapter;
    var number = window.CHAPTERS.indexOf(chapter) + 1;
    $("chapterName").textContent = chapter.meta.chapter;
    document.title = chapter.meta.chapter + " · C程序设计语言 交互读本";
    state.currentJudge = null;
    clearJudge();
    renderChapterNav();
    renderChips();
    renderSections();
    renderBookExercises();
    refreshProgressUI();
    setupSpy();
    try { localStorage.setItem("krc-course-chapter-v1", String(number)); } catch (e) {}
    if (scrollToTop) $("sections").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ============================ 滚动高亮 ============================ */

  /*
   * 用 IntersectionObserver 把正文小节的可见性映射到侧栏 chip 的 current 类。
   * rootMargin 把判定区域收缩成页面顶部的一条横带（上方 15%、下方 70% 不参与），
   * 于是「刚滚到顶部」的小节才会高亮；切换章节时先断开上一批观察。
   */
  function setupSpy() {
    if (!("IntersectionObserver" in window)) return;
    if (setupSpy.observer) setupSpy.observer.disconnect();
    var map = {};
    document.querySelectorAll(".chip[data-outline-topic]").forEach(function (c) {
      map[c.getAttribute("data-outline-topic")] = c;
    });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var topic = en.target.getAttribute("data-outline-topic");
        document.querySelectorAll(".chip").forEach(function (c) { c.classList.remove("current"); });
        if (map[topic]) map[topic].classList.add("current");
      });
    }, { rootMargin: "-15% 0px -70% 0px" });
    setupSpy.observer = obs;
    document.querySelectorAll("[data-outline-topic].outline-topic, [data-outline-topic].supplement-topic").forEach(function (topic) {
      obs.observe(topic);
    });
  }

  /* ============================ 目录收缩 ============================ */

  /*
   * 目录收缩：状态写在 <html> 的 toc-collapsed 类上（CSS 负责布局），
   * 并同步到 localStorage 供下次首屏直接恢复。
   * 窄屏下目录是浮层抽屉，点选小节后自动收起。
   */
  function setupTocToggle() {
    var narrow = window.matchMedia("(max-width: 1080px)");

    function apply(collapsed) {
      document.documentElement.classList.toggle("toc-collapsed", collapsed);
      var btn = $("tocCollapse");
      if (btn) btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }

    function persist(collapsed) {
      try { localStorage.setItem("krc-course-toc-collapsed-v1", collapsed ? "1" : "0"); } catch (e) {}
    }

    // 与 <head> 内联脚本写入的初始状态对齐 (仅同步 aria, 不落盘)
    apply(document.documentElement.classList.contains("toc-collapsed"));

    var collapseBtn = $("tocCollapse");
    var expandBtn = $("tocExpand");
    if (collapseBtn) collapseBtn.addEventListener("click", function () {
      apply(true); persist(true);
    });
    if (expandBtn) expandBtn.addEventListener("click", function () {
      apply(false); persist(false);
    });

    // 窄屏下目录是浮层抽屉: 选中某个小节后自动收起 (点章节只展开其小节, 抽屉保持打开)
    var toc = $("toc");
    if (toc) toc.addEventListener("click", function (e) {
      if (!narrow.matches) return;
      var hit = e.target.closest ? e.target.closest(".chip") : null;
      if (hit) { apply(true); persist(true); }
    });
  }

  /* ============================ 初始化 ============================ */

  /* 初始化：主题、目录、工作台、章节数据渲染，最后拉起编译器列表 */
  function init() {
    var L = window.CHAPTER1;

    /* 主题以 <head> 内联脚本写入的 data-theme 为准（避免首屏跳变） */
    var theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    var themeButton = $("themeToggle");
    var themeLabel = $("themeLabel");
    function updateThemeButton() {
      var isDark = theme === "dark";
      themeButton.setAttribute("aria-pressed", isDark ? "true" : "false");
      themeButton.setAttribute("aria-label", "切换到" + (isDark ? "亮色" : "暗色") + "主题");
      themeButton.querySelector(".theme-toggle-icon").textContent = isDark ? "☼" : "☾";
      themeLabel.textContent = isDark ? "亮色" : "暗色";
    }
    updateThemeButton();
    themeButton.addEventListener("click", function () {
      theme = theme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", theme);
      updateThemeButton();
      try { localStorage.setItem("krc-ch1-theme-v1", theme); } catch (e) {}
    });

    setupTocToggle();

    // 编辑器元素
    codeEl   = $("code");
    hlEl     = $("hl");
    gutterEl = $("gutter");
    stdinEl  = $("stdin");
    setupWorkbench();

    loadProgress();
    renderChapterNav();
    /* 恢复到上次阅读的章节；存档越界（课程数据变动）时退回第 1 章 */
    var savedChapter = null;
    try { savedChapter = parseInt(localStorage.getItem("krc-course-chapter-v1"), 10); } catch (e) {}
    if (savedChapter > 0 && savedChapter <= window.CHAPTERS.length) {
      L = window.CHAPTERS[savedChapter - 1];
    }
    selectChapter(L, false);

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
        var j = state.currentJudge;
        setCode(state.loadedCode, stdinEl.value, j);
        setMeta("已重置为载入时的代码", "");
      }
    });
    $("compilerSel").addEventListener("change", refreshStdSel);

    // 载入第一节示例（恢复到的章节可能是只读附录，没有专题，故固定取第 1 章）
    var first = window.CHAPTER1.sections[0];
    setCode(first.sample.code, first.sample.stdin, null);
    setMeta("就绪 · 载入了 1.1 示例", "");

    // 编译器列表
    loadCompilers();

    // 快捷入口：?autorun=sample 自动运行 1.1 示例，?autorun=judge 自动载入并运行 1.1 练习
    var q = new URLSearchParams(location.search).get("autorun");
    if (q === "sample" || q === "judge") {
      setTimeout(function () {
        selectChapter(window.CHAPTER1, false);
        if (q === "judge") {
          var s1 = window.CHAPTER1.sections[0];
          setCode(s1.exercise.starter, s1.exercise.stdin, {
            kind: "section", id: s1.id, key: "section:" + s1.id,
            expected: s1.exercise.expected, short: s1.id
          });
        }
        run();
      }, 800);
    }
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
