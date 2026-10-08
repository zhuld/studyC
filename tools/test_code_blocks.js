/*
 * test_code_blocks.js — 校验「教材正文中带 main 的完整程序」判定规则
 *
 * 页面会给命中的代码块加「载入编辑器 / ▶ 运行」按钮, 因此这里同时验证:
 *   · 命中块确实定义了 main 且花括号配平(可在线编译)
 *   · 被排除的块必须是跨块片段(花括号不配平)、书中省略写法 main() { ... }
 *     或「代码 + 中文旁注」排版块(注释之外含非 ASCII 字符)
 * 运行: node tools/test_code_blocks.js   （在仓库根目录执行）
 */
"use strict";

const assert = require("assert");
/* 本脚本在 tools/ 下：判定规则与课程数据都在上一级仓库根目录 */
const { isRunnableProgram } = require("../code-blocks.js");
const chapters = require("../course-content.json");

/* html.escape 生成的实体 (md_to_course.py) → 还原为代码纯文本 */
const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', "#x27": "'", "#39": "'" };
function decodeEntities(s) {
  return String(s).replace(/&(lt|gt|amp|quot|#x27|#39);/g, (whole, name) => ENTITIES[name]);
}

/* 收集教程正文(paragraphs/theory)与交互专题正文(theory)中的 <pre> 代码块 */
function collectCodeBlocks() {
  const blocks = [];
  const scan = (number, field, texts) => {
    texts.forEach((text) => {
      const re = /<pre[^>]*>([\s\S]*?)<\/pre>/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        blocks.push({ number, field, code: decodeEntities(m[1]) });
      }
    });
  };
  chapters.forEach((chapter) => {
    chapter.tutorials.forEach((tutorial) => {
      scan(tutorial.number, "tutorial", tutorial.paragraphs.concat(tutorial.theory || []));
    });
    chapter.sections.forEach((section) => {
      scan(section.id, "section", section.theory || []);
    });
  });
  return blocks;
}

function countsByNumber(list) {
  const out = {};
  list.forEach((block) => {
    out[block.number] = (out[block.number] || 0) + 1;
  });
  return out;
}

function stripComments(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/* 独立核对: 去掉注释后花括号是否配平 */
function braceDepth(code) {
  let depth = 0;
  const body = stripComments(code).replace(/"(?:\\.|[^"\\])*"/g, '""');
  for (const ch of body) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

const blocks = collectCodeBlocks();
const withMain = blocks.filter((block) => /main\s*\(/.test(block.code));
const hits = withMain.filter((block) => isRunnableProgram(block.code));
const excluded = withMain.filter((block) => !isRunnableProgram(block.code));

/* 独立核对: 去掉注释/字面量后是否残留非 ASCII 字符 (原书「代码 + 中文旁注」排版块) */
function hasAnnotatedText(code) {
  const body = stripComments(code)
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  return /[^\x00-\x7F]/.test(body);
}

/* 预期命中(与页面按钮一致): 31 块完整程序 */
const EXPECTED_HITS = {
  "1.1": 2, "1.2": 2, "1.3": 1, "1.4": 1,
  "1.5.1": 2, "1.5.2": 2, "1.5.3": 1, "1.5.4": 1,
  "1.6": 1, "1.7": 1, "1.9": 1,
  "3.4": 1,
  "4.1": 1, "4.2": 1, "4.3": 1,
  "5.10": 2, "5.11": 1, "5.12": 1,
  "6.3": 1, "6.4": 1, "6.5": 1,
  "7.1": 1, "7.4": 1,
  "8.2": 1, "8.3": 1, "8.6": 1
};

/* 预期排除: 7 块跨块片段 + 2 块省略写法 + 1 块中文旁注排版块 */
const EXPECTED_EXCLUDED = {
  "1.1": 1, "1.10": 1, "4.3": 1, "4.4": 1,
  "5.6": 1, "5.10": 2, "5.12": 1,
  "7.5": 1, "7.6": 1
};

/* 正文块总数随 md 排版修订而变(代码围栏合并/拆分), 只做量级保护;
   含 main 的块数与命中/排除分布才是本判定的契约 */
assert.ok(blocks.length >= 600, `正文代码块总数异常: ${blocks.length}`);
assert.ok(withMain.length >= 30, `含 main 的正文代码块过少: ${withMain.length}`);

assert.deepStrictEqual(
  countsByNumber(hits),
  EXPECTED_HITS,
  "命中的可编译完整程序分布与预期不符"
);
assert.deepStrictEqual(
  countsByNumber(excluded),
  EXPECTED_EXCLUDED,
  "被排除的代码块分布与预期不符"
);

hits.forEach((block) => {
  const label = `${block.number}(${block.field}, ${block.code.trim().length} 字符)`;
  assert.ok(
    /(^|\n)[ \t]*(?:int[ \t]+|void[ \t]+)?main[ \t]*\(/.test(block.code),
    `${label} 命中但未定义 main`
  );
  assert.strictEqual(braceDepth(block.code), 0, `${label} 命中但花括号不配平`);
});

excluded.forEach((block) => {
  const label = `${block.number}(${block.field}, ${block.code.trim().length} 字符)`;
  const concise = /\{\s*\.\.\.\s*\}/.test(stripComments(block.code));
  assert.ok(
    concise || braceDepth(block.code) !== 0 || hasAnnotatedText(block.code),
    `${label} 被排除, 但既不是省略写法、花括号不配平, 也不是中文旁注排版块`
  );
});

console.log(
  `[ OK ] 正文 ${blocks.length} 个代码块, ${withMain.length} 个含 main: ` +
  `${hits.length} 个可在线编译, ${excluded.length} 个片段/省略写法已排除`
);
