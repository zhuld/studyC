#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""md_to_course.py —— 流水线第 2 阶段: 分章 Markdown → course-content.json。

读取 pdf_to_md.py 生成的前言、八章书稿与三个附录, 把每节正文解析成块级
HTML 后写回课程数据 course-content.json, 并同步图片。本脚本只更新课程
内容数据, 不改动页面(HTML/CSS/JS)。

输入:
    md/00-前言与序.md     前言书稿 (`## ` 为各篇序言标题, 见 PREFACE_FILE)
    md/NN-第N章-*.md     八章书稿 (见下方 CHAPTER_FILES)
    md/NN-附录X-*.md     附录书稿 (见下方 APPENDIX_FILES)
    md/images/*          书稿引用的图片
    course-content.json  既有课程数据 (八章的章节/小节编号作为写入骨架)
输出:
    course-content.json  章节顺序为「前言 → 八章 → 三个附录」共 12 章;
                         前言与附录由书稿全量生成, 八章的 paragraphs
                         被 md 正文覆盖
    images/*             从 md/images/ 复制来的图片 (程序根目录)

命令行用法(在仓库根目录执行):
    python tools/md_to_course.py            # 写入 JSON 并复制图片, 随后自校验
    python tools/md_to_course.py --verify   # 只做 md ⇔ JSON 一致性校验, 不写文件

写入规则:
    - md 中 `## x.y` 是教材主小节, `### x.y.z` 是第三级小节; 二者与 JSON 里
      91 个 tutorials 的编号一一对应 (77 主小节 + 14 三级小节)
    - 行内标记: 除 `code`、**粗体** 外, 段落还支持行内上标 ^x^ 与下标 ~x~,
      分别转成 <sup>x</sup> / <sub>x</sub> (如 10^38^ → 10<sup>38</sup>,
      H~2~O → H<sub>2</sub>O); 分隔符之间的内容须是至多 12 个不含空白的
      字母/数字/运算符字符且至少含一个字母或数字, code 片段内不转换,
      因此按位取反 ~077、异或 x ^ y、字符 '~' 等写法不受影响
    - 每节的 paragraphs 只取「该节标题之下的正文」: 三级小节
      (subsection) 显示 `### x.y.z` 的内容, 其原有内容被 md 正文覆盖清除;
      父节不再吞并三级正文
    - 小节编号与标题等手工字段保持不变
    - 前言书稿的 `## ` 标题是各篇序言的标题 (出版者的话 / 中文版序 / …),
      无编号, 按出现顺序合成 0.1, 0.2, …; 章标题取自文件名「前言与序」;
      整章由书稿生成: meta.kind = "preface"、置于章节列表最前
    - 附录的编号带字母前缀 (`## A.1` / `### A.2.1`), 且 JSON 里没有对应骨架,
      整章由书稿生成: meta.kind = "appendix"、全部块进 paragraphs
    - 附录 C 的书稿只有 h1 没有任何 `##` 标题, 整篇合成为一个小节
    - 表格: 连续行若由「表头行 + 分隔行 + 数据行」构成(每行都含 `|`, 分隔行
      单元格形如 `---`/`:---:`/`---:`), 整块转成 <div class="table-scroll">
      包裹的 <table>: 表头 <th>、数据 <td>, 对齐标记写成 text-align 内联样式;
      单元格内可用与段落相同的行内标记; 其余含 `|` 的行仍是普通段落;
      单元格内要写竖线字符本身时用 `\\|` / `\\vert` (单竖线) 或 `\\Vert`
      (双竖线 `||`) 转义, 拆列时不当作分隔符, 渲染前还原
      (如表 2-1 的按位或/按位或运算符行)

关键设计约束:
    - 只搬运已经过版面重建的文字, 不转录原著正文, 以规避版权风险。
    - 输出确定: 章节顺序与块顺序严格保持 md 中的出现顺序, 不排序、不去重。
    - 自校验: 写完立即做「md ⇔ JSON」逐节文本比对, 不一致即退出码 1。
      (完整回归另需 node 跑 tools/test_*.js)
"""
from __future__ import annotations

import html
import json
import re
import shutil
import sys
from pathlib import Path

# ---------- 路径与章节清单 ----------

# 脚本位于 tools/, 输入输出都在上一级(仓库根目录)
BASE = Path(__file__).resolve().parent.parent
MD_DIR = BASE / "md"
JSON_PATH = BASE / "course-content.json"
IMG_DST = BASE / "images"

# 前言书稿: h1 是各篇序言的标题, 没有编号; 整章由书稿生成后置于最前
PREFACE_FILE = "00-前言与序.md"

# 顺序必须与 JSON 中的 8 章一致; 缺文件会直接抛错, 避免写错章节
CHAPTER_FILES = [
    "01-第1章-导言.md",
    "02-第2章-类型、运算符与表达式.md",
    "03-第3章-控制流.md",
    "04-第4章-函数与程序结构.md",
    "05-第5章-指针与数组.md",
    "06-第6章-结构.md",
    "07-第7章-输入与输出.md",
    "08-第8章-UNIX系统接口.md",
]

# 附录书稿: 没有 JSON 写入骨架, 整章由书稿生成后追加在第 8 章之后
APPENDIX_FILES = [
    "09-附录A-参考手册.md",
    "10-附录B-标准库.md",
    "11-附录C-变更小结.md",
]

# 整块图片: 一行或多行成块后就是 ![](images/...), 用 $ 锚定到块尾
IMAGE_BLOCK_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)\s*$")
# 行内代码 `...` 与行内粗体 **...**
INLINE_CODE_RE = re.compile(r"`([^`]+)`")
INLINE_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
# 行内上标 ^x^ 与下标 ~x~ (如 10^38^、x^y^、H~2~O):
# 内容限定为至多 12 个不含空白的字母/数字/运算符字符, 转换时还要求至少含一个
# 字母或数字——否则正文与代码里的按位取反 ~077、异或 x ^ y、字符 '~' 等写法
# 会被误伤; code 片段(行内与围栏)整体不参与转换
SCRIPT_BODY = r"[A-Za-z0-9+\-*/().,%×=]{1,12}"
SUP_MARK_RE = re.compile(r"\^(%s)\^" % SCRIPT_BODY)
SUB_MARK_RE = re.compile(r"~(%s)~" % SCRIPT_BODY)
# 主小节编号 x.y 与三级小节编号 x.y.z
SECTION_NUM_RE = re.compile(r"^\d+\.\d+$")
SUB_NUM_RE = re.compile(r"^\d+\.\d+\.\d+$")
# 附录小节编号 A.1 与三级编号 A.2.1 (字母前缀是附录与正文章的唯一差别)
APPX_SECTION_NUM_RE = re.compile(r"^[A-Z]\.\d+$")
APPX_SUB_NUM_RE = re.compile(r"^[A-Z]\.\d+\.\d+$")
# 表格分隔行的单个单元格: `---` / `:---` / `---:` / `:---:` (至少一个 `-`)
TABLE_SEP_CELL_RE = re.compile(r"^:?-+:?$")
# 表格行的单元格分隔符: 未转义的 `|` (`\|` 是单元格内的字面竖线, 不切)
TABLE_CELL_SEP_RE = re.compile(r"(?<!\\)\|")
# 「附录C 变更小结」→ 字母 C 与标题「变更小结」
APPX_H1_RE = re.compile(r"^附录\s*([A-Z])\s*(.*)$")
# 「00-前言与序.md」→ 章标题「前言与序」
PREFACE_TITLE_RE = re.compile(r"^\d+-")


# ---------- Markdown 解析 ----------

class Block:
    """md 内容块: kind = p(段落) | code(围栏代码) | img(图片) | table(表格)。

    解析阶段填入 text/alt/src, build_html 阶段生成两种 HTML 表示:
    inner 为不含 <p> 的内联 HTML, full 为块级 HTML (写入 paragraphs)。

    Attributes:
        kind: 块类型, "p"/"code"/"img"/"table"。
        text: p 为段落原文; code 为代码正文(不含围栏); table 为表格原文
            (表头行 + 分隔行 + 数据行); img 为 ""。
        alt: 图片替代文本。
        src: 图片路径(相对 md/)。
        rows: 仅 table: 各行单元格原文, rows[0] 是表头行。
        aligns: 仅 table: 每列对齐方式, "left"/"center"/"right"/""(默认)。
        inner: 内联 HTML, 仅 p 有值。
        full: 块级 HTML。
    """

    def __init__(self, kind: str, text: str = "", alt: str = "", src: str = "",
                 rows: list | None = None, aligns: list | None = None):
        """初始化内容块。

        Args:
            kind: 块类型, "p"/"code"/"img"/"table"。
            text: 段落原文、代码正文或表格原文。
            alt: 图片替代文本。
            src: 图片路径。
            rows: table 的各行单元格原文 (含表头行)。
            aligns: table 的每列对齐方式。

        Side effects:
            无。
        """
        self.kind = kind
        self.text = text      # p: 段落原文; code: 代码正文(不含围栏); img: ""
        self.alt = alt
        self.src = src
        self.rows = rows or []    # table: 各行单元格原文, [0] 为表头
        self.aligns = aligns or []
        self.inner = ""       # p: 不含 <p> 的内联 HTML
        self.full = ""        # 块级 HTML (写入 paragraphs)

    def build_html(self) -> "Block":
        """按类型生成 inner/full 两种 HTML 表示。

        Returns:
            self, 便于链式调用 (解析时即 build_html())。

        Side effects:
            就地写入 self.inner / self.full。
        """
        if self.kind == "p":
            self.inner = md_inline_to_html(self.text)
            self.full = "<p>" + self.inner + "</p>"
        elif self.kind == "code":
            self.full = ('<pre class="card-code">'
                         + html.escape(self.text) + "</pre>")
        elif self.kind == "img":
            self.full = '<img src="%s" alt="%s">' % (self.src, self.alt)
        elif self.kind == "table":
            def cell(tag: str, txt: str, i: int) -> str:
                """单个单元格: 对齐方式写成内联 style, 内容走行内标记转换。"""
                align = self.aligns[i] if i < len(self.aligns) else ""
                style = (' style="text-align:%s"' % align) if align else ""
                return "<%s%s>%s</%s>" % (tag, style,
                                          md_inline_to_html(txt), tag)

            parts = ['<div class="table-scroll"><table>', "<thead><tr>"]
            parts += [cell("th", c, i) for i, c in enumerate(self.rows[0])]
            parts.append("</tr></thead><tbody>")
            for row in self.rows[1:]:
                parts.append("<tr>")
                parts += [cell("td", c, i) for i, c in enumerate(row)]
                parts.append("</tr>")
            parts.append("</tbody></table></div>")
            self.full = "".join(parts)
        return self


def convert_scripts(s: str) -> str:
    """把行内上标 `^x^` 与下标 `~x~` 转成 `<sup>x</sup>` / `<sub>x</sub>`。

    内容须至少含一个字母或数字, 否则整对分隔符保持原样
    (如 `~(~` 不是下标标记)。

    Args:
        s: 已转义、且 code 片段已替换成占位符的行内文本。

    Returns:
        转换后的 HTML 片段; 不含 code 片段。

    Side effects:
        无。
    """
    def repl(m: re.Match, tag: str) -> str:
        """有字母/数字的内容才转换, 否则原样返回。"""
        body = m.group(1)
        if not re.search(r"[A-Za-z0-9]", body):
            return m.group(0)
        return "<%s>%s</%s>" % (tag, body, tag)

    s = SUP_MARK_RE.sub(lambda m: repl(m, "sup"), s)
    s = SUB_MARK_RE.sub(lambda m: repl(m, "sub"), s)
    return s


def md_inline_to_html(text: str) -> str:
    """把行内标记转换为 HTML。

    先整体转义 &<> , 再处理 `code`、**粗体** 与上下标 ^x^ / ~x~。为避免先
    转义再匹配时把 code 内部的内容当作标记处理, code 片段先替换成
    \\x00<序号>\\x00 占位符, 其余标记处理完后再换回 <code>…</code>。

    Args:
        text: 段落原文(可能含 `code`、**粗体**、^上标^、~下标~)。

    Returns:
        转义并转换后的 HTML 片段; 不含 <p> 标签。

    Raises:
        ValueError: 原文含保留字符 \\x00(占位符冲突)。

    Side effects:
        无。
    """
    if "\x00" in text:
        raise ValueError("段落含保留字符 \\x00")
    s = html.escape(text, quote=False)
    spans: list[str] = []

    def stash(m: re.Match) -> str:
        """把 code 片段暂存并换成不会与正文冲突的占位符。"""
        spans.append(m.group(1))
        return "\x00%d\x00" % (len(spans) - 1)

    s = INLINE_CODE_RE.sub(stash, s)
    s = INLINE_BOLD_RE.sub(lambda m: "<strong>" + m.group(1) + "</strong>", s)
    s = convert_scripts(s)
    s = re.sub(r"\x00(\d+)\x00",
               lambda m: "<code>" + spans[int(m.group(1))] + "</code>", s)
    return s


def split_heading(rest: str) -> tuple[str, str]:
    """把标题行去掉 `#` 后的剩余文字拆成编号与标题。

    `A.2.5 常量` → ("A.2.5", "常量"); `1.5.1. 文件复制` 去掉尾点后得
    ("1.5.1", "文件复制"); 只有编号没有标题时标题为空串。

    Args:
        rest: 去掉 `#` 前缀与首尾空白后的标题行。

    Returns:
        (编号, 标题) 二元组。

    Raises:
        ValueError: 标题行里没有编号。

    Side effects:
        无。
    """
    parts = rest.split(None, 1)
    if not parts:
        raise ValueError(f"空标题行: {rest!r}")
    num = parts[0].rstrip(".")
    title = parts[1].strip() if len(parts) > 1 else ""
    return num, title


def read_h1(path: Path) -> str:
    """读取书稿的 h1 章标题 (如「附录A 参考手册」)。

    Args:
        path: 书稿 md 文件路径。

    Returns:
        h1 标题文字; 文件开头没有 h1 时返回空串。

    Raises:
        FileNotFoundError: 文件不存在。

    Side effects:
        无(只读取 md 文件)。
    """
    if not path.exists():
        raise FileNotFoundError(path)
    for line in path.read_text(encoding="utf-8").split("\n"):
        if line.startswith("# "):
            return line[2:].strip()
        if line.strip():
            break
    return ""


def split_appendix_h1(h1: str) -> tuple[str, str]:
    """拆出附录字母与小节标题:「附录C 变更小结」→ ("C", "变更小结")。

    Args:
        h1: 附录书稿的 h1 标题。

    Returns:
        (字母, 标题); 不符合「附录X …」时字母为空串、标题原样返回。

    Side effects:
        无。
    """
    m = APPX_H1_RE.match(h1)
    if not m:
        return "", h1
    return m.group(1), m.group(2).strip() or h1


def split_table_cells(line: str) -> list[str]:
    """拆出表格一行中的各单元格原文。

    去掉首尾空白后, 两端未转义的 `|` 是行边界而不是单元格分隔符;
    中间每个未转义的 `|` 分隔一个单元格, 单元格内的 `\\|` / `\\vert`
    是竖线字符本身的转义写法, 此处保留原样由 unescape_table_cell 处理;
    单元格自身再去掉首尾空白。

    Args:
        line: 表格中的一行原文。

    Returns:
        单元格原文列表(可能含空串), 仍含转义序列。

    Side effects:
        无。
    """
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    # 仅当行尾 `|` 未被转义时才是行边界 (`\|` 是内容里的字面竖线)
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip() for c in TABLE_CELL_SEP_RE.split(s)]


def unescape_table_cell(s: str) -> str:
    """把单元格内的竖线转义还原成字面竖线。

    支持三种写法(均要求词形完整, `\\vertical` 之类不算):
    `\\|` (GFM 写法) → `|`; `\\vert` (LaTeX 单竖线) → `|`;
    `\\Vert` (LaTeX 双竖线, 如按位或运算符 `||`) → `||`。
    还原后才是最终要渲染的文本。

    Args:
        s: split_table_cells 得到的单元格原文(可能含转义序列)。

    Returns:
        还原竖线后的文本。

    Side effects:
        无。
    """
    s = re.sub(r"\\Vert(?![A-Za-z])", "||", s)
    s = re.sub(r"\\vert(?![A-Za-z])", "|", s)
    return s.replace("\\|", "|")


def align_of_sep_cell(cell: str) -> str:
    """由分隔行单元格推出该列对齐方式。

    `:---` → "left", `:---:` → "center", `---:` → "right", `---` → ""(默认左对齐)。

    Args:
        cell: 分隔行的一个单元格 (如 ":---:")。

    Returns:
        对齐方式; 默认对齐返回空串。

    Side effects:
        无。
    """
    if cell.startswith(":") and cell.endswith(":"):
        return "center"
    if cell.endswith(":"):
        return "right"
    if cell.startswith(":"):
        return "left"
    return ""


def try_parse_table(cur: list[str], path: Path, line_no: int):
    """若累积的行构成管道表格则解析之, 否则返回 None。

    表格须满足: 至少两行且每行都含 `|`; 第二行是分隔行(每格形如 `---` /
    `:---:`); 表头行与各数据行的单元格数一致。单元格内可用 `\\|` 或
    `\\vert` 转义竖线字符, 拆列只认未转义的 `|`, 存入 rows 前先还原。

    Args:
        cur: 累积的非空行(块内容)。
        path: 章 md 文件路径(报错信息用)。
        line_no: 块首行在 md 中的行号(1 起, 报错信息用)。

    Returns:
        Block("table", ...)(未 build_html) 或 None(不是表格)。

    Raises:
        ValueError: 形似表格(第二行是分隔行)但单元格数不一致。

    Side effects:
        无。
    """
    if len(cur) < 2 or not all("|" in ln for ln in cur):
        return None
    sep_cells = split_table_cells(cur[1])
    if not sep_cells or not all(TABLE_SEP_CELL_RE.match(c) for c in sep_cells):
        return None
    rows = [[unescape_table_cell(c) for c in split_table_cells(cur[0])]]
    rows += [[unescape_table_cell(c) for c in split_table_cells(ln)]
             for ln in cur[2:]]
    ncols = len(sep_cells)
    for i, row in enumerate(rows):
        if len(row) != ncols:
            raise ValueError(
                f"{path.name}: 第{line_no + i}行表格列数 {len(row)} "
                f"与表头 {ncols} 不一致")
    aligns = [align_of_sep_cell(c) for c in sep_cells]
    return Block("table", "\n".join(cur), rows=rows, aligns=aligns)


def parse_chapter(path: Path, appendix: bool = False, preface: bool = False):
    """解析章节 md, 按其自带的标题切分为小节块。

    每个 `## x.y` / `### x.y.z` 标题开一节, 正文归该节所有; 返回顺序与 md
    中一致(不排序、不去重)。章标题 `# ` 行只记入 h1, 标题之前的正文作为章首
    导言。块以空行分隔; 相邻非空行先累积, 遇空行/新标题/围栏开关时整体 flush。

    Args:
        path: 章 md 文件路径。
        appendix: 附录书稿传 True: 小节编号允许字母前缀 (`A.1` / `A.2.1`);
            整篇没有任何 `##` 标题时(如附录 C)把导言合成为一个小节。
        preface: 前言书稿传 True: `## ` 行不再是编号小节, 而是各篇序言的
            标题, 编号按出现顺序合成 "0.1", "0.2", …。

    Returns:
        (intro_blocks, sections) 二元组:
            intro_blocks: 章首导言 Block 列表;
            sections: [(编号, 标题, [Block, ...]), ...], 编号为 "x.y"、
                "x.y.z"、附录的 "A.1"/"A.2.1" 或前言的 "0.1"。

    Raises:
        FileNotFoundError: 文件不存在。
        ValueError: 行内标题编号异常、三级小节未紧跟父节、围栏未闭合、
            图片块混入多行或图片路径异常、正文没有小节标题。

    Side effects:
        无(只读取 md 文件)。
    """
    if not path.exists():
        raise FileNotFoundError(path)
    sec_re = APPX_SECTION_NUM_RE if appendix else SECTION_NUM_RE
    sub_re = APPX_SUB_NUM_RE if appendix else SUB_NUM_RE
    lines = path.read_text(encoding="utf-8").split("\n")
    intro: list[Block] = []
    sections: list[tuple[str, str, list[Block]]] = []
    target: list[Block] = intro
    cur_main: str | None = None   # 当前所属主小节编号 (三级小节的父节)
    cur: list[str] = []
    cur_first = 0                 # cur 首行的行号(1 起), 供表格报错定位
    in_fence = False
    fence_line = -1
    h1 = ""

    def flush():
        nonlocal cur, cur_first, in_fence, fence_line
        if not cur:
            return
        body = "\n".join(cur)
        if not body.strip():
            cur = []
            return
        if in_fence:
            ls = cur
            if len(ls) < 2 or not ls[-1].startswith("```"):
                raise ValueError(f"{path.name}: 第{fence_line + 1}行代码围栏未闭合: {ls[0][:40]!r}")
            blk = Block("code", "\n".join(ls[1:-1]))
        else:
            tbl = try_parse_table(cur, path, cur_first)
            if tbl is not None:
                blk = tbl
            else:
                stripped = body.strip()
                m = IMAGE_BLOCK_RE.match(stripped)
                if m:
                    if "\n" in stripped:
                        raise ValueError(f"{path.name}: 图片块混入多行: {stripped[:60]!r}")
                    blk = Block("img", alt=m.group(1), src=m.group(2))
                    if not blk.src.startswith("images/"):
                        raise ValueError(f"{path.name}: 图片路径异常: {blk.src}")
                else:
                    blk = Block("p", body.strip("\n"))
        target.append(blk.build_html())
        cur = []

    for i, line in enumerate(lines):
        if not cur:
            cur_first = i + 1
        if in_fence:
            cur.append(line)
            if line.startswith("```") and len(cur) > 1:
                flush()
                in_fence = False
                fence_line = -1
            continue
        if line.startswith("```"):
            flush()
            in_fence = True
            cur = [line]
            fence_line = i
            continue
        if line.startswith("###"):
            # 第三级小节标题 (如 `### 1.5.1. 文件复制`): 正文归该小节所有
            # 必须先于 `## ` 判断, 否则 "###" 会被 "## " 之类规则误吞
            flush()
            num, title = split_heading(line[3:].strip())
            if not sub_re.match(num):
                raise ValueError(f"{path.name}: 三级小节编号异常: {line!r}")
            if num.rsplit(".", 1)[0] != cur_main:
                raise ValueError(
                    f"{path.name}: 三级小节 {num} 未紧跟其父节 {cur_main}: {line!r}")
            target = []
            sections.append((num, title, target))
            continue
        if line.startswith("## "):
            flush()
            if preface:
                # 前言书稿的二级标题是各篇序言的标题, 无编号,
                # 按出现顺序合成 0.1, 0.2, …
                target = []
                sections.append(("0.%d" % (len(sections) + 1),
                                  line[3:].strip(), target))
                continue
            num, title = split_heading(line[3:].strip())
            if not sec_re.match(num):
                raise ValueError(f"{path.name}: 节编号异常: {line!r}")
            cur_main = num
            target = []
            sections.append((num, title, target))
            continue
        if line.startswith("# "):
            flush()          # 章标题行, 记下 h1 后不再参与正文
            h1 = line[2:].strip()
            continue
        if not line.strip():
            flush()          # 空行 = 块边界
            continue
        cur.append(line)
    flush()
    if not sections:
        if not appendix:
            raise ValueError(f"{path.name}: 未找到任何 ## 节")
        # 附录 C 之类的书稿只有 h1: 整篇导言合成为一个小节 (编号 C.1)
        letter, title = split_appendix_h1(h1)
        if not letter or not intro:
            raise ValueError(f"{path.name}: 缺「附录X」标题或正文, 无法合成小节")
        sections.append((f"{letter}.1", title, intro))
        intro = []      # 正文已归入该小节, 导言本身不再重复参与比对
    return intro, sections


def _strip_scripts(s: str) -> str:
    """与 convert_scripts 同一套正则, 只去掉上下标分隔符、保留内容。

    Args:
        s: 不含 code 片段的文本。

    Returns:
        去掉分隔符后的文本; 不满足「至少一个字母或数字」的成对标记原样保留,
        与转换端「不转换」的行为保持一致。

    Side effects:
        无。
    """
    def strip1(m: re.Match) -> str:
        return m.group(1) if re.search(r"[A-Za-z0-9]", m.group(1)) else m.group(0)

    return SUB_MARK_RE.sub(strip1, SUP_MARK_RE.sub(strip1, s))


def strip_scripts_outside_code(text: str) -> str:
    """只在 code 片段之外按转换规则去掉上下标分隔符。

    用于 md ⇔ JSON 文本比对: 转换后 JSON 侧的 <sup>/<sub> 标签会被
    norm_json 剥掉只剩内容, md 侧须同步去掉分隔符才能逐字对齐;
    code 片段内不做转换, 其中的 ^ / ~ 两侧都原样保留, 比对同样成立。

    Args:
        text: 段落原文。

    Returns:
        处理后的文本。

    Side effects:
        无。
    """
    out: list[str] = []
    pos = 0
    for m in INLINE_CODE_RE.finditer(text):
        out.append(_strip_scripts(text[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(_strip_scripts(text[pos:]))
    return "".join(out)


def strip_bold_outside_code(text: str) -> str:
    """只在 code 片段之外按转换规则去掉成对粗体分隔符 **。

    与 strip_scripts_outside_code 同一思路: 转换后 JSON 侧的 <strong> 标签
    会被 norm_json 剥掉只剩内容, md 侧须同步去掉成对 ** 才能逐字对齐;
    code 片段内不做转换, 其中的 ** (如 `void **p`) 两侧都原样保留。

    与转换端共用 INLINE_BOLD_RE, 因此「内容不含 *」等限制完全一致;
    行内粗体 (**说明**：…) 与整块题注 (**图 5-1**) 一并处理。

    Args:
        text: 段落或单元格原文。

    Returns:
        处理后的文本。

    Side effects:
        无。
    """
    out: list[str] = []
    pos = 0
    for m in INLINE_CODE_RE.finditer(text):
        out.append(INLINE_BOLD_RE.sub(r"\1", text[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(INLINE_BOLD_RE.sub(r"\1", text[pos:]))
    return "".join(out)


# ---------- 写入 JSON ----------

def apply_content(data: list, parsed: list) -> None:
    """把八章书稿写入 JSON: 各节 paragraphs。

    Args:
        data: course-content.json 反序列化后的八个正文章节(就地修改)。
        parsed: 八章的 parse_chapter 结果, 顺序与 data 对应。

    Returns:
        None。

    Side effects:
        就地覆盖 data 中每节的 paragraphs;
        向 stdout 打印每章同步统计。

    Raises:
        AssertionError: 章节数不为 8、编号重复, 或 md 与 JSON 的小节集合
            不一致时立即失败, 避免写坏数据。
    """
    assert len(data) == 8 == len(parsed), "章节数必须为 8"
    for ci, (intro, sections) in enumerate(parsed):
        chap = data[ci]
        sec_map = {num: blocks for num, _title, blocks in sections}
        assert len(sec_map) == len(sections), f"第{ci+1}章节编号重复"
        tuts = {t["number"]: t for t in chap["tutorials"]}
        assert len(tuts) == len(chap["tutorials"]), f"第{ci+1}章 tutorial 编号重复"
        md_nums = {num for num, _title, _blocks in sections}
        assert md_nums == set(tuts), (
            f"第{ci+1}章 md 与 JSON 小节不一致: "
            f"仅md={sorted(md_nums - set(tuts))} 仅json={sorted(set(tuts) - md_nums)}")
        # 正文: paragraphs = 全部块(块级 HTML, 严格保序)
        # 三级小节 (### x.y.z) 只取本小节标题下的正文, 覆盖清除其原有内容;
        # 父节不再包含三级小节的正文 (正文交由对应 subsection 显示)
        n_sub = 0
        for idx, (num, _title, sec_blocks) in enumerate(sections):
            # 首节的块 = 章首导言 + 该节正文, 使导言随之进入 1.1 的 paragraphs
            blocks = (intro + sec_blocks) if idx == 0 else sec_blocks
            assert blocks, f"{num}: 标题下没有正文块"
            if num.count(".") > 1:
                n_sub += 1
            t = tuts[num]
            t["paragraphs"] = [b.full for b in blocks]
        print(f"  第{ci+1}章: {len(sections) - n_sub} 主小节 + {n_sub} 三级小节已同步")


def build_appendix(filename: str, h1: str, intro: list, sections: list) -> dict:
    """由附录书稿生成完整章节对象 (附录在 JSON 里没有写入骨架)。

    Args:
        filename: md/ 下的附录文件名 (仅用于报错信息)。
        h1: 书稿的 h1 标题 (如「附录A 参考手册」)。
        intro: 章首导言 Block 列表, 会并入首节正文。
        sections: parse_chapter(appendix=True) 得到的 (编号, 标题, 块) 列表。

    Returns:
        可直接放进 course-content.json 的章节对象:
        meta.kind = "appendix"、tutorials 的
        paragraphs 收全部块(原书正文)。

    Raises:
        ValueError: h1 不是「附录X …」或某节没有正文块。

    Side effects:
        无(只构造对象, 不修改传入的 intro/sections)。
    """
    letter, _ = split_appendix_h1(h1)
    if not letter:
        raise ValueError(f"{filename}: h1 不是「附录X …」: {h1!r}")

    tutorials = []
    for idx, (num, title, sec_blocks) in enumerate(sections):
        # 首节的块 = 章首导言 + 该节正文 (与正文章同一规则)
        blocks = (intro + sec_blocks) if idx == 0 else sec_blocks
        if not blocks:
            raise ValueError(f"{filename}: {num} 标题下没有正文块")
        tutorials.append({
            "number": num,
            "title": title,
            "paragraphs": [b.full for b in blocks],
        })
    return {
        "meta": {
            "chapter": h1,
            "kind": "appendix",
        },
        "tutorials": tutorials,
    }


def build_preface(filename: str, intro: list, sections: list) -> dict:
    """由前言书稿生成完整章节对象 (前言在 JSON 里没有写入骨架)。

    Args:
        filename: md/ 下的前言文件名 (用于派生章标题与报错信息)。
        intro: 章首导言 Block 列表, 会并入首节正文。
        sections: parse_chapter(preface=True) 得到的 (编号, 标题, 块) 列表。

    Returns:
        可直接放进 course-content.json 的章节对象:
        meta.kind = "preface"、章标题取自文件名
        (「00-前言与序.md」→「前言与序」)、tutorials 的 paragraphs 收全部块。

    Raises:
        ValueError: 某节没有正文块。

    Side effects:
        无(只构造对象, 不修改传入的 intro/sections)。
    """
    title = PREFACE_TITLE_RE.sub("", filename).removesuffix(".md")
    tutorials = []
    for idx, (num, sec_title, sec_blocks) in enumerate(sections):
        # 首节的块 = 章首导言 + 该节正文 (与正文章同一规则)
        blocks = (intro + sec_blocks) if idx == 0 else sec_blocks
        if not blocks:
            raise ValueError(f"{filename}: {num} {sec_title} 标题下没有正文块")
        tutorials.append({
            "number": num,
            "title": sec_title,
            "paragraphs": [b.full for b in blocks],
        })
    return {
        "meta": {
            "chapter": title,
            "kind": "preface",
        },
        "tutorials": tutorials,
    }


def sync_images(parsed: list) -> int:
    """把章节引用的图片从 md/images/ 复制到程序根目录 images/。

    Args:
        parsed: 前言、八章与三个附录的 parse_chapter 结果 (附录不含图片)。

    Returns:
        实际复制的图片张数(内容已一致而跳过的计入 0)。

    Raises:
        FileNotFoundError: 引用的图片在 md/images/ 中不存在。

    Side effects:
        创建 images/ 目录; 复制/覆盖图片文件(内容相同则跳过, 保持幂等,
        避免无谓地刷新文件时间戳)。
    """
    IMG_DST.mkdir(exist_ok=True)
    copied = 0
    seen = set()
    for intro, sections in parsed:
        blocks = list(intro) + [b for _n, _t, bs in sections for b in bs]
        for b in blocks:
            if b.kind != "img" or b.src in seen:
                continue
            seen.add(b.src)
            src = MD_DIR / b.src
            dst = IMG_DST / Path(b.src).name
            if not src.exists():
                raise FileNotFoundError(src)
            if not dst.exists() or dst.read_bytes() != src.read_bytes():
                shutil.copy2(src, dst)
                copied += 1
    return copied


# ---------- 一致性校验 ----------

def block_md_text(b: "Block") -> str:
    """把块还原为可比对的 md 侧纯文本。

    图片块不计入文本比对, 其一致性由图片数统计单独校验。

    Args:
        b: 待转换的 Block。

    Returns:
        img 块返回 ""; p 块去掉成对 ** (行内粗体与整块题注, code 内的 **
        保留) 与其中的反引号、并按转换规则去掉上下标分隔符; table 块按
        「行 × 列」顺序拼接各单元格(不含分隔行与 `|`), 单元格内同样去
        上下标分隔符、反引号与成对 **, 拼接不加空白——与 JSON 侧去标签后
        <th>/<td> 直接相邻的行为一致; code 块原样返回正文。
    """
    if b.kind == "img":
        return ""
    if b.kind == "table":
        cells: list[str] = []
        for row in b.rows:
            for cell in row:
                c = strip_scripts_outside_code(cell)
                c = strip_bold_outside_code(c)
                cells.append(c.replace("`", ""))
        return "".join(cells)
    t = b.text
    if b.kind == "p":
        # 行内粗体(**说明**：…)与整块题注(**图 5-1**)一并去掉成对 **,
        # 才能与 JSON 去标签文本对齐; code 片段内的 ** 原样保留
        t = strip_bold_outside_code(t)
        t = strip_scripts_outside_code(t)
        t = t.replace("`", "")
    return t


def norm_json(s: str) -> str:
    """归一化 JSON 侧 HTML 文本, 便于与 md 纯文本比对。

    Args:
        s: 由 paragraphs 拼接的 HTML 文本。

    Returns:
        先去除所有 <...> 标签, 再做 HTML 反转义, 最后把连续空白折叠为一个
        空格并去首尾。顺序不可颠倒: 若先反转义, 正文里的 &lt; 会变成 <,
        再被当成标签删除。
    """
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def first_diff(a: str, b: str) -> str:
    """定位两段文本的首个差异位置, 生成带上下文的摘要。

    Args:
        a: md 侧文本。
        b: JSON 侧文本。

    Returns:
        形如「位置i: md=…前25后35字… json=…」的说明, 供人工排查。
    """
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]:
        i += 1
    return (f"位置{i}: md=…{a[max(0,i-25):i+35]!r}… "
            f"json=…{b[max(0,i-25):i+35]!r}…")


def verify(data: list, parsed: list) -> list[str]:
    """双向完整性校验: 每节 md 文本 ⇔ JSON 去标签文本逐节相等, 图片数一致。

    前言、八章与附录走同一套比对: 首节的 md 块都先并上章首导言, 再与该节
    paragraphs 的去标签文本比对。

    Args:
        data: 待校验的 JSON 章节列表(apply_content 之后或磁盘既有数据)。
        parsed: 前言、八章与三个附录的 parse_chapter 结果, 顺序与 data 对应。

    Returns:
        错误描述列表; 全部通过时为空列表。

    Side effects:
        无(只比较, 不修改传入数据)。
    """
    errors: list[str] = []
    total_imgs = 0
    for ci, (intro, sections) in enumerate(parsed):
        chap = data[ci]
        if not sections:
            errors.append(f"第{ci+1}章无小节")
            continue
        tuts = {t["number"]: t for t in chap["tutorials"]}
        first_num = sections[0][0]
        for num, _title, sec_blocks in sections:
            t = tuts.get(num)
            if t is None:
                errors.append(f"第{ci+1}章 {num}: md 有而 JSON 无")
                continue
            blocks = (intro + sec_blocks) if num == first_num else sec_blocks
            # 两侧都做空白折叠: md 保留原书换行, JSON 侧 HTML 无换行信息
            a = re.sub(r"\s+", " ",
                       " ".join(block_md_text(x) for x in blocks)).strip()
            b = norm_json(" ".join(t["paragraphs"]))
            if a != b:
                errors.append(f"{num} 文本不一致: {first_diff(a, b)}")
            na = sum(1 for x in blocks if x.kind == "img")
            nb = " ".join(t["paragraphs"]).count("<img ")
            total_imgs += na

            if na != nb:
                errors.append(f"{num} 图片数不一致: md={na} json={nb}")
        # md 中没有对应标题的 tutorial
        md_nums = {num for num, _t, _b in sections}
        for t in chap["tutorials"]:
            if t["number"] not in md_nums:
                errors.append(f"第{ci+1}章 {t['number']}: JSON 有而 md 无")
    # 全局检查
    dump = json.dumps(data, ensure_ascii=False)
    if re.search(r"\?{3,}", dump):
        errors.append("输出含 ??? 占位符")
    if total_imgs != 21:
        errors.append(f"图片引用总数应为 21 (含前言扉页 1 张), 实际 {total_imgs}")
    return errors


# ---------- 入口 ----------

def main() -> None:
    """程序入口: 解析书稿, 写入 JSON 并自校验(或仅校验)。

    默认流程: 读入 course-content.json → 解析前言、八章与三个附录的 md →
    apply_content 写八章正文 → 由书稿重建前言与三个附录章节 → sync_images
    复制图片 → 写回 JSON → verify 校验。带 --verify 时只校验磁盘上的既有
    JSON, 不写 JSON、不复制图片。

    Returns:
        None。

    Side effects:
        默认模式下覆盖写入 course-content.json 与 images/ 下的图片;
        打印进度与统计; 校验失败时以退出码 1 结束进程。
    """
    verify_only = "--verify" in sys.argv
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    # 8 个正文章是人工维护的写入骨架; 前言(第 1 章)与第 10 章起的附录
    # 没有骨架, 一律由本脚本从书稿重建
    main_chapters = [c for c in data
                     if c.get("meta", {}).get("kind") not in ("preface", "appendix")]
    assert len(main_chapters) == 8, \
        "course-content.json 应含 8 个人工维护的正文章"
    assert all(c.get("meta", {}).get("kind") in (None, "preface", "appendix")
               for c in data), \
        "course-content.json 只允许 kind ∈ {缺省, preface, appendix} 的章节"

    parsed_preface = parse_chapter(MD_DIR / PREFACE_FILE, preface=True)
    preface_chapter = build_preface(PREFACE_FILE, *parsed_preface)
    parsed_chapters = [parse_chapter(MD_DIR / f) for f in CHAPTER_FILES]
    parsed_appendix = []
    appendix_chapters = []
    for f in APPENDIX_FILES:
        path = MD_DIR / f
        intro, secs = parse_chapter(path, appendix=True)
        parsed_appendix.append((intro, secs))
        appendix_chapters.append(build_appendix(f, read_h1(path), intro, secs))
    parsed = [parsed_preface] + parsed_chapters + parsed_appendix

    if verify_only:
        assert len(data) == 12 and \
            data[0].get("meta", {}).get("kind") == "preface", (
            "course-content.json 还没有前言章节, "
            "请先运行 python tools/md_to_course.py")
        errors = verify(data, parsed)
    else:
        apply_content(main_chapters, parsed_chapters)
        # 前言与附录一律由书稿重建; 正文章原位保留(只覆盖 paragraphs)
        data = [preface_chapter] + main_chapters + appendix_chapters
        copied = sync_images(parsed)
        JSON_PATH.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
        print(f"已写入 {JSON_PATH.name} (复制图片 {copied} 张)")
        errors = verify(data, parsed)
    if errors:
        print(f"[FAIL] {len(errors)} 项:")
        for e in errors[:30]:
            print("  -", e)
        sys.exit(1)
    n_preface = len(data[0]["tutorials"])
    n_main = sum(1 for c in data[1:9] for t in c["tutorials"]
                 if t["number"].count(".") == 1)
    n_sub = sum(1 for c in data[1:9] for t in c["tutorials"]
                if t["number"].count(".") > 1)
    n_appx = sum(len(c["tutorials"]) for c in data[9:])
    print(f"[ OK ] 1 前言/{n_preface} 小节 + 8 章 / {n_main} 主小节 + "
          f"{n_sub} 三级小节 + {len(data) - 9} 附录 / {n_appx} 附录小节 "
          f"md 与 JSON 文本逐节一致, 图片一致")


if __name__ == "__main__":
    main()

