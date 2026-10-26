/*
 * load-markdown-course.js — Node 测试用的本地书稿读取器。
 * 通过与浏览器相同的文件清单与 Markdown 解析器构造章节。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { chapterFiles, parse } = require("./markdown-course.js");

function loadMarkdownCourse() {
  const directory = path.join(__dirname, "md");
  return chapterFiles.map((file) =>
    parse(file, fs.readFileSync(path.join(directory, file), "utf8")));
}

module.exports = loadMarkdownCourse;
