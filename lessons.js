/*
 * lessons.js — 课程数据加载器
 *
 * 读取同目录下的 course-content.json，完成结构与完整性校验后，
 * 通过 window.CHAPTERS / window.CHAPTER1 交给 app.js，
 * 并用 window 事件通知就绪（course-content-ready / course-content-error）。
 *
 * 校验策略是「快速失败」：章数不符、字段缺失或编号重复时直接抛错，
 * 由 app.js 显示加载失败提示，避免把半截课程渲染到页面上。
 * 除校验外还会做一次派生：把教学小节与交互专题配对，
 * 未被任何小节认领的专题归入 chapter.extraSections。
 */
(function () {
  "use strict";

  /* 以本脚本自身的 URL 为基准解析数据路径，使页面可部署在任意子目录 */
  var baseUrl = new URL(".", document.currentScript.src);
  /* 拉取并解析 JSON；HTTP 层错误转成带文件名的可读异常 */
  function loadJson(fileName) {
    return fetch(new URL(fileName, baseUrl)).then(function (response) {
      if (!response.ok) {
        throw new Error(fileName + " 加载失败：HTTP " + response.status);
      }
      return response.json();
    });
  }

  loadJson("course-content.json")
    .then(function (chapters) {
      /* 课程固定为 8 章 + 3 个附录, 数量不符说明拿到的不是本课程的数据文件 */
      if (!Array.isArray(chapters) || chapters.length !== 11) {
        throw new Error("课程内容格式错误：应包含 8 个章节与 3 个附录");
      }

      chapters.forEach(function (chapter, chapterIndex) {
        if (!chapter.meta || !Array.isArray(chapter.sections) ||
            !Array.isArray(chapter.tutorials) || !Array.isArray(chapter.bookExercises)) {
          throw new Error("课程内容格式错误：第 " + (chapterIndex + 1) + " 章结构不完整");
        }

        /* 附录 (meta.kind = "appendix") 是只读正文：没有交互专题，
           也没有原书页码可用；正文章则必须两者齐备。两者不可混用。 */
        var isAppendix = chapter.meta.kind === "appendix";
        if (isAppendix !== (chapter.sections.length === 0)) {
          throw new Error("课程内容格式错误：第 " + (chapterIndex + 1) +
            " 章的附录标记与交互专题数不匹配");
        }

        /* 专题编号是判题与进度存档的键，必须唯一 */
        var practiceSections = {};
        chapter.sections.forEach(function (section) {
          if (practiceSections[section.id]) {
            throw new Error("课程专题编号重复：" + section.id);
          }
          practiceSections[section.id] = section;
        });

        chapter.tutorials.forEach(function (tutorial) {
          // 含三级小节 (如 1.5.1) 的父节可能只保留导语, 正文由子小节承载
          var hasChildren = chapter.tutorials.some(function (other) {
            return other.number.indexOf(tutorial.number + ".") === 0;
          });
          function bad(reason) {
            throw new Error("课程小节数据格式错误：" +
              (tutorial.number || "编号缺失") + "（" + reason + "）");
          }
          if (!tutorial.number || !tutorial.title) bad("缺编号或标题");
          if (!Array.isArray(tutorial.paragraphs) || !tutorial.paragraphs.length) {
            bad("缺正文");
          }

          if (isAppendix) {
            /* 附录只有书稿正文：原书页码无从取得，也不挂交互专题，
               因此 page 必须为 null、不能带 sectionId，theory 允许为空 */
            if (tutorial.page !== null || tutorial.sectionId != null) bad("附录不应带页码或专题");
            if (!Array.isArray(tutorial.theory)) bad("theory 应为数组");
            return;
          }

          /* 正文章：段落数下限按是否含子小节区分（父节可只剩导语）；
             theory 是书稿第 3 块起的延伸正文，原书短小节（如 7.8.1 只有
             引言与函数表）可以为空，篇幅靠测试的字数断言把关 */
          if (!Number.isInteger(tutorial.page) || tutorial.page < 1 ||
              !practiceSections[tutorial.sectionId]) {
            bad("页码或配套专题缺失");
          }
          if (tutorial.paragraphs.length < (hasChildren ? 1 : 2) ||
              !Array.isArray(tutorial.theory)) {
            bad("正文篇幅不足");
          }
        });

        /* 把每个交互专题挂到某个教学小节上：优先取与小节同编号的教程
           （1.5 的专题配 1.5 的教程），否则退回该专题的第一个教程 */
        var assignedPractice = {};
        chapter.sections.forEach(function (section) {
          var candidates = chapter.tutorials.filter(function (tutorial) {
            return tutorial.sectionId === section.id;
          });
          var tutorial = candidates.find(function (candidate) {
            return candidate.number === section.id;
          }) || candidates[0];
          if (tutorial) {
            tutorial.practiceSectionId = section.id;
            assignedPractice[section.id] = true;
          }
        });
        /* 没有任何教程承载的专题（PDF 目录之外的交互专题）单列出来，
           由 app.js 渲染成「课程补充专题」 */
        chapter.extraSections = chapter.sections.filter(function (section) {
          return !assignedPractice[section.id];
        });
      });

      /* 交付给 app.js：同时保留全局数组与第 1 章引用，并广播就绪事件 */
      window.CHAPTERS = chapters;
      window.CHAPTER1 = chapters[0];
      window.dispatchEvent(new Event("course-content-ready"));
    })
    .catch(function (error) {
      window.COURSE_CONTENT_ERROR = error;
      console.error(error);
      window.dispatchEvent(new Event("course-content-error"));
    });
})();
