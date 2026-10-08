#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdf_to_md.py —— 课程内容生产流水线第 1 阶段: PDF → 分章 Markdown。

本脚本用 pypdf 读取原书 PDF 的文字坐标与字体信息, 先重建页面的视觉行,
再依据 PDF 内嵌书签(outline)把全书切成「前言与序 / 各章 / 附录 / 索引」
等输出单元, 逐单元渲染为 Markdown 正文与独立图片文件。其产物供下一阶段
md_to_course.py 解析并写入 course-content.json。

输入:
    c-programming-language-2nd-edition-simple-chinese.pdf
        (仓库根目录; 文字层 + 书签 + 内嵌图片)
输出:
    md/README.md        自动生成的目录页(替代未转换的原书「目录」页)
    md/NN-<标题>.md     每个输出单元一个文件, NN 为两位序号
    md/images/*         去重后的插图文件(PNG/JPG/GIF/BMP/WEBP)

命令行用法(在仓库根目录执行):
    python tools/pdf_to_md.py            # 仅当 md/ 尚无书稿时写出
    python tools/pdf_to_md.py --force    # 覆盖已有 md/(同时清理未再生成的旧图片)

关键设计约束:
    - 只做版面重建, 不转录原著正文: 全部文字均取自 PDF 文本层坐标,
      不引入任何外部或人工撰写的原文, 以规避版权风险。
    - 输出必须确定(deterministic): 同一 PDF 每次运行应得到逐字节相同的
      结果; 图片去重与命名基于内容 SHA-1, 不依赖时间戳或随机数。
    - 仅依赖 pypdf; 字体信息缺失时自动退化为基于坐标的版面启发式。
    - 每次运行会删除 md/images/ 中本次未再生成的旧图片(见 main)。
    - 覆盖保护: md/ 是人工整理过的书稿, 也是 course-content.json 的来源,
      重新生成会整体覆盖, 因此默认拒绝写入, 需显式加 --force(见 main)。
"""
from __future__ import annotations

import hashlib
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from pypdf import PdfReader

# ---------- 路径常量 ----------

# 脚本位于 tools/, 输入输出都在上一级(仓库根目录)
BASE = Path(__file__).resolve().parent.parent
PDF_PATH = BASE / "c-programming-language-2nd-edition-simple-chinese.pdf"
OUT_DIR = BASE / "md"
IMG_DIR = OUT_DIR / "images"

# ---- 版面参数 (正文左边界 x=90, 正文行距≈15.6pt, 代码行距≈12pt) ----
Y_TOL = 3.0            # 行 y 聚类容差
WIDE_GAP_EM = 3.5      # 行内间隙>3.5em → 宽间隙(图旁注/表格列)
PARA_GAP = 21.0        # 纵向间隙>此值 → 段落分隔
CODE_GAP = 26.0        # 代码行间隙>此值 → 拆分代码块
PARA_INDENT_X = 105.0  # 行首 x≥此值 → 段落缩进行
FLUSH_X_HINT = 100.0   # 前一行 x≤此值才用缩进规则判段
COURIER_FRAC = 0.5     # Courier 字符占比阈值 → 代码行
MARGIN_TOP_Y = 766.0   # 高于此 y 的纯数字行 = 页码, 剔除
MARGIN_BOT_Y = 72.0    # 低于此 y 的纯数字行 = 页码, 剔除

# ---------- 版面识别用正则 ----------

# PDF 字体名中出现这些子串即视为等宽字体 (原书代码段使用 Courier 系列)
COURIER_HINTS = ("courier", "mono")
# 页眉/页脚的裸页码行: 1~4 位纯数字 (需配合 y 坐标才能判定为页码)
PAGE_NO_RE = re.compile(r"^\d{1,4}$")
# 图题注「图 N-M...」; 只捕获 N、M 两个图号, 其后的标题文字不参与匹配
CAPTION_IMG_RE = re.compile(r"^图\s*(\d+)\s*[-–—]\s*(\d+)(?:\s+\S.*)?$")
# 表题注「表 A-1」等 (附录表格用字母编号); 用前缀匹配, 允许后续标题文字
CAPTION_TBL_RE = re.compile(r"^表\s*[A-C]\s*[-–—]\s*\d+")
# 项目符号行(圆点/间隔号/三角), 用于强制断开段落
BULLET_RE = re.compile(r"^[•·‣]\s")
# 附录中未进书签的小节标题, 如「A.1 概述」「A.2.1 函数原型」
APPX_HEAD_RE = re.compile(r"^([ABC])\.(\d+(?:\.\d+)*)\s+\S{1,30}$")


# ---------- 文本宽度与字符判定 ----------

def is_cjk(ch: str) -> bool:
    """判断单个字符是否为 CJK 宽字符(汉字及全角标点)。

    Args:
        ch: 单个字符。

    Returns:
        命中以下任一区段时为 True: 0x2E80-0x9FFF(CJK 部首~统一表意文字)、
        0xF900-0xFAFF(兼容表意文字)、0xFF00-0xFF60(全角形式)、
        0x3000-0x303F(CJK 标点)。宽字符按整字宽计, 用于 est_width 估算与
        代码块语言判定。

    Side effects:
        无。
    """
    o = ord(ch)
    return (0x2E80 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF
            or 0xFF00 <= o <= 0xFF60 or 0x3000 <= o <= 0x303F)


def est_width(text: str, size: float, courier: bool) -> float:
    """估算一段文字在页面上占用的水平宽度(单位: pt)。

    pypdf 的文字块只给出起点坐标, 需要自行推算终点才能判断块间是否有
    空隙; 这里用「字符类别 × 字号」的近似字宽换算, 不求精确排版宽。

    Args:
        text: 待估算的文字(换行符忽略)。
        size: 字号(pt)。
        courier: 是否等宽字体; 等宽字符宽度比比例字体略大。

    Returns:
        估算宽度(pt): 宽字符按 size, 空格按 0.3*size,
        其余字符等宽按 0.6*size、比例字体按 0.52*size。

    Side effects:
        无。
    """
    w = 0.0
    for ch in text:
        if ch in "\n\r":
            continue
        if is_cjk(ch):
            w += size
        elif ch == " ":
            w += size * 0.3
        else:
            w += size * (0.6 if courier else 0.52)
    return w


def need_space(prev_ch: str, next_ch: str, gap: float,
               size: float, prev_size: float) -> bool:
    """判断两个相邻文字块之间是否需要补一个空格。

    PDF 里词间空格常常不落成独立的字符, 而是体现为块间坐标间隙, 因此
    需要按间隙大小与相邻字符类型还原空格。

    Args:
        prev_ch: 前一块的末字符。
        next_ch: 后一块的首字符。
        gap: 两块之间的水平间隙(pt)。
        size: 后一块字号(pt)。
        prev_size: 前一块字号(pt); 为 0 时回退用 size。

    Returns:
        需要补空格返回 True。以下情况不补: 缺字符、任一侧已是空白、
        间隙过小(<= max(0.6, 前一字号*0.30), 视为字间字距)、
        两侧均为宽字符(中文之间不断词)。

    Side effects:
        无。
    """
    if not prev_ch or not next_ch:
        return False
    if prev_ch.isspace() or next_ch.isspace():
        return False
    if gap <= max(0.6, (prev_size or size) * 0.30):
        return False
    if is_cjk(prev_ch) and is_cjk(next_ch):
        return False
    return True


# ---------- 标题匹配 ----------

def norm_title(s: str) -> str:
    """归一化标题文本, 供书签标题与页面标题行比较。

    Args:
        s: 原始标题(可能来自书签或页面文本行)。

    Returns:
        把全角「／（）」折成半角, 并删除所有空白、点号、连字符/破折号后的
        比较键——这些字符在书签与正文排版中经常不一致。

    Side effects:
        无。
    """
    s = s.replace("／", "/").replace("（", "(").replace("）", ")")
    return re.sub(r"[\s.\-\u2014\u2013]+", "", s)


def heading_match(title: str, line_text: str) -> bool:
    """判断书签标题是否与某页面文本行对应。

    Args:
        title: 书签标题。
        line_text: 页面上的候选文本行。

    Returns:
        归一化后相等, 或满足下列模糊条件时返回 True。模糊匹配只对带数字
        编号的标题启用(前言类标题一律要求精确相等): 候选行不超 40 字、
        不以句读结尾、数字编号前缀完全一致、长度不过分超出, 且前缀相同
        或差异不超过 2 个字符。这样可容忍页码/多余空格等版式噪声, 又不会
        把正文句子误认成标题。

    Side effects:
        无。
    """
    lt = line_text.strip()
    t_norm = norm_title(title)
    l_norm = norm_title(lt)
    if l_norm == t_norm:
        return True
    m = re.match(r"^\d+(\.\d+)*", title)
    if not m:
        return False                      # 前言类标题只做精确匹配
    if len(lt) > 40 or l_norm.endswith(("。", "；", "，", ",", "：")):
        return False
    if not l_norm.startswith(re.sub(r"[\s.]", "", m.group(0))):
        return False                      # 数字编号必须一致
    if len(l_norm) > len(t_norm) + 12:
        return False
    if l_norm.startswith(t_norm) or t_norm.startswith(l_norm):
        return True
    pre = 0
    for a, b in zip(l_norm, t_norm):
        if a != b:
            break
        pre += 1
    return pre >= max(len(l_norm), len(t_norm)) - 2


# ---------- 页面/行级解析 ----------

@dataclass
class Line:
    """重建后的一行文字及其版面属性, 是块级渲染的判定依据。

    Attributes:
        y: 行中心 y 坐标(PDF 坐标系: 原点在左下, y 越大越靠上)。
        x0: 行内首个文字块的左边界 x 坐标。
        size: 行内最大字号(pt)。
        text: 拼接后的整行文本(含为对齐而补入的空格)。
        ranges: 需渲染为行内代码的字符下标区间列表 [(start, end)]。
        courier: 等宽字体字符数(不含空白)。
        total: 非空白字符总数。
        wide: 行内是否出现宽间隙(通常为图旁注或表格列)。
        consumed: 是否已被标题等事件消费; 为 True 时不再作为正文输出。
    """

    y: float
    x0: float
    size: float
    text: str
    ranges: list          # [(start, end)] 需渲染为行内代码的片段
    courier: int
    total: int
    wide: bool
    consumed: bool = False

    @property
    def frac(self) -> float:
        """等宽字符占比; total 为 0 时返回 0.0 以避免除零。"""
        return self.courier / self.total if self.total else 0.0

    @property
    def is_code(self) -> bool:
        """是否判定为代码行: 存在宽间隙, 或等宽字符占比达到阈值。"""
        return self.wide or self.frac >= COURIER_FRAC


def _build_line(y: float, members: list) -> Line | None:
    """把同一视觉行内的多个文字块拼成一条 Line。

    Args:
        y: 该视觉行的中心 y 坐标。
        members: 该行文字块列表, 每项为
            (y, x, size, font_name, text); 调用方已按 x 排序。

    Returns:
        拼接完成的 Line; 整行为空白时返回 None。文本中块间间隙会按
        WIDE_GAP_EM/need_space 规则还原为空格, 并据此标出 wide 与需要
        行内代码渲染的字符区间。

    Side effects:
        无(纯计算, 不读写文件)。
    """
    pieces = []                 # (cls, text) cls: 'c'=Courier 't'=其它 's'=间隙
    prev_end = None
    prev_size = 0.0
    prev_ch = ""
    cour = tot = 0
    wide = False
    x0 = members[0][1]
    for _, x, size, fname, t in members:
        courier = any(h in fname.lower() for h in COURIER_HINTS)
        if pieces:
            gap = x - prev_end
            if gap > size * WIDE_GAP_EM:
                # 宽间隙: 按 0.6em/字符折算成若干空格(上限 40), 保留列对齐
                wide = True
                sep = " " * min(40, max(2, int(round(gap / max(1.0, size * 0.6)))))
            elif need_space(prev_ch, t[:1], gap, size, prev_size):
                sep = " "
            else:
                sep = ""
            if sep:
                pieces.append(("s", sep))
        pieces.append(("c" if courier else "t", t))
        for ch in t:
            if not ch.isspace():
                tot += 1
                if courier:
                    cour += 1
        prev_end = x + est_width(t, size, courier)
        prev_size = size
        if t:
            prev_ch = t[-1]
    # 合成文本 + 每字符类别
    text = ""
    chars: list[str] = []
    for cls, s in pieces:
        text += s
        chars.extend(["s"] * len(s) if cls == "s" else [cls] * len(s))
    # 两个 'c' 之间的 's' 并入代码运行
    i = 0
    n = len(chars)
    while i < n:
        if chars[i] == "s":
            j = i
            while j < n and chars[j] == "s":
                j += 1
            if i > 0 and chars[i - 1] == "c" and j < n and chars[j] == "c":
                for k in range(i, j):
                    chars[k] = "c"
            i = j
        else:
            i += 1
    ranges = []
    start = None
    for idx, c in enumerate(chars):
        if c == "c" and start is None:
            start = idx
        elif c != "c" and start is not None:
            ranges.append((start, idx))
            start = None
    if start is not None:
        ranges.append((start, n))
    # 修剪: 去空、去纯标点的伪代码片段
    # (等宽字体也用于表格与数字, 故按内容过滤而非仅凭字体)
    trimmed = []
    for a, b in ranges:
        seg = text[a:b]
        core = seg.strip()
        if not core:
            continue
        # 至少含一个 ASCII 字母数字, 或长度>=3, 才算真正的代码片段
        if not (any(ch.isascii() and ch.isalnum() for ch in core) or len(core) >= 3):
            continue
        off = len(seg) - len(seg.lstrip())
        trimmed.append((a + off, a + off + len(core)))
    if not text.strip():
        return None
    return Line(y=y, x0=x0, size=size, text=text, ranges=trimmed,
                courier=cour, total=tot, wide=wide)


def assemble_page(page) -> list:
    """按 y 聚行、按 x 排序, 重建页面的视觉行。

    先收集页面上所有文字块及其坐标(visitor 回调), 再把 y 相差不超过
    Y_TOL 的块并入同一行——PDF 同一视觉行内各块的 y 常有零点几磅的抖动。
    同一行内若有上下错位的块(如上下标), 按 (x, -y) 排序以保证从左到右、
    偏上的块先出现。

    Args:
        page: pypdf 的 Page 对象。

    Returns:
        Line 列表, 已按 y 从大到小(页面上到下)排序; 空页返回 []。

    Side effects:
        无文件写入; 会调用 page.extract_text 触发 pypdf 解析。
    """
    segs: list = []

    def visitor(text, cm, tm, font_dict, font_size):
        if not text:
            return
        t = text.replace("\n", "")
        if t == "":
            return
        fname = ""
        if font_dict:
            try:
                fname = str(font_dict.get("/BaseFont", ""))
            except Exception:
                fname = ""
        segs.append((tm[5] + cm[5], tm[4] + cm[4], float(font_size), fname, t))

    page.extract_text(visitor_text=visitor)
    if not segs:
        return []
    groups: list[list[float]] = []
    # 先按 0.1pt 取整去重再聚类, 抵消浮点误差造成的 y 微小抖动
    for y in sorted({round(s[0], 1) for s in segs}):
        if groups and y - groups[-1][-1] <= Y_TOL:
            groups[-1].append(y)
        else:
            groups.append([y])
    lines = []
    for g in groups:
        lo, hi = g[0], g[-1]
        members = [s for s in segs if lo - 0.01 <= round(s[0], 1) <= hi + 0.01]
        members.sort(key=lambda s: (s[1], -s[0]))
        ln = _build_line((lo + hi) / 2, members)
        if ln:
            ln.size = max(m[2] for m in members)
            lines.append(ln)
    lines.sort(key=lambda l: -l.y)
    return lines


# ---------- 章节单元与文件命名 ----------

def sanitize(title: str) -> str:
    """把章节标题转成安全的文件名片段。

    Args:
        title: 原始标题。

    Returns:
        去掉首尾空白, 把文件系统非法字符 <>:"/\\|?* 替换为连字符,
        并把空格替换为连字符(避免文件名含空格)。
    """
    t = re.sub(r'[<>:"/\\|?*]', "-", title.strip())
    return t.replace(" ", "-")


def read_outline(reader) -> list:
    """递归读取 PDF 书签, 展平为带层级与页码的列表。

    Args:
        reader: pypdf 的 PdfReader 对象。

    Returns:
        字典列表, 每项含:
            title (str): 书签标题;
            level (int): 层级, 顶层为 1, 越深越大;
            page (int | None): 目标页 0 基页码, 无法解析时为 None。
        条目顺序与书签在文档中的出现顺序一致。
    """
    items: list = []

    def walk(outline, level=1):
        for it in outline:
            if isinstance(it, list):
                walk(it, level + 1)
            else:
                try:
                    page = reader.get_destination_page_number(it)
                except Exception:
                    page = None
                items.append({"title": str(it.title).strip(),
                              "level": level, "page": page})

    walk(reader.outline)
    return items


def build_units(outline: list, n_pages: int) -> list:
    """把书签大纲切分为输出单元, 并计算每单元的页码范围与文件名。

    第 0 单元恒为「前言与序」(正文目录页之前的全部内容); 其后每个 level==1
    的书签各起一个单元, 落在其区间内的 level==2 书签作为该单元的小节标题。
    原书「目录」页整体跳过: 前言单元的 end 定为目录页前一行, 各章从目录
    之后的页开始。

    Args:
        outline: read_outline 的返回值。
        n_pages: PDF 总页数, 用于给各章兜底 end。

    Returns:
        单元字典列表, 每项含:
            file (str): 输出文件名, 形如 "03-第3章-控制流.md";
            title (str): 单元标题;
            start, end (int): 闭区间的 0 基页码;
            headings (list): 该单元的书签 {title, level, page};
            index_mode (bool): 为「索引」单元时为 True, 渲染时按词条列表处理;
            appendix (bool): 标题以「附录」开头时为 True, 渲染时补抓小节标题。
    """
    toc = next(o for o in outline if o["title"] == "目录")
    front_heads = [{"title": o["title"], "level": 1, "page": o["page"]}
                   for o in outline
                   if o["page"] is not None and o["page"] < toc["page"]]
    units = [{
        "file": "00-前言与序.md", "title": "前言与序",
        "start": 0, "end": toc["page"] - 1, "headings": front_heads,
        "index_mode": False, "appendix": False,
    }]
    for o in outline:
        if o["page"] is None or o["page"] <= toc["page"]:
            continue
        if o["level"] == 1:
            units.append({
                "file": "", "title": o["title"],
                "start": o["page"], "end": n_pages - 1,
                "headings": [{"title": o["title"], "level": 1, "page": o["page"]}],
                "index_mode": o["title"] == "索引",
                "appendix": o["title"].startswith("附录"),
            })
        elif o["level"] == 2 and units[-1]["start"] <= o["page"]:
            units[-1]["headings"].append(
                {"title": o["title"], "level": 2, "page": o["page"]})
    for i, u in enumerate(units):
        if i == 0:
            continue          # 前言单元 end 已定为目录页-1, 目录页整体跳过
        if i + 1 < len(units):
            u["end"] = units[i + 1]["start"] - 1
        u["file"] = f"{i:02d}-{sanitize(u['title'])}.md"
    return units


# ---------- 行/块渲染 ----------

def is_img_caption(t: str) -> bool:
    """判断一行是否为图片题注。

    Args:
        t: 去除首尾空白后的行文本。

    Returns:
        匹配「图 N-M」且长度 <= 45、不含句号(「。」)时为 True;
        排除正文里引用插图、带句号的句子。
    """
    return len(t) <= 45 and "。" not in t and bool(CAPTION_IMG_RE.match(t))


def is_caption(t: str) -> bool:
    """判断一行是否为图或表的题注。

    Args:
        t: 去除首尾空白后的行文本。

    Returns:
        图题注见 is_img_caption; 表题注要求匹配「表 A-1」等前缀、长度 <= 40
        且不以句读结尾(排除正文对表格的引用)。
    """
    if is_img_caption(t):
        return True
    if (CAPTION_TBL_RE.match(t) and len(t) <= 40
            and not t.endswith(("。", "；", "，", ","))):
        return True
    return False


def render_inline(ln: Line) -> str:
    """把一行文本按 ranges 用反引号包出行内代码, 并去掉首尾空白。

    Args:
        ln: 待渲染的行。

    Returns:
        Markdown 文本; ranges 覆盖的片段渲染为 `code`。
    """
    out = []
    last = 0
    for a, b in ln.ranges:
        out.append(ln.text[last:a])
        out.append("`" + ln.text[a:b] + "`")
        last = b
    out.append(ln.text[last:])
    return "".join(out).strip()


def render_code_line(ln: Line, flush_x: float) -> str:
    """渲染代码行, 把行首 x 坐标换算成等宽空格缩进。

    Args:
        ln: 代码行。
        flush_x: 本页正文的左边界 x(该页所有行的最小 x0), 作为零缩进基准。

    Returns:
        缩进后的代码行文本(行尾空白已去除)。
    """
    # 基础缩进由行首 x 决定, 文本自带的前导空格(相对缩进)原样保留
    n = max(0, int(round((ln.x0 - flush_x) / max(1.0, ln.size * 0.6))))
    return (" " * n + ln.text).rstrip()


def fence(lines_text: list) -> str:
    """把多行文本包成围栏代码块。

    Args:
        lines_text: 代码行列表。

    Returns:
        围栏字符串; 全部为 ASCII 时标注语言 `c`, 含中文(代码旁注)时留空,
        以免高亮器把中文注释当 C 代码处理。
    """
    body = "\n".join(lines_text)
    lang = "c" if not any(is_cjk(ch) for ch in body) else ""
    return f"```{lang}\n{body}\n```"


def join_lines(prev: str, new: str) -> str:
    """合并同一段落内相邻两行(原书硬换行还原为一行)。

    Args:
        prev: 已累积的段落文本。
        new: 待并入的下一行(去掉前导空白)。

    Returns:
        合并后的文本。行尾是 ASCII 字母/数字、下行以字母/数字或 "([" 开头,
        或上行以 ")]" 结尾且下行以字母/数字开头时, 补一个空格, 避免把跨行
        的英文单词粘在一起; 中文场景直接拼接。
    """
    new = new.lstrip()
    if not prev or not new:
        return new
    a, b = prev[-1], new[0]
    if a.isascii() and a.isalnum() and (b.isascii() and b.isalnum() or b in "(["):
        return " " + new
    if a in ")]" and b.isascii() and b.isalnum():
        return " " + new
    return new


def image_md(name: str, caption: str | None) -> str:
    """生成图片的 Markdown 语法。

    Args:
        name: 图片文件名(位于 md/images/)。
        caption: 题注文本; 为 None 时用文件名主干作替代文本(alt)。

    Returns:
        形如 ![alt](images/name) 的字符串。
    """
    alt = caption if caption else Path(name).stem
    return f"![{alt}](images/{name})"


def sniff_ext(data: bytes) -> str:
    """按文件头魔数判断图片格式。

    Args:
        data: 图片二进制内容。

    Returns:
        扩展名字符串(不含点): png/jpg/gif/bmp/webp; 无法识别时按 png 返回
        (PDF 内嵌图绝大多数为 PNG)。
    """
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:2] == b"\xff\xd8":
        return "jpg"
    if data[:3] == b"GIF":
        return "gif"
    if data[:2] == b"BM":
        return "bmp"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return "png"


def extract_images(page, page_idx: int, caps: list, hash_seen: dict,
                   registry: dict) -> list:
    """提取本页图片并按内容去重落盘。

    前 len(caps) 张图按题注命名为 fig-<图号>-<序号>, 其余按 img-p<页码>
    命名; 内容相同的图片(跨页复用)只写一次。

    Args:
        page: pypdf 的 Page 对象。
        page_idx: 0 基页码, 用于回退命名与冲突消歧。
        caps: 本页图题注 Line 列表, 与图片按出现顺序配对。
        hash_seen: 运行期共享的 {SHA-1: 文件名} 缓存, 用于跨页去重。
        registry: 运行期共享的 {文件名: SHA-1}, 用于重名冲突检测与
            最终清理未使用图片。

    Returns:
        本页图片文件名列表, 顺序与 PDF 中的出现顺序一致; 读取失败的图片
        跳过并打印 [warn]。

    Side effects:
        向 IMG_DIR 写入图片文件; 更新 hash_seen 与 registry; 失败时向
        stdout 打印警告。
    """
    names: list[str] = []
    try:
        imgs = list(page.images)
    except Exception as e:
        print(f"  [warn] 第{page_idx}页图片列表失败: {e}")
        return names
    for i, im in enumerate(imgs):
        try:
            data = im.data
        except Exception as e:
            print(f"  [warn] 第{page_idx}页图片数据失败: {e}")
            continue
        h = hashlib.sha1(data).hexdigest()
        if h in hash_seen:
            names.append(hash_seen[h])
            continue
        ext = sniff_ext(data)
        stem = f"img-p{page_idx}"
        if i < len(caps):
            m = CAPTION_IMG_RE.match(caps[i].text.strip())
            if m:
                stem = f"fig-{m.group(1)}-{m.group(2)}"
        fname = f"{stem}.{ext}"
        if fname in registry and registry[fname] != h:
            fname = f"{stem}-p{page_idx}.{ext}"
        (IMG_DIR / fname).write_bytes(data)
        registry[fname] = h
        hash_seen[h] = fname
        names.append(fname)
    return names


# ---------- 单元(章)渲染 ----------

def render_unit(reader, unit: dict, hash_seen: dict, registry: dict):
    """渲染一个输出单元(前言/某章/附录/索引)。

    逐页重建视觉行, 剔除页眉页脚的裸页码, 抽取图片, 再把「书签标题、附录
    小节标题、正文/代码/题注/图片」按 y 从上到下合并成一个事件流输出。

    Args:
        reader: pypdf 的 PdfReader。
        unit: build_units 产生的单元字典。
        hash_seen: 图片去重缓存, 透传给 extract_images。
        registry: 图片文件名登记表, 透传给 extract_images。

    Returns:
        (blocks, warns) 二元组:
            blocks: 该单元的 Markdown 块列表(段落/围栏代码/标题/图片),
                由 main 用空行连接后写盘;
            warns: 标题定位失败等警告文本列表。

    Side effects:
        写入 md/images/ 下的图片文件并更新 hash_seen、registry;
        不写 Markdown 文件(由 main 负责)。
    """
    blocks: list[str] = []
    warns: list[str] = []
    para: list[str] = []
    prev_body_x = None
    prev_body_y = None
    prev_page = None
    code_lines: list[str] = []
    code_y = None
    code_page = None

    def flush_para():
        nonlocal para
        if para:
            text = "".join(para).strip()
            if text:
                blocks.append(text)
        para = []

    def close_code():
        nonlocal code_lines, code_y, code_page
        if code_lines:
            blocks.append(fence(code_lines))
            code_lines = []
            code_y = None
            code_page = None

    def close_all():
        flush_para()
        close_code()

    for p in range(unit["start"], unit["end"] + 1):
        page = reader.pages[p]
        lines = assemble_page(page)
        # 版心之外的纯数字行是页眉/页脚页码, 不参与正文
        lines = [ln for ln in lines
                 if not (PAGE_NO_RE.match(ln.text.strip())
                         and (ln.y > MARGIN_TOP_Y or ln.y < MARGIN_BOT_Y))]
        # 图片提取与文本无关, 必须先于空页检查
        img_caps = [ln for ln in lines if is_img_caption(ln.text.strip())]
        imgs = extract_images(page, p, img_caps, hash_seen, registry)
        cap_img: dict = {}
        for idx, cap in enumerate(img_caps):
            if idx < len(imgs):
                cap_img[id(cap)] = imgs[idx]
        leftover = imgs[len(img_caps):]
        if not lines:
            if imgs:
                close_all()
                for name in imgs:
                    blocks.append(image_md(name, None))
            continue
        if leftover and not img_caps:
            close_all()                 # 无题注的图(封面/装饰图)置于页首
            for name in leftover:
                blocks.append(image_md(name, None))
        flush_x = min(ln.x0 for ln in lines)

        # 1) 书签标题: 在本页文本中定位, 按 y 插入并消费该行
        events: list = []
        for h in unit["headings"]:
            if h["page"] != p:
                continue
            target = h["title"]
            hit = next((ln for ln in lines
                        if not ln.consumed and heading_match(target, ln.text)),
                       None)
            y = None
            if hit is not None:
                hit.consumed = True
                y = hit.y
            else:
                warns.append(f"第{p}页未找到标题行: {h['title']}")
            events.append((y, "head", h))

        # 2) 附录内书签缺失的小节标题 (A.1 / A.2.1 ...)
        if unit["appendix"]:
            for ln in lines:
                if ln.consumed:
                    continue
                t = ln.text.strip()
                if APPX_HEAD_RE.match(t) and len(t) <= 30:
                    depth = t.split()[0].count(".")   # A.1→1  A.2.1→2
                    ln.consumed = True
                    events.append((ln.y, "head",
                                   {"title": t, "level": depth + 1}))

        # 3) 组织本页事件流, 按 y 从上到下处理
        evs: list = []
        for y, kind, payload in events:
            # 定位失败的标题给一个超大 y, 保证它排在本页所有正文之后
            evs.append((y if y is not None else 9e5, kind, payload))
        for ln in lines:
            if not ln.consumed:
                evs.append((ln.y, "line", ln))
        # y 从大到小 = 页面自上而下
        evs.sort(key=lambda e: -e[0])

        for _y, kind, payload in evs:
            if kind == "img":
                close_all()
                for name in payload:
                    blocks.append(image_md(name, None))
                continue
            if kind == "head":
                close_all()
                blocks.append("#" * payload["level"] + " " + payload["title"])
                continue

            ln = payload
            t = ln.text.strip()
            if not t:
                continue
            if unit["index_mode"]:
                close_all()
                # 索引页: 单个字母是字母段标题, 其余为词条列表项
                if re.fullmatch(r"[A-Za-z]", t):
                    blocks.append("**" + t + "**")
                else:
                    blocks.append("- " + t)
                continue
            if is_caption(t):
                close_all()
                name = cap_img.get(id(ln))
                if name:
                    blocks.append(image_md(name, t))
                blocks.append("**" + t + "**")
                continue
            if ln.is_code:
                flush_para()
                # 跨页或纵向间隙过大说明是另一段代码, 需另起围栏
                if code_lines and (code_page != p or code_y - ln.y > CODE_GAP):
                    close_code()
                code_lines.append(render_code_line(ln, flush_x))
                code_y = ln.y
                code_page = p
                continue

            # 正文段落
            text = render_inline(ln)
            if not text:
                continue
            close_code()
            if not para:
                para.append(text)
            else:
                # 段落切分启发式: 纵向间隙过大、或本行另有段首缩进而上一行
                # 未缩进、或本行是项目符号时开新段, 否则视为同一段的折行
                brk = False
                if prev_page == p and prev_body_y - ln.y > PARA_GAP:
                    brk = True
                elif (ln.x0 >= PARA_INDENT_X and prev_body_x is not None
                      and prev_body_x <= FLUSH_X_HINT):
                    brk = True
                elif BULLET_RE.match(text):
                    brk = True
                if brk:
                    flush_para()
                    para.append(text)
                else:
                    para.append(join_lines(para[-1], text))
            prev_body_x = ln.x0
            prev_body_y = ln.y
            prev_page = p

        if leftover and img_caps:
            close_all()     # 配对不完的图(题注在下页)置于页尾, 保持原书位置
            for name in leftover:
                blocks.append(image_md(name, None))

    close_all()
    if not blocks:
        blocks.append("# " + unit["title"])
    return blocks, warns


# ---------- 汇总输出与入口 ----------

def write_readme(units: list) -> None:
    """生成 md/README.md 目录页。

    原书内置「目录」页位于正文之前且版式为多栏, 难以按行重建, 故整页跳过,
    改由本函数根据书签生成等效目录。

    Args:
        units: build_units 产生的单元列表。

    Returns:
        None。

    Side effects:
        覆盖写入 md/README.md (UTF-8); 索引单元不展开二级条目。
    """
    out = [
        "# 《C程序设计语言》（第2版·简体中文）Markdown 版",
        "",
        "> 由 `pdf_to_md.py` 从 `c-programming-language-2nd-edition-simple-chinese.pdf` "
        "自动转换生成 (基于 pypdf 的文字坐标与字体信息重建标题、段落、代码块与插图)。"
        "原书内置「目录」页未转换, 以本目录替代; 插图位于 `images/` 目录。",
        "",
        "## 目录",
        "",
    ]
    for u in units:
        out.append(f"- [{u['title']}]({u['file']})")
        if not u["index_mode"]:
            for h in u["headings"]:
                if h["level"] >= 2:
                    out.append(f"  - {h['title']}")
    out.append("")
    (OUT_DIR / "README.md").write_text("\n".join(out), encoding="utf-8")


def guard_overwrite(force: bool) -> None:
    """覆盖保护: 已有书稿时拒绝重新生成, 除非显式要求。

    md/ 由人工整理过(句读、题注、三级小节标题、图片命名都与脚本原始输出不同),
    且是 course-content.json 的唯一来源, 一旦被重新生成就会整体覆盖。

    Args:
        force: 是否为本次运行显式传入了 --force。

    Side effects:
        检测到已有书稿且未传 --force 时向 stdout 打印提示并以退出码 1 结束进程。
    """
    existing = sorted(OUT_DIR.glob("*.md")) if OUT_DIR.is_dir() else []
    if not existing or force:
        return
    print(f"[中止] {OUT_DIR} 下已存在 {len(existing)} 个 Markdown 文件, 重新生成会整体覆盖:")
    for path in existing[:5]:
        print(f"  - {path.name}")
    if len(existing) > 5:
        print(f"  … 另有 {len(existing) - 5} 个")
    print("       md/ 是人工整理过的书稿(课程数据的来源), 请先备份或将改动纳入版本控制;")
    print("       确认要重新生成时加 --force: python tools/pdf_to_md.py --force")
    sys.exit(1)


def main() -> None:
    """程序入口: 解析 PDF 书签, 逐单元渲染并写出 Markdown 与图片。

    流程: 覆盖保护 → 校验 PDF 存在 → 读大纲并切分单元 → 逐单元渲染写盘 →
    生成目录 → 清理本次未再生成的旧图片 → 打印标题警告与统计。

    Returns:
        None。

    Side effects:
        写入 md/ 下的 Markdown 与图片文件; 删除 md/images/ 中本次未使用的
        旧文件; 向 stdout 打印进度、警告与统计; 已有书稿且未传 --force 时退出码 1。
    """
    guard_overwrite("--force" in sys.argv)
    if not PDF_PATH.exists():
        sys.exit(f"找不到 PDF: {PDF_PATH}")
    reader = PdfReader(str(PDF_PATH))
    outline = read_outline(reader)
    units = build_units(outline, len(reader.pages))
    OUT_DIR.mkdir(exist_ok=True)
    IMG_DIR.mkdir(exist_ok=True)
    hash_seen: dict = {}
    registry: dict = {}
    all_warns: list = []
    for u in units:
        print(f"[{u['file']}] 页 {u['start']}..{u['end']}")
        blocks, warns = render_unit(reader, u, hash_seen, registry)
        all_warns.extend(warns)
        text = "\n\n".join(b for b in blocks if b).strip() + "\n"
        if text.count("```") % 2:
            print(f"  [warn] {u['file']} 代码围栏不平衡")
        if "\ufffd" in text:
            print(f"  [warn] {u['file']} 含 U+FFFD 替换字符")
        (OUT_DIR / u["file"]).write_text(text, encoding="utf-8")
        print(f"  {len(blocks)} 块, {len(text)} 字符")
    write_readme(units)
    # 清理上一次运行遗留、本次未再生成的图片
    for f in IMG_DIR.glob("*"):
        if f.is_file() and f.name not in registry:
            f.unlink()
    for w in all_warns:
        print("[标题]", w)
    print(f"完成: {OUT_DIR}  (图片 {len(list(IMG_DIR.glob('*')))} 张)")


if __name__ == "__main__":
    main()




