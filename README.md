# DSH Memory 插件

`dsh-plugin-memory` 为 DeepSeek Harness 提供按项目隔离的持久化知识，以及只写入、不可读取的项目凭据状态工具。它是一个 ESM Cordis 插件，目标运行时为 Harness `0.1.5-rc.2`。

## 功能验证截图

![memory 插件测试证据](docs/screenshots/memory-test-output.svg)

图：由真实 `npm test` 输出渲染的功能验证证据（14 项通过、0 项失败），不是图形化 memory 面板截屏。来源和验证边界见 [`docs/screenshots/SOURCES.md`](docs/screenshots/SOURCES.md)。

## 安装

安装和每次启动 Harness 时使用同一个 `DSH_HOME`：

```sh
export DSH_HOME=/absolute/path/to/your/dsh-home
git clone https://github.com/hzxwonder-dsh-plugins/dsh-plugin-memory.git
cd dsh-plugin-memory
npm ci
dsh plugin --profile migration add "file:$PWD"
dsh --profile migration
```

请保留 `file:` 前缀；裸路径会被 pnpm 当作 `link:`，不会解析插件声明的依赖。

如使用其他 profile，请在两个 DSH 命令中替换 `migration`。宿主 profile 需要提供 `tools`、`credentials`、`sessionProjections` 和 `sandboxPolicy` 服务。插件补丁只插入稳定 id `dsh-plugin-memory`，不会改写 Harness 源码。

## 当前验证结论

本地检查结果如下：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 单元和集成测试 | 通过（14/14） | `npm test` |
| JavaScript 语法 | 通过 | `node --check index.js && node --check store.js` |
| 发布包清单 | 通过 | `npm run pack:check` |
| migration profile 加载 | 已确认 | `dsh --profile migration --dump-config` |
| Harness Web 实际启动 | 通过 | 临时 profile 启动并加载插件 |
| 真实 Harness Agent | 通过 | 工具注册、记忆读写、CAS 冲突、凭据写入及仅状态返回；部署目录 `tests/harness-integration.mjs` |

因此，存储、并发、权限和凭据边界已经由自动化测试覆盖；在 watcher 限制解除并完成真实 Web Session 操作前，不把上述结果扩展为完整 UI 运行保证。

## `memory` 工具

存储身份来自 `exec.agent.session.header.cwd`，模型不能通过参数指定路径：

1. 将路径解析为规范化真实目录。
2. 对规范路径计算 SHA-256 项目 ID。
3. 在 `$DSH_HOME/plugin-data/memory/<project-id>/` 中保存知识和流程状态。

同一项目的别名路径共享记忆，不同的同名目录保持隔离。动作如下：

- `read`：返回完整 Markdown、内容 revision 和待维护流程。
- `write`：在 `baseRevision` 仍然匹配时替换完整文档。
- `forget`：在同一 revision 校验下替换文档，用于删除过时事实。
- `observe_process`：仅在流程及最终检查真实完成后记录一次流程观察。

同一宿主 turn 只计数一次；两个不同 turn 观察到同一流程后，会生成待维护项。确认维护时需要同时提交最新知识 revision、维护 revision、已更新的流程 ID 和完整的新文档。

## `memory_credentials` 工具

该工具只接受环境变量风格名称，并提供两个动作：

- `secret_set`：为当前项目写入或轮换凭据，返回名称和保存状态。
- `secret_status`：返回指定名称是否已配置。

凭据记录通过 Harness `ctx.credentials` 保存，记录 ID 同时包含项目 ID 和名称摘要。插件没有读取、导出、注入环境变量、执行命令或网络发送凭据的动作；工具结果也不会返回凭据值。

### 会话记录边界

Harness 会在工具执行前记录完整参数，因此 `secret_set` 的值可能出现在 Session 历史并发送给配置的模型提供方。插件无法修改这段历史。只有在接受该暴露边界时才使用 `secret_set`；普通知识文档只记录变量名，不记录值。

## 沙箱策略

插件在每次调用前解析当前 Session 的 `sandboxPolicy`：

- `read-only` 允许 `memory.read` 和 `secret_status`。
- `write`、`forget`、`observe_process` 及 `secret_set` 返回 `MEMORY_SANDBOX_DENIED`，并在插件状态发生变化前失败。
- 第一次 `memory.read` 会在 `$DSH_HOME` 下按需创建 owner-only 目录和初始 `memory.md`；这不写入项目工作区。 `secret_status` 不会初始化普通记忆目录。

## 存储与安全

```text
$DSH_HOME/plugin-data/memory/<sha256-canonical-project-root>/
  memory.md
  processes.json
```

目录权限为 `0700`，文件权限为 `0600`。知识和流程状态上限为 64 KiB，完整文档写入使用跨进程锁和原子替换。符号链接、硬链接和不安全的托管路径会被拒绝；锁超时返回稳定的 `MEMORY_BUSY`，不会猜测锁已失效。常见私钥、Token、密码和 Secret 赋值模式会被拦截，但这是启发式护栏，不是完整的秘密扫描器。

## 开发与验证

```sh
npm install --cache /private/tmp/npm-cache-dsh-migration
npm test
npm run pack:check
```

详细契约见 [`docs/spec.md`](docs/spec.md)，用户路径见 [`docs/e2e.md`](docs/e2e.md)。双语文档见 [`README.en.md`](README.en.md)。

## 许可证与来源

LGPL-3.0-or-later。实现源自 PI-Desktop 的 `pi.memory` 行为并适配 DSH 官方服务；归属信息见 [`NOTICE`](NOTICE)，依赖项保留各自许可证。
