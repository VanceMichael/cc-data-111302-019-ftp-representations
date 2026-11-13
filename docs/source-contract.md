# 来源协议

本地FTP子集：USER、PASS、TYPE A/I、PASV、SIZE、MDTM、REST、RETR、QUIT。TYPE A把LF转CRLF，SIZE永远是存储字节数；REST只在TYPE I可用。PASV端口动态分配，主机可通过控制值设置以测试拒绝未授权端点。RETR先150，数据关闭后延迟返回226或451；replaceDuring使内容领取后版本递增。客户端应等待最终回复。公开readBanner只读取欢迎语。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
