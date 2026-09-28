# 调研与AI协作记录

## 选题来源

选题来自个人参与多人桌游和线上派对游戏的经历，以及对 Watcher 原型的现场观察。观察到的流程包括：输入昵称、创建或加入房间、最多八个玩家槽位、角色和棋子选择、添加AI玩家、准备、工具骰与移动骰、立体方格地图、障碍和特殊地块。个人希望降低安装与凑人数成本，并把智能体能力用于真实的局面决策。

参考资料：

- Watcher 原型：http://watchergame.cn:5173/
- Watcher 教程：https://www.bilibili.com/video/BV1dNEE64EUY/
- Pummel Party：https://store.steampowered.com/app/880940/Pummel_Party/
- Super Mario Party Jamboree：https://www.nintendo.com/us/store/products/super-mario-party-jamboree-switch/

## 需求变化记录

最初考虑XCPC训练工具，随后考虑酒馆AI、剧情游戏和谈判桌游。看到Watcher原型后，最终收敛为类桌游多人回合制竞速游戏。为保证个人开发可完成，MVP从“多人完整派对游戏平台”删减为“一张地图、三种道具、2—4人及一条从房间到结算的流程”；AI从自由生成游戏剧情改为在合法行动列表中选择行动。

## AI协作

已使用Codex讨论选题、浏览参考原型、整理需求与验收条件。人工保留了房间、棋盘、骰子和AI对手等可验证机制，删去了开放世界、语音、关卡社区等超出课程周期的方案。需求中的数值目标仍需在后续原型和测试中校准。
