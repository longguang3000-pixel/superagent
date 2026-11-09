# dsh-feishu-shot

飞书里说一句「截图」/「截左屏」/「截右屏」，约 1 秒内收到本机对应的屏幕截图。它是 DSH（dsh-superagent）的一个本地 Cordis 插件。

## 为什么要做成插件，而不是让 Agent 去做

Agent 处理一条飞书消息要走准入、模型评估、开单、执行，通常十几秒到几十秒——二维码早就换了。截屏本身却是一步本地操作，不需要模型。

这个插件利用一件已经存在的事：dsh-superagent 的飞书长连接把每条收到的消息写进 `<stateDir>/orchestrator.sqlite` 的 `trigger` 表（在模型介入之前）。插件只读轮询这张表，命中指令就直接抓屏、直接回图，完全绕开工单链路。

一次截图的固定开销：

| 环节 | 耗时 |
| --- | --- |
| 只读轮询 `trigger` 表 | < 1 ms（每 250 ms 一次） |
| 常驻 PowerShell worker 抓屏并编码 JPEG | 150–400 ms |
| `lark-cli im +messages-send --image` 上传并发送 | 1–2 s |
| 合计 | 约 1.5–2.5 s |

## 指令

| 说法 | 结果 |
| --- | --- |
| 截图 / 截屏 / 截个图 / 全屏 / 整屏 / screenshot | 整个虚拟桌面（所有显示器） |
| 截左屏 / 左屏 / 左边截图 | 最左边的显示器 |
| 截右屏 / 右屏 / 右边截图 | 最右边的显示器 |

只匹配短指令（去空格标点后不超过 12 个字）。「二维码截图后发我一下」这种长句仍然走正常的 Agent 流程。

## 安装（Windows + 已在用 dsh-superagent 的 desktop profile）

```powershell
$src = 'C:\path\to\this\repo\plugin'                      # 本仓库里的 plugin/ 目录
$dst = "$env:USERPROFILE\.dsh\local-plugins\dsh-feishu-shot"
Copy-Item $src $dst -Recurse -Force
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-feishu-shot" $dst
```

在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加一行（保持 pnpm 状态一致）：

```json
"dsh-feishu-shot": "link:../../local-plugins/dsh-feishu-shot"
```

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: dsh-feishu-shot
      name: dsh-feishu-shot
      config:
        stateDir: "//?/C:/Users/<you>/.dsh/state/superagent"
        # 只接受这些发送者（open_id）；留空表示不限制
        allowedSenders:
          - ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

保存后 DSH 的 HMR 会自动重组 profile 并加载插件，不需要重启整个应用。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `stateDir` | `~/.dsh/state/superagent` | dsh-superagent 的状态目录，插件从这里的 `orchestrator.sqlite` 读 trigger |
| `cli` | `%APPDATA%\npm\node_modules\@larksuite\cli\bin\lark-cli.exe` | 机器人身份的 `lark-cli` |
| `powershell` | `pwsh.exe` | 抓屏 worker 用的 PowerShell |
| `shotsDir` | `<stateDir>/screenshots` | 截图与去重状态存放处 |
| `intervalMs` | `250` | 轮询间隔；是端到端延迟的主要来源 |
| `allowedSenders` | `[]` | 只响应这些 open_id；空数组表示不限制。**截屏是隐私操作，生产部署建议填上** |
| `keepDays` | `2` | 截图保留天数，过期的 JPEG 自动清理 |

## 运行与排错

- 日志：`<stateDir>/feishu-shot.log`（每张图的尺寸、抓屏耗时、端到端耗时、失败原因）
- 去重状态：`<shotsDir>/seen.json`；删掉它并重启插件，会重新"认领"当前库里的历史消息（不会重放）
- 截图文件：`<shotsDir>/<时间戳>-<left|right|all>.jpg`
- 插件只以只读方式打开 `orchestrator.sqlite`，不写任何 Superagent 数据。

## 已知边界

- 依赖 dsh-superagent 的 `trigger` 表结构；`select id, value from trigger` 是唯一用到的契约。
- 只有被 dsh-superagent 接收的消息才会出现在 `trigger` 表里。群策略只收 `@` 时，请 `@` 机器人再说「截图」。
- 这条消息同时也会进入 Agent 的准入流程，所以可能先收到插件回的图，再收到 Agent 的一句回复。
- Windows 专用（`System.Windows.Forms.Screen` + `lark-cli`）。左/右屏按虚拟桌面上的 X 坐标排序确定。
