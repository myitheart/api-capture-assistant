# Delivery Protocol

插件与本地 Companion 之间的版本化任务协议。`PROTOCOL_VERSION` 与插件版本、Companion 版本分别管理；双方版本不兼容时必须拒绝执行。

插件是独立仓库，因此发布时会保留一份协议版本快照；外层仓库中的定义是 Companion、Harness 插件和集成测试的规范来源。
