# DSH Memory 插件

`dsh-plugin-project-memory` 为 DeepSeek Harness 提供按项目隔离的持久化知识，以及只写入、不可读取的项目凭据状态工具。它同时把记忆的使用策略和当前项目状态注入 system prompt，让 agent 自行判断何时读写，并自动提示维护重复出现的流程。它是一个 ESM Cordis 插件，目标运行时为 Harness `0.1.5-rc.2`。

## 功能验证截图

![memory 插件测试证据](docs/screenshots/memory-test-output.svg)

图：2026-09-12 的真实 `npm test` 输出渲染的功能验证证据（当时 14 项通过、0 项失败），不是图形化 memory 面板截屏；此后新增的提示词注入用例不在此图范围内，当前计数以本页表格为准。来源和验证边界见 [`docs/screenshots/SOURCES.md`](docs/screenshots/SOURCES.md)。

## 安装

一行命令（把 `web` 换成你自己的 profile 名）：

```sh
dsh plugin --profile web add github:hzxwonder-dsh-plugins/dsh-plugin-memory
```

这一条命令会自己完成安装：profile 不存在时先初始化，然后用 pnpm 拉取仓库并安装依赖，最后因为包在自己的 `package.json` 里声明了 `dsh.bundle.patch`，自动把这个插件加入 `dsh.profile.bundles`，不需要手工编辑 profile。插件是纯 JavaScript、没有 `prepare` 构建脚本，所以也不会出现需要写进 `allowBuilds` 的构建脚本授权提示。需要固定版本时改用 tag：

```sh
dsh plugin --profile web add github:hzxwonder-dsh-plugins/dsh-plugin-memory#v0.2.0
```

安装与每次启动 Harness 时使用同一个 `DSH_HOME`；宿主 profile 需要提供 `tools`、`credentials`、`sessionProjections`、`sandboxPolicy` 和 `systemPrompt` 服务。插件补丁只插入稳定 id `dsh-plugin-project-memory`，不会改写 Harness 源码。安装后重启 `dsh web`（或重启 DSH 应用），插件在宿主启动时加载。

仓库名仍是 `dsh-plugin-memory`，安装后的包名是 `dsh-plugin-project-memory`；本插件尚未发布到 npm，npm 上无 scope 的 `dsh-plugin-memory` 属于另一位作者，与本仓库无关。

改名同时改变了凭据记录的作用域（`<scope>/project-<projectId>-<keyHash>`），旧作用域下已写入的凭据需要用 `secret_set` 重新写入一次；项目记忆按规范化项目路径隔离，不受改名影响。

本地开发时改用 `file:`：

```sh
git clone https://github.com/hzxwonder-dsh-plugins/dsh-plugin-memory.git
cd dsh-plugin-memory
npm ci
dsh plugin --profile web add "file:$PWD"
```

请保留 `file:` 前缀；裸路径会被 pnpm 当作 `link:`，不会解析插件声明的依赖。

## 当前验证结论

本地检查结果如下：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 单元和集成测试 | 通过（18/18） | `npm test` |
| JavaScript 语法 | 通过 | `node --check index.js && node --check store.js` |
| 发布包清单 | 通过 | `npm run pack:check` |
| system prompt 注入 | 通过 | 真实 `@deepseek-ai/dsh-system-prompt` 组装：策略段进入提示词、动态上下文报告项目 revision 与待维护流程 |
| 一行命令安装 | 通过 | 隔离 `DSH_HOME` 中执行 `dsh plugin --profile web add github:…`：自动初始化 profile、拉取安装依赖并并入 `dsh.profile.bundles`，`--dump-config` 显示该层 |
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

## 自动使用记忆（system prompt 注入）

插件在 `systemPrompt` 服务可用时注入两份内容，不需要用户主动唤醒记忆功能：

- **静态使用策略**（section `tool:memory`，order `2950`）：告诉 agent 何时该读、什么样的信息值得写、`write`/`forget` 是整篇替换加 revision CAS、过时内容应改写或删除而不是追加重复、凭据不得写入文档，以及「同一流程在两个不同 turn 被观察到就必须补文档」。文本静态，保证系统提示词前缀可缓存。
- **动态项目状态**（context `memory:project`，order `130`）：每个模型步骤读取当前项目状态。已有文档时给出一行 revision 与大小；出现待维护流程时直接给出维护指令（pending 流程 ID、知识 revision、维护 revision 和需要提交的 `acknowledgedProcesses`），agent 据此立即补写步骤并清除 pending。

因此 agent 会自动决定读写时机：读到相关事实就更新或删除过时内容，重复两次的流程会被提示补写成 `## Procedures`。用户也可以在对话中直接说「请把这条存进 memory」「忘掉某某」，策略要求在同一 turn 内执行。

动态状态只含 revision、大小和流程 ID，**不含文档正文**，因此记忆内容不会泄漏进提示词；它在缺失、异常或超限时返回空字符串，不创建目录、也不写入任何文件，存储错误不会经由提示词暴露。

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

`test/system-prompt.test.js` 用真实的 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-system-prompt` 组装提示词；这两个包是宿主提供的 peer，未安装时该用例自动跳过，其余用例不受影响。

详细契约见 [`docs/spec.md`](docs/spec.md)，用户路径见 [`docs/e2e.md`](docs/e2e.md)。双语文档见 [`README.en.md`](README.en.md)。

## 许可证与来源

LGPL-3.0-or-later。实现源自 PI-Desktop 的 `pi.memory` 行为并适配 DSH 官方服务；归属信息见 [`NOTICE`](NOTICE)，依赖项保留各自许可证。
