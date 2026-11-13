# GridEngine Console

基于 Node.js、Express、React 和 Vite 的中文集群计算管理控制台，使用 pnpm 管理依赖。

## 运行

需要 Node.js 22.12+ 和 pnpm。

```sh
pnpm install
pnpm dev:demo
```

开发模式同时启动 API 和前端。Vite 默认使用 5173，端口占用时自动选择下一个可用端口，以终端输出为准。API 默认使用 3101；设置 `API_PORT` 后，开发代理自动使用相同端口。

```sh
pnpm build:demo
pnpm start:demo
```

构建后由 Express 提供静态文件和 API，访问 `http://localhost:3101`。`pnpm preview` 仅预览前端产物，不会启动 API。

`dev:demo` / `dev:live`、`start:demo` / `start:live` 分别选择后端模式；`build:demo` / `build:live` 使用对应的 Vite mode 加载构建配置。未区分模式的 `dev`、`start`、`build` 命令仍保留，其中后端默认使用 demo 模式。

## Demo 与 Live

`GRIDENGINE_MODE` 支持 `demo`（默认）和 `live`，其他值会在启动时报错。切换模式后须重启后端。

- `demo`：使用本地演示数据，保留原有创建、修改和删除功能。
- `live`：从当前 SGE 环境读取真实状态，不读写 `DATA_FILE`，不初始化演示数据。所有 API 写请求均返回 `405`，前端同步禁用写操作；命令失败返回 `502`，不会回退到演示数据。

先将后端部署在能访问集群的 SGE 提交主机或管理主机上，以拥有查询权限的普通系统账户运行。加载该集群的环境，例如：

```sh
source /opt/sge/default/common/settings.sh
qstat -xml -u '*'
qhost -xml
qconf -sql
qconf -shgrpl

pnpm dev:live
```

请将环境脚本路径替换为实际路径。生产运行使用 `pnpm build:live` 后执行 `pnpm start:live`。进程继承当前 shell 的 `SGE_ROOT`、`SGE_CELL`、`PATH`、SGE 端口等环境变量；不会自动加载环境脚本或 `.env` 文件。通过 systemd 等运行时，应在服务中显式配置这些环境变量。

| 可选环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SGE_BIN_DIR` | 从 `PATH` 查找 | `qstat`、`qhost`、`qconf` 所在目录，例如 `/opt/sge/bin/lx-amd64` |
| `SGE_CLUSTER_ID` | `sge` | 前端集群 ID |
| `SGE_CLUSTER_NAME` | `SGE_CELL` 或 `Grid Engine` | 前端集群名称 |
| `SGE_QMASTER_HOST` | `-` | 主控节点的展示名称，不改变命令连接目标 |
| `SGE_COMMAND_TIMEOUT_MS` | `10000` | 每条命令超时，范围 1–120000 毫秒 |
| `SGE_CACHE_MS` | `10000` | 成功快照缓存，范围 1–300000 毫秒 |

每个后端进程对应一套 SGE 环境，暂不支持多集群切换或 SSH 远程执行。命令使用 `execFile` 和参数数组，不执行 shell，输出上限为每条命令 8 MiB；配置查询最多四条并发。并发状态请求合并，过期缓存查询失败会报错，不返回旧缓存作为新数据。

### Live 数据来源

| 数据 | 查询命令 |
| --- | --- |
| 所有用户的当前作业 | `qstat -xml -u '*'` |
| 执行主机、负载、内存 | `qhost -xml` |
| 队列实例状态与槽位 | `qstat -f -xml -u '*'` |
| 队列配置 | `qconf -sql`、`qconf -sq 队列名` |
| 主机组 | `qconf -shgrpl`、`qconf -shgrp @组名` |
| 管理者用户、执行者用户、用户组 | `qconf -sm`、`qconf -so`、`qconf -sul` |

队列槽位从队列实例汇总；主机组保留原始成员（包括嵌套组引用），关联队列由队列 `hostlist` 的直接组引用反向计算，不展开嵌套关系。数组作业保留任务编号或范围。live 用户管理页分为管理者用户、执行者用户和用户组三个只读标签，分别展示对应 qconf 命令返回的名称；作业用户列表仍仅代表当前作业中观测到的用户。邮箱、部门和权限不推断。历史事件为空，不生成虚构审计记录。

`qhost` 的平均负载不等于 CPU 使用率，因此 CPU 使用率显示 `-`，负载可在节点详情查看；内存百分比由 `mem_used / mem_total` 计算。未提供的主机 IP、引擎版本和指标显示 `-`；live 不显示模拟历史曲线和昨日对比。实际 SGE 发行版的命令参数和输出可能有差异，上线前需与目标集群核验。当前测试使用命令样例，不代表已完成真实集群联调。

## 功能

- 集群概览：计算节点、作业状态、CPU/内存使用情况、演示趋势图、节点健康矩阵及队列负载。
- 作业管理：脚本提交、用户和队列选择、槽位配置、搜索、状态筛选、分页、详情、挂起、恢复、终止及批量挂起。
- 用户管理：demo 支持创建、角色资料、启用、停用与删除并保护默认管理员；live 分标签查看管理者用户、执行者用户和用户组。
- 节点管理：添加节点、CPU/内存配置、资源使用率、详情、上下线与删除。
- 集群管理：创建、主控节点资料、详情、启停与关联资源删除保护。
- 队列管理：创建、槽位及优先级配置、负载、启停与活动作业删除保护。
- 队列组：在队列管理页管理 SGE 主机组（`@组名`），支持创建、编辑、成员节点与队列关联、搜索、集群筛选及删除。节点和队列必须属于同一集群；删除组前须解除队列关联，引用中的节点、队列及集群受删除保护。
- CSV 导出、操作事件、通知中心、集群筛选、自动刷新偏好以及移动端导航。

## 数据与边界

**默认 demo 模式不会连接或修改真实 Grid Engine 集群，也不会执行提交的脚本。** 首次运行生成 3 个集群、24 个节点和 156 个作业；更改保存到 `server/data.json`。通过 `DATA_FILE=/path/to/data.json` 可使用独立数据文件。趋势图和昨日对比为演示数据，不是历史监控采样。live 模式只执行上述查询，不允许提交或修改集群资源。

队列组按 SGE host group 建模，使用 `hosts` 保存节点 ID、`queueIds` 保存关联队列 ID；队列关联表示演示环境中的队列 `hostlist` 主机组引用，不执行 `qconf`。当前不支持嵌套主机组。已有数据文件会兼容加载，默认队列组为空，不修改原有资源。

角色字段仅展示用户资料，未实现认证或服务端 RBAC。两种模式都不应直接暴露到公网；只读状态仍包含集群资源和作业信息。应部署在受信任网络或有认证的反向代理后，不要使用 root 运行。未来开放真实写操作前，还需登录认证、服务端权限校验、审计持久化和受控写命令适配器。demo 中的集群启停与节点上下线仅修改演示状态，不代表操作系统关机。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/state` | 集群、节点、队列、用户、作业与事件 |
| POST | `/api/:resource` | 创建资源 |
| PATCH | `/api/:resource/:id` | 修改状态 |
| DELETE | `/api/:resource/:id` | 删除非作业资源 |
| POST | `/api/hostGroups` | 创建队列组：`name`、`cluster`、`hosts`、`queueIds` |
| PATCH | `/api/hostGroups/:id` | 完整更新队列组配置 |
| DELETE | `/api/hostGroups/:id` | 删除已解除队列关联的队列组 |

`resource` 为 `clusters`、`nodes`、`queues`、`users` 或 `jobs`。作业终止使用 PATCH，状态为 `deleted`；历史记录保留。接口使用 Zod 校验，错误以 JSON 返回。

上述写接口仅在 demo 中可用。`GET /api/state` 返回 `mode` 和 `readOnly` 字段；live 另返回 `fetchedAt`，表示命令快照生成时间。live 查询失败的响应也包含模式及只读标识。

## 验证

```sh
pnpm lint
pnpm build
pnpm test
```

`pnpm test` 不需要 SGE 或浏览器，覆盖 XML/配置解析、子进程命令调用、缓存、错误处理、live 写保护、文件隔离和 demo 持久化回归。集成测试使用临时命令样例和临时数据目录，不修改实际集群或本地数据。

浏览器冒烟测试使用 demo：

```sh
pnpm exec playwright install chromium
GRIDENGINE_MODE=demo pnpm dev
```

另一个终端执行：

```sh
TEST_BASE_URL=http://localhost:5173 pnpm test:smoke
```

将测试 URL 改为实际 Vite 地址。测试在独立临时数据文件和 3109 端口启动 API，不修改演示数据。覆盖五类资源创建、状态变更、删除保护、持久化、作业交互、用户交互、CSV 下载及桌面/移动端布局。可用 `TEST_API_PORT` 调整测试端口，用 `PLAYWRIGHT_EXECUTABLE_PATH` 指定本机 Chromium。截图写入 `/tmp/gridengine-desktop.png` 与 `/tmp/gridengine-mobile.png`。
