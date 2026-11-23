# 第三方来源

- [Wechaty Puppet Neo](https://github.com/wechaty/puppet-neo)，固定提交 `aea74c70b9b14438045fd38ab3161ef5c2474095`。上游许可为 Apache-2.0，负责个人微信的扫码登录、消息同步和发送。
- [wechat-protocol](https://crates.io/crates/wechat-protocol) 固定为 `2.2.0`，由 Neo 原生模块调用。该 crate 的 `LICENSE` 包含其 MIT 许可及内嵌 SILK SDK 的 Skype BSD 风格条款，`NOTICE` 记录了其中的第三方来源。群聊和图片接入由 Hedwig 的 `tools/prepare_groups.py` 与 `neo-overlay/` 扩展。只读会话恢复移植自 [Puppet Neo `ddfa5ec`](https://github.com/wechaty/puppet-neo/blob/ddfa5ecd53ba1303d7e424acb47f86989715af89/native/src/lib.rs#L332-L411)。
- Neo 的固定提交包含 `LICENSE`。发布预构建二进制或容器前，应按产物核对依赖的许可证、NOTICE 和修改说明。
- 示例角色取材自《哈利·波特》作品，仅作为可选同人 Prompt。项目与相关权利人及微信官方均无隶属关系。
- Hedwig 自有代码采用 [Apache-2.0](../LICENSE)。
