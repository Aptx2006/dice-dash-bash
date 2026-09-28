# 实验3：软件架构与界面设计源文件

项目：**《当骰一棒》 / Dice, Dash & Bash**。设计基线日期：2026-09-28。

本目录保存设计文字与可重建的绘图源代码。报告插图、SVG及可点击HTML原型在本地生成，不上传图片文件。设计以实验2报告的US-01—US-05和UC-01—UC-09为编号基线，详见[设计基线](design-spec.md)。

| 文件 | 内容 |
| --- | --- |
| [design-spec.md](design-spec.md) | 需求追踪、五项ADR、模块、数据、接口、流程、交互与一致性检查 |
| [generate_figures.py](generate_figures.py) | 9张图的可编辑绘图源，生成高清PNG、SVG及4页可点击交互原型 |
| [verification.md](verification.md) | 本次设计与原型检查、项目现有测试及构建结果 |

## 本地重建

依赖：Python 3、Pillow；Windows默认使用微软雅黑字体。项目根目录运行：

```powershell
python docs/experiment3/generate_figures.py
```

默认输出到仓库同级的`实验3-设计图`目录，避免将图片纳入仓库。其他平台或目录可指定：

```text
python docs/experiment3/generate_figures.py --font <中文字体文件> --output <本地输出目录>
```

直接用浏览器打开输出目录中的`交互原型.html`即可浏览，无需启动游戏后端。界面支持创建与配置导航、人数检查、道具确认/取消、退出、规则查询样例和重新开始；顶部情境切换用于演示超时、无依据、创建失败和局面过期。可用键盘Tab定位按钮，Enter激活。

| 图号 | 输出文件 | 设计职责 |
| --- | --- | --- |
| 1 | 01-context.png / .svg | 软件边界与外部云端模型 |
| 2 | 02-architecture.png / .svg | M1—M7模块及依赖 |
| 3 | 03-data.png / .svg | 核心数据模型与多重性 |
| 4 | 04-flow.png / .svg | 真人确认、AI失败、统一校验与演出 |
| 5 | 05-navigation.png / .svg | 四页导航、教学和返回路径 |
| 6 | 06-home.png / .svg | P01首页 |
| 7 | 07-lobby.png / .svg | P02房间配置 |
| 8 | 08-game.png / .svg | P03核心对局与教练扩展 |
| 9 | 09-result.png / .svg | P04结算与再来一局 |

图中数据为设计样例。交互原型只演示页面和反馈，不执行真实棋盘规则、数据库事务、模型调用或检索；这些属于后续开发和验收范围。当前本地游戏的既有功能与新增设计在设计基线中分别标明。
