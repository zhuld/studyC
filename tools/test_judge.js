/*
 * test_judge.js — 端到端校验：用「参考答案」跑 Wandbox，检查每道练习的
 * starter/expected/stdin 是否自洽（本脚本需要联网，属人工验证工具）。
 *
 * 运行：node tools/test_judge.js   （在仓库根目录执行，需联网）
 *
 * 说明：solutions 是每道题的参考解法（等同于学生完成 TODO 后的代码），
 *      与 course-content.json 里的 expected 逐字比对（归一化规则与页面判题一致）。
 *      Wandbox 有速率限制，请求失败会退避重试，题与题之间也留出间隔。
 */
"use strict";

const L = require("../course-content.json")[0];

/* 每道题的参考解法（模拟学生完成 TODO 后的代码） */
const solutions = {
  "1.1": `#include <stdio.h>\n\nint main(void)\n{\n    printf("hello, C!\\n");\n    return 0;\n}\n`,
  "1.2": `#include <stdio.h>\n\nint main(void)\n{\n    int f;\n    f = 32;\n    printf("%d\\n", 5 * (f - 32) / 9);\n    f = 212;\n    printf("%d\\n", 5 * (f - 32) / 9);\n    return 0;\n}\n`,
  "1.3": `#include <stdio.h>\n\nint main(void)\n{\n    int fahr;\n    double celsius;\n    for (fahr = 0; fahr <= 300; fahr = fahr + 20) {\n        celsius = (5.0 / 9.0) * (fahr - 32);\n        printf("%3d %6.1f\\n", fahr, celsius);\n    }\n    return 0;\n}\n`,
  "1.4": `#include <stdio.h>\n\n#define STEP 25\n#define UPPER 100\n\nint main(void)\n{\n    int f;\n    for (f = 0; f <= UPPER; f += STEP)\n        printf("%d\\n", f);\n    return 0;\n}\n`,
  "1.5": `#include <stdio.h>\n\nint main(void)\n{\n    int c;\n    while ((c = getchar()) != EOF)\n        putchar(c);\n    return 0;\n}\n`,
  "1.6": `#include <stdio.h>\n\nint main(void)\n{\n    int c, i;\n    int ndigit[10];\n    for (i = 0; i < 10; i++)\n        ndigit[i] = 0;\n    while ((c = getchar()) != EOF)\n        if (c >= '0' && c <= '9')\n            ndigit[c - '0']++;\n    for (i = 0; i < 10; i++)\n        printf("%d %d\\n", i, ndigit[i]);\n    return 0;\n}\n`,
  "1.7": `#include <stdio.h>\n\nint mypow(int base, int n);\n\nint main(void)\n{\n    printf("%d\\n", mypow(2, 10));\n    printf("%d\\n", mypow(3, 3));\n    printf("%d\\n", mypow(5, 0));\n    return 0;\n}\n\nint mypow(int base, int n)\n{\n    int i, p = 1;\n    for (i = 0; i < n; i++)\n        p = p * base;\n    return p;\n}\n`,
  "1.8": `#include <stdio.h>\n\nvoid try_swap(int a, int b);\n\nint main(void)\n{\n    int a, b;\n    a = 1;\n    b = 2;\n    try_swap(a, b);\n    printf("after: a = %d, b = %d\\n", a, b);\n    return 0;\n}\n\nvoid try_swap(int a, int b)\n{\n    int temp = a;\n    a = b;\n    b = temp;\n}\n`,
  "1.9": `#include <stdio.h>\n\n#define MAXLINE 1000\n\nint getline_(char s[], int lim);\nvoid reverse(char s[], int len);\n\nint main(void)\n{\n    char line[MAXLINE];\n    int len;\n    len = getline_(line, MAXLINE);\n    if (len > 0)\n        reverse(line, len);\n    return 0;\n}\n\nint getline_(char s[], int lim)\n{\n    int c, i;\n    for (i = 0; i < lim - 1 && (c = getchar()) != EOF && c != '\\n'; ++i)\n        s[i] = c;\n    if (c == '\\n')\n        s[i++] = c;\n    s[i] = '\\0';\n    return i;\n}\n\nvoid reverse(char s[], int len)\n{\n    int i;\n    if (len > 0 && s[len - 1] == '\\n')\n        len--;\n    for (i = len - 1; i >= 0; i--)\n        putchar(s[i]);\n    putchar('\\n');\n}\n`,
  "1.10": `#include <stdio.h>\n\nint fahr, celsius;\n\nvoid convert(void);\n\nint main(void)\n{\n    for (fahr = 0; fahr <= 100; fahr += 20) {\n        convert();\n        printf("%d %d\\n", fahr, celsius);\n    }\n    return 0;\n}\n\nvoid convert(void)\n{\n    celsius = 5 * (fahr - 32) / 9;\n}\n`,

  /* ---- 章末习题 ---- */
  "1-1": `#include <stdio.h>\n\nint main(void)\n{\n    printf("hello, world\\n");\n    return 0;\n}\n`,
  "1-2": `#include <stdio.h>\n\nint main(void)\n{\n    printf("a\\tb\\tc\\n");\n    printf("a\\\\tb\\\\tc\\n");\n    return 0;\n}\n`,
  "1-3": `#include <stdio.h>\n\nint main(void)\n{\n    int c;\n    for (c = 0; c <= 100; c += 20)\n        printf("%d %d\\n", c, c * 9 / 5 + 32);\n    return 0;\n}\n`,
  "1-8": `#include <stdio.h>\n\nint main(void)\n{\n    int c, nblank, ntab, nnewline;\n    nblank = ntab = nnewline = 0;\n    while ((c = getchar()) != EOF) {\n        if (c == ' ') nblank++;\n        else if (c == '\\t') ntab++;\n        else if (c == '\\n') nnewline++;\n    }\n    printf("blank=%d tab=%d newline=%d\\n", nblank, ntab, nnewline);\n    return 0;\n}\n`,
  "1-12": `#include <stdio.h>\n\nint main(void)\n{\n    int c, inword;\n    inword = 0;\n    while ((c = getchar()) != EOF) {\n        if (c == ' ' || c == '\\t' || c == '\\n') {\n            if (inword) { putchar('\\n'); inword = 0; }\n        } else {\n            putchar(c);\n            inword = 1;\n        }\n    }\n    if (inword) putchar('\\n');\n    return 0;\n}\n`,
  "1-13": `#include <stdio.h>\n\nint main(void)\n{\n    int c, len, inword;\n    len = inword = 0;\n    while ((c = getchar()) != EOF) {\n        if (c == ' ' || c == '\\t' || c == '\\n') {\n            if (inword) { printf("%d\\n", len); len = 0; inword = 0; }\n        } else {\n            len++;\n            inword = 1;\n        }\n    }\n    if (inword) printf("%d\\n", len);\n    return 0;\n}\n`,
  "1-14": `#include <stdio.h>\n\nint main(void)\n{\n    int c, i;\n    int freq[26];\n    for (i = 0; i < 26; i++)\n        freq[i] = 0;\n    while ((c = getchar()) != EOF)\n        if (c >= 'a' && c <= 'z')\n            freq[c - 'a']++;\n    for (i = 0; i < 26; i++)\n        if (freq[i] > 0)\n            printf("%c %d\\n", 'a' + i, freq[i]);\n    return 0;\n}\n`
};

/* 与 app.js 的判题归一化保持一致：CRLF→LF、去行尾空白、去首尾空行 */
function normalize(s) {
  return String(s == null ? "" : s)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/* 提交编译；命中 429 时按次数递增等待后重试，最多 5 次 */
async function compile(code, stdin) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch("https://wandbox.org/api/compile.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ compiler: "gcc-13.2.0-c", code, stdin: stdin || "" })
    });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
      continue;
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  throw new Error("rate limited");
}

/* 汇总为「小节练习 + 章末习题」两类任务后顺序执行 */
(async function () {
  const tasks = [];
  L.sections.forEach((s) => tasks.push({
    key: s.id, kind: "小节练习",
    code: solutions[s.id], stdin: s.exercise.stdin, expected: s.exercise.expected
  }));
  L.bookExercises.forEach((x) => tasks.push({
    key: x.id, kind: "章末习题",
    code: solutions[x.id], stdin: x.stdin, expected: x.expected
  }));

  let pass = 0, fail = 0;
  for (const t of tasks) {
    if (!t.code) {
      console.log("[SKIP] " + t.key + " —— 无参考解");
      continue;
    }
    try {
      const res = await compile(t.code, t.stdin);
      if (res.status !== "0") {
        fail++;
        console.log("[FAIL] " + t.key + " 编译失败:\n" + (res.compiler_message || "").slice(0, 400));
        continue;
      }
      const ok = normalize(res.program_message) === normalize(t.expected);
      if (ok) { pass++; console.log("[ OK ] " + t.kind + " " + t.key); }
      else {
        fail++;
        console.log("[FAIL] " + t.key + "\n  expected: " + JSON.stringify(normalize(t.expected)) +
          "\n  actual  : " + JSON.stringify(normalize(res.program_message)));
      }
    } catch (e) {
      fail++;
      console.log("[ERR ] " + t.key + " " + e.message);
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
