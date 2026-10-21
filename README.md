# PCB 焊接导航

手工焊板子的辅助工具，一个网页文件，打开就能用。支持 **KiCad、嘉立创EDA、Altium Designer、Cadence Allegro / OrCAD、ODB++、Gerber**。

把工程文件夹（或 zip）拖进去，它会：

- **按焊接顺序分步列出器件**：细间距芯片 → 三极管/晶振 → 0402 → 0603 → 有极性件 → 大件 → 开关 → 底面 → 插件。同值同封装的器件归成一组。
- **在板图上标出位置**：点一组，这种器件在板上全部高亮并自动缩放。小到 0402 也能一眼找到。
- **标出方向**：1 脚、二极管/LED 阴极、电解/钽电容正极用蓝色焊盘标出，并直接说“阴极 K 在左侧”。底面视图已镜像，翻面、旋转后方向提示跟着变。
- **测引脚**：点任意焊盘，显示是哪个器件第几脚、接什么网络，同网络的其他焊盘全部标出来，配合万用表通断档查虚焊、连锡。
- **双面对照**：选中的网络同时连到顶面和底面时，板图自动左右分屏（左顶面、右底面镜像），两边各自框住所有同网络引脚；也可以按 `D` 手动开关。
- **记进度**：每个器件可以勾“已焊”，下次打开还在。

![焊接模式](docs/solder.png)
![测引脚模式](docs/pins.png)

## 使用

**在线**：<https://3977871701-spec.github.io/pcb-solder-nav/>

**离线**：下载 [`index.html`](index.html)，双击用浏览器（Chrome / Edge / Firefox）打开。不依赖任何外部库，离线也能解压 zip。

读入方式：把文件夹、zip 或单个文件拖进页面，或点“选择文件夹”。一个文件夹里有几块板就读出几块，同目录的 BOM、坐标文件、网表会自动配上。

## 支持的文件

| EDA | 直接读 | 也可以用 |
| --- | --- | --- |
| KiCad 6 ~ 10 | `.kicad_pcb` | IPC-2581、ODB++、Gerber 套件 |
| 嘉立创EDA 专业版 | 工程 `.epro` / `.epro2`，备份 `.epru`（含封装）；一个工程多块板会分开显示 | 嘉立创 Gerber 包（自带 `FlyingProbeTesting.json` 网表） |
| 嘉立创EDA 标准版 | PCB 源文件 `.json` | Gerber 套件 |
| Altium Designer | `.PcbDoc`（二进制和 ASCII 都行，包括嘉立创导出的 AD 文件） | IPC-2581、ODB++、Gerber + Pick Place + IPC-356 |
| Cadence Allegro / OrCAD | IPC-2581（File → Export → IPC 2581） | Gerber/`.art` + 坐标 + IPC-356（File → Export → IPC 356） |
| PADS、Xpedition 等 | IPC-2581、ODB++ | Gerber 套件 |

`.brd`（Allegro 原文件）是加密的二进制格式，浏览器里读不了，请导出 IPC-2581。嘉立创本地工程库 `.eprj2` 也请先导出成 `.epro2`。

**Gerber 套件** = Gerber + 钻孔 + 坐标文件（Pick and Place / CPL）。再加一个 IPC-356 网表或嘉立创飞针文件，就有引脚号和网络；没有网表时，焊盘按“中心对称 + 封装尺寸”归到器件，测引脚不可用，页面会提示。坐标文件和 Gerber 的原点、单位（mm / mil / inch）、Y 方向不一致时会自动对齐。

**BOM**：CSV 或 Excel（.xlsx），带 `Designator` / `Reference` / 位号 列即可，自动识别 Comment、LCSC、MPN、封装、DNP 列，GBK / UTF-16 编码也能读。BOM 里写在括号里的备注（如“缺货，下单前确认”）会显示为警告。

## 准确性

每种格式都拿同一块板的另一份权威数据逐焊盘比对过：

| 格式 | 参照 | 结果 |
| --- | --- | --- |
| KiCad `.kicad_pcb` | KiCad 自带 pcbnew API | 3 块板 834 个焊盘，位置误差 ≤ 0.01 mm，网络 100% 一致 |
| IPC-2581（KiCad 导出 / Allegro 导出） | pcbnew；同板的嘉立创工程 | ≤ 0.001 mm，网络一致 |
| ODB++（KiCad 导出） | pcbnew | ≤ 0.012 mm（导出文件只保留 2 位小数） |
| 嘉立创EDA 专业版 | Allegro 原设计；嘉立创自己的飞针文件 | 0 偏差；底面 0/90/180/270° 全部正确 |
| Altium `.PcbDoc` | KiCad 的 Altium 导入器（5 块板） | ≤ 0.0014 mm，网络、器件值一致 |
| 嘉立创EDA 标准版 | 走线端点自洽检查 | 184 个走线端点全部落在同网络焊盘上 |
| Gerber + 坐标 + IPC-356 | Allegro IPC-2581 | 350 个焊盘 0 偏差，引脚号和网络一致 |

## 判断规则

- **焊接顺序**按封装名和位号前缀判断：`QFN/DFN/LGA/BGA/QFP/TSSOP/FPC/Type-C` 算细间距，`SOT/SOIC/晶振` 算第二步，阻容按 0402 / 0603 / 0805+ 分，`D/LED` 和电解/钽电容算有极性，底面贴片和插件放最后。
- **极性**按常见封装库惯例（KiCad、立创、Altium）：二极管、LED 的 1 号焊盘是阴极，电解/钽电容、电池、蜂鸣器的 1 号焊盘是正极。双向 TVS（`-BI` 封装或 `xxCA` 型号）判为无极性。少数厂家封装例外，焊前对一下丝印。
- 测试点、安装孔、Mark 点、Logo、标了“不进 BOM”的器件不进焊接清单；测试点在“测引脚”模式里可以直接点。
- 底面器件按同样的顺序再分一遍（底面 · 细间距芯片 → …），插件放在最后。
- 设计里有重复位号时，重复的依次加 (2)、(3) 区分，并在页面上提示。
- 重新导入同一个文件夹，会替换这个文件夹之前读出来的板子。

## 快捷键

| 键 | 作用 |
| --- | --- |
| `N` / `]` | 下一种没焊完的 |
| `[` | 上一种 |
| `空格` | 这种全部标记已焊，跳到下一种 |
| `D` | 测引脚时开关双面对照 |
| `T` | 切换焊接 / 测引脚 |
| `F` | 翻面 |
| `R` | 旋转 90° |
| `0` | 显示全板 |
| `Esc` | 清除选中 |

## 隐私

所有文件只在浏览器本地解析。读入的板子和勾选进度保存在当前浏览器的 IndexedDB / localStorage 里，不上传任何服务器。页面只从 Google Fonts 加载字体。

## 开发

源码在 `src/`，`node build.js` 把它们打包成单文件 `index.html`（没有依赖）。

```
src/core/      geom 几何、files 解压(zip/tar/gzip/.Z)/XML/CSV/XLSX、tables BOM/坐标/IPC-356/飞针、project 文件归组
src/import/    kicad、ipc2581、easyeda、altium、odb、gerber(含 Excellon)、fab(Gerber 套件拼装)
src/enrich.js  焊接分步、极性、分组
src/app.js     界面
```

解析模块不依赖 DOM，可以直接在 Node（≥ 18）里跑；`test/` 里是对照测试脚本，需要本地样本数据（不在仓库里）。

## 许可

MIT
