# 实验5：规则教练与RAG运行记录

日期：2026-10-26。实现范围：已确认规则的关键词检索与带出处问答，不执行游戏动作，不读取玩家隐藏手牌。

## 准备和运行

运行环境为Node.js 22.23或更新的兼容版本。安装依赖后，在服务端环境中配置DASHSCOPE_API_KEY；默认模型为qwen3.8-flash。也可复制根目录.env.example为本地.env，填写LLM_API_KEY、LLM_BASE_URL和LLM_MODEL。真实密钥不能提交，不能使用VITE_前缀。

1. `npm run coach`：在127.0.0.1:3001启动问答服务。
2. `npm run dev`：启动网页，首页展开规则教练。Vite代理/api请求。
3. `npm run coach:ask -- "瞬移到终点会立刻结算吗？"`：直接执行命令行问答。
4. `npm run eval:rules -- compare`：使用固定8题，运行直接模型/RAG两组，各8次独立上下文。
5. `npm run eval:rules -- prompt`、`context`、`failure`：分别运行Prompt配对、全量/Top-3上下文、成功与连接拒绝对照。

重新运行评测会产生真实模型调用，覆盖对应结果文件；原报告采用本提交保存的结果，不将后续重跑结果自动替换为报告数据。

## 证据索引

| 文件 | 内容 |
| --- | --- |
| compare-results.json | 16次真实云端请求、检索、完整messages、原始输出、校验结果、usage和耗时 |
| prompt-initial.json | 首次v1测试，含Q8追问正文与insufficient状态不一致的观察 |
| prompt-results.json | Q6/Q7/Q8各自v1/v2配对，同一问题、资料和参数 |
| context-results.json | 同一多规则问题的全20段与Top-3输入对照 |
| failure-results.json | qwen3.8-flash成功调用及本地关闭端口的连接拒绝 |
| initial-provider-failure.json | 前置qwen-flash请求的HTTP400、Arrearage真实观察，非完整错误体 |
| safety-results.json | 单个带“忽略指令/伪造引用”输入的真实响应，不能外推为彻底防御 |
| knowledge-snapshot.json | 20个片段、行号、版本、长度和原资料SHA-256 |
| review.json | AI辅助依据源码逐项核对，保留Q6遗漏 |
| comparison-review.md | 作者审阅用的两组原始回答与预定判据 |
| author-review-confirmation.json | 作者在当前会话审阅后确认评分 |

报告截图仅保存在课程工作区本地，不上传仓库。日常用户请求不会自动写入这些实验文件。

## 结果范围

直接组状态符合3/8、覆盖6/21要点；RAG符合8/8、覆盖20/21要点。RAG提供了项目特定规则，但本次耗时和Token更高；8题单次采样且参与开发，不代表独立泛化评估。引用ID检查与语义核对分开执行。

## 模块边界

`server/providers/chat.ts`负责HTTP模型调用、超时、取消和安全错误；`server/rag/knowledge.ts`负责本地Markdown切分及检索；`prompts.ts`组织模板；`coach.ts`组合链路并验证JSON和引用；`server/index.ts`仅在回环地址提供API，限制请求大小、并发、来源和调用次数。前端只显示答案与本次出处，不接收密钥或原始服务商错误体。
