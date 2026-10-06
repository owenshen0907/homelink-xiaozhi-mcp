# 工程档案

- 展示名：HomeLink XiaoZhi MCP；工程 key：`homelink-bridge`。
- 唯一仓库：`owenshen0907/homelink-xiaozhi-mcp`；新仓库初始主线为 `main`，从作者的已实测 Home Hub 桥接模块提取，新建历史。
- 接手入口：根目录 AGENTS、README、SECURITY、THIRD_PARTY_NOTICES。本机个人规则由执行者自己的来源标记解析，不包含在公开包中。
- 组件：`src/` 可复用本地域层，`bin/cli.mjs` 为配置、验证与小智连接入口；无 Web、云业务 API、数据库或固件。
- 版本真源：`package.json`；Node 22.13+，macOS/Linux；`package-lock.json` 为依赖安装真源。
- 运行数据归使用者所有，唯一写入方是持有进程锁的实例；默认私有目录 `~/.local/share/homelink-xiaozhi-mcp`。与作者私有后台使用不同目录，初始分发不迁移任何账号材料。
- 共享服务：使用用户本人 HomeLink/Alexa 关联和小智智能体 MCP 接入点；不登记新的 App Services 身份、公共管理账号或签名平台身份。
- 交付渠道：用户授权公开 GitHub 源码；`private: true` 阻止误发布 npm。CI 仅检查源码，不启用自动部署、固件更新或其他发布渠道。
- 检查入口：`npm ci`、`npm run check`、`npm run format:check`、`npm test`、`npm run audit:dependencies`；本地与 CI 使用相同命令。凭据和真实设备只由使用者本人配置与验收。
- 回退：停止实例，保留仓库外私有文件，切换已验证的源码版本；旧版本是否支持当前文件需先核对。停止或回退不补发家电指令、不自动撤销 Amazon 会话。
- 初始证据范围：原接入由实物 ESP32 操作两盏灯，独立包用模拟账号与本地 WebSocket 验证；红外空调及连续语音稳定性不作为已完成验收。
