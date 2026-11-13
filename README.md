# GridEngine Console

基于 Node.js、Express、React 和 Vite 的中文集群计算管理控制台，使用 pnpm 管理依赖。

## 运行

需要 Node.js 22.12+ 和 pnpm。

```sh
pnpm install
pnpm dev
```

开发模式同时启动 API 和前端。Vite 默认使用 5173，端口占用时自动选择下一个可用端口，以终端输出为准。API 默认使用 3101；通过 `API_PORT` 修改 API 端口时，还需同步调整 `vite.config.js` 中的代理目标。

```sh
pnpm build
pnpm start
```

构建后由 Express 提供静态文件和 API，访问 `http://localhost:3101`。`pnpm preview` 仅预览前端产物，不会启动 API。

## 功能

- 集群概览：计算节点、作业状态、CPU/内存使用情况、演示趋势图、节点健康矩阵及队列负载。
- 作业管理：脚本提交、用户和队列选择、槽位配置、搜索、状态筛选、分页、详情、挂起、恢复、终止及批量挂起。
- 用户管理：创建、角色资料、启用、停用与删除；保护默认管理员。
- 节点管理：添加节点、CPU/内存配置、资源使用率、详情、上下线与删除。
- 集群管理：创建、主控节点资料、详情、启停与关联资源删除保护。
- 队列管理：创建、槽位及优先级配置、负载、启停与活动作业删除保护。
- CSV 导出、操作事件、通知中心、集群筛选、自动刷新偏好以及移动端导航。

## 数据与边界

**当前为演示模式，不会连接或修改真实 Grid Engine 集群，也不会执行提交的脚本。** 首次运行生成 3 个集群、24 个节点和 156 个作业；更改保存到 `server/data.json`。通过 `DATA_FILE=/path/to/data.json` 可使用独立数据文件。趋势图和昨日对比为演示数据，不是历史监控采样。

角色字段仅展示用户资料，未实现认证或服务端 RBAC。请勿直接将此演示服务暴露到公网。真实部署还需：登录认证、服务端权限校验、审计持久化，以及在受信任的 Grid Engine 提交主机上实现 `qstat`、`qhost`、`qconf`、`qsub`、`qmod`、`qdel` 命令适配器。命令调用应使用参数数组而非拼接 shell 字符串，并以有权限的系统账户运行。控制台中的集群启停与节点上下线仅修改演示状态，不代表操作系统关机。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/state` | 集群、节点、队列、用户、作业与事件 |
| POST | `/api/:resource` | 创建资源 |
| PATCH | `/api/:resource/:id` | 修改状态 |
| DELETE | `/api/:resource/:id` | 删除非作业资源 |

`resource` 为 `clusters`、`nodes`、`queues`、`users` 或 `jobs`。作业终止使用 PATCH，状态为 `deleted`；历史记录保留。接口使用 Zod 校验，错误以 JSON 返回。

## 验证

```sh
pnpm lint
pnpm build
pnpm exec playwright install chromium
pnpm dev
```

另一个终端执行：

```sh
TEST_BASE_URL=http://localhost:5173 pnpm test
```

将测试 URL 改为实际 Vite 地址。测试在独立临时数据文件和 3109 端口启动 API，不修改演示数据。覆盖五类资源创建、状态变更、删除保护、持久化、作业交互、用户交互、CSV 下载及桌面/移动端布局。可用 `TEST_API_PORT` 调整测试端口，用 `PLAYWRIGHT_EXECUTABLE_PATH` 指定本机 Chromium。截图写入 `/tmp/gridengine-desktop.png` 与 `/tmp/gridengine-mobile.png`。
