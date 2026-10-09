/*
 * test_course_data.js — 课程数据回归测试（纯本地，不访问网络）
 * 运行：node tools/test_course_data.js   （在仓库根目录执行）
 *
 * 校验 course-content.json 的结构完整性：章节数量、编号唯一性、
 * 每个专题的讲解/示例/练习是否齐备、PDF 小节与交互专题的对应关系，
 * 以及正文与讲解的篇幅下限（防止批量丢失内容）。
 *
 * 课程 = 8 个正文章 + 3 个附录（meta.kind = "appendix"）。
 * 附录是只读的原书正文：sections / bookExercises 为空，小节没有原书页码
 * （page 为 null）也不挂交互专题，因此下面的配套专题与篇幅断言分两支。
 */
"use strict";

const assert = require("assert");

/* 本脚本在 tools/ 下，课程数据位于上一级仓库根目录 */
const chapters = require("../course-content.json");
assert.strictEqual(chapters.length, 11, "course should contain chapters 1–8 plus appendices A–C");
/* 连续问号说明转换/保存过程中出现过编码替换错误，正文已不可用 */
assert.ok(
  !/\?{3,}/.test(JSON.stringify(chapters)),
  "course content should not contain corrupted question-mark placeholders"
);

/* 跨章唯一编号集合与 PDF 小节计数器，用于全局查重与总量核对 */
const sectionIds = new Set();
const exerciseIds = new Set();
const tutorialIds = new Set();
let tutorialCount = 0;
chapters.forEach((chapter, chapterIndex) => {
  /* 附录固定是最后三个章节，正文章一律不带 appendix 标记 */
  const isAppendix = chapter.meta.kind === "appendix";
  assert.strictEqual(
    isAppendix,
    chapterIndex >= 8,
    `chapter ${chapterIndex + 1} appendix flag should match its position`
  );
  assert.ok(chapter.meta.chapter, `chapter ${chapterIndex + 1} should have a title`);
  assert.ok(chapter.meta.blurb, `chapter ${chapterIndex + 1} should have an introduction`);
  assert.ok(chapter.tutorials.length > 0, `chapter ${chapterIndex + 1} should have PDF-ordered tutorials`);
  if (isAppendix) {
    assert.strictEqual(
      chapter.sections.length, 0, `appendix ${chapterIndex + 1} should have no interactive sections`);
    assert.strictEqual(
      chapter.bookExercises.length, 0, `appendix ${chapterIndex + 1} should have no exercises`);
  } else {
    assert.ok(chapter.sections.length > 0, `chapter ${chapterIndex + 1} should have sections`);
    if (chapterIndex > 0) {
      assert.ok(chapter.sections.length >= 6, `chapter ${chapterIndex + 1} should cover the expanded topic set`);
    }
  }

  chapter.sections.forEach((section) => {
    assert.ok(section.id.startsWith(`${chapterIndex + 1}.`), `${section.id} should be in its chapter`);
    assert.ok(!sectionIds.has(section.id), `${section.id} should be unique`);
    sectionIds.add(section.id);
    assert.ok(section.theory.length > 0, `${section.id} should have lesson content`);
    const theoryText = section.theory.join("").replace(/<[^>]*>/g, "");
    assert.ok(
      theoryText.length >= 300,
      `${section.id} should include detailed explanations, not only a topic summary`
    );
    assert.ok(section.sample.code, `${section.id} should have a code example`);
    assert.ok(section.exercise.starter, `${section.id} should have an exercise starter`);
    assert.ok(section.exercise.expected != null, `${section.id} should have expected output`);
    assert.ok(section.exercise.hint, `${section.id} should have a hint`);
    assert.ok(!exerciseIds.has(section.id), `${section.id} exercise should be unique`);
    exerciseIds.add(section.id);
  });

  chapter.bookExercises.forEach((exercise) => {
    assert.ok(!exerciseIds.has(exercise.id), `${exercise.id} should be unique`);
    exerciseIds.add(exercise.id);
  });

  const tutorialNumbers = new Set();
  const plainText = (item) =>
    item.paragraphs.join("") + item.theory.join("").replace(/<[^>]*>/g, "");
  chapter.tutorials.forEach((tutorial) => {
    assert.ok(tutorial.number && tutorial.title, "tutorials should have a number and title");
    assert.ok(!tutorialIds.has(tutorial.number), `${tutorial.number} should be unique across chapters`);
    assert.ok(!tutorialNumbers.has(tutorial.number), `${tutorial.number} should be unique in its chapter`);
    if (isAppendix) {
      /* 附录 md 不含原书页码，也不挂交互专题 */
      assert.strictEqual(tutorial.page, null, `${tutorial.number} should carry no PDF page`);
      assert.ok(!("sectionId" in tutorial), `${tutorial.number} should not map to a section`);
      assert.ok(Array.isArray(tutorial.theory), `${tutorial.number} theory should be an array`);
    } else {
      assert.ok(
        Number.isInteger(tutorial.page) && tutorial.page > 0 && tutorial.page <= 296,
        `${tutorial.number} should have a valid PDF page`
      );
      assert.ok(
        chapter.sections.some((section) => section.id === tutorial.sectionId),
        `${tutorial.number} should map to an interactive section in its own chapter`
      );
    }
    // 含三级小节 (如 1.5.1) 的父节可能只保留导语, 正文由子小节承载
    const childTutorials = chapter.tutorials.filter(
      (other) => other.number.startsWith(`${tutorial.number}.`)
    );
    assert.ok(
      tutorial.paragraphs.length >= (isAppendix || childTutorials.length ? 1 : 2),
      `${tutorial.number} should contain original tutorial text`
    );
    assert.ok(
      tutorial.theory.length > 0 || childTutorials.length > 0 || isAppendix,
      `${tutorial.number} should contain extended lesson content`
    );
    const fullText = plainText(tutorial) + childTutorials.map(plainText).join("");
    assert.ok(
      /* 原书附录的小节短则数十字 (如 A.2.2 注释), 门槛只需挡住正文丢失 */
      fullText.trim().length >= (isAppendix ? 30 : 100),
      `${tutorial.number} should contain readable tutorial text`
    );
    tutorial.paragraphs.forEach((paragraph) => {
      assert.ok(typeof paragraph === "string" && paragraph.trim(), `${tutorial.number} should have readable text`);
    });
    tutorial.theory.forEach((paragraph) => {
      assert.ok(typeof paragraph === "string" && paragraph.trim(), `${tutorial.number} should have extended lesson text`);
    });
    tutorialNumbers.add(tutorial.number);
    tutorialIds.add(tutorial.number);
    tutorialCount++;
  });
  // 正文取自教材 md, 单节篇幅随原书小节长短而定 (如 7.8.3 原文仅数行),
  // 因此按章整体把关, 防止大批正文缺失; 附录 C 通篇只有一节, 门槛相应降低
  const chapterText = chapter.tutorials.map(plainText).join("");
  assert.ok(
    chapterText.length >= (isAppendix ? 1000 : 10000),
    `chapter ${chapterIndex + 1} should keep the whole chapter text`
  );
});
/* 固定总量：课程契约的一部分，修订课程数据时需同步调整 */
assert.strictEqual(sectionIds.size, 64, "course should retain all 64 interactive sections");
assert.strictEqual(
  tutorialIds.size, 188,
  "course should retain all 91 PDF topics plus 97 appendix sections"
);
console.log(
  `[ OK ] ${chapters.length} chapters, ${sectionIds.size} interactive sections, ` +
  `${tutorialCount} tutorials (${tutorialCount - 91} in appendices)`
);
