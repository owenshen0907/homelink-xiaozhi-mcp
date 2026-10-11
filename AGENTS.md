# HomeLink XiaoZhi MCP

接手先读 README、SECURITY 和 docs/development/project-profile.md。

- 这是从已实测的家电接入中提取的独立 Node.js 桥接器；不要把固件、私人后台或用户配置加入本仓。
- Node.js 22.13+，macOS/Linux；版本真源是 package.json。
- 安装使用 npm ci，验证使用 npm run check 和 npm test；测试全部使用合成账号与本地模拟，不操作真实家电。
- 凭据留在仓库外私有目录，权限0700/0600；不得放入 Git、fixture、日志或命令行参数。
- 家电写入只支持已声明 power 能力的设备，必须保留期限、取消、单次发送、幂等和重启不补发。
- Alexa 回报不是独立物理确认；红外空调结果保持未确认。
- 保留 MIT 和 THIRD_PARTY_NOTICES 的来源；不复制供应商输出或私有仓库历史。
- CI 不持有任何用户授权，使用仓库专用自托管 Linux Runner。仅接收同仓库 Owner 的可信 PR；主机预执行 hook 拒绝其他来源。
