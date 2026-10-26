/*
 * test_course_data.js — 课程数据回归测试（纯本地，不访问网络）
 * 运行：node tools/test_course_data.js   （在仓库根目录执行）
 *
 * 校验浏览器端 Markdown 解析结果的结构完整性：章节数量、章首导言 intro、
 * 编号唯一性、每个小节正文是否齐备，以及正文篇幅下限（防止批量丢失内容）。
 *
 * 课程 = 1 个前言章节（首节编号 0.x）+ 8 个正文章 + 3 个附录（首节 A.x–C.x）。
 * 前言与附录是只读的原书正文，因此下面的篇幅断言分两支。
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

/* 与页面共用 Markdown 解析器构造真实课程章节 */
const chapters = require("../load-markdown-course")();

function validateImages(html, label) {
  const imagePaths = Array.from(html.matchAll(/<img src="([^"]+)"/g), (match) => match[1]);
  imagePaths.forEach((imagePath) => {
    assert.ok(imagePath.startsWith("md/images/"),
      `${label} images should load from md/images/`);
    assert.ok(fs.existsSync(path.join(__dirname, "..", imagePath)),
      `${imagePath} should exist`);
  });
}
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
  /* 章节身份按首节编号前缀判定（0. → 前言、字母 → 附录），并与固定次序交叉校验：
     前言是第 1 章、附录是最后三章 */
  const prefix = chapter.tutorials.length ? chapter.tutorials[0].number.split(".")[0] : "";
  const isPreface = prefix === "0";
  const isAppendix = /^[A-Za-z]$/.test(prefix);
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
  /* 章首导言独立成块：intro 是块级 HTML 数组，不并入首节；无导言时为空数组 */
  assert.ok(Array.isArray(chapter.intro), `chapter ${chapterIndex + 1} should expose an intro array`);
  chapter.intro.forEach((paragraph) => {
    assert.ok(typeof paragraph === "string" && paragraph.trim(),
      `chapter ${chapterIndex + 1} intro should have readable text`);
  });
  chapter.intro.forEach((paragraph) =>
    validateImages(paragraph, `chapter ${chapterIndex + 1} intro`));
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
      validateImages(paragraph, tutorial.number);
    });
    tutorialNumbers.add(tutorial.number);
    tutorialIds.add(tutorial.number);
    tutorialCount++;
  });
  // 正文取自教材 md, 单节篇幅随原书小节长短而定 (如 7.8.3 原文仅数行),
  // 因此按章整体把关, 防止大批正文缺失; 附录 C 通篇只有一节, 门槛相应降低
  const chapterText = chapter.intro.join("") + chapter.tutorials.map(plainText).join("");
  assert.ok(
    chapterText.length >= (isReadonly ? 1000 : 10000),
    `chapter ${chapterIndex + 1} should keep the whole chapter text`
  );
});
/* 固定总量：课程契约的一部分，修订课程数据时需同步调整 */
assert.strictEqual(
  tutorialIds.size, 190,
  "course should retain 6 preface sections, all 91 main topics plus 93 appendix sections"
);
console.log(
  `[ OK ] ${chapters.length} chapters, ${tutorialCount} tutorials ` +
  `(6 preface, ${tutorialCount - 97} in appendices)`
);
