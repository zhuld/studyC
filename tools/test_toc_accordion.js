/*
 * test_toc_accordion.js — 校验侧栏三级抽屉的开合语义
 *
 *   · 手风琴：同一时刻至多只有一个 .chip-group.is-open（点父 chip 与滚动高亮共用 setGroupOpen）
 *   · 选中即收口：选中二级小节时收起非本级的三级抽屉，叶级二级小节收起全部；
 *     点击路径 selectChip() 与滚动高亮路径 highlight() 都必须执行该规则。
 * 被测函数从 app.js 源码按名字截取本体，在最小假 DOM 上执行，
 * 保证测试覆盖的是页面真实实现而非复制品。
 * 运行: node tools/test_toc_accordion.js   （在仓库根目录执行）
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

/* ---- 最小假 DOM：够四个被测函数使用 ---- */
function makeGroup(name) {
  const classes = new Set();
  const tab = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  return {
    name,
    classList: {
      toggle(cls, force) { if (force) classes.add(cls); else classes.delete(cls); },
      contains(cls) { return classes.has(cls); }
    },
    querySelector(sel) { return sel === ".chip.has-subs" ? tab : null; },
    tab
  };
}
const groups = ["A", "B", "C"].map(makeGroup);

function makeChip(topic, group) {
  const classes = new Set();
  return {
    topic,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); }
    },
    /* 真实 DOM 中父 chip 与三级 chip 位于其 .chip-group 内，叶级二级 chip 不属于任何分组 */
    closest(sel) { return sel === ".chip-group" ? group : null; }
  };
}

const chipLeaf2 = makeChip("1.4", null);         // 叶级二级小节（无三级子节）
const chipParentA = makeChip("1.5", groups[0]);  // 二级父小节（三级抽屉 A）
const chipSub = makeChip("1.5.1", groups[0]);    // 三级小节（隶属 A）
const chipParentB = makeChip("1.6", groups[1]);  // 另一个二级父小节（抽屉 B）
const allChips = [chipLeaf2, chipParentA, chipSub, chipParentB];
const topicMap = { "1.4": chipLeaf2, "1.5": chipParentA, "1.5.1": chipSub, "1.6": chipParentB };

const fakeDoc = {
  querySelectorAll(sel) {
    if (sel === "#chapterNav .chip-group.is-open")
      return groups.filter((g) => g.classList.contains("is-open"));
    if (sel === ".chip") return allChips;
    throw new Error("意外的选择器: " + sel);
  }
};
const setupSpyFake = { pinned: null };

/* 拼接真实源码执行：highlight 依赖的闭包变量 map 以参数名注入 */
const fns = new Function("document", "setupSpy", "map",
  ["closeGroupsExcept", "setGroupOpen", "selectChip", "highlight"]
    .map((n) => extractFn(appSrc, n)).join("\n\n") +
  "\nreturn { setGroupOpen: setGroupOpen, closeGroupsExcept: closeGroupsExcept," +
  " selectChip: selectChip, highlight: highlight };"
)(fakeDoc, setupSpyFake, topicMap);

/* ---- 断言工具 ---- */
function openNames() {
  return groups.filter((g) => g.classList.contains("is-open")).map((g) => g.name);
}
/* 直接改类：构造「多个抽屉同时打开」等非手风琴的历史状态 */
function forceOpen(name, on) {
  groups.find((g) => g.name === name).classList.toggle("is-open", on);
}
function resetCurrent() { allChips.forEach((c) => c.classList.remove("current")); }
function assertAtMostOne(step) {
  assert.ok(openNames().length <= 1, step + "：同时打开了 " + openNames().join(","));
}

/* ===== 1. 手风琴：展开时收起其余，aria-expanded 同步 ===== */
fns.setGroupOpen(groups[0], true);
fns.setGroupOpen(groups[1], true);
assert.deepStrictEqual(openNames(), ["B"], "展开 B 后应只剩 B");
assert.strictEqual(groups[0].tab.attrs["aria-expanded"], "false", "A 的 aria 应回落 false");
assert.strictEqual(groups[1].tab.attrs["aria-expanded"], "true", "B 的 aria 应为 true");
fns.setGroupOpen(groups[2], true);
assert.deepStrictEqual(openNames(), ["C"], "展开 C 后应只剩 C");
fns.setGroupOpen(groups[2], false);
assert.deepStrictEqual(openNames(), [], "收起后应无展开项");
fns.setGroupOpen(groups[0], true);
fns.setGroupOpen(groups[0], true);
assert.deepStrictEqual(openNames(), ["A"], "重复展开同一项应保持只开 A");

/* ===== 2. closeGroupsExcept：keep=null 全收，否则只留 keep ===== */
forceOpen("B", true);
fns.closeGroupsExcept(null);
assert.deepStrictEqual(openNames(), [], "keep=null 应全部收起");
forceOpen("A", true); forceOpen("B", true); forceOpen("C", true);
fns.closeGroupsExcept(groups[1]);
assert.deepStrictEqual(openNames(), ["B"], "只保留 keep 指定的分组");

/* ===== 3. 点击路径 selectChip：选中二级小节时非本级抽屉关闭 ===== */
forceOpen("A", true); forceOpen("B", true);
resetCurrent();
fns.selectChip(chipLeaf2, "1.4");
assert.deepStrictEqual(openNames(), [], "选中叶级二级小节应收起全部三级抽屉");
assert.ok(chipLeaf2.classList.contains("current"), "选中项应标记 current");
assert.strictEqual(setupSpyFake.pinned, "1.4", "点击应锁定滚动高亮");

forceOpen("A", true); forceOpen("B", true);
resetCurrent();
fns.selectChip(chipSub, "1.5.1");
assert.deepStrictEqual(openNames(), ["A"], "选中三级小节只保留本级分组");

forceOpen("A", true); forceOpen("B", true);
resetCurrent();
fns.selectChip(chipParentA, "1.5");
assert.deepStrictEqual(openNames(), ["A"], "选中二级父小节保留本级并关闭其余");
forceOpen("A", false);
resetCurrent();
fns.selectChip(chipParentA, "1.5");
assert.deepStrictEqual(openNames(), [], "selectChip 不强制展开本级（开合仍归点击处理器）");
assertAtMostOne("selectChip");

/* ===== 4. 滚动高亮路径 highlight ===== */
forceOpen("A", true); forceOpen("B", true);
resetCurrent();
fns.highlight("1.4");
assert.deepStrictEqual(openNames(), [], "滚动到叶级二级小节应收起全部三级抽屉");

forceOpen("B", true);
resetCurrent();
fns.highlight("1.5.1");
assert.deepStrictEqual(openNames(), ["A"], "滚动到三级小节只展开本级分组");
assert.strictEqual(groups[0].tab.attrs["aria-expanded"], "true", "本级 aria 应为 true");
assert.strictEqual(groups[1].tab.attrs["aria-expanded"], "false", "非本级 aria 应为 false");

forceOpen("B", true); forceOpen("C", true);
resetCurrent();
fns.highlight("1.5");
assert.deepStrictEqual(openNames(), ["A"], "滚动到二级父小节展开本级、收起其余");

forceOpen("A", false);
fns.highlight("1.5"); // chip 已是 current：短路返回，不动抽屉
assert.deepStrictEqual(openNames(), [], "current 未变时 highlight 直接返回");
assertAtMostOne("highlight");

console.log("[ OK ] 三级抽屉开合：手风琴至多开一个；选中二级小节时非本级抽屉收起（点击与滚动两条路径）");
