/*
 * test_highlight.js — 校验 highlight.js 的着色正确性（纯本地，不访问网络）
 * 运行：node tools/test_highlight.js   （在仓库根目录执行）
 *
 * 页面把编辑器高亮层与正文代码框（pre.card-code）都交给同一份 highlight()，
 * 因此这里同时验证：
 *   · 往返一致：去掉 span、还原实体后与源码逐字相等
 *     （「复制 / 载入编辑器 / 运行」取 pre.textContent，着色不得有损文本）
 *   · 输出只含白名单标签（tok-* span），源码里的 < & 一律被转义
 *   · 字面量不跨行：未闭合的 " 只染到行尾；英文撇号（如语法说明 *'s）
 *     不会被当成未闭合字符字面量而吞掉后续内容
 *   · 关键 token 分类抽查（注释/字符串/预处理/数字/关键字/类型/函数）
 *   · 编辑器行数对齐：renderEditor 拼出的高亮层与行号列行数一致
 */
"use strict";

const assert = require("assert");
/* 本脚本在 tools/ 下：着色实现与课程数据都在上一级仓库根目录 */
const { highlight } = require("../highlight.js");
const chapters = require("../course-content.json");

/* html.escape 生成的实体 (md_to_course.py) → 还原为代码纯文本 */
const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', "#x27": "'", "#39": "'" };
function decodeEntities(s) {
  return String(s).replace(/&(lt|gt|amp|quot|#x27|#39);/g, (whole, name) => ENTITIES[name]);
}

/* 允许出现在输出里的标签：tok-* 开标签与对应的闭标签，其余一律视为 bug */
const ALLOWED_TAG_RE = /^<span class="tok-(?:cm|str|pp|num|kw|ty|fn)">$|^<\/span>$/;

/* 收集一切会进页面代码框的源码：教程正文/专题理论中的 <pre>、示例与练习起始代码 */
function collectSources() {
  const out = [];
  const scanHtml = (label, text) => {
    const re = /<pre[^>]*>([\s\S]*?)<\/pre>/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push({ label, code: decodeEntities(m[1]) });
  };
  chapters.forEach((chapter) => {
    chapter.tutorials.forEach((tutorial) => {
      tutorial.paragraphs.forEach((p, i) => scanHtml(`${tutorial.number}/paragraphs[${i}]`, p));
      (tutorial.theory || []).forEach((p, i) => scanHtml(`${tutorial.number}/theory[${i}]`, p));
    });
    chapter.sections.forEach((section) => {
      (section.theory || []).forEach((p, i) => scanHtml(`${section.id}/theory[${i}]`, p));
      out.push({ label: `${section.id}/sample`, code: section.sample.code });
      out.push({ label: `${section.id}/starter`, code: section.exercise.starter });
    });
    chapter.bookExercises.forEach((x) => out.push({ label: `${x.id}/starter`, code: x.starter }));
  });
  return out;
}

/* 输出里的全部标签（源码中的 < 已被转义，命中即为 span） */
function tagsOf(html) {
  return html.match(/<[^>]*>/g) || [];
}

/* 去掉 span 只留文本（仍带实体），用于与源码做往返比对 */
function stripSpans(html) {
  return html
    .replace(/<span class="tok-(?:cm|str|pp|num|kw|ty|fn)">/g, "")
    .replace(/<\/span>/g, "");
}

/* 抽出高亮 span 的 (类别, 内容)，内容仍是实体形式（不含裸 <） */
function spansOf(code) {
  const out = [];
  const re = /<span class="tok-(cm|str|pp|num|kw|ty|fn)">([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(highlight(code))) !== null) out.push({ cls: m[1], text: m[2] });
  return out;
}

function hasSpan(list, cls, text) {
  return list.some((s) => s.cls === cls && decodeEntities(s.text) === text);
}

/* ---------- 1. 课程全量源码：往返一致 + 标签白名单 + 字符串不跨行 ---------- */

const sources = collectSources();
/* 正文块数随 md 排版修订而变，只做量级保护 */
assert.ok(sources.length >= 600, `样本过少: ${sources.length}`);

sources.forEach(({ label, code }) => {
  const html = highlight(code);
  tagsOf(html).forEach((tag) => {
    assert.ok(ALLOWED_TAG_RE.test(tag), `${label}: 出现白名单之外的标签 ${tag}`);
  });
  assert.strictEqual(
    decodeEntities(stripSpans(html)),
    code,
    `${label}: 高亮往返与源码不一致（复制/载入会取到被改动的文本）`
  );
  spansOf(code)
    .filter((s) => s.cls === "str")
    .forEach((s) => {
      assert.ok(!s.text.includes("\n"), `${label}: 字符串/字符字面量跨行了: ${s.text}`);
    });
});

/* ---------- 2. token 分类抽查 ---------- */

const sample =
  "#include <stdio.h>\n" +
  "int main(void)\n" +
  "{\n" +
  '    size_t n = 10;\n' +
  '    printf("hi %d", n);   // note\n' +
  "    /* multi\n       line */\n" +
  "    return 0;\n" +
  "}\n";
const spans = spansOf(sample);
assert.ok(hasSpan(spans, "pp", "#include"), "预处理行未着色");
assert.ok(hasSpan(spans, "kw", "int"), "关键字未着色");
assert.ok(hasSpan(spans, "kw", "return"), "关键字 return 未着色");
assert.ok(hasSpan(spans, "ty", "size_t"), "类型名未着色");
assert.ok(hasSpan(spans, "fn", "main"), "函数名未着色");
assert.ok(hasSpan(spans, "fn", "printf"), "函数名未着色");
assert.ok(hasSpan(spans, "str", '"hi %d"'), "字符串未着色");
assert.ok(hasSpan(spans, "cm", "// note"), "行注释未着色");
assert.ok(hasSpan(spans, "cm", "/* multi\n       line */"), "跨行块注释未完整着色");
assert.ok(hasSpan(spans, "num", "10"), "数字未着色");
/* <stdio.h> 不是调用也不是关键字，应保持纯文本 */
assert.ok(!spans.some((s) => decodeEntities(s.text) === "stdio"), "普通标识符被误着色");

/* ---------- 3. 正文排版块：英文撇号不得吞掉后续内容 ---------- */

const grammar = "dcl:       optional *'s direct-dcl\n    direct-dcl name\n";
const grammarSpans = spansOf(grammar);
assert.ok(
  grammarSpans.every((s) => s.cls !== "str"),
  "语法说明里的英文撇号被当成了字符字面量"
);
assert.strictEqual(decodeEntities(stripSpans(highlight(grammar))), grammar, "语法说明往返不一致");
/* 未闭合的双引号只染到本行尾，不能跨行 */
const unclosed = 'char *p = "oops\nint x;\n';
spansOf(unclosed)
  .filter((s) => s.cls === "str")
  .forEach((s) => assert.ok(!s.text.includes("\n"), "未闭合字符串跨行着色"));

/* ---------- 4. 编辑器行数对齐（renderEditor 的拼接方式） ---------- */

["", "int x;", "a\nb", "#include <stdio.h>\n", "x = 'a';\ny = 2;\n"].forEach((code) => {
  const hl = highlight(code) + "\n";                 // 高亮层
  const lines = code.split("\n").length;
  let gutter = "";
  for (let i = 1; i <= lines; i++) gutter += i + "\n"; // 行号列
  assert.strictEqual(
    hl.split("\n").length,
    gutter.split("\n").length,
    `编辑器高亮层与行号列行数不一致: ${JSON.stringify(code)}`
  );
});

console.log(
  `[ OK ] 高亮往返 ${sources.length} 个代码/示例源一致，` +
  `token 分类、字面量不跨行与编辑器行数对齐均通过`
);