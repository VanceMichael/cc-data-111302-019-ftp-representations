# 来源协议（本地合成 FTP 子集）

用于在一台机器上复现历史合作站的 FTP 交付。服务器同时维护**控制连接**与
**数据连接**两条通道，命令在控制连接上串行处理，文件字节走 PASV 数据连接。

## 命令集

`USER`、`PASS`、`TYPE A/I`、`PASV`、`SIZE`、`MDTM`、`REST`、`RETR`、
`NOOP`、`PWD`、`QUIT`。

- `TYPE A`：文本表示，服务器把存储内容中的 LF 在数据通道上转成 CRLF；
  落盘存储字节不变。
- `TYPE I`：二进制表示，数据通道原样发送存储字节。
- `SIZE`：**永远返回服务器存储字节数**，与当前 TYPE 无关。文本表示下
  网络字节数（含 CRLF）与 SIZE 本来就不同，客户端不得把 SIZE 套到
  转换后的本地文件上。
- `MDTM`：返回 `YYYYMMDDHHMMSS`（UTC）形式的修改时间，作为文件身份的一部分。
- `REST`：只在 `TYPE I` 下接受；`TYPE A` 下返回 `504 Text restart unsupported`。
  文件故障 `restartSupported:false` 时二进制 REST 也会被拒（`502`），
  用于复现"不支持可靠续传"的来源。
- `PASV`：动态端口，回复中的主机四元组可通过 `state.pasvHost` 配置，
  用于验证客户端只连接本地批准的主机，而不是信任回复里的任意地址。
- `RETR`：先回 `150` 初步回复，数据连接结束并等待 `finalDelay` 毫秒后，
  再在控制连接上回**主动的最终状态回复**：成功 `226`，失败 `451/426`。
  数据连接关闭本身不代表成功。

## 故障注入（`state.faults[文件名]`）

| 字段 | 行为 |
| --- | --- |
| `finalFail` | 字节全部送达后最终回复 `451`，复现"收完却失败" |
| `replaceAtOpen` | RETR 打开数据时替换文件内容并推进版本/修改时间 |
| `cutAfterBytes` | 数据通道发送指定字节后销毁，最终回复 `426` |
| `restartSupported:false` | 拒绝 `REST`，要求客户端整份重取 |

顶层 `finalFail` / `replaceDuring` 仍作用于旧夹具里的 `sample.txt`。

## HTTP 外壳（仅测试/运维）

`GET /health` 存活检查；`GET /state`、`GET /inventory` 查看来源状态；
`POST /control` 仅接受白名单字段（`finalFail`、`replaceDuring`、`pasvHost`、
`finalDelay`、`faults`）与 `mutate` 文件变更操作。它不是采集业务接口，
真实交付只走 FTP。

每次创建服务重新读取 `fixtures/source.json`；服务使用随机本地端口，
测试负责启动与关闭。没有真实凭据或业务资料。
