/*
 * test_toc_counts.js — 校验侧栏目录的「子菜单数量」徽标
 *
 *   · 一级徽标 .chapter-tab-count：章按钮右侧的数字 = 直接挂在本章抽屉下的二级小节数
 *   · 二级徽标 .chip-count：带子节的父 chip 右侧的数字 = 其三级抽屉里实际挂载的小节数
 *     （同源于 renderChips 的挂载规则，二者必须一致，否则数字会骗人）
 *   · 计数为 0 时不输出徽标：无三级子节的叶 chip、没有二级小节的空章
 *   · 徽标靠右排列由 style.css 的 auto margin 负责
 *
 * 被测函数从 app.js 源码按名字截取本体，连同 activeLesson 注入最小假 DOM 上执行，
 * 保证测试覆盖的是页面真实实现而非复制品。
 * 运行: node tools/test_toc_counts.js   （在仓库根目录执行）
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

/* 按 `function <name>(` 截取到花括号配平处（这些函数体内的字符串与注释不含花括号） */
function extractFn(source, name) {
  const sig = source.indexOf("function " + name + "(");
  assert.ok(sig >= 0, "app.js 中未找到 " + name);
  let depth = 0;
  for (let j = source.indexOf("{", sig); j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}" && --depth === 0) return source.slice(sig, j + 1);
  }
  throw new Error(name + " 花括号不配平");
}

/* ---- 最小假 DOM：只支持被测代码用到的 标签.类[属性="值"] 三类选择器 ---- */

function parseSel(sel) {
  const m = /^([a-z]*)(?:\.([\w-]+))?(?:\[([\w-]+)="([^"]*)"\])?$/.exec(sel.trim());
  assert.ok(m, "测试用选择器暂不支持: " + sel);
  return { tag: m[1], cls: m[2] || null, attr: m[3] || null, value: m[4] };
}
function matches(node, p) {
  if (p.tag && node.tag !== p.tag) return false;
  if (p.cls && !node.classList.contains(p.cls)) return false;
  if (p.attr && node.getAttribute(p.attr) !== p.value) return false;
  return true;
}
function walk(node, fn) {
  node.children.forEach(function (child) { fn(child); walk(child, fn); });
}
function queryAll(root, sel) {
  const p = parseSel(sel);
  const out = [];
  walk(root, function (n) { if (matches(n, p)) out.push(n); });
  return out;
}
function query(root, sel) { return queryAll(root, sel)[0] || null; }

function makeNode(tag) {
  const classes = new Set();
  let className = "";
  const node = {
    tag: String(tag).toLowerCase(),
    children: [],
    parent: null,
    attrs: {},
    id: "",
    type: "",
    title: "",
    _html: "",
    /* 真实 DOM 里 className 与 classList 同步，这里也同步，否则按类选择查不到节点 */
    get className() { return className; },
    set className(v) {
      className = String(v);
      classes.clear();
      className.split(/\s+/).filter(Boolean).forEach(function (c) { classes.add(c); });
    },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
      }
    },
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return k in node.attrs ? node.attrs[k] : null; },
    addEventListener() {},
    querySelector(sel) { return query(node, sel); },
    querySelectorAll(sel) { return queryAll(node, sel); }
  };
  Object.defineProperty(node, "innerHTML", {
    get() { return node._html; },
    /* 赋空串即清空子节点（两个渲染函数重渲染前都这么做） */
    set(v) { node._html = String(v); if (v === "") node.children = []; }
  });
  return node;
}

const root = makeNode("body");
const chapterNav = makeNode("nav");
chapterNav.id = "chapterNav";
root.appendChild(chapterNav);
const doc = {
  createElement(tag) { return makeNode(tag); },
  getElementById(id) { return id === "chapterNav" ? chapterNav : null; },
  querySelector(sel) { return query(root, sel); }
};
const fakeWindow = { CHAPTERS: [] };

/* ---- 断言工具 ---- */

/* 从按钮的 innerHTML 读徽标数字；没有徽标返回 null */
function badgeOf(node, cls) {
  const m = new RegExp('<span class="' + cls + '">(\\d+)</span>').exec(node.innerHTML);
  return m ? Number(m[1]) : null;
}
/* 期望值与页面同一套规则：编号两段 = 直挂本章抽屉的二级小节；前缀匹配 = 父节的三级小节 */
const topCount = (ch) => ch.tutorials.filter((t) => t.number.split(".").length === 2).length;
const subCountOf = (ch, no) =>
  ch.tutorials.filter((t) => t.number.indexOf(no + ".") === 0).length;

function checkChapters(chapters, note) {
  fakeWindow.CHAPTERS = chapters;
  api.renderChapterNav();
  const items = queryAll(root, ".chapter-item");
  assert.strictEqual(items.length, chapters.length, note + "：章条目数不符");
  chapters.forEach(function (chapter, i) {
    const tab = query(items[i], ".chapter-tab");
    assert.ok(tab, note + "：第 " + (i + 1) + " 条缺章节按钮");
    const want = topCount(chapter);
    const got = badgeOf(tab, "chapter-tab-count");
    const where = note + "：" + chapter.meta.chapter + " 的一级徽标";
    if (want) {
      assert.strictEqual(got, want, where + "应为 " + want);
      assert.strictEqual(tab.title, "含 " + want + " 个小节", where + "的提示文案不符");
      /* 已移除开合箭头，徽标成为按钮内最后一个元素（靠右） */
      assert.ok(/chapter-tab-count">\d+<\/span>\s*$/.test(tab.innerHTML),
        where + "应为按钮内最后一个元素");
    } else {
      assert.strictEqual(got, null, where + "不该输出");
      assert.strictEqual(tab.title, "", where + "不该有提示文案");
    }
  });
}

function checkChips(chapters, note) {
  chapters.forEach(function (chapter, i) {
    api.setActive(chapter);
    api.renderChips();
    const item = queryAll(root, '.chapter-item[data-chapter="' + (i + 1) + '"]')[0];
    assert.ok(item, note + "：找不到第 " + (i + 1) + " 章的抽屉");
    const nav = query(item, ".chips");
    /* 前言/教材/附录标签与页面同规则：按首节编号前缀（0. → 前言、字母 → 附录） */
    const prefix = chapter.tutorials.length ? chapter.tutorials[0].number.split(".")[0] : "";
    const kindLabel = prefix === "0" ? "前言" : /^[A-Za-z]$/.test(prefix) ? "附录" : "教材";
    assert.strictEqual(
      nav.getAttribute("aria-label"),
      kindLabel + "小节，共 " + chapter.tutorials.length + " 项",
      note + "：" + chapter.meta.chapter + " 的目录 aria-label 不符"
    );

    /* 逐个已挂载条目核对徽标，并顺带收集编号，验证「每个小节恰好渲染一次」 */
    const seen = [];
    nav.children.forEach(function (child) {
      const subs = query(child, ".chip-subs");
      if (!subs) {
        assert.strictEqual(child.tag, "button", note + "：直挂条目应为 chip 按钮");
        const no = child.getAttribute("data-outline-topic");
        assert.strictEqual(badgeOf(child, "chip-count"), null,
          note + "：无三级子节的 " + no + " 不该有徽标");
        assert.ok(!/chip-count/.test(child.innerHTML),
          note + "：叶 chip 不应出现徽标节点");
        seen.push(no);
        return;
      }
      const parentChip = child.children[0];
      const no = parentChip.getAttribute("data-outline-topic");
      seen.push(no);
      const want = subCountOf(chapter, no);
      const where = note + "：父节 " + no + " 的二级徽标";
      assert.strictEqual(badgeOf(parentChip, "chip-count"), want, where + "应为 " + want);
      assert.ok(parentChip.title.indexOf("含 " + want + " 个三级小节，点击开合") >= 0,
        where + "的提示文案不符");
      /* 已移除开合箭头，徽标成为父 chip 内最后一个元素（靠右） */
      assert.ok(/chip-count">\d+<\/span>\s*$/.test(parentChip.innerHTML),
        where + "应为父 chip 内最后一个元素");
      /* 数字必须与抽屉里真正挂载的三级小节数一致，否则徽标只是装饰 */
      const subChips = subs.children[0].children;
      assert.strictEqual(subChips.length, want, where + "与抽屉内小节数不一致");
      subChips.forEach(function (c) { seen.push(c.getAttribute("data-outline-topic")); });
    });
    assert.deepStrictEqual(
      seen, chapter.tutorials.map((t) => t.number),
      note + "：" + chapter.meta.chapter + " 的小节应按数据顺序全部出现且只出现一次");
  });
}


/* 拼接真实源码执行：开合与选中语义由 test_toc_accordion.js 覆盖，这里只关心徽标 */
const api = new Function(
  "document", "window", "$", "setGroupOpen", "selectChip",
  [
    "var activeLesson = null;",
    extractFn(appSrc, "esc"),
    extractFn(appSrc, "el"),
    extractFn(appSrc, "setChapterOpen"),
    extractFn(appSrc, "renderChapterNav"),
    extractFn(appSrc, "renderChips"),
    "return { setActive: function (l) { activeLesson = l; }," +
    " renderChapterNav: renderChapterNav, renderChips: renderChips };"
  ].join("\n\n")
)(doc, fakeWindow, function (id) { return doc.getElementById(id); },
  function () {}, function () {});


/* ===== 1. 边界数据：空章（无徽标）、全叶章（无徽标）、带子节的附录章与前言 ===== */
const synthetic = [
  { meta: { chapter: "第 1 章　空章" }, tutorials: [] },
  { meta: { chapter: "第 2 章　全叶节" }, tutorials: [
    { number: "2.1", title: "甲", paragraphs: [] },
    { number: "2.2", title: "乙", paragraphs: [] }
  ] },
  { meta: { chapter: "附录A 参考手册" }, tutorials: [
    { number: "A.1", title: "甲", paragraphs: [] },
    { number: "A.2", title: "乙", paragraphs: [] },
    { number: "A.2.1", title: "记号", paragraphs: [] },
    { number: "A.2.2", title: "注释", paragraphs: [] },
    { number: "A.2.3", title: "字", paragraphs: [] },
    { number: "A.3", title: "丙", paragraphs: [] }
  ] },
  { meta: { chapter: "前言与序" }, tutorials: [
    { number: "0.1", title: "出版者的话", paragraphs: [] }
  ] }
];
checkChapters(synthetic, "边界数据");
checkChips(synthetic, "边界数据");
const syntheticTabs = queryAll(root, ".chapter-item").map(
  (it) => query(it, ".chapter-tab"));
assert.strictEqual(badgeOf(syntheticTabs[0], "chapter-tab-count"), null,
  "空章不该输出一级徽标");
assert.strictEqual(badgeOf(syntheticTabs[1], "chapter-tab-count"), 2,
  "全叶章的一级徽标应为其二级小节数");
assert.strictEqual(badgeOf(syntheticTabs[2], "chapter-tab-count"), 3,
  "附录章的一级徽标应为二级小节数（三级小节不计入）");
assert.strictEqual(badgeOf(syntheticTabs[3], "chapter-tab-count"), 1,
  "前言的一级徽标应为其小节数");

/* ===== 2. 真实课程数据：12 章 187 节，数字与抽屉挂载逐章核对 ===== */
const chapters = require("../course-content.json");
checkChapters(chapters, "课程数据");
checkChips(chapters, "课程数据");

console.log("[ OK ] 目录徽标：章按钮与父 chip 的数量与各自抽屉挂载一致，计数为 0 时不输出");
