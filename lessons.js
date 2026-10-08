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
      /* 课程固定为 8 章，数量不符说明拿到的不是本课程的数据文件 */
      if (!Array.isArray(chapters) || chapters.length !== 8) {
        throw new Error("课程内容格式错误：应包含 8 个章节");
      }

      chapters.forEach(function (chapter, chapterIndex) {
        if (!chapter.meta || !Array.isArray(chapter.sections) ||
            !Array.isArray(chapter.tutorials) || !Array.isArray(chapter.bookExercises)) {
          throw new Error("课程内容格式错误：第 " + (chapterIndex + 1) + " 章结构不完整");
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
          /* 段落数下限按是否含子小节区分：父节可只剩导语，叶子小节至少要有一节正文 */
          if (!tutorial.number || !tutorial.title ||
              !Number.isInteger(tutorial.page) || tutorial.page < 1 ||
              !practiceSections[tutorial.sectionId] ||
              !Array.isArray(tutorial.paragraphs) ||
              tutorial.paragraphs.length < (hasChildren ? 1 : 2) ||
              !Array.isArray(tutorial.theory) ||
              (!tutorial.theory.length && !hasChildren)) {
            throw new Error("课程小节数据格式错误：" + (tutorial.number || "编号缺失"));
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
