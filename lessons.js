/*
 * lessons.js — 课程数据加载器
 *
 * 读取 md/ 下的章节 Markdown 并解析，完成结构与完整性校验后，
 * 通过 window.CHAPTERS / window.CHAPTER1 交给 app.js，
 * 并用 window 事件通知就绪（course-content-ready / course-content-error）。
 *
 * 校验策略是「快速失败」：章数不符或字段缺失时直接抛错，
 * 由 app.js 显示加载失败提示，避免把半截课程渲染到页面上。
 */
(function () {
  "use strict";

  /* 文件名即课程顺序；浏览器无法列出目录，清单由解析器统一维护 */
  var chapterFiles = window.MarkdownCourse.chapterFiles;
  /* 以本脚本自身的 URL 为基准解析书稿路径，使页面可部署在任意子目录 */
  var baseUrl = new URL(".", document.currentScript.src);
  function loadMarkdown(fileName) {
    var path = "md/" + fileName;
    return fetch(new URL(path, baseUrl)).then(function (response) {
      if (!response.ok) {
        throw new Error(path + " 加载失败：HTTP " + response.status);
      }
      return response.text().then(function (markdown) {
        return window.MarkdownCourse.parse(fileName, markdown);
      });
    });
  }

  Promise.all(chapterFiles.map(loadMarkdown))
    .then(function (chapters) {
      /* 课程固定为 1 前言 + 8 章 + 3 个附录, 数量不符说明拿到的不是本课程的数据文件 */
      if (!Array.isArray(chapters) || chapters.length !== 12) {
        throw new Error("课程内容格式错误：应包含 1 个前言章节、8 个章节与 3 个附录");
      }

      chapters.forEach(function (chapter, chapterIndex) {
        if (!chapter.meta || !Array.isArray(chapter.tutorials)) {
          throw new Error("课程内容格式错误：第 " + (chapterIndex + 1) + " 章结构不完整");
        }

        /* 前言（首节编号 0.x）与附录（A.x–C.x）是只读书稿正文，只需有内容即可；
           正文章的段落数下限按是否含子小节区分——章节身份按首节编号前缀判定 */
        var prefix = chapter.tutorials.length
          ? chapter.tutorials[0].number.split(".")[0] : "";
        var isReadonly = prefix === "0" || /^[A-Za-z]$/.test(prefix);

        /* 章首导言独立成块渲染：intro 必为块级 HTML 数组，
           没有导言的章节（如附录 A）为空数组 */
        if (!Array.isArray(chapter.intro)) {
          throw new Error("课程内容格式错误：第 " + (chapterIndex + 1) +
            " 章缺 intro 字段");
        }
        chapter.intro.forEach(function (paragraph, i) {
          if (typeof paragraph !== "string" || !paragraph.trim()) {
            throw new Error("课程内容格式错误：第 " + (chapterIndex + 1) +
              " 章 intro[" + i + "] 缺正文");
          }
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
          if (isReadonly) return;

          /* 正文章：父节可只剩导语, 原书短小节 (如 7.8.1 只有引言与函数表)
             的篇幅靠测试的字数断言把关 */
          if (tutorial.paragraphs.length < (hasChildren ? 1 : 2)) {
            bad("正文篇幅不足");
          }
        });
      });

      /* 交付给 app.js：同时保留全局数组与首章（前言与序）引用，并广播就绪事件 */
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
