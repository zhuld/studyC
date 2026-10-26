/*
 * markdown-course.js — 将 md/ 下的书稿解析为页面使用的章节对象。
 *
 * 只支持教材当前使用的 Markdown 子集：标题、段落、代码围栏、表格与图片。
 * 浏览器和 Node 回归测试共用同一份解析实现。
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MarkdownCourse = api;
}(this, function () {
  "use strict";

  var NUMBER_TOKEN = /^(?:[A-Za-z]|\d+)(?:\.\d+)+\.?$/;
  var APPENDIX_H1 = /^附录\s*([A-Z])\s*(.*)$/;
  var IMAGE_BLOCK = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
  var SCRIPT_BODY = "[A-Za-z0-9+\\-*/().,%×=]{1,12}";
  var SUP_MARK = new RegExp("\\^(" + SCRIPT_BODY + ")\\^", "g");
  var SUB_MARK = new RegExp("~(" + SCRIPT_BODY + ")~", "g");

  function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttribute(text) {
    return escapeHtml(text).replace(/"/g, "&quot;");
  }

  function escapeCode(text) {
    return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  }

  function convertScripts(text, tag) {
    return text.replace(tag === "sup" ? SUP_MARK : SUB_MARK, function (whole, body) {
      return /[A-Za-z0-9]/.test(body) ? "<" + tag + ">" + body + "</" + tag + ">" : whole;
    });
  }

  function inlineHtml(text) {
    if (text.indexOf("\u0000") !== -1) throw new Error("正文含保留字符 NUL");
    var spans = [];
    var escaped = escapeHtml(text).replace(/`([^`]+)`/g, function (_whole, code) {
      spans.push(code);
      return "\u0000" + (spans.length - 1) + "\u0000";
    });
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    escaped = convertScripts(escaped, "sup");
    escaped = convertScripts(escaped, "sub");
    return escaped.replace(/\u0000(\d+)\u0000/g, function (_whole, index) {
      return "<code>" + spans[Number(index)] + "</code>";
    });
  }

  function splitHeading(text) {
    var rest = text.trim();
    var match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
    if (!match) throw new Error("空标题行");
    if (NUMBER_TOKEN.test(match[1])) {
      return { number: match[1].replace(/\.$/, ""), title: (match[2] || "").trim() };
    }
    return { number: null, title: rest };
  }

  function splitCells(line) {
    var text = line.trim();
    if (text.charAt(0) === "|") text = text.slice(1);
    if (text.charAt(text.length - 1) === "|") {
      var escapes = 0;
      for (var i = text.length - 2; i >= 0 && text.charAt(i) === "\\"; i--) escapes++;
      if (escapes % 2 === 0) text = text.slice(0, -1);
    }
    var cells = [];
    var cell = "";
    for (var j = 0; j < text.length; j++) {
      if (text.charAt(j) === "|" && (j === 0 || text.charAt(j - 1) !== "\\")) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += text.charAt(j);
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  function unescapeCell(text) {
    return text.replace(/\\Vert(?![A-Za-z])/g, "||")
      .replace(/\\vert(?![A-Za-z])/g, "|").replace(/\\\|/g, "|");
  }

  function parseTable(lines, fileName, lineNumber) {
    if (lines.length < 2 || !lines.every(function (line) { return line.indexOf("|") !== -1; })) {
      return null;
    }
    var separators = splitCells(lines[1]);
    if (!separators.length || !separators.every(function (cell) { return /^:?-+:?$/.test(cell); })) {
      return null;
    }
    var rows = [splitCells(lines[0]).map(unescapeCell)];
    for (var i = 2; i < lines.length; i++) rows.push(splitCells(lines[i]).map(unescapeCell));
    rows.forEach(function (row, index) {
      if (row.length !== separators.length) {
        throw new Error(fileName + ": 第" + (lineNumber + index) +
          "行表格列数 " + row.length + " 与表头 " + separators.length + " 不一致");
      }
    });
    return {
      type: "table",
      rows: rows,
      aligns: separators.map(function (cell) {
        if (cell.charAt(0) === ":" && cell.charAt(cell.length - 1) === ":") return "center";
        if (cell.charAt(cell.length - 1) === ":") return "right";
        if (cell.charAt(0) === ":") return "left";
        return "";
      })
    };
  }

  function renderBlock(block) {
    if (block.type === "code") {
      return '<pre class="card-code">' + escapeCode(block.text) + "</pre>";
    }
    if (block.type === "image") {
      return '<img src="' + escapeAttribute("md/" + block.src) + '" alt="' +
        escapeAttribute(block.alt) + '">';
    }
    if (block.type === "table") {
      var html = '<div class="table-scroll"><table><thead><tr>';
      block.rows[0].forEach(function (cell, index) {
        var style = block.aligns[index] ? ' style="text-align:' + block.aligns[index] + '"' : "";
        html += "<th" + style + ">" + inlineHtml(cell) + "</th>";
      });
      html += "</tr></thead><tbody>";
      block.rows.slice(1).forEach(function (row) {
        html += "<tr>";
        row.forEach(function (cell, index) {
          var style = block.aligns[index] ? ' style="text-align:' + block.aligns[index] + '"' : "";
          html += "<td" + style + ">" + inlineHtml(cell) + "</td>";
        });
        html += "</tr>";
      });
      return html + "</tbody></table></div>";
    }
    return "<p>" + inlineHtml(block.text) + "</p>";
  }

  function appendixPrefix(title) {
    var match = APPENDIX_H1.exec(title);
    return match ? match[1] : "";
  }

  function chapterPrefix(fileName, title, headings) {
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].number) return headings[i].number.split(".")[0];
    }
    var appendix = appendixPrefix(title);
    if (appendix) return appendix;
    var prefix = /^(\d+)/.exec(fileName);
    if (prefix) return String(parseInt(prefix[1], 10));
    throw new Error(fileName + ": 无法推导章编号前缀");
  }

  function assignNumbers(fileName, headings, prefix) {
    var used = {};
    var children = {};
    var previousMain = "";
    return headings.map(function (heading) {
      var number = heading.number;
      if (heading.level === 2) {
        if (!number) {
          var next = 1;
          while (used[prefix + "." + next]) next++;
          number = prefix + "." + next;
        }
        previousMain = number;
      } else {
        if (!previousMain) {
          throw new Error(fileName + ": 三级小节「" + heading.title + "」出现在任何二级小节之前");
        }
        if (!number) {
          var child = (children[previousMain] || 0) + 1;
          while (used[previousMain + "." + child]) child++;
          number = previousMain + "." + child;
        } else if (number.substring(0, number.lastIndexOf(".")) !== previousMain) {
          throw new Error(fileName + ": 三级小节 " + number + " 未紧跟其父节 " + previousMain);
        }
        children[previousMain] = parseInt(number.substring(number.lastIndexOf(".") + 1), 10);
      }
      if (used[number]) throw new Error(fileName + ": 小节编号重复: " + number);
      used[number] = true;
      return { number: number, title: heading.title, blocks: heading.blocks };
    });
  }

  function parseMarkdown(fileName, markdown) {
    var lines = markdown.split(/\r?\n/);
    var title = "";
    var intro = [];
    var target = intro;
    var headings = [];
    var current = [];
    var currentLine = 1;
    var inFence = false;
    var fenceLine = 0;

    function flush() {
      if (!current.length) return;
      var text = current.join("\n");
      var block;
      if (inFence) {
        if (current.length < 2 || current[current.length - 1].indexOf("```") !== 0) {
          throw new Error(fileName + ": 第" + (fenceLine + 1) + "行代码围栏未闭合");
        }
        block = { type: "code", text: current.slice(1, -1).join("\n") };
      } else {
        var table = parseTable(current, fileName, currentLine);
        var image = IMAGE_BLOCK.exec(text.trim());
        if (table) {
          block = table;
        } else if (image) {
          if (text.indexOf("\n") !== -1) throw new Error(fileName + ": 图片块混入多行");
          if (image[2].indexOf("images/") !== 0) throw new Error(fileName + ": 图片路径异常: " + image[2]);
          block = { type: "image", src: image[2], alt: image[1] };
        } else {
          block = { type: "paragraph", text: text };
        }
      }
      target.push(renderBlock(block));
      current = [];
    }

    lines.forEach(function (line, index) {
      if (!current.length) currentLine = index + 1;
      if (inFence) {
        current.push(line);
        if (line.indexOf("```") === 0 && current.length > 1) {
          flush();
          inFence = false;
          fenceLine = 0;
        }
        return;
      }
      if (line.indexOf("```") === 0) {
        flush();
        inFence = true;
        current = [line];
        fenceLine = index;
        return;
      }
      if (line.indexOf("###") === 0) {
        flush();
        var sub = splitHeading(line.slice(3));
        if (sub.number && (sub.number.match(/\./g) || []).length !== 2) {
          throw new Error(fileName + ": 三级小节编号异常: " + line);
        }
        target = [];
        headings.push({ number: sub.number, level: 3, title: sub.title, blocks: target });
        return;
      }
      if (line.indexOf("## ") === 0) {
        flush();
        var section = splitHeading(line.slice(3));
        if (section.number && (section.number.match(/\./g) || []).length !== 1) {
          throw new Error(fileName + ": 节编号异常: " + line);
        }
        target = [];
        headings.push({ number: section.number, level: 2, title: section.title, blocks: target });
        return;
      }
      if (line.indexOf("# ") === 0) {
        flush();
        title = line.slice(2).trim();
        return;
      }
      if (!line.trim()) {
        flush();
        return;
      }
      current.push(line);
    });
    flush();
    if (inFence) throw new Error(fileName + ": 代码围栏未闭合");

    var prefix = chapterPrefix(fileName, title, headings);
    var sections = assignNumbers(fileName, headings, prefix);
    if (!sections.length) {
      if (!intro.length) throw new Error(fileName + ": 缺小节标题与正文");
      var appendix = APPENDIX_H1.exec(title);
      var chapterTitle = appendix ? (appendix[2].trim() || title) : title;
      if (!chapterTitle) throw new Error(fileName + ": 没有小节标题与章标题");
      sections.push({ number: prefix + ".1", title: chapterTitle, blocks: intro });
      intro = [];
    }

    sections.forEach(function (section) {
      if (!section.blocks.length) {
        throw new Error(fileName + ": " + section.number + " " + section.title + " 标题下没有正文块");
      }
    });
    var chapterTitle = title || fileName.replace(/^\d+-/, "").replace(/\.md$/i, "");
    var result = {
      meta: { chapter: chapterTitle },
      intro: intro,
      tutorials: sections.map(function (section) {
        return {
          number: section.number,
          title: section.title,
          paragraphs: section.blocks
        };
      })
    };
    return result;
  }

  return {
    chapterFiles: [
      "00-前言与序.md",
      "01-第1章-导言.md",
      "02-第2章-类型、运算符与表达式.md",
      "03-第3章-控制流.md",
      "04-第4章-函数与程序结构.md",
      "05-第5章-指针与数组.md",
      "06-第6章-结构.md",
      "07-第7章-输入与输出.md",
      "08-第8章-UNIX系统接口.md",
      "09-附录A-参考手册.md",
      "10-附录B-标准库.md",
      "11-附录C-变更小结.md"
    ],
    parse: parseMarkdown
  };
}));
