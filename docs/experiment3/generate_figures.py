"""Generate local, editable design figures. Requires Python 3 + Pillow.

Run from the repository: python docs/experiment3/generate_figures.py
Images and the clickable prototype stay OUTSIDE the repository by default.
"""
from pathlib import Path
from html import escape
import argparse
import json
import math
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=ROOT / '实验3-设计图')
parser.add_argument('--font', type=Path, default=Path('C:/Windows/Fonts/msyh.ttc'))
args = parser.parse_args()
OUT = args.output.resolve()
OUT.mkdir(parents=True, exist_ok=True)
INK, MUTED, LINE = '#233345', '#586879', '#B8C5CE'
TEAL, PALE, PAPER, WHITE = '#176B64', '#E7F3EE', '#F6F7F5', '#FFFFFF'
SAND, AMBER, RED = '#FFF2D9', '#95611B', '#A93F37'
SCALE = 2
fonts = {}

def font(size):
    if size not in fonts:
        fonts[size] = ImageFont.truetype(str(args.font), size * SCALE)
    return fonts[size]

def measure(text, size):
    return font(size).getlength(text) / SCALE

class Canvas:
    def __init__(self, name, title, subtitle, height=880):
        self.name, self.w, self.h = name, 1280, height
        self.img = Image.new('RGB', (self.w*SCALE, self.h*SCALE), PAPER)
        self.d = ImageDraw.Draw(self.img)
        self.svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="{height}" viewBox="0 0 1280 {height}">', f'<title>{escape(title)}</title>', f'<rect width="1280" height="{height}" fill="{PAPER}"/>']
        self.text(38, 24, title, 31, INK)
        self.text(40, 71, subtitle, 20, MUTED)
        self.line([(40, 112), (1240, 112)], LINE)

    def rect(self, x, y, w, h, fill=WHITE, stroke=LINE, radius=12, width=2, dashed=False):
        self.d.rounded_rectangle(tuple(v*SCALE for v in (x,y,x+w,y+h)), radius*SCALE, fill, stroke, width*SCALE)
        dash = ' stroke-dasharray="8 6"' if dashed else ''
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{width}"{dash}/>')

    def text(self, x, y, text, size=23, color=INK, center=False):
        if center: x -= measure(text, size)/2
        if x < 0 or x + measure(text, size) > self.w+1 or y+size>self.h:
            raise ValueError(f'Text outside {self.name}: {text}')
        self.d.text((x*SCALE, y*SCALE), text, font=font(size), fill=color, anchor='lt')
        self.svg.append(f'<text x="{x}" y="{y+size*.87}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="{size}" fill="{color}">{escape(text)}</text>')

    def wrap(self, x, y, text, width, size=22, color=MUTED, gap=9):
        yy = y
        for paragraph in text.split('\n'):
            line = ''
            for ch in paragraph:
                if line and measure(line+ch, size)>width:
                    self.text(x, yy, line, size, color); yy += size+gap; line = ''
                line += ch
            self.text(x, yy, line, size, color); yy += size+gap
        return yy

    def line(self, points, color=INK, width=2, arrow=False):
        self.d.line([(x*SCALE,y*SCALE) for x,y in points], fill=color, width=width*SCALE)
        self.svg.append(f'<polyline points="{" ".join(f"{x},{y}" for x,y in points)}" fill="none" stroke="{color}" stroke-width="{width}"/>')
        if arrow:
            (x0,y0),(x1,y1)=points[-2:]; angle=math.atan2(y1-y0,x1-x0)
            pts=[(x1,y1),(x1-13*math.cos(angle-.5),y1-13*math.sin(angle-.5)),(x1-13*math.cos(angle+.5),y1-13*math.sin(angle+.5))]
            self.poly(pts,color,color)

    def poly(self, points, fill, stroke=LINE):
        self.d.polygon([(x*SCALE,y*SCALE) for x,y in points],fill=fill)
        self.d.line([(x*SCALE,y*SCALE) for x,y in points+[points[0]]],fill=stroke,width=2*SCALE)
        self.svg.append(f'<polygon points="{" ".join(f"{x},{y}" for x,y in points)}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')

    def circle(self, x,y,r,fill=TEAL,stroke=None):
        self.d.ellipse(((x-r)*SCALE,(y-r)*SCALE,(x+r)*SCALE,(y+r)*SCALE),fill=fill,outline=stroke)
        self.svg.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}" stroke="{stroke or fill}"/>')

    def box(self,x,y,w,h,title,body='',fill=WHITE):
        self.rect(x,y,w,h,fill)
        self.text(x+18,y+16,title,24,TEAL)
        if body: self.wrap(x+18,y+57,body,w-36,21)

    def button(self,x,y,w,label,primary=False,disabled=False,h=48):
        fill = '#E8ECEF' if disabled else TEAL if primary else WHITE
        color = MUTED if disabled else WHITE if primary else INK
        self.rect(x,y,w,h,fill,LINE if disabled else TEAL,9)
        self.text(x+w/2,y+(h-22)/2-1,label,22,color,center=True)

    def footer(self,text):
        self.line([(40,self.h-70),(1240,self.h-70)],LINE)
        self.text(40,self.h-48,text,19,MUTED)

    def save(self):
        self.img.save(OUT/f'{self.name}.png')
        (OUT/f'{self.name}.svg').write_text('\n'.join(self.svg+['</svg>']),encoding='utf-8')

def context():
    c=Canvas('01-context','图1  软件与外部环境关系图','设计边界：本地人机闭环保留；云端模型通过自有服务端接入。')
    c.rect(330,165,590,510,PALE,TEAL,16)
    c.text(355,187,'《当骰一棒》软件边界',27,TEAL)
    c.box(380,255,480,145,'浏览器端 · 已有基础','页面 / 棋盘 / 本地规则与规则AI\n本地练习不依赖模型服务')
    c.box(380,465,480,150,'自有服务端 · 待开发','权威规则 / Agent Harness / RAG\n规则文件、对局存储属于软件内部')
    c.line([(620,400),(620,465)],TEAL,arrow=True)
    c.text(640,418,'命令 / 状态',21)
    c.box(40,280,220,145,'玩家 / 房主','操作、配置\n查看结果')
    c.line([(260,302),(380,302)],TEAL,arrow=True)
    c.text(274,271,'输入',20)
    c.line([(380,375),(260,375)],TEAL,arrow=True)
    c.text(274,384,'反馈',20)
    c.box(980,415,260,200,'外部云端模型','DeepSeek 等 API\n发送脱敏局面/规则\n返回行动建议/回答',SAND)
    c.line([(860,500),(980,500)],TEAL,arrow=True)
    c.text(885,470,'请求',20)
    c.line([(980,570),(860,570)],TEAL,arrow=True)
    c.text(885,580,'响应',20)
    c.box(330,710,910,80,'边界约束','',WHITE)
    c.text(355,752,'不向模型发送密钥或对手隐藏手牌；本次未设计本地大模型部署。',22)
    c.footer('箭头表示主要信息流；第三方游戏、社交平台和支付系统不属于本次依赖。')
    c.save()

def architecture():
    c=Canvas('02-architecture','图2  分层架构与模块结构','M1—M7 对应需求追踪表；下列为目标模块划分，非当前全部实现。',1000)
    c.box(40,148,370,175,'M1 界面与演出','Home / Lobby / Game / Result\n相机、骰子和出牌事件队列\n只维护展示状态',PALE)
    c.box(455,148,370,175,'M2 应用服务 / GameGateway','房间、会话、命令去重\nLocalGateway：本地调用\nRemoteGateway：后端调用',PALE)
    c.box(870,148,370,175,'M3 规则引擎','合法动作 / 随机源 / 胜负\n单局串行、版本复验\n状态变更的唯一入口',PALE)
    c.line([(410,230),(455,230)],TEAL,arrow=True)
    c.line([(825,230),(870,230)],TEAL,arrow=True)
    c.line([(1055,323),(1055,367),(225,367),(225,323)],TEAL,arrow=True)
    c.text(460,340,'权威快照 + 有序事件 → 展示',21,TEAL)
    c.box(40,432,370,213,'M4 Agent Harness · 新增','上下文、工具预算、5秒超时\n模型输出校验、规则降级\n动作建议交回 M2/M3',SAND)
    c.box(455,432,370,213,'M5 规则检索 / RAG · 新增','仅索引已确认的当前规则\n按版本过滤、检索、引用验证\n实时状态由 M3 提供',SAND)
    c.box(870,432,370,213,'M6 模型适配 · 新增','统一请求、解析与错误码\n密钥仅在服务端读取\n适配外部云端模型 API',SAND)
    c.line([(640,323),(640,398),(225,398),(225,432)],TEAL,arrow=True)
    c.text(300,401,'智能体回合',20)
    c.line([(410,495),(455,495)],TEAL,arrow=True)
    c.line([(225,645),(225,680),(1055,680),(1055,645)],TEAL,arrow=True)
    c.text(285,650,'模型请求',20)
    c.box(40,732,560,153,'M7 存储与轨迹 · 新增','服务端：SQLite 快照 / 事件 / 脱敏轨迹\n项目文件：版本化规则；浏览器：昵称/倍速')
    c.box(660,732,580,153,'Eval Harness · 开发侧验收工具','固定局面、问答与故障注入 → M3 / M4 / M5\n不属于玩家操作流程；记录结果而非预设通过')
    c.line([(640,645),(640,708),(320,708),(320,732)],TEAL,arrow=True)
    c.text(650,690,'规则文件 / 检索数据',19)
    c.footer('依赖：M2→M3/M4/M7；M4→M5/M6/M7；M5→规则文件。普通回合可绕过模型。')
    c.save()

def data():
    c=Canvas('03-data','图3  核心数据模型（概念类图）','箭头为引用方向；端点标明多重性。GameState 延续现有结构，版本等字段拟新增。',1000)
    boxes=[
        (40,180,360,260,'GameState · 对局快照','matchId / mapId\nstateVersion / rulesetVersion\nphase / activePlayerId\nplayers[] / dice / finished'),
        (460,180,340,260,'PlayerState · 玩家','playerId / name / isAI\ncell(x,y) / finishedTurn?\nhand: ToolInstance[]\n牌：uid / toolId / points?'),
        (860,180,380,260,'ActionEvent · 事件','matchId / seq（联合唯一）\nactorId / requestId / type\nstateVersion / payload\nagentTraceId?'),
        (40,590,360,220,'RuleSet · 规则包','version（唯一）/ hash\nstatus: confirmed / draft\n地图与道具定义引用'),
        (460,590,340,220,'RuleEntry · 规则条目','ruleId + version（唯一）\ntitle / text / source\n只索引 confirmed 条目'),
        (860,590,380,220,'AgentTrace · 执行轨迹','traceId / matchId / version\nsourceIds[] / elapsedMs\nactionId / fallbackReason?'),
    ]
    for x,y,w,h,title,body in boxes:c.box(x,y,w,h,title,body)
    c.line([(400,285),(460,285)],TEAL,arrow=True)
    c.text(404,249,'2..8',19,TEAL)
    c.text(372,290,'1',18)
    c.line([(1040,440),(1040,590)],TEAL,arrow=True)
    c.text(1055,451,'事件引用轨迹',20)
    c.text(1055,487,'0..* → 0..1',20)
    c.line([(200,440),(200,590)],TEAL,arrow=True)
    c.text(217,451,'对局锁定规则版本',20)
    c.text(217,487,'0..* → 1',20)
    c.line([(400,700),(460,700)],TEAL,arrow=True)
    c.text(404,663,'1..*',18,TEAL)
    c.text(373,707,'1',18)
    c.line([(220,180),(220,151),(1050,151),(1050,180)],TEAL,arrow=True)
    c.text(480,120,'1 对局 → 0..* 有序事件',19,TEAL)
    c.box(40,842,1200,75,'存储约束：','')
    c.text(190,861,'actorId 引用局内玩家；命令回执按 requestId 去重；隐藏手牌只在权威端保存。',21)
    c.footer('快照与事件同事务保存；RuleSet/RuleEntry 保存为版本化文件，AgentTrace 不保存密钥。')
    c.save()

def flow():
    c=Canvas('04-flow','图4  一次行动的正常与异常流程','真人确认与模型预算属于不同入口；两条路径最终使用同一规则校验入口。',1130)
    c.box(415,143,450,78,'读取当前玩家与合法动作','',PALE)
    c.line([(530,221),(530,247),(240,247),(240,270)],TEAL,arrow=True)
    c.line([(750,221),(750,247),(1010,247),(1010,270)],TEAL,arrow=True)
    c.text(275,224,'真人回合',20)
    c.text(882,224,'智能体回合',20)
    c.box(40,270,400,122,'选择动作并预览','缺目标 → 留在选择态；不扣牌')
    c.box(830,270,410,122,'Harness 获取建议','5秒总预算；工具最多2轮',SAND)
    c.line([(240,392),(240,427)],TEAL,arrow=True)
    c.box(40,427,400,122,'玩家确认','影响他人时显示目标和效果\n取消 → 返回选择，不提交')
    c.line([(1035,392),(1035,427)],TEAL,arrow=True)
    c.box(830,427,410,122,'输出校验 / 规则降级','超时、非法、解析失败 →\n2秒内规则策略产生合法建议',SAND)
    c.line([(440,488),(470,488),(470,630)],TEAL,arrow=True)
    c.line([(830,488),(770,488),(770,630)],TEAL,arrow=True)
    c.box(415,630,450,122,'权威端原子校验与提交','会话、版本、阶段、目标、去重\n通过 → 状态更新一次，版本+1',PALE)
    c.box(40,645,290,145,'拒绝 / 重新获取','过期：刷新候选\n已结束：只读结果',SAND)
    c.line([(415,684),(330,684)],RED,arrow=True)
    c.line([(40,717),(18,717),(18,182),(415,182)],RED,arrow=True)
    c.text(46,577,'仅过期：重新选择',19,RED)
    c.line([(640,752),(640,797)],TEAL,arrow=True)
    c.box(415,797,450,116,'播放已提交的有序事件','出牌 → 骰值/路径 → 地块效果\n倍速只改变演出时间')
    c.line([(530,913),(530,950),(225,950),(225,977)],TEAL,arrow=True)
    c.line([(750,913),(750,950),(1040,950),(1040,977)],TEAL,arrow=True)
    c.box(40,977,370,70,'未结束 → 下一行动 / 回合','')
    c.box(855,977,385,70,'到达终点 → 结算并锁定操作','',PALE)
    c.footer('重复 requestId 返回原结果；过期模型响应丢弃。无合法动作时由引擎判断受控结束阶段。')
    c.save()

def navigation():
    c=Canvas('05-navigation','图5  页面与状态导航','P01—P04 对应图6—图9；教练与确认框为 P03 内的抽屉或弹层。',750)
    for x,title,body in [(40,'P01 首页','昵称 / 练习入口\n教学关 / 联机入口'),(460,'P02 房间配置','角色 / 地图 / 智能体\n人数检查后开始'),(880,'P03 核心对局','投骰 / 道具 / 移动\n观察AI / 规则教练')]:
        c.box(x,165,360,150,title,body,PALE)
    c.line([(400,218),(460,218)],TEAL,arrow=True)
    c.line([(820,218),(880,218)],TEAL,arrow=True)
    c.text(404,183,'创建',18)
    c.text(825,183,'开始',18)
    c.line([(560,315),(560,360),(210,360),(210,315)],TEAL,arrow=True)
    c.text(260,332,'离开配置 → 首页',20)
    c.line([(205,165),(205,135),(1060,135),(1060,165)],TEAL,arrow=True)
    c.text(415,112,'教学入口：自动配置 1 名教学AI',19)
    c.box(880,475,360,130,'P04 结果页','胜者 / 距终点 / 回合摘要\n再来一局 / 返回配置',PALE)
    c.line([(1060,315),(1060,475)],TEAL,arrow=True)
    c.text(1075,377,'对局结束',21)
    c.line([(1180,475),(1260,475),(1260,255),(1240,255)],TEAL,arrow=True)
    c.text(1070,428,'再来一局',20)
    c.line([(880,550),(640,550),(640,315)],TEAL,arrow=True)
    c.text(672,518,'返回配置',21)
    c.box(40,455,495,150,'异常与取消','加入失败留在首页；确认取消留在对局\n退出对局需确认；确认后返回配置\n教学退出返回首页；请求失败允许重试')
    c.footer('本地基线不开放真实联机；联机入口禁用并说明原因，不生成虚假的跨设备连接。')
    c.save()

def header(c,stage):
    c.rect(40,139,1200,65,WHITE)
    c.text(62,156,'当骰一棒',26,TEAL)
    c.text(216,163,'DICE, DASH & BASH',17,MUTED)
    c.text(680,160,stage,22)

def board(c,x,y,w=620,h=325,active=False):
    c.rect(x,y,w,h,'#EDF0E9',LINE,10)
    # Slightly skewed 2.5D projection, long edge almost parallel to the screen bottom.
    ox,oy=x+45,y+45
    for row in range(5):
        for col in range(8):
            px=ox+col*(w-140)/8+row*5
            py=oy+row*(h-85)/5-col*1.4
            tw,th=(w-150)/8,(h-103)/5
            fill=PALE if active and row==3 and col in (2,3,4) else '#FFFFFF'
            if (row,col) in ((1,3),(2,5)):fill='#ABB6B3'
            c.poly([(px,py),(px+tw,py-1),(px+tw+5,py+th),(px+5,py+th+1)],fill)
            if (row,col)==(0,7):
                c.line([(px+tw/2,py+8),(px+tw/2,py+th-5)],TEAL,3)
                c.poly([(px+tw/2,py+7),(px+tw-3,py+13),(px+tw/2,py+21)],TEAL,TEAL)
            if (row,col) in ((3,1),(2,3)):
                color=AMBER if row==3 else TEAL
                c.circle(px+tw/2+2,py+th/2+2,12,color)
                c.text(px+tw/2+2,py+th/2-9,'我' if row==3 else 'AI',14,WHITE,True)
    c.text(x+20,y+h-29,'旗帜：终点    实心块：障碍    圆点：玩家',17,MUTED)

def home():
    c=Canvas('06-home','图6  P01 首页原型','US-01 / UC-01、UC-04 · 低保真交互草图 · 文案与数据均为设计样例',940)
    header(c,'开始一场棋盘冒险')
    c.box(40,228,650,527,'01  地图预览与游戏目标','先抵达终点者获胜；支持人机练习。')
    board(c,65,335,600,320)
    c.button(66,682,250,'上一张 / 下一张')
    c.text(345,697,'已选：经典竞速',22)
    c.box(720,228,520,527,'02  快速开始','输入昵称，创建并配置本地对局。')
    c.text(747,327,'昵称  ·  去空白后 1—12 字',21)
    c.rect(746,366,466,58,WHITE)
    c.text(764,383,'小骰',23)
    c.button(746,444,466,'创建本地房间',True,h=56)
    c.button(746,518,466,'新手教学 · 自动加入 1 名 AI',h=56)
    c.line([(746,601),(1212,601)],LINE)
    c.text(746,618,'好友房间码 · 6 位字母或数字',21)
    c.rect(746,653,296,52,'#EFF1F2')
    c.text(763,666,'联机功能尚未开放',20,MUTED)
    c.button(1060,653,152,'加入',disabled=True,h=52)
    c.text(746,720,'联机上线后启用输入框与加入按钮。',18,MUTED)
    c.box(40,781,1200,76,'反馈与限制','')
    c.text(220,803,'空昵称：输入框下提示；创建中：按钮禁用；创建失败：保留输入并允许重试。',20)
    c.footer('标注 01 为静态说明和地图；02 为输入与命令区。教学入口使用默认昵称，不强迫填写。')
    c.save()

def lobby():
    c=Canvas('07-lobby','图7  P02 房间配置原型','US-01 / UC-02、UC-03 · 本地房间标识仅用于辨认本次配置',940)
    header(c,'本地房间  LOCAL-01')
    c.button(1052,148,168,'返回首页')
    c.box(40,228,715,500,'01  参与者（2 / 8）','至少 2 人开局；本地基线为 1 名真人 + 1—7 名 AI。')
    for i,(name,desc) in enumerate([('小骰  ·  房主','角色：村民    状态：已准备'),('小棒  ·  智能体','策略：规则策略    状态：已准备')]):
        yy=343+i*112
        c.rect(65,yy,663,93,PALE if i==0 else WHITE)
        c.circle(100,yy+46,21,AMBER if i==0 else TEAL)
        c.text(140,yy+13,name,24)
        c.text(140,yy+52,desc,21,MUTED)
        if i:c.button(612,yy+22,98,'移除')
    c.button(65,587,260,'+ 添加智能体')
    c.text(65,663,'满员时禁用添加；不足 2 人时禁用开始。',21,MUTED)
    c.box(785,228,455,500,'02  本局配置','开局时固定地图和规则版本。')
    c.text(808,339,'地图',21)
    c.rect(808,375,408,53,WHITE)
    c.text(826,390,'经典竞速  / 切换',22)
    c.text(808,463,'当前角色：村民    [ 更换 ]',22)
    c.text(808,524,'演出速度：慢速 0.6×',22)
    c.text(808,585,'AI 模式：规则策略',22)
    c.wrap(808,630,'模型模式接入后才开放；教学关固定 1 名教学 AI。',395,20)
    c.button(40,760,240,'离开配置')
    c.text(360,777,'配置完整，可开始游戏',23,TEAL)
    c.button(865,752,375,'开始对局',True,h=63)
    c.footer('加载态：显示“正在创建对局…”并锁定配置；失败保留配置；返回首页不会退出浏览器。')
    c.save()

def game():
    c=Canvas('08-game','图8  P03 核心对局原型','US-02 / US-03 / US-05 · 示例停留在玩家行动阶段；教练为后续扩展设计',1040)
    header(c,'第 06 回合  ·  轮到：小骰')
    c.button(1030,148,190,'退出对局')
    c.rect(40,222,835,59,PALE)
    c.text(59,239,'01 当前阶段：行动  |  移动点 4',21)
    c.button(444,228,190,'慢速 0.6×')
    c.button(651,228,209,'最佳屏幕大小')
    board(c,40,300,835,328,True)
    c.text(60,648,'02 拖动平移 / 滚轮缩放 / 固定视角；点击高亮方向预览。',20,MUTED)
    c.rect(40,691,835,84,WHITE)
    c.text(60,706,'03 双骰结果：移动骰 4  ·  工具骰 拳击',23)
    c.text(60,744,'骰值由规则产生；动画揭示结果，不重新随机。',19,MUTED)
    c.button(40,795,166,'投骰',disabled=True)
    c.button(222,795,190,'移动 · 选方向')
    c.button(428,795,225,'拳击 · 选目标')
    c.button(669,795,206,'结束阶段')
    c.rect(40,862,835,76,SAND)
    c.text(60,878,'04 拳击目标：小棒 · 击退效果待确认',21)
    c.text(60,911,'确认前不扣牌；目标变化后重新预览。',17,AMBER)
    c.button(594,878,112,'取消',h=44)
    c.button(724,878,130,'确认使用',True,h=44)
    c.box(900,222,340,225,'05 玩家与动作反馈','小骰（你） · 当前回合\n小棒（AI） · 等待\n上一行动：小棒移动\n查看依据 / 已播放事件')
    c.box(900,470,340,468,'06 规则教练 · 规划','示例：如何使用拳击？',PALE)
    c.rect(920,568,300,91,WHITE)
    c.wrap(936,582,'输入规则问题…\n最多 200 字',265,21)
    c.button(920,680,300,'查询规则',True)
    c.wrap(920,749,'回答区：先选合法目标，再确认使用。',299,21)
    c.text(920,824,'依据：[道具 · 拳击 v1]',20,TEAL)
    c.wrap(920,866,'无依据：无法确认。\n服务失败：查看规则条目。',300,18)
    c.footer('模型思考与动画播放分别显示；请求中防重复；AI失败显示“已切换规则策略”并继续。')
    c.save()

def result():
    c=Canvas('09-result','图9  P04 结算原型','US-04 / UC-09 · 第一名到达终点即结束，其余玩家按距终点排序',940)
    header(c,'对局结束')
    c.rect(40,228,1200,125,PALE,TEAL)
    c.text(78,253,'小骰率先抵达终点！',34,TEAL)
    c.text(80,307,'经典竞速  ·  共 12 回合  ·  所有行动入口已关闭',23)
    c.box(40,378,740,307,'01  本局排名','名次     玩家                到达状态')
    c.rect(65,488,690,62,PALE)
    c.text(86,506,'1        小骰（你）      第 12 回合到达',23)
    c.rect(65,571,690,62,WHITE)
    c.text(86,590,'2        小棒（AI）      未完赛 · 距终点 3 格',21)
    c.box(810,378,430,307,'02  对局摘要','第12回合：小骰抵达终点\n最后行动：移动\nAI 模式：规则策略\n模型降级统计：未启用')
    c.rect(40,711,1200,90,WHITE)
    c.text(65,728,'03 再来一局将沿用本次地图与角色，创建全新的对局状态。',23)
    c.text(65,768,'旧结果保留只读；创建失败时停留在本页，不清空当前结果。',20,MUTED)
    c.button(40,810,260,'返回房间配置')
    c.button(930,810,310,'再来一局',True,h=48)
    c.footer('未完赛不标成“已到达”；并列距离显示并列名次；没有模型轨迹时显示“未启用”。')
    c.save()

def prototype_html():
    # Accessible native controls overlay the exact SVG design, preserving screen geometry.
    screens=[('home','06-home',940),('lobby','07-lobby',940),('game','08-game',1040),('result','09-result',940)]
    spec={
        'home':[(746,366,466,58,'input','nickname','小骰'),(746,444,466,56,'button','create','创建本地房间'),(746,518,466,56,'button','tutorial','新手教学 · 自动加入 1 名 AI')],
        'lobby':[(1052,148,168,48,'button','home','返回首页'),(612,477,98,48,'button','remove','移除'),(65,587,260,48,'button','add','+ 添加智能体'),(40,760,240,48,'button','home','离开配置'),(865,752,375,63,'button','start','开始对局')],
        'game':[(1030,148,190,48,'button','exit','退出对局'),(444,228,190,48,'button','speed','慢速 0.6×'),(651,228,209,48,'button','fit','最佳屏幕大小'),(222,795,190,48,'button','move','移动 · 选方向'),(428,795,225,48,'button','tool','拳击 · 选目标'),(669,795,206,48,'button','end','结束阶段'),(594,878,112,44,'button','cancel','取消'),(724,878,130,44,'button','confirm','确认使用'),(920,568,300,91,'input','question','如何使用拳击？'),(920,680,300,48,'button','ask','查询规则')],
        'result':[(40,810,260,48,'button','lobby','返回房间配置'),(930,810,310,48,'button','restart','再来一局')]
    }
    panels=[]
    for screen,name,height in screens:
        controls=[]
        for x,y,w,h,kind,action,label in spec[screen]:
            style=f'left:{x/12.8}%;top:{y/height*100}%;width:{w/12.8}%;height:{h/height*100}%'
            if kind=='input':
                maxlen=12 if action=='nickname' else 200
                controls.append(f'<input id="{action}" aria-label="{action}" maxlength="{maxlen}" value="{label}" style="{style}">')
            else:
                controls.append(f'<button data-action="{action}" style="{style}">{label}</button>')
        extra = ''
        if screen == 'lobby':
            extra = '<output id="memberCount" style="position:absolute;left:4.5%;top:26%;width:47%;height:4%;background:white;font-size:clamp(10px,1.7vw,24px);color:#176b64"></output><output id="aiStatus" style="position:absolute;left:10.9%;top:50%;width:35%;height:9%;background:white;font-size:clamp(10px,1.6vw,22px)"></output>'
        panels.append(f'<section data-screen="{screen}" hidden><img src="{name}.svg" alt="{screen} 界面设计草图">{extra}{"".join(controls)}</section>')
    html='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>当骰一棒 · 实验3交互原型</title>
<style>*{box-sizing:border-box}body{margin:0;background:#edf0ef;color:#233345;font:16px "Microsoft YaHei",sans-serif}header{padding:16px 3%;background:white;display:flex;gap:12px;align-items:center;flex-wrap:wrap}header b{margin-right:20px}button{cursor:pointer;border:1px solid #176b64;background:#fff;color:#233345;border-radius:8px;padding:7px 12px;font:inherit}button:hover{background:#e7f3ee}button:focus-visible,input:focus-visible{outline:3px solid #bb811f;outline-offset:2px}main{max-width:1280px;margin:auto}section{position:relative}section img{display:block;width:100%}section button,section input{position:absolute;font-size:clamp(10px,1.6vw,22px);border:2px solid #176b64;border-radius:9px;background:#fff;color:#233345;padding:4px}section input{padding:10px}#notice{position:sticky;bottom:0;padding:14px 4%;background:#233345;color:white;min-height:50px}dialog{border:1px solid #b8c5ce;border-radius:14px;padding:28px;max-width:550px}dialog::backdrop{background:#15223077}dialog button{margin:12px 10px 0 0}#demo{margin-left:auto}</style>
<header><b>当骰一棒 · 可点击设计原型</b><button data-nav="home">首页</button><button data-nav="lobby">配置</button><button data-nav="game">对局</button><button data-nav="result">结果</button><label id="demo">情境 <select id="scenario"><option value="normal">正常</option><option value="timeout">模型超时</option><option value="unknown">规则无依据</option><option value="createfail">创建失败</option><option value="stale">状态过期</option></select></label></header>
<main>__PANELS__</main><div id="notice" role="status" aria-live="polite">本原型演示导航、输入检查和异常反馈；不运行真实游戏、检索或模型服务。</div>
<dialog id="confirmDialog"><h2 id="dialogTitle"></h2><p id="dialogBody"></p><button id="dialogCancel">取消</button><button id="dialogConfirm">确认</button></dialog>
<script>
let current='home',ai=1,mode='practice',pending=null,speedIndex=0;
const $=s=>document.querySelector(s),notice=t=>$('#notice').textContent=t;
function syncLobby(){document.querySelector('[data-action="start"]').disabled=ai<1;document.querySelector('[data-action="add"]').disabled=ai>=7;document.querySelector('[data-action="remove"]').disabled=ai===0;$('#memberCount').textContent='01 参与者（'+(ai+1)+' / 8）';$('#aiStatus').textContent=ai?'智能体 × '+ai+' · 已准备':'尚未配置智能体，请添加。'}
function show(s){current=s;document.querySelectorAll('[data-screen]').forEach(p=>p.hidden=p.dataset.screen!==s);syncLobby();notice('已进入'+({home:'首页',lobby:'配置页',game:'对局页',result:'结果页'}[s])+'。原型数据为设计样例。');window.scrollTo(0,0)}
function promptConfirm(title,body,fn){$('#dialogTitle').textContent=title;$('#dialogBody').textContent=body;pending=fn;$('#confirmDialog').showModal()}
$('#dialogCancel').onclick=()=>{$('#confirmDialog').close();pending=null;notice('已取消，未提交操作。')};
$('#dialogConfirm').onclick=()=>{$('#confirmDialog').close();const fn=pending;pending=null;fn?.()};
document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>show(b.dataset.nav));
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{
 const a=b.dataset.action,s=$('#scenario').value;
 if(['home','lobby'].includes(a)){show(a);return}
 if(a==='create'){const n=$('#nickname').value.trim();if(!n){notice('请输入昵称（去空白后 1—12 字）。');$('#nickname').focus();return}if(s==='createfail'){notice('创建失败，请重试；昵称已保留。');return}mode='practice';ai=1;show('lobby');notice('本地房间创建成功：'+n+' + 1 名智能体。');return}
 if(a==='tutorial'){mode='tutorial';ai=1;show('game');notice('教学：先观察当前阶段，再选择高亮方向；自动配置 1 名教学 AI。');return}
 if(a==='add'){ai=Math.min(7,ai+1);syncLobby();notice('参与者共 '+(ai+1)+' / 8 人；已配置 '+ai+' 名 AI。');return}
 if(a==='remove'){ai=Math.max(0,ai-1);syncLobby();notice('现有 '+ai+' 名 AI；至少需要 1 名 AI 才能开始。');return}
 if(a==='start'){if(ai<1){notice('人数不足，请添加至少 1 名智能体。');return}if(s==='createfail'){notice('创建对局失败，配置已保留，可重试。');return}show('game');return}
 if(a==='exit'){promptConfirm('退出本局？','本局进度将结束，取消可继续游戏。',()=>show(mode==='tutorial'?'home':'lobby'));return}
 if(a==='speed'){const speeds=['0.6×','1×','1.75×','3×'];speedIndex=(speedIndex+1)%speeds.length;b.textContent='速度 '+speeds[speedIndex];notice('演出倍速 '+speeds[speedIndex]+'；不改变骰值或模型预算。');return}
 if(a==='fit'){notice('设计行为：以全部棋格为边界居中适配，棋盘外框允许超出视区。');return}
 if(a==='move'){notice('已预览向右移动；正式实现由引擎给出合法落点，确认后提交。');return}
 if(a==='tool'||a==='confirm'){promptConfirm('对小棒使用拳击？','检查目标与击退方向；确认前不消耗道具。',()=>notice(s==='stale'?'局面已变化，请重新选择；道具未消耗。':'已确认：演示一次道具效果。'));return}
 if(a==='cancel'){notice('已取消目标选择；道具未消耗。');return}
 if(a==='end'){notice(s==='timeout'?'模型超时，已切换规则策略；播放行动后继续。':'阶段结束：观察 AI 出牌、移动和效果。');return}
 if(a==='ask'){if(!$('#question').value.trim()){notice('请输入规则问题（1—200 字）。');return}notice(s==='unknown'?'当前规则库没有依据，无法确认。':s==='timeout'?'规则服务暂不可用，可查看本地规则条目。':'示例回答：先选合法目标再确认使用。依据：道具·拳击 v1。');return}
 if(a==='restart'){if(s==='createfail'){notice('新对局创建失败，当前结果已保留，请重试。');return}show('game');notice('新对局已创建；沿用配置，旧结果保持只读。')}
});
show('home');
</script></html>'''.replace('__PANELS__',''.join(panels))
    (OUT/'交互原型.html').write_text(html,encoding='utf-8')

for draw in (context,architecture,data,flow,navigation,home,lobby,game,result):draw()
prototype_html()
manifest={'figures':[{'name':p.stem,'width':Image.open(p).width,'height':Image.open(p).height} for p in sorted(OUT.glob('0[1-9]-*.png'))], 'image_references':'local only','prototype':'交互原型.html'}
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'Generated {len(manifest["figures"])} PNG/SVG figures and one clickable prototype in {OUT}')
