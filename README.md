# HomeLink → Alexa → 小智 MCP

一个独立的 Node.js 桥接器，让小智语音助手调用 HomeLink 已关联到 Alexa 的家电。关键链路来自一次 ESP32 实机接入：上方灯关闭、下方灯开启均由用户确认。

```text
你说话 → ESP32 → 小智智能体 → MCP 工具
                                  ↓
                            本机桥接程序
                                  ↓
                          Alexa → HomeLink
                                  ↓
                          智能灯 / eRemote 空调
```

本程序主动连接小智的云端 MCP 接入点，不开放公网家电控制端口。ESP32 继续使用原来的官方小智语音通道；厂商适配在电脑端完成。

**当前范围：日本 Amazon 账号、macOS/Linux、已声明 power 能力的设备开/关。** HomeLink 与 Alexa 的账号关联是官方能力；本程序访问 Alexa 使用非官方 `alexa-remote2`，接口变化可能需要重新适配。调温、亮度、颜色和场景没有接入。

## 快速开始

需要 Node.js 22.13 或以上、可联网的电脑，以及已在 HomeLink 中正常工作的设备。先在 Alexa App 启用 HomeLink 技能、完成账号关联，确认 Alexa App 也能控制设备。[官方关联说明](https://linkjapan.co.jp/support/faq/a-homelink/)

```sh
git clone https://github.com/owenshen0907/homelink-xiaozhi-mcp.git
cd homelink-xiaozhi-mcp
npm ci
```

### 1. 取得 Alexa 会话

```sh
npm run login
```

终端显示一个本机浏览器地址。由你本人登录已经关联 HomeLink 的日本 Amazon 账号，完成验证码，然后回到终端。程序通过 `alexa-cookie2` 的本机代理取得所需会话；它不是官方第三方 OAuth 授权应用，也不会自动复用浏览器里的 Amazon 购物网站登录。

登录代理只绑定 `127.0.0.1`，完成、取消或超时后关闭。日本登录所需的 OAuth 命名空间修正保留了原登录主机、PKCE 与回调，不关闭 TLS 验证。

### 2. 确认设备

```sh
npm run devices
```

复制输出中目标设备的 `id`。只操作 `actions` 中列出的能力；传感器项可以出现在目录里，但没有开关权限。

```sh
node bin/cli.mjs rename DEVICE_ID 上方灯
node bin/cli.mjs control DEVICE_ID turn_on
node bin/cli.mjs control DEVICE_ID turn_off
```

`DEVICE_ID` 是占位符，必须换成你自己的目录输出。控制命令退出码：0 为 Alexa 回报成功，1 为失败，2 为结果未确认。请观察设备真实响应；`reported` 只是 Alexa 回报，红外空调始终保留 `unconfirmed`，不能据此宣称空调已经收到红外。

### 3. 接入小智

在小智控制台选择 ESP32 当前使用的智能体，找到扩展能力中的 **MCP 接入点**，复制地址。

```sh
npm run configure
```

直接在终端粘贴接入点并回车，输入不回显。不要把带令牌的地址放到命令行参数、聊天或 Git。此命令只保存配置，不联网注册工具。

### 4. 保持桥接运行

```sh
npm start
```

显示 `MCP 状态：ready` 后，用实物语音助手试一句明确指令，例如“关闭上方灯”。按 Ctrl+C 停止。电脑与程序需保持运行，互联网、Alexa、HomeLink 和小智连接均正常时才有完整链路。

同一份数据只允许一个程序实例写入。运行其他命令前先停止 `start`。需要独立环境时，在命令前加 `--data-dir`：

```sh
node bin/cli.mjs --data-dir "$HOME/.local/share/homelink-test" configure
node bin/cli.mjs --data-dir "$HOME/.local/share/homelink-test" start
```

## 提供的工具与执行边界

| 工具 | 参数 | 功能 |
| --- | --- | --- |
| `home_list_devices` | 无 | 列出名称、编号和允许的动作 |
| `home_control_device` | `deviceId`、`action` | `turn_on` / `turn_off` |

目标不清楚时应先询问用户。执行端保留有效期、取消、重复请求检查、一次厂商写入和重启不补发；忙时拒绝新操作，不堆积指令。已发送的指令不能保证撤回。MCP 同连接的相同 RPC 编号去重；跨连接无法判断两个新调用是否表达了同一条语音，请不要让模型自动重试家电写入。

如果接入自己的后台，可以使用 `src/smart-home.mjs` 的 `smartHome()`，或组合 `alexaAdapter()` 与 `smartHomeMcp()`。MCP 工具和 CLI 共用家电执行逻辑；嵌入方需自行提供管理接口的认证、授权、CSRF 和单写入者协调。本仓没有 HTTP 管理服务器。

## 私有数据与退出

默认数据目录：`~/.local/share/homelink-xiaozhi-mcp`。

```text
runtime-lock.json                 单实例锁（PID，不含账号信息）
smart-home/session.json           Amazon 会话
smart-home/voice.json             小智 MCP 接入点
smart-home/settings.json          自定义名称及最近 100 条控制结果
smart-home/registration-cache.json 登录代理注册缓存
```

这些文件属于使用者，保存在仓库外，权限0700/0600；会话是明文私有文件，不能发给他人或放在共享目录。停止程序不撤销 Amazon 服务端会话；需要彻底停用时，也应到 Amazon 账号中撤销对应注册。

异常断电或强制结束可能留下进程锁。确认没有进程再使用这份数据后，才移除 `runtime-lock.json`；程序不会自动删除旧锁并重复操作设备。[安全说明与已知依赖告警](SECURITY.md)

## 验证与目前的限制

```sh
npm run check
npm run format:check
npm test
npm run audit:dependencies
```

测试使用合成会话、模拟 Alexa 和真实本地 WebSocket，覆盖私有文件、期限、取消、幂等、重启、登录修正、MCP 工具及 CLI。CI 在 GitHub 托管 runner 上测试 Node 22/24，不使用个人授权。

原 Home Hub 集成已经通过 ESP32 实物语音控制两盏灯；独立提取版的自动测试不能代替你的真实设备验收，也不证明所有 HomeLink 型号都兼容。原实测后 ESP32 曾持续响声、失联，断电恢复但没有取得故障现场堆栈；本仓没有修改或修复固件。

版本由 `package.json` 管理。这次只公开源码，没有发布 npm 包、后台部署或固件更新。

## 接入实录与来源

- [我把 HomeLink 接进了小智：完整接入实录](https://owenshen.top/notes/2026-10-06-homelink-esp32-voice)
- [HomeLink 官方 FAQ](https://linkjapan.co.jp/support/faq/a-homelink/)
- [alexa-remote](https://github.com/Apollon77/alexa-remote) / [alexa-cookie](https://github.com/Apollon77/alexa-cookie)
- [Homebridge Alexa Smart Home](https://github.com/joeyhage/homebridge-alexa-smarthome)：Alexa GraphQL 请求结构参考
- [小智官方 MCP 示例](https://github.com/78/mcp-calculator)

MIT 开源，保留原来源版权声明，见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。与 LinkJapan、Amazon 或小智的官方产品没有隶属关系。
