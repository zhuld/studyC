/*
 * test_course_data.js — 课程数据回归测试（纯本地，不访问网络）
 * 运行：node tools/test_course_data.js   （在仓库根目录执行）
 *
 * 校验 course-content.json 的结构完整性：章节数量、编号唯一性、
 * 每个小节正文是否齐备，以及正文篇幅下限（防止批量丢失内容）。
 *
 * 课程 = 1 个前言章节（meta.kind = "preface"）+ 8 个正文章 +
 * 3 个附录（meta.kind = "appendix"）。
 * 前言与附录是只读的原书正文，因此下面的篇幅断言分两支。
 */
"use strict";

const assert = require("assert");

/* 本脚本在 tools/ 下，课程数据位于上一级仓库根目录 */
const chapters = require("../course-content.json");
assert.strictEqual(
  chapters.length, 12,
  "course should contain preface, chapters 1–8 plus appendices A–C"
);
/* 连续问号说明转换/保存过程中出现过编码替换错误，正文已不可用 */
assert.ok(
  !/\?{3,}/.test(JSON.stringify(chapters)),
  "course content should not contain corrupted question-mark placeholders"
);

/* 跨章唯一编号集合与小节计数器，用于全局查重与总量核对 */
const tutorialIds = new Set();
let tutorialCount = 0;
chapters.forEach((chapter, chapterIndex) => {
  /* 章节次序固定：前言是第 1 章、附录是最后三章、正文章一律不带 kind 标记 */
  const kind = chapter.meta.kind;
  const isPreface = kind === "preface";
  const isAppendix = kind === "appendix";
  const isReadonly = isPreface || isAppendix;
  assert.strictEqual(
    isPreface,
    chapterIndex === 0,
    `chapter ${chapterIndex + 1} preface flag should match its position`
  );
  assert.strictEqual(
    isAppendix,
    chapterIndex >= 9,
    `chapter ${chapterIndex + 1} appendix flag should match its position`
  );
  assert.ok(chapter.meta.chapter, `chapter ${chapterIndex + 1} should have a title`);
  assert.ok(chapter.tutorials.length > 0, `chapter ${chapterIndex + 1} should have ordered tutorials`);

  const tutorialNumbers = new Set();
  const plainText = (item) => item.paragraphs.join("");
  chapter.tutorials.forEach((tutorial) => {
    assert.ok(tutorial.number && tutorial.title, "tutorials should have a number and title");
    assert.ok(!tutorialIds.has(tutorial.number), `${tutorial.number} should be unique across chapters`);
    assert.ok(!tutorialNumbers.has(tutorial.number), `${tutorial.number} should be unique in its chapter`);
    // 含三级小节 (如 1.5.1) 的父节可能只保留导语, 正文由子小节承载
    const childTutorials = chapter.tutorials.filter(
      (other) => other.number.startsWith(`${tutorial.number}.`)
    );
    assert.ok(
      tutorial.paragraphs.length >= (isReadonly || childTutorials.length ? 1 : 2),
      `${tutorial.number} should contain original tutorial text`
    );
    const fullText = plainText(tutorial) + childTutorials.map(plainText).join("");
    assert.ok(
      /* 原书前言/附录的小节短则数十字 (如 A.2.2 注释), 门槛只需挡住正文丢失 */
      fullText.trim().length >= (isReadonly ? 30 : 100),
      `${tutorial.number} should contain readable tutorial text`
    );
    tutorial.paragraphs.forEach((paragraph) => {
      assert.ok(typeof paragraph === "string" && paragraph.trim(), `${tutorial.number} should have readable text`);
    });
    tutorialNumbers.add(tutorial.number);
    tutorialIds.add(tutorial.number);
    tutorialCount++;
  });
  // 正文取自教材 md, 单节篇幅随原书小节长短而定 (如 7.8.3 原文仅数行),
  // 因此按章整体把关, 防止大批正文缺失; 附录 C 通篇只有一节, 门槛相应降低
  const chapterText = chapter.tutorials.map(plainText).join("");
  assert.ok(
    chapterText.length >= (isReadonly ? 1000 : 10000),
    `chapter ${chapterIndex + 1} should keep the whole chapter text`
  );
});
/* 固定总量：课程契约的一部分，修订课程数据时需同步调整 */
assert.strictEqual(
  tutorialIds.size, 188,
  "course should retain 6 preface sections, all 91 main topics plus 91 appendix sections"
);
console.log(
  `[ OK ] ${chapters.length} chapters, ${tutorialCount} tutorials ` +
  `(6 preface, ${tutorialCount - 97} in appendices)`
);
