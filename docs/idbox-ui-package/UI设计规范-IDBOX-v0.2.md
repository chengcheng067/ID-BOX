# ID BOX · UI 设计规范 v0.2（交付开发版）

> 依据 `11-UI需求-IDBOX.md` + 用户 2026-10-14 三轮拍板整理。
> 设计稿源文件：Ardot `736163821507042`（14 屏）。截图见 `screens/`。
> **底线**：结构与交互以本文档为准；色值必须取自本文 token 表，禁止自行取色。

---

## 0. 一句话总纲

浅色 = **Soft UI**（slate 浅底、白卡大圆角、柔影替代描边）；深色 = **macOS Vibrancy**（三档中性深灰、1px 描边、无投影）。
两主题共用：**系统蓝强调色 + Sarasa Gothic SC + 中性灰阶文字**。
⛔ 全局禁用：橙色/棕色高亮、紫色系、玻璃拟态 backdrop-blur、渐变。

---

## 1. 色彩 Token（CSS 变量，直接可用）

```css
:root, [data-theme="light"] {
  /* Soft UI 浅色 */
  --bg-canvas:        #F8FAFC;  /* 画布/中栏 */
  --bg-sidebar:       #F1F5F9;  /* 侧栏/输入面/搜索框底 */
  --bg-elevated:      #E2E8F0;  /* 选中导航底（非强调态） */
  --surface-card:     #FFFFFF;  /* 卡片/弹窗/操作条 */
  --border:           #E2E8F0;  /* 1px 分隔线（仅弹窗/槽位组） */
  --text-primary:     #1F2937;
  --text-secondary:   #4B5563;
  --text-tertiary:    #6B7280;  /* 图标/次级文字 */
  --text-muted:       #9CA3AF;  /* 弱化/计数 */
  --accent:           #007AFF;  /* 系统蓝（浅色） */
  --accent-text:      #007AFF;
  --accent-tint:      #E1EFFF;  /* 选中导航/徽标/chip 底 */
  --danger:           #E5484D;
  --danger-tint:      #FEF1F0;
  --success:          #30A46C;

  /* Soft UI 阴影（替代描边） */
  --shadow-card:      0 8px 24px rgba(100, 116, 139, 0.10);
  --shadow-card-active: 0 8px 24px rgba(0, 122, 255, 0.15);
  --shadow-modal:     0 16px 48px rgba(38, 48, 64, 0.18);
  --shadow-floatbar:  0 12px 32px rgba(38, 48, 64, 0.18);
}

[data-theme="dark"] {
  /* macOS Vibrancy 深色 */
  --bg-canvas:        #111113;  /* 画布/中栏，黑就黑下去 */
  --bg-sidebar:       #161618;  /* 侧栏/底栏/右栏 */
  --surface-card:     #1C1C1E;  /* 卡片/弹窗 */
  --bg-elevated:      #242428;  /* 浮起：输入框/操作条/tab hover */
  --bg-active-nav:    #1E2A38;  /* 选中导航底（蓝 tint） */
  --border:           #2A2A2D;  /* 1px 描边，唯一的分隔手段 */
  --text-primary:     #F2F2F4;
  --text-secondary:   #98989E;
  --text-muted:       #636368;
  --accent:           #0A84FF;  /* 系统蓝（深色） */
  --accent-text:      #6DB2FF;  /* 深色上的强调文字/徽标字 */
  --accent-tint:      #1E2A38;
  --danger:           #FF6961;
  --danger-tint:      #2A1517;
  --success:          #7A9268;

  --shadow-modal:     0 16px 48px rgba(0, 0, 0, 0.5);
  /* 卡片不加投影，靠 #111113 → #161618 → #1C1C1E → #242428 明度分层 */
}
```

**铁律**：深色主题底色必须中性（不带色相）；暖色/彩色只允许出现在强调位（CTA、选中态、徽标、chip、危险钮）和素材缩略图本身。

---

## 2. 字体 / 圆角 / 间距

```css
:root {
  --font-family: "Sarasa Gothic SC", "Microsoft YaHei UI", sans-serif;

  --fs-page-title:   17px;  /* Semi Bold 600，中栏标题 */
  --fs-modal-title:  16px;  /* Semi Bold */
  --fs-section:      14px;  /* Semi Bold，面板标题/资产名 */
  --fs-card-title:   13px;  /* Semi Bold，弹窗小节标题 */
  --fs-card-name:    12px;  /* Semi Bold，卡片名/按钮/正文强调 */
  --fs-body:         12px;  /* Regular，正文/导航 */
  --fs-caption:      11px;  /* Regular，辅助说明/文件行 */
  --fs-micro:        10px;  /* Regular，徽标/计数/库路径 */

  --radius-btn:      10px;  /* 按钮/输入框/CTA */
  --radius-modal:    14px;  /* 弹窗/预览区 */
  --radius-card:     16px;  /* 资产卡片 */
  --radius-nav:      9px;   /* 侧栏导航项 */
  --radius-chip:     6px;   /* 徽标/chip */
  --radius-winbtn:   7px;   /* 窗口控制钮 28×28 */

  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 20px; --space-6: 24px;
  --gap-card: 16px;              /* 卡片网格间距 */
  --stroke-width: 1px;           /* 所有描边一律 1px，选中态 1.5-2px */
}
```

---

## 3. 组件规格

### 3.1 顶栏（高 56，`--bg-canvas`，浅色无底边线/深色 1px `--border`）
| 元素 | 规格 |
| --- | --- |
| Logo | 22×22 圆角6 `--accent` 方块 + "ID BOX" 15px Semi Bold |
| 搜索框（默认收起） | **32×32 图标按钮**，底 `--bg-sidebar`，只有放大镜图标，无占位文字 |
| 搜索框（点击展开） | **右对齐展开至 380px**，右缘与右栏详情面板齐平，向左扩展把 CTA 顶向左；显示占位文字"搜索名称 / 标签 / 分类" |
| 最近导入 ▾ | 纯文字 + caret，12px `--text-secondary` |
| 视图切换 | 68×32 分段控件，底 `--bg-sidebar`，选中段白底（深色 `#2C2C2E`）+ 蓝图标 |
| 导入压缩包（唯一 CTA） | 132×32，底 `--accent`，白字 12px Semi Bold，导入图标 |
| 窗口控制（自绘） | 最小化(–)/最大化(□) `--text-tertiary` 28×28 方钮 r7；**关闭 ✕ 用 danger 色**；hover 加浅灰底 |

### 3.2 左栏库导航（宽 216）
- 分组：全部 → 分类（模型/贴图/HDRI/材质预设/其他，**未分类恒排最后**）→ SU 版本 → 风格 → 来源 →（弹性空白）→ 设置 → 库路径小字
- 行高 32，r9；选中：浅色 `--accent-tint` 底+蓝字 / 深色 `--bg-active-nav` 底+`--accent-text` 字
- 每行右侧计数：11px `--text-muted`
- 底部：库路径 + 版本号小字（10px muted）

### 3.3 资产卡片
- **所有缩略图统一 1:1（224px）**（2026-10-14 用户拍板：四卡等高；模型图填充裁切居中）
- 卡片：白底/`#1C1C1E`，r16；浅色柔影替代描边；**选中：2px `--accent` 描边 + 右上角 22×22 蓝色对勾徽章（白描边 2px，深色用深底描边）**
- 缩略图优先级：包内 Preview/预览/封面图 > SKP 内嵌 > 包内其他渲染图 > 类型图标占位
- 卡片信息：名称 12px Semi Bold + 类型徽标（贴图=accent-tint/模型=中性灰 tint）+ 体积/文件数/SU 版本 11px muted
- **多选浮出操作条**：白底（深 `#242428`）r14 投影，**相对中栏水平居中**、悬浮于网格底部；内容：`已选 N 项` 胶囊（accent-tint）→ 指派分类（实心蓝）→ 删除（danger-tint 底 danger 字）→ 取消（纯文字）

### 3.4 右栏详情（宽 300）
- 预览区：材质 1:1 / 模型现有比例，r14
- 更换封面条：`--bg-sidebar` 底 28px，文字"更换封面 · 粘贴 / 拖图 / 选文件"（支持粘贴/拖图/选文件三来源）
- 分类 chips：一级/二级，accent-tint 蓝字，可点击改；"＋ 风格 / 标签"为描边 ghost chip
- **文件按槽位分组**（`文件（8）` 头 + 右侧"可单独拖出"提示）：
  组头 26px（`--bg-canvas` 底，11px Semi Bold）+ 文件行 28px（文件名 + 体积右对齐）
  槽位：基础色 Albedo / 法线 Normal / 粗糙度 Roughness / AO / 置换 Displacement / 元数据 / 预览 / 其他（识别不进的归"其他"，不丢弃）
  **每行可单独拖出到 SU/D5**
- 底部操作行：`打开所在文件夹`（描边钮，flex-1）+ `删除`（danger 描边钮 72px）

### 3.5 底部 toast（高 44）
- 左：绿圆勾图标 + 结果文字（"导入完成 3 个资产 · 已自动剔除 2 个杂质文件"）
- 右：**5 秒删除撤销条**——"删除「资产名」" + 蓝底"撤销 Ns"按钮，倒计时结束自动消失

### 3.6 设置弹窗（760×560，左 tab 右内容）
- tab 栏宽 172，`--bg-sidebar` 底：外观/导入/库与分类/数据与备份/高级/关于；左下角小字版本号
- 选中 tab：accent-tint 底 + accent 字
- **导入 tab**：原压缩包处置三档单选卡（选中项 accent 描边 1.2px；默认"移入回收站"）；同时解压任务数 stepper（默认 2）；库维护·重新扫描按钮（**从顶栏移入此处，顶栏不放**）
- **外观 tab**：主题三选卡（各带迷你界面预览 + 单选点）；未实现主题 55% 透明度禁用并标"v0.2 留位"
- **关于 tab**：居中 Logo 56×56 r16 + "ID BOX" 22px + **版本号胶囊（accent-tint 底，13px Semi Bold，醒目）** + 检查更新（禁用灰，留位）+ "MIT License · 本地离线运行 · 数据不出设备"

### 3.7 自定义渲染面板（820×560）
- 左：渲染画布 460×420（深色近黑底 `#0D0A07`，材质球最出效果）+ "实时预览 · 拖动滑块即时重渲"
- 右：两个滑块（**第一版只放两个**）：反光强度（roughness 倍率）、凹凸强度（normal/displacement 倍率），拖动即时重渲
- 底部：`保存 · 设为封面`（实心 accent 通栏钮）→ 离屏渲染一帧存 JPG，`coverSource='manual'`
- three.js MaterialBall 底层已有，只加滑块与保存

---

## 4. 关键交互规则（逐条验收）

1. **搜索框**：默认收起仅图标（32×32）；点击后右对齐展开 380px，右缘与右栏详情面板对齐；失焦/ESC 收起
2. **窗口控制**：软件内自绘，不用系统原生；关闭钮红色区分
3. **拖入**：压缩包→现有链路；**单张图片→独立"贴图"资产**；文件夹→现有链路；图片拖到详情封面区→设为封面（stopPropagation）
4. **缩略图**：材质包内 `Preview/预览/封面` 命名图直接当封面；three.js 渲染球仅为兜底（无成品图且槽位齐全时才渲，结果存 JPG）
5. **删除**：确认 + **5 秒撤销条**（底部 toast 右侧）
6. **多选**：框选/Ctrl 点击；浮出操作条相对中栏居中
7. **重新扫描**：只放设置·导入 tab，顶栏不占位
8. **落盘规则**：导入零打断 → `<大类>/未分类/未分类/<资产名>`，事后指派分类

---

## 5. 屏幕清单（screens/）

| 文件 | 内容 |
| --- | --- |
| 01-主界面-浅色.png | 五区全览（Soft UI），搜索展开态 |
| 02-设置-导入-浅色.png | 原包处置三档/并发/重新扫描 |
| 03-自定义渲染-浅色.png | 双滑块+保存设为封面 |
| 04-主界面-深色.png | Vibrancy 版主界面 |
| 05-设置-外观-浅色.png | 主题三选卡（浅色选中） |
| 06-设置-关于-浅色.png | 版本号醒目 |
| 07-多选操作条-浅色.png | 选中卡+浮动操作条（中栏居中） |
| 09-UI设计规范.png | 双主题 token 总表面板 |
| 10-设置-导入-深色.png | 深色对应 |
| 11-自定义渲染-深色.png | 深色对应 |
| 12-设置-外观-深色.png | 深色选中态 |
| 13-设置-关于-深色.png | 深色对应 |
| 14-多选操作条-深色.png | 深色对应 |

---

## 6. 待确认（不阻塞开发）

- Q2 自动预分类（建议：按文件名/来源匹配词表，能配则配，配不进仍落未分类）
- Q3 多张图片同时拖入：各自独立（当前设计）vs 合并贴图组
- 窗口控制 hover 底色（稿中未画：建议浅色 `rgba(0,0,0,0.06)` / 深色 `rgba(255,255,255,0.08)`，关闭钮 hover 直接变红底白叉）

---
*v0.2 · 2026-10-14 · 苏小匠按丞丞三轮反馈定稿 · 结构交互已拍板，视觉以本文 token 为准*
