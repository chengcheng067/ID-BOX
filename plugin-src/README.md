# ID BOX · SketchUp 插件（V1.0 初版）

这是 **ID BOX 的 SketchUp 扩展面板**：在 SketchUp 里搜本地 ID BOX 库，点一下就插入模型。
插件自己**不建库、不改库、不联网**——索引和分类的唯一权威仍在 ID BOX 应用里。

> ⚠️ **本目录里的 Ruby 语法从未在本机执行过**：开发这台机器上没有装 Ruby，也没有装
> SketchUp，所以**没有跑过 `ruby -c`、没有在 SketchUp 里加载过**。已做的是：逐行复读、
> 逐字段对账 `src/shared/pluginSnapshot.ts`、用 grep 证明硬约束成立。第一次真机装包请按
> 下面的「自检清单」逐条看。

---

## 目录结构（打包后 `.rbz` 根里恰好两项）

```
plugin-src/
  idbox_panel.rb          ← 根注册文件（registrar）：只注册扩展 + 元数据，不含逻辑
  idbox_panel/            ← 与根 .rb 同名的支持目录（其余内容全在这里）
    main.rb               ← 装配入口（加载链序 0–7 + guard 块，单一模块 IDBoxPanel）
    panel.html            ← 面板 UI（UI::HtmlDialog#set_file 加载；零外链、零网络）
    lib/                  ← core / paths / loader / panel_callback / panel_dialog / toolbar（1.1.0 起实际产出，见 docs/42 §2）
    assets/               ← toolbar.svg + toolbar.pdf（工具栏矢量图标成对，按平台二选一）
```

`native/<platform>/<rubyVer>/` 按 `docs/39 §4.2` **只立约定、不产出文件**
（V1.0 无原生件、无第三方 gem，只用 stdlib 的 `json` / `digest`）。

## 怎么安装

1. 在 ID BOX 里导出插件包，得到一个 `idbox_panel-x.y.z.rbz` 文件（`.rbz` 就是改名的 ZIP）。
2. SketchUp → **扩展 → 扩展程序管理器 → 安装扩展**（Extension Manager → Install Extension），
   选中那个 `.rbz`。
3. **重启 SketchUp**（装完当次不生效是正常的）。
4. 菜单 **扩展 → ID BOX 资产面板** 打开面板。

前置条件：ID BOX 里 **设置 → 数据与备份 → SketchUp 插件** 打开「插件索引导出」，
并让 ID BOX **刷新过一次索引**。没有这两个文件，面板只会显示 `IDBOX-101` 的指引。

索引文件位置（固定，不猜路径）：

```
%APPDATA%\idbox\plugin\manifest.json
%APPDATA%\idbox\plugin\index.json
```

## V1.0 支持什么

| 能力 | 状态 |
| --- | --- |
| 搜索：按名称 / 大类 / 子类过滤（**纯前端过滤，不发任何请求**） | ✅ |
| 列表：名称 + 分类路径 + 类型标签 | ✅ |
| 插入：`kind = model` 的记录，一次点击插入当前模型 | ✅ |
| 单步撤销：整个插入包在一次 `start_operation` … `commit_operation` 里 | ✅ |
| 路径安全：只为库根之下的文件加载组件（等价 `isWithinRoot`，越界 → `IDBOX-105`） | ✅ |
| 版本预警：`suMajor` 高于当前 SketchUp 时先确认（`IDBOX-104`） | ✅ |
| 错误提示：`IDBOX-101/102/103/104/105/106` 全部给中文可读文案 | ✅ |
| 索引新鲜度：显示「索引更新于 X 秒前」，超过 `freshnessHintSeconds` 变黄提示 | ✅ |
| 面板打开时每 3 s 只比 `manifest.generatedAt` / `indexSha256`，变了才重读索引 | ✅ |
| 半写防护：`SHA256` 不一致当「正在写」，`sleep 0.2` 重试，连续 3 轮才报 `IDBOX-102` | ✅ |
| 阈值：SketchUp 2021+（低于它提示 `IDBOX-106`，不开面板） | ✅ |

## V1.0 **故意不做**什么

- **材质 / 贴图 / HDRI / CAD 的取用**：`Material#texture=` 这一类材质 API 仍是【待核实】
  （`docs/38 §8.2` D2 的结论等真机探针）。所以这些行**插入按钮置灰**，悬停提示
  「材质/贴图取用待真机验证，暂不支持」。本轮只做模型（`model`）。
- **缩略图显示**：`manifest.thumbsRoot` + `record.thumbRel` 已经在数据里，但 `panel.html`
  里嵌本地图片要额外考虑 `file://` 加载与转义，本轮**不显示缩略图**，只显示文字行。
- **属性字典 `idbox_*` 回写**（`docs/38 §7`）：写入时机依赖 `place_component` 的返回值形态，
  该方法签名【待核实】，未写。V1.0 不往工程里写任何东西。
- **面板内真拖拽**：`docs/38 §5` 用户已裁定「点一下即插入」，拖拽明确不做。
- **材质球、封面抓取、批量导入**等 ID BOX 侧能力：与插件无关，不做。

## 硬约束（改代码时不得放开）

1. **零网络**：没有 `Net::HTTP` / socket / `open-uri`，`panel.html` 里没有任何外链、XHR、fetch。
2. **零原生件**：不 require 任何 `.so` / `.bundle` / `.dll`，不依赖第三方 gem。
3. **零 token、零端口、零后台服务**：唯一定时器是「面板打开时的 3 s 轮询」，面板关闭即 `stop_timer`。
4. **不解压、不读压缩包**：只加载已入库的单个文件。
5. **不自删、不自升级**。
6. **纯读方**：全文件里不存在任何写文件调用；`%APPDATA%\idbox\plugin\` 只读不写。
7. 所有代码在单一模块 `IDBoxPanel` 内，**不用任何全局变量**（`$x`）。
8. 包内互相 `require` 用 `Sketchup.require 'idbox_panel/xxx'`。

## 自检清单（第一次真机装包时按这个看）

1. 装完重启，扩展列表里能看到 **ID BOX Panel 1.0.0**，可启停。
2. ID BOX 未开导出时打开面板 → 出现 `IDBOX-101` + 设置路径指引（不是裸异常）。
3. 在 ID BOX 里刷新索引后，点面板「刷新」→ 列表出现记录，条数等于 ID BOX 里的资产数。
4. 点一条「模型」→ 应进入 SketchUp 的放置状态（`place_component`）；`Ctrl+Z` 一次撤回整个插入。
5. 点一条「贴图/材质」→ 按钮是灰的，悬停能看到「材质/贴图取用待真机验证，暂不支持」。
6. 故意把某条记录的 `.skp` 改名 → 插入应报 `IDBOX-103`，且模型里不留半个组件定义。
7. 用户名含中文的机器：面板顶部会有一行灰字提示（`docs/39 §4.4` 的一次性提示，不是错误）。

## 已知风险（如实标注）

- **Ruby 语法未执行**：`ruby` 不在本机，`ruby -c` 没跑过。已复读检查 `end` 配对与块参数，
  但**第一次真机加载仍可能暴露语法或 API 名问题**。
- **`SketchupExtension` 类名**（`docs/36:128` 【待核实】）：注册文件里做了存在性探测，
  两种历史写法都试，但**实际取哪个未在真机确认**。
- **`place_component` 签名**（【待核实】）：`respond_to?` 探测 + 失败退回原点
  `active_entities.add_instance(defn, Geom::Transformation.new)`。
- **`suMajor` 量纲**：契约里是四位年份（`2024`），而 `Sketchup.version.to_i` 是两位（`21`），
  代码里做了归一化（`< 100` 就 `+2000`）后再比较，否则每条记录都会误报「版本过高」。
- **非 ASCII 用户目录**（`docs/39 §4.4`）：只是【推断】风险，未真机核实；已按规范只给提示、
  不占错误码、不立备用发现根。
