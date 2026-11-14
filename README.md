# FTP 观测表采集客户端：传输表示与收件确认

面向老合作站 FTP 交付的 Node.js 采集端。它知道自己领取的是哪一种**传输表示**
（文本 `TYPE A` / 二进制 `TYPE I`），把控制命令、初步回复、数据字节流和
**最终状态回复**关联成一次完整领取；数据连接关闭不被当作成功，晚到的最终
失败不会被下一次领取吞掉。仅完整成功的版本进入目录，每次尝试都留下原始
接收事实、规范内容和收件确认。

## 解决的问题

- 文本传输下网络换行（CRLF）与落盘字节（LF）本来就不同，列表尺寸不能
  无条件套用到本地转换后的文件；
- 数据已收完但服务器最终回复失败时，不能把半份/失败内容当完成；
- 文件在领取过程中被替换，靠领取前后 `SIZE`/`MDTM` 身份核对拦截；
- 断线续传只在二进制且身份绑定时可靠；文本位置不可换算时明确整份重取；
- PASV 回复里的主机不可信，数据端点只连接本地配置批准的主机。

## 环境与命令

Node.js 22.22+，无第三方运行时依赖。

```sh
npm ci --ignore-scripts
npm run build   # 语法检查
npm test        # 15 个集成测试（含真实控制/数据双通道）
npm run demo    # 五个故障场景的端到端演示，工作区建在系统临时目录
```

## 在一台机器上复现双通道（两个进程）

终端 A，启动合成 FTP 来源（控制通道固定 2121，PASV 数据端口动态分配）：

```sh
FTP_PORT=2121 node src/ftp-cli.mjs
# {"status":"FTP 来源就绪","control":"127.0.0.1:2121","files":[...]}
```

终端 B，运行采集器，显式声明每个文件的传输表示：

```sh
FTP_HOST=127.0.0.1 FTP_PORT=2121 \
FTP_WORKSPACE=.local/run \
FTP_FILES=observe.txt,observe.bin \
FTP_TYPES=observe.txt:A,observe.bin:I \
node src/collect-cli.mjs
```

采集器逐文件输出收件确认摘要；完整产物在 `.local/run/inbox/`，原始网络
字节在 `staging/raw/`，失败隔离在 `staging/quarantine/`，每份确认在
`receipts/`。`FTP_PIN=127.0.0.1` 可显式钉扎允许的数据主机。

### 手工制造故障

编辑夹具 JSON（`FTP_FIXTURE` 指向的文件）中的 `faults`：

```json
{ "faults": { "observe.bin": { "finalFail": true } } }
```

- `finalFail`：数据收完后最终回复 `451`；
- `cutAfterBytes`: 10：数据通道发 10 字节后断开（`426`），二进制会留下
  身份绑定的续传标记，清除故障后再次运行即 REST 续传重组；
- `replaceAtOpen`：领取瞬间替换文件，触发前后身份不一致；
- `restartSupported: false`：拒绝 REST，客户端整份重取并在确认中说明。

## 演示场景（`npm run demo`）

1. 文本换行：CRLF 网络事实 vs LF 规范内容，SIZE 不套用；
2. 数据收完却返回 `451`：隔离不入目录，重取成功；
3. 领取中文件被替换：前后元数据不一致，拒绝入目录；
4. 恢复领取：二进制截断 → REST 续传重组；文本截断 → 整份重取；
5. PASV 钉扎：控制回复指向 `10.0.0.9` 时拒绝连接数据端点。

## 目录

- `src/ftp-server.mjs`：合成 FTP 来源（控制/数据双通道、故障注入）。
- `src/ftp-client.mjs`：协议客户端（回复关联、串行化、PASV 钉扎）。
- `src/collector.mjs`：采集器（表示身份、前后核对、续传重组、收件确认、原子入目录）。
- `src/ftp-cli.mjs` / `src/collect-cli.mjs`：独立进程入口。
- `src/source.mjs` / `src/serve.mjs`：测试用 HTTP 外壳与启动入口。
- `docs/source-contract.md`：FTP 协议子集与故障语义。
- `docs/collector-design.md`：采集端设计与落盘约定。

运行时状态属于来源模拟，重启回到 `fixtures/source.json`；采集工作区
请使用 `.local/`（已在 `.gitignore`）或明确的外部路径。
