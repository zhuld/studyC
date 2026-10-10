# 《C程序设计语言》交互读本

围绕 C 语言核心知识组织的 8 章 + 3 个附录的交互式课程。课程阅读区与可自由拖动、缩放、关闭的代码工作台彼此分离：
逐节阅读教材小节，随时把代码送进工作台在线编译，练习运行即自动判题。

纯静态页面，无构建步骤、无第三方运行时依赖，可直接部署到 GitHub Pages。

## 目录

- [项目概览](#项目概览)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [架构](#架构)
- [课程数据格式](#课程数据格式)
- [数据管线](#数据管线)
- [开发约定](#开发约定)
- [测试](#测试)
- [贡献指南](#贡献指南)
- [课程范围](#课程范围)
- [快捷入口](#快捷入口)
- [已知限制](#已知限制)
- [AI 辅助设计说明](#ai-辅助设计说明)
- [版权与许可](#版权与许可)

## 项目概览

**课程内容**

- **8 章、91 个 PDF 小节教程**（77 个主小节 + 14 个三级小节），按教材目录顺序逐节讲解，
  每节保留对应的原书页码。
- **附录 A/B/C 共 97 个小节教程**（参考手册 79、标准库 17、变更小结 1），作为目录第 9–11 条，
  编号显示为 A/B/C；它们是**只读的原书正文**——没有交互专题，也没有原书页码（`page` 为 `null`）。
- **64 个交互专题**（每章 7–10 个），每个专题含三部分：`theory` 讲解、`sample` 示例、
  `exercise` 练习（附标准答案与提示）。专题编号与 PDF 小节编号对齐，编号相同者直接配对。
- **第 1 章另有 7 道章末习题**（`bookExercises`），在正文之后单独成区。

**阅读与运行**

- **课程与代码分离**：切换章节不会覆盖工作台内容；从示例或练习载入代码时工作台自动展开。
- **教材正文可直接运行**：正文里「带 `main` 的完整程序」（当前 38 处）在代码块下方自动获得
  「载入编辑器 / ▶ 运行」入口，判定规则见 [code-blocks.js](code-blocks.js)。
- **在线编译**：调用 [Wandbox](https://wandbox.org) 公开 API（CORS 开放，浏览器直连，无需后端）。
  编译器下拉框由 `list.json` 中 `language === "C"` 的条目填充；C 标准可选
  （c89 / c99 / c11 …，取决于编译器），默认 **C89**——教材描述的是 ANSI C。
  支持 stdin 标准输入；Wandbox 不可用时退化为内置占位编译器，页面仍可打开。
- **自动判题**：程序输出与 `expected` 归一化后逐字比对（CRLF→LF、去每行行尾空白、去首尾空行），
  通过即盖章并把进度写入本地存档。
- **代码编辑器**：行号、C 语法高亮、Tab 缩进（4 空格，Shift+Tab 反缩进）、`Ctrl+Enter` 运行，
  零 CDN 依赖。
- **独立代码工作台**：可拖动、缩放、关闭；关闭后可从页面右下角重新打开，拖动与缩放均可用键盘操作；开合时带缩放动画（尊重 `prefers-reduced-motion`）。
- **三级瀑布式目录**：章 → 小节 → 三级小节逐级就地下拉，当前章默认展开，点带子节的父节开合其三级抽屉；
  窄屏下目录为浮层抽屉，选中叶级小节后自动收起。

## 快速开始

任意静态服务器即可（**不要**直接用 `file://` 打开：课程数据由 `fetch` 加载，需经 HTTP）：

```powershell
npx serve .
# 或
python -m http.server 8080
```

打开 `http://localhost:8080/`。

部署到 GitHub Pages：

1. 推送本目录到 GitHub 仓库；
2. 仓库 Settings → Pages → Source 选择 `main` 分支根目录；
3. 访问 `https://<用户名>.github.io/<仓库名>/`。

页面部署需要仓库根目录下的 `index.html`、`style.css`、`*.js`、`course-content.json` 与 `images/`；
`md/` 与 `tools/` 不参与部署。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `index.html` | 页面骨架：报头、左栏目录、右栏教程、浮动工作台；内容容器初始为空，由脚本填充 |
| `style.css` | 样式表；颜色一律走 CSS 变量 |
| `lessons.js` | 课程数据加载器：`fetch` + 结构校验 + 派生配对，就绪后广播事件 |
| `app.js` | 页面主逻辑：渲染、编辑器、在线编译、判题、进度与本地存储 |
| `code-blocks.js` | 教材正文代码块的「可在线编译」判定（页面与测试共用同一份规则） |
| `course-content.json` | 课程数据：8 章 + 3 个附录 / 188 小节 / 64 专题 / 7 道章末习题 |
| `images/` | 教程插图（由管线从 `md/images/` 复制），页面直接引用 |
| `md/` | 书稿：`md/README.md` 目录页 + 13 个章节文件 + `md/images/`，是课程数据的唯一来源 |
| `tools/` | 开发辅助脚本：数据管线与回归测试，不参与页面部署 |
| `c-programming-language-2nd-edition-simple-chinese.pdf` | 教材 PDF，管线的输入与人工核对依据（体积较大，不入版本控制） |

页面侧的渲染与交互集中在 `app.js` 一个文件里（约 1 200 行）；`lessons.js` 与 `code-blocks.js` 各自
只负责一件事（数据加载、代码块判定），都在 100 行以内。`tools/pdf_to_md.py` 是最大的一段工具代码，
`style.css` 与 `app.js` 规模相当。

## 架构

### 模块与加载顺序

页面按依赖顺序加载三个脚本，顺序不可调换：

```html
<script src="lessons.js"></script>     <!-- 课程数据 → window.CHAPTERS / window.CHAPTER1 -->
<script src="code-blocks.js"></script> <!-- 判定规则 → window.KRC_CODE_BLOCKS -->
<script src="app.js"></script>         <!-- 渲染与全部交互 -->
```

初始化链路：

1. `<head>` 内的内联脚本在首屏绘制前读取 `localStorage`，写入 `toc-collapsed` 类，避免样式跳变。
2. `lessons.js` 拉取 `course-content.json`，**快速失败**式校验：章数必须为 11（8 章 + 3 个附录），每章需有
   `meta`/`sections`/`tutorials`/`bookExercises`，专题编号必须唯一，教程字段与段落数下限必须满足；
   附录（`meta.kind === "appendix"`）另走一支：`sections` 必须为空、小节不得带页码与 `sectionId`、
   正文只需有内容、`theory` 可为空；随后做一次派生 ——
   把每个交互专题挂到编号相同的教程上（`tutorial.practiceSectionId`），未被任何教程认领的专题
   归入 `chapter.extraSections`。最后设定 `window.CHAPTERS` / `window.CHAPTER1` 并广播
   `course-content-ready`；失败则设 `window.COURSE_CONTENT_ERROR` 并广播 `course-content-error`。
3. `code-blocks.js` 以 UMD 包装导出 `isRunnableProgram(code)`（Node 下 `require` 可拿到同一份实现）。
4. `app.js` 监听就绪事件后执行 `init()`：恢复主题 → 绑定工作台与编辑器 → 渲染第 1 章 → 拉取编译器列表。

### 渲染

每章的渲染顺序（都在 [`app.js`](app.js) 的「渲染教程」区段内）：

| 函数 | 产出 |
| --- | --- |
| `renderChapterNav()` | 左栏三级瀑布式目录：每章一个 `.chapter-item`（章节按钮 + 内嵌小节抽屉）；编号栏正文章显示 `01…08`、附录显示 `A`/`B`/`C` |
| `renderChips()` | 当前章抽屉内的小节 chips（目录的第二、三级）：两段编号的二级小节直挂，三段编号的三级小节收进父节 `.chip-group` 抽屉（点父节开合），其后是目录外补充专题与章末习题入口；附录小节没有原书页码，chip 不带页码提示 |
| `renderSections()` | 正文：按 PDF 顺序输出小节（`1.5` → `h2`、`1.5.1` → `h3`，附录的 `A.1` → `h2`、`A.2.1` → `h3` 同理），再输出补充专题；配套示例/练习卡片紧随其小节正文 |
| `renderBookExercises()` | 章末习题卡片 |
| `decorateRunnableCode()` | 给正文中命中判定的代码块追加「载入编辑器 / ▶ 运行」按钮 |
| `setupSpy()` | 滚动高亮：`IntersectionObserver` 触发后按几何选出「顶边已越过视口 25% 横线的最后一个小节」高亮；当前项为三级小节时自动展开其父组 |
| `selectChip()` | 点击 chip 时立即高亮并「锁定」（用户真实滚动 wheel/触摸/按键后才交还滚动侦测），避免平滑跳转途中高亮被上一长节抢占而错位 |

DOM 元素之间靠 `data-*` 属性约定通信，新增元素时请沿用同一命名：

| 属性 | 用途 |
| --- | --- |
| `data-chapter` | 目录中的章节序号 |
| `data-outline-topic` | 滚动高亮定位（PDF 小节编号，或 `extra:<专题号>`） |
| `data-practice-sec` / `data-practice-section` | 进度标记（专题编号） |
| `data-ex` / `data-judge-card` | 示例、练习卡片与判题结果回填 |
| `data-act` | 卡片内按钮的动作类型 |
| `data-sec` | 正文小节锚点 |

### 编辑器与工作台

编辑器是「高亮层 + 透明 `textarea`」的叠放结构：`#hl` 渲染着色后的代码（不可交互），`#code` 负责输入与光标，
行号列 `#gutter` 与之同高；三者都绝对定位、自身不产生滚动条，因此 `syncScroll()` 必须把 `textarea`
的滚动位置同步给高亮层与行号列，否则文字与光标会错位。

`highlight()` 用单趟正则按「注释 → 字符串/字符 → 预处理行 → 数字 → 标识符」的优先级交替匹配，
每段先转义再包 `span`，因此注释与字面量内部的词不会被后续分组重复着色。

工作台是 `position: fixed` 的浮层，拖动标题栏与右下角缩放手柄都使用 pointer capture，指针移出窗口也不会丢失拖动；
尺寸与位置始终被夹在视口内（留 12px 边距）；无鼠标时可用方向键（Shift 加速）。

### 在线编译与判题

- 编译器列表来自 `https://wandbox.org/api/list.json`，取 `language === "C"` 的条目；
  取不到时退化为仅含 `gcc-13.2.0-c` 的占位配置（下拉框会标注「占位配置」）。
- 运行把编辑器内容、`stdin`、编译器名与标准选项提交到 `https://wandbox.org/api/compile.json`；
  请求期间 `state.running` 为真，运行按钮禁用，避免并发提交。
- Wandbox 的 `status` 非 `"0"` 并不等于编译失败，判错以编译器消息为准。
- 判题只比对 stdout 与 `exercise.expected`（**归一化规则必须与 [`tools/test_judge.js`](tools/test_judge.js) 保持一致**）；
  载入示例或正文代码时判题上下文为 `null`，运行后不判题。

### 本地存储

页面用 `localStorage` 记录偏好与进度，清除浏览器数据即恢复默认：

| 键 | 用途 | 写入方 |
| --- | --- | --- |
| `krc-course-toc-collapsed-v1` | 目录是否收缩（窄屏默认收缩） | `index.html` 内联脚本（读）、`app.js`（写） |
| `krc-course-chapter-v1` | 上次阅读的章节 | `app.js` `selectChapter()` |
| `krc-ch1-progress-v1` | 已通过的专题与习题（编号 → 时间戳） | `app.js` `saveProgress()` |

所有读写都包在 `try/catch` 中：隐私模式等场景下 localStorage 不可用，页面按默认状态继续渲染。

## 课程数据格式

`course-content.json` 是一个长度为 11 的数组：前 8 个元素是正文章，后 3 个是附录（`meta.kind = "appendix"`）：

```jsonc
{
  "meta": {
    "kicker":  "KERNIGHAN & RITCHIE · THE C PROGRAMMING LANGUAGE · 2ND EDITION",
    "chapter": "第 1 章　导言",
    "blurb":   "章首导言首段（纯文本，由管线从书稿同步）"
  },
  "tutorials": [
    {
      "number":    "1.5.1",         // PDF 小节编号，章内与全课程唯一
      "title":     "文件复制",
      "page":      31,              // 原书页码
      "sectionId": "1.5",           // 指向本章 sections 中的专题
      "paragraphs": ["<p>…</p>"],   // 该节标题下的前两个块（块级 HTML）
      "theory":     ["<p>…</p>"]    // 其余块；无二级标题时可只留导语
    }
  ],
  "sections": [
    {
      "id":    "1.5",
      "title": "字符输入/输出",
      "theory":   ["<p>…</p>"],                                    // 讲解，≥300 字
      "sample":   { "label": "书中示例 1-5　…", "code": "…", "stdin": "" },
      "exercise": {
        "prompt":   "题干（可含 HTML）",
        "starter":  "初始代码，含 TODO",
        "stdin":    "标准输入",
        "expected": "标准答案输出",
        "hint":     "提示"
      }
    }
  ],
  "bookExercises": [
    { "id": "1-1", "title": "运行 hello, world",
      "prompt": "…", "starter": "…", "stdin": "", "expected": "…", "hint": "…" }
  ]
}
```

要点：

- **`tutorials`（188 个：91 正文 + 97 附录）与 `sections`（64 个）数量不同、职责不同。** 前者是逐节正文，
  `paragraphs` / `theory` / `meta.blurb` 由管线从书稿同步；后者是人工撰写的交互专题，
  管线完全不触碰（`id` / `title` / `theory` / `sample` / `exercise` 全部保持原样）。
- **附录章节整章由管线从书稿生成**，没有 JSON 写入骨架，形如：

  ```jsonc
  {
    "meta": { "kicker": "APPENDIX A · REFERENCE MANUAL",
              "chapter": "附录A 参考手册",
              "kind": "appendix",           // 正文章不带该字段
              "blurb": "首段纯文本" },
    "sections": [],                          // 只读正文，没有交互专题
    "bookExercises": [],
    "tutorials": [
      { "number": "A.2.1", "title": "记号", "page": null,
        "paragraphs": ["<p>…</p>", "<pre class=\"card-code\">…</pre>"],
        "theory": [] }                       // 原书正文全进 paragraphs，不占课程讲解槽
    ]
  }
  ```

  附录 C 的书稿没有 `##` 标题，整篇被合成为一个小节 `C.1`。
- `theory` 与 `paragraphs` 是块级 HTML 字符串数组，段落顺序严格保持书稿中的出现顺序。
- `practiceSectionId` 与 `extraSections` **不存储在 JSON 中**，由 `lessons.js` 在加载时派生。
- `expected`、`stdin` 与判题归一化规则共同构成题目的契约；改题时同步更新
  [`tools/test_judge.js`](tools/test_judge.js) 里的参考解法。
- 章末习题当前只在第 1 章提供，其余章（含附录）为空数组。

## 数据管线

书稿由教材 PDF 生成，但**`md/` 经人工整理，是课程数据的唯一来源**（已纳入版本控制）：

```powershell
python tools/pdf_to_md.py            # 第 1 步：PDF → md/*.md（仅当 md/ 尚无书稿时执行）
python tools/pdf_to_md.py --force    # 第 1 步强制重跑：整体覆盖 md/ 并清理未再生成的旧图片
python tools/md_to_course.py         # 第 2 步：md/*.md → course-content.json（并复制插图到 images/）
python tools/md_to_course.py --verify  # 只做一致性校验，不改写 JSON、不复制图片
```

日常修改教程**只跑第 2 步**即可。第 1 步默认拒绝覆盖已有 `md/`：脚本原始输出与人工整理后的书稿并不相同
（句读、图题注、三级小节标题、图片命名都有差异），重跑会丢失这些整理结果，必须显式加 `--force`。

两个脚本都按自身位置（`tools/`）回退一级定位输入输出，因此可在任意目录调用（通常在仓库根目录执行）。

**[`tools/pdf_to_md.py`](tools/pdf_to_md.py)**

用 `pypdf` 读取文字坐标与字体信息，先按 y 聚行重建页面视觉行，再依据 PDF 内嵌书签把全书切成
「前言与序 / 各章 / 附录 / 索引」等输出单元，逐单元渲染为 Markdown：
Courier 字体占比高者判为代码行（按行首 x 换算成等宽空格缩进）、跨页的裸页码按 y 坐标剔除、
插图按内容 SHA-1 去重后落盘为 `md/images/`。原书内置的多栏「目录」页无法按行重建，整页跳过，
改由 `write_readme()` 依据书签生成等效目录 `md/README.md`。

输出是确定的：同一 PDF 每次运行得到逐字节相同的结果（不依赖时间戳或随机数）。
每次运行会删除 `md/images/` 中本次未再生成的旧图片。

**[`tools/md_to_course.py`](tools/md_to_course.py)**

按书稿自带的 `## x.y` / `### x.y.z` 标题切分小节，把块级内容转成 HTML，然后：

- `meta.blurb` ← 章首导言首段（去标记纯文本）；
- 每节的 `paragraphs` ← 该节标题下的前两个块，`theory` ← 其余块合并；
- 首节的块包含章首导言，因此导言也随之进入 `1.1`；
- 三级小节只取自身标题下的正文，父节不再吞并三级小节的内容；
- 同步复制书稿引用的图片到 `images/`。

`sections`、`bookExercises`、`page`、`sectionId` 等手工维护的字段一律保持不动——管线只搬运书稿文字。

**附录是例外**：`md/09~11-附录X-*.md` 在 JSON 里没有写入骨架，整章由 `build_appendix()` 生成后追加在第 8 章之后
（重复运行会原位重建，不重复追加）。差别有三处：小节编号允许字母前缀（`## A.1` / `### A.2.1`）；
该节的**全部块**都进 `paragraphs`（`theory` 是课程讲解专用的样式槽，原书正文用不上）；
`page` 记为 `null`（附录 md 不含原书页码）、不带 `sectionId`。附录 C 的书稿没有 `##` 标题，
整篇导言被合成为一个小节 `C.1`。

写盘前有三道断言护栏：JSON 必须是 8 章或「8 章 + 3 附录」且第 9 章起只能是附录、八章的章数必须为 8、
md 与 JSON 的小节编号集合必须完全一致。写盘后立即做
**双向校验**：每节 md 纯文本 ⇔ JSON 去标签文本逐节相等（八章与附录同一套比对）、图片数量一致；不一致则打印首个差异位置并以退出码 1 结束。
`--verify` 只做这一步校验（要求 JSON 已含附录章节），适合提交前检查。

## 开发约定

- **无构建、无第三方运行时依赖**：浏览器端统一使用 ES5 写法（`var` + 字符串拼接），不引入打包器或 CDN 库；
  改完直接刷新页面。
- **注释与文案使用简体中文**，代码注释只写需要澄清的地方。
- **数据与页面解耦**：增改教程内容只动 `course-content.json`（或 `md/` + 管线），不碰页面代码。
- **单一事实来源**：正文代码块的可编译判定只在 [`code-blocks.js`](code-blocks.js) 里实现一次，
  页面与 Node 测试共用；判题归一化规则只在 `app.js` 与 `tools/test_judge.js` 各有一份，改动必须同步。
- **样式走变量**：颜色、圆角、字体一律经 CSS 变量；半透明色用 `color-mix` 从主题色派生，
  新增一种颜色通常只需在 `style.css` 的 `:root` 块加一行。
- **可访问性**：工作台的拖动/缩放/关闭都有键盘替代操作，动态区域带 `aria-*` 标注。

## 测试

`tools/` 下有 3 个测试脚本，前两个不联网：

```powershell
node tools/test_course_data.js    # 课程数据回归（离线）
node tools/test_code_blocks.js    # 正文代码块判定回归（离线）
node tools/test_judge.js          # 端到端判题验证（需联网，会调用 Wandbox）
```

| 脚本 | 覆盖内容 |
| --- | --- |
| `test_course_data.js` | 章数（8 章 + 3 附录）、附录标记与位置、编号唯一性、每章专题数下限、`theory` 篇幅（≥300 字）、示例/练习字段齐备、正文章教程页码合法与专题对应关系、附录小节不得带页码/专题、每章正文总篇幅（正文 ≥10 000 字、附录 ≥1 000 字）、全课程固定总量（64 个专题 / 188 个教程），并拒绝连续问号等编码损坏 |
| `test_code_blocks.js` | 用同一份判定规则扫描 740+ 个正文代码块，核对「可编译完整程序」的命中分布（38 块，逐小节计数）与被排除分布（跨块片段、书中省略写法、代码+中文旁注排版块），并独立复核花括号配平与非 ASCII 残留 |
| `test_judge.js` | 拿每道题的参考解法真跑 Wandbox，与 `expected` 归一化比对；带退避重试与请求间隔（人工验证工具） |

提交前请至少跑通前两个；改动题目或正文代码块时再跑第三个。

## 贡献指南

**修订教程正文（PDF 小节与附录）**

1. 改 `md/NN-第N章-*.md` 或 `md/NN-附录X-*.md`（正文的唯一来源）；
2. `python tools/md_to_course.py`；
3. `node tools/test_course_data.js` 与 `node tools/test_code_blocks.js`。

附录章节在 `course-content.json` 里没有骨架，整章由管线按书稿重建：**不要手工改第 9 章之后的内容**，
跑一次管线就会被覆盖；新增/删除附录小节只需改书稿。

**新增或修改交互专题**

1. 在 `course-content.json` 对应章的 `sections` 中增删改条目（`id` 需落在本章编号空间内且全局唯一）；
2. 若该专题要与某个 PDF 小节配对显示，令字符串编号与教程 `number` 相同（不同则退回该专题的第一个教程）；
   目录之外的扩展专题会自动归入「补充专题」；
3. 新增题目后，在 [`tools/test_judge.js`](tools/test_judge.js) 的 `solutions` 中补上参考解法，再跑：
   `node tools/test_course_data.js`、`node tools/test_judge.js`；
4. 若专题总数不再是 64、或教程总数不再是 188（91 正文 + 97 附录），
   同步修改 `test_course_data.js` 末尾的固定总量断言（该数字属课程契约）。

**新增可在线运行的正文代码块**

无需登记：只要代码块在去掉注释与字面量后花括号配平、不含非 ASCII 字符、且定义了 `main`
（三种排除情形见 `code-blocks.js` 头部注释），页面就会自动加按钮。
若改动了判定规则，必须同步更新 `test_code_blocks.js` 中的 `EXPECTED_HITS` / `EXPECTED_EXCLUDED` 分布。

**页面与样式改动**

改 `index.html` / `style.css` / `app.js`，刷新页面自测；新增 DOM 元素时沿用 `data-*` 约定（见[架构](#架构)）。
改动判题归一化规则时，务必同步 `app.js` 与 `tools/test_judge.js`。

## 课程范围

教程依据以下教材，按其次序与小节组织，正文章课程数据保留每节对应的原书页码（附录小节无页码，`page` 为 `null`）：

- 《C程序设计语言（第2版·新版）》，机械工业出版社 2004-1，ISBN 9787111128069，徐宝文 等译
- 原书 *The C Programming Language*, 2nd ed., Prentice Hall 1988, ISBN 0-13-110362-7
  ——该书迄今最新的正式版本

示例与练习为可交互专题；目录之外的扩展专题在目录中单独标注为「补充」。附录 A/B/C 是只读的原书正文，
不配交互专题，在目录中以编号 A/B/C 紧跟在第 8 章之后。

| 章节 | 覆盖重点 |
| --- | --- |
| 1 | 入门、变量、循环、字符流、数组、函数与作用域 |
| 2 | 类型、常量、声明、运算符、条件表达式与求值规则 |
| 3 | 分支、循环、结构化退出、标号与跳转 |
| 4 | 函数、递归、作用域、存储期、初始化与预处理 |
| 5 | 指针、数组、字符串、命令行参数、函数指针与复杂声明 |
| 6 | 结构体、结构指针、自引用结构、查找、联合与函数接口 |
| 7 | 格式化 I/O、流、文件、错误处理、变长参数与标准库工具 |
| 8 | 文件描述符、低级 I/O、缓冲字符读取、分配器、目录接口与随机访问 |
| A | 参考手册：词法、语法、声明、语义与预处理，直至 A.13 语法总结（79 节） |
| B | 标准库：stdio / ctype / string / math 等头文件的函数清单（17 节） |
| C | 变更小结：第 1 版 C 与 ANSI C 的差异逐条列举（1 节） |

## 快捷入口

- `?autorun=sample`：打开页面后自动运行 1.1 示例
- `?autorun=judge`：打开页面后自动载入并运行 1.1 练习判题

## 已知限制

- 判题的进度存档键沿用早期的 `krc-ch1-progress-v1` 命名，实际记录全部章节的进度；
  改名会使既有用户丢失进度，故只在必要时才动。
- 章末习题目前只有第 1 章（7 道），其余章为空。
- 附录书稿里有不少 PDF 版面重建的遗留：被换行切断的句子会落进 ``` 围栏，
  页面照原样渲染成代码块（正文章的「说明：」框同样如此）。修复需要改 `md/` 书稿，未在本次范围内。
- 在线编译完全依赖 Wandbox：服务不可用时只能编译占位配置，页面其余功能正常。
- `md/` 一旦被 `pdf_to_md.py --force` 覆盖，人工整理成果即丢失，只能靠版本控制找回。

## AI 辅助设计说明

本项目在界面构思、视觉设计、部分课程内容整理及代码实现过程中使用了 AI 工具辅助。
AI 生成的建议和内容均由项目维护者审阅、修改，并通过课程数据检查、语法检查及练习回归测试验证。
AI 工具仅作为辅助，不替代教材、C 语言标准或人工核对。

## 版权与许可

- 本项目**原创**的部分——页面代码（`index.html`、`style.css`、`*.js`）、`tools/` 脚本，
  以及 `sections` 中的讲解、示例与练习——依照仓库根目录的 [MIT License](./LICENSE) 授权。
- **教材内容不属于本项目授权范围。** `md/` 书稿与 `course-content.json` 中 188 个小节的正文
  （91 个正文章 PDF 小节 + 97 个附录小节），由 `tools/pdf_to_md.py` 从教材 PDF 的文本层重建而来，
  本身即《C程序设计语言（第2版）》中文译本的文字，
  版权归原作者与出版方所有。教材 PDF 不入版本控制（见 [.gitignore](./.gitignore)），
  但由其重建的书稿已纳入版本控制，**未获授权前请勿公开分发仓库**。
- 本项目与教材的作者、译者、出版方无隶属或授权关系，仅供个人学习使用。
