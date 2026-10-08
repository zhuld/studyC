#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""md_to_course.py —— 流水线第 2 阶段: 分章 Markdown → course-content.json。

读取 pdf_to_md.py 生成的八章 Markdown, 把每节正文解析成块级 HTML 后写回
课程数据 course-content.json, 并同步图片与 meta.blurb。本脚本只更新课程
内容数据, 不改动页面(HTML/CSS/JS)。

输入:
    md/NN-第N章-*.md     八章书稿 (见下方 CHAPTER_FILES)
    md/images/*          书稿引用的图片
    course-content.json  既有课程数据 (章节/小节编号作为写入骨架)
输出:
    course-content.json  paragraphs / theory / meta.blurb 被 md 正文覆盖
    images/*             从 md/images/ 复制来的图片 (程序根目录)

命令行用法(在仓库根目录执行):
    python tools/md_to_course.py            # 写入 JSON 并复制图片, 随后自校验
    python tools/md_to_course.py --verify   # 只做 md ⇔ JSON 一致性校验, 不写文件

写入规则:
    - md 中 `## x.y` 是教材主小节, `### x.y.z` 是第三级小节; 二者与 JSON 里
      91 个 tutorials 的编号一一对应 (77 主小节 + 14 三级小节)
    - 每节的 paragraphs / theory 只取「该节标题之下的正文」: 三级小节
      (subsection) 显示 `### x.y.z` 的内容, 其原有内容被 md 正文覆盖清除;
      父节不再吞并三级正文
    - 同步 meta.blurb; sections、bookExercises、page、sectionId 等保持不变

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

# 整块图片: 一行或多行成块后就是 ![](images/...), 用 $ 锚定到块尾
IMAGE_BLOCK_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)\s*$")
# 行内代码 `...` 与行内粗体 **...**
INLINE_CODE_RE = re.compile(r"`([^`]+)`")
INLINE_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
# 主小节编号 x.y 与三级小节编号 x.y.z
SECTION_NUM_RE = re.compile(r"^\d+\.\d+$")
SUB_NUM_RE = re.compile(r"^\d+\.\d+\.\d+$")


# ---------- Markdown 解析 ----------

class Block:
    """md 内容块: kind = p(段落) | code(围栏代码) | img(图片)。

    解析阶段填入 text/alt/src, build_html 阶段生成两种 HTML 表示:
    inner 为不含 <p> 的内联 HTML(写入 paragraphs), full 为块级 HTML
    (写入 theory)。

    Attributes:
        kind: 块类型, "p"/"code"/"img"。
        text: p 为段落原文; code 为代码正文(不含围栏); img 为 ""。
        alt: 图片替代文本。
        src: 图片路径(相对 md/)。
        inner: 内联 HTML, 仅 p 有值。
        full: 块级 HTML。
    """

    def __init__(self, kind: str, text: str = "", alt: str = "", src: str = ""):
        """初始化内容块。

        Args:
            kind: 块类型, "p"/"code"/"img"。
            text: 段落原文或代码正文。
            alt: 图片替代文本。
            src: 图片路径。

        Side effects:
            无。
        """
        self.kind = kind
        self.text = text      # p: 段落原文; code: 代码正文(不含围栏); img: ""
        self.alt = alt
        self.src = src
        self.inner = ""       # p: 不含 <p> 的内联 HTML (写入 paragraphs)
        self.full = ""        # 块级 HTML (写入 theory)

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
        return self


def md_inline_to_html(text: str) -> str:
    """把行内标记转换为 HTML。

    先整体转义 &<> , 再处理 `code` 与 **粗体**。为避免先转义再匹配时把
    code 内部的内容当作标记处理, code 片段先替换成 \\x00<序号>\\x00 占位符,
    粗体处理完后再换回 <code>…</code>。

    Args:
        text: 段落原文(可能含 `code`、**粗体**)。

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
    s = re.sub(r"\x00(\d+)\x00",
               lambda m: "<code>" + spans[int(m.group(1))] + "</code>", s)
    return s


def parse_chapter(path: Path):
    """解析章节 md, 按其自带的标题切分为小节块。

    每个 `## x.y` / `### x.y.z` 标题开一节, 正文归该节所有; 返回顺序与 md
    中一致(不排序、不去重)。章标题 `# ` 行忽略, 标题之前的正文作为章首导言。
    块以空行分隔; 相邻非空行先累积, 遇空行/新标题/围栏开关时整体 flush。

    Args:
        path: 章 md 文件路径。

    Returns:
        (intro_blocks, sections) 二元组:
            intro_blocks: 章首导言 Block 列表;
            sections: [(编号, [Block, ...]), ...], 编号为 "x.y" 或 "x.y.z"。

    Raises:
        FileNotFoundError: 文件不存在。
        ValueError: 行内标题编号异常、三级小节未紧跟父节、围栏未闭合、
            图片块混入多行或图片路径异常。

    Side effects:
        无(只读取 md 文件)。
    """
    if not path.exists():
        raise FileNotFoundError(path)
    lines = path.read_text(encoding="utf-8").split("\n")
    intro: list[Block] = []
    sections: list[tuple[str, list[Block]]] = []
    target: list[Block] = intro
    cur_main: str | None = None   # 当前所属主小节编号 (三级小节的父节)
    cur: list[str] = []
    in_fence = False

    def flush():
        nonlocal cur, in_fence
        if not cur:
            return
        body = "\n".join(cur)
        if not body.strip():
            cur = []
            return
        if in_fence:
            ls = cur
            if len(ls) < 2 or not ls[-1].startswith("```"):
                raise ValueError(f"{path.name}: 代码围栏未闭合: {ls[0][:40]!r}")
            blk = Block("code", "\n".join(ls[1:-1]))
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

    for line in lines:
        if in_fence:
            cur.append(line)
            if line.startswith("```") and len(cur) > 1:
                flush()
                in_fence = False
            continue
        if line.startswith("```"):
            flush()
            in_fence = True
            cur = [line]
            continue
        if line.startswith("###"):
            # 第三级小节标题 (如 `### 1.5.1. 文件复制`): 正文归该小节所有
            # 必须先于 `## ` 判断, 否则 "###" 会被 "## " 之类规则误吞
            flush()
            # 去掉标题尾部的点
            num = line[3:].split()[0].rstrip(".")
            if not SUB_NUM_RE.match(num):
                raise ValueError(f"{path.name}: 三级小节编号异常: {line!r}")
            if num.rsplit(".", 1)[0] != cur_main:
                raise ValueError(
                    f"{path.name}: 三级小节 {num} 未紧跟其父节 {cur_main}: {line!r}")
            target = []
            sections.append((num, target))
            continue
        if line.startswith("## "):
            flush()
            num = line[3:].split()[0]
            if not SECTION_NUM_RE.match(num):
                raise ValueError(f"{path.name}: 节编号异常: {line!r}")
            cur_main = num
            target = []
            sections.append((num, target))
            continue
        if line.startswith("# "):
            flush()          # 章标题行, 忽略
            continue
        if not line.strip():
            flush()          # 空行 = 块边界
            continue
        cur.append(line)
    flush()
    if not sections:
        raise ValueError(f"{path.name}: 未找到任何 ## 节")
    return intro, sections


def plain_md(text: str) -> str:
    """剥离 md 行内标记, 得到纯文本 (用于 meta.blurb)。

    Args:
        text: 含 `code` / **粗体** 的段落原文。

    Returns:
        去掉反引号与双星号、并去除首尾空白后的文本。
    """
    return text.replace("`", "").replace("**", "").strip()


# ---------- 写入 JSON ----------

def apply_content(data: list, parsed: list) -> None:
    """把八章书稿写入 JSON: meta.blurb + 各节 paragraphs/theory。

    Args:
        data: course-content.json 反序列化后的章节列表(就地修改)。
        parsed: 八章的 parse_chapter 结果, 顺序与 data 对应。

    Returns:
        None。

    Side effects:
        就地覆盖 data 中每节的 paragraphs、theory 与每章 meta.blurb;
        向 stdout 打印每章同步统计。

    Raises:
        AssertionError: 章节数不为 8、编号重复, 或 md 与 JSON 的小节集合
            不一致时立即失败, 避免写坏数据。
    """
    assert len(data) == 8 == len(parsed), "章节数必须为 8"
    for ci, (intro, sections) in enumerate(parsed):
        chap = data[ci]
        sec_map = dict(sections)
        assert len(sec_map) == len(sections), f"第{ci+1}章节编号重复"
        tuts = {t["number"]: t for t in chap["tutorials"]}
        assert len(tuts) == len(chap["tutorials"]), f"第{ci+1}章 tutorial 编号重复"
        md_nums = {n for n, _ in sections}
        assert md_nums == set(tuts), (
            f"第{ci+1}章 md 与 JSON 小节不一致: "
            f"仅md={sorted(md_nums - set(tuts))} 仅json={sorted(set(tuts) - md_nums)}")
        # meta.blurb ← 章首导言首段
        intro_ps = [b for b in intro if b.kind == "p"]
        assert intro_ps, f"第{ci+1}章缺章首导言段落"
        chap["meta"]["blurb"] = plain_md(intro_ps[0].text)
        # 正文: paragraphs = 前两个块(块级 HTML, 严格保序), theory = 其余全部块
        # 三级小节 (### x.y.z) 只取本小节标题下的正文, 覆盖清除其原有内容;
        # 父节不再包含三级小节的正文 (正文交由对应 subsection 显示)
        n_sub = 0
        for idx, (num, sec_blocks) in enumerate(sections):
            # 首节的块 = 章首导言 + 该节正文, 使导言随之进入 1.1 的 paragraphs
            blocks = (intro + sec_blocks) if idx == 0 else sec_blocks
            assert blocks, f"{num}: 标题下没有正文块"
            if num.count(".") > 1:
                n_sub += 1
            t = tuts[num]
            t["paragraphs"] = [b.full for b in blocks[:2]]
            t["theory"] = (["\n".join(b.full for b in blocks[2:])]
                           if len(blocks) > 2 else [])
        print(f"  第{ci+1}章: {len(sections) - n_sub} 主小节 + {n_sub} 三级小节已同步")


def sync_images(parsed: list) -> int:
    """把章节引用的图片从 md/images/ 复制到程序根目录 images/。

    Args:
        parsed: 八章的 parse_chapter 结果。

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
        blocks = list(intro) + [b for _, bs in sections for b in bs]
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
        img 块返回 ""; p 块去掉整块包裹的 ** 与其中的反引号;
        code 块原样返回正文。
    """
    if b.kind == "img":
        return ""
    t = b.text
    if b.kind == "p":
        st = t.strip()
        # 整块粗体多为题注, 去掉外层 ** 才能与 JSON 去标签文本对齐
        if st.startswith("**") and st.endswith("**") and len(st) >= 4:
            t = st[2:-2]
        t = t.replace("`", "")
    return t


def norm_json(s: str) -> str:
    """归一化 JSON 侧 HTML 文本, 便于与 md 纯文本比对。

    Args:
        s: 由 paragraphs/theory 拼接的 HTML 文本。

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

    Args:
        data: 待校验的 JSON 章节列表(apply_content 之后或磁盘既有数据)。
        parsed: 八章的 parse_chapter 结果。

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
        for num, sec_blocks in sections:
            t = tuts.get(num)
            if t is None:
                errors.append(f"第{ci+1}章 {num}: md 有而 JSON 无")
                continue
            blocks = (intro + sec_blocks) if num == first_num else sec_blocks
            # 两侧都做空白折叠: md 保留原书换行, JSON 侧 HTML 无换行信息
            a = re.sub(r"\s+", " ",
                       " ".join(block_md_text(x) for x in blocks)).strip()
            b = norm_json(" ".join(t["paragraphs"]) + " " + " ".join(t["theory"]))
            if a != b:
                errors.append(f"{num} 文本不一致: {first_diff(a, b)}")
            na = sum(1 for x in blocks if x.kind == "img")
            nb = " ".join(t["paragraphs"] + t["theory"]).count("<img ")
            total_imgs += na

            if na != nb:
                errors.append(f"{num} 图片数不一致: md={na} json={nb}")
        # md 中没有对应标题的 tutorial
        md_nums = {n for n, _ in sections}
        for t in chap["tutorials"]:
            if t["number"] not in md_nums:
                errors.append(f"第{ci+1}章 {t['number']}: JSON 有而 md 无")
        # 章首导言 / blurb
        intro_ps = [x for x in intro if x.kind == "p"]
        if intro_ps and plain_md(intro_ps[0].text) != chap["meta"]["blurb"]:
            errors.append(f"第{ci+1}章 meta.blurb 与章首导言首段不一致")
    # 全局检查
    dump = json.dumps(data, ensure_ascii=False)
    if re.search(r"\?{3,}", dump):
        errors.append("输出含 ??? 占位符")
    if total_imgs != 20:
        errors.append(f"八章图片引用总数应为 20, 实际 {total_imgs}")
    return errors


# ---------- 入口 ----------

def main() -> None:
    """程序入口: 解析书稿, 写入 JSON 并自校验(或仅校验)。

    默认流程: 读入 course-content.json → 解析八章 md → apply_content 写正文 →
    sync_images 复制图片 → 写回 JSON → verify 校验。带 --verify 时只校验,
    不写 JSON、不复制图片。

    Returns:
        None。

    Side effects:
        默认模式下覆盖写入 course-content.json 与 images/ 下的图片;
        打印进度与统计; 校验失败时以退出码 1 结束进程。
    """
    verify_only = "--verify" in sys.argv
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    assert len(data) == 8, "course-content.json 应含 8 章"
    parsed = [parse_chapter(MD_DIR / f) for f in CHAPTER_FILES]
    if verify_only:
        errors = verify(data, parsed)
    else:
        apply_content(data, parsed)
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
    n_main = sum(1 for c in data for t in c["tutorials"]
                 if t["number"].count(".") == 1)
    n_sub = sum(1 for c in data for t in c["tutorials"]
                if t["number"].count(".") > 1)
    print(f"[ OK ] 8 章 / {n_main} 主小节 + {n_sub} 三级小节 "
          f"md⇔JSON 文本逐节一致, 图片一致")


if __name__ == "__main__":
    main()

