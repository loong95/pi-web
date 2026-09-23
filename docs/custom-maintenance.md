# 私有 Pi Web 定制分支维护指南

本仓库的 `origin` 是私有 fork：`https://github.com/loong95/pi-web`。原仓库更新通过 GitHub 的 **Sync fork** 同步到 `origin/main`；本地不需要额外配置 `upstream` remote。

## 分支职责

```text
origin/main                 # 仅镜像原仓库；禁止直接加入私有功能
└── custom/main             # 可部署的私有定制版
    └── feature/<name>      # 一个正在开发的私有功能
```

`main` 必须保持为原仓库的快进镜像。PlantUML、内部认证或其他私有功能都进入 `custom/main`，而非 `main`。这样 GitHub Sync fork 始终安全，且每次同步的冲突范围只在私有改动与上游改动之间。

## 当前 PlantUML 改动：首次整理

先完成测试并提交当前工作区的 PlantUML 实现和维护文档。`pi-web-handoff-add-plantuml-support.md` 是一次性交接输入，不应提交。

```bash
# 当前位于 add-plantuml-support 时执行
git add \
  app/api/plantuml \
  app/globals.css app/settings.css \
  components/FileViewer.tsx components/FileViewer.test.mjs \
  components/MarkdownBody.tsx components/MarkdownBody.test.mjs \
  components/PlantUmlBlock.tsx components/PlantUmlBlock.test.mjs \
  components/PlantUmlBlock.dom.test.mjs components/PlantUmlSettings.tsx \
  components/SettingsPanel.tsx \
  docs/plantuml-acceptance.md docs/custom-maintenance.md \
  lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts \
  lib/plantuml.ts lib/plantuml-client.ts lib/plantuml-languages.ts \
  lib/plantuml.test.mjs lib/plantuml-settings.test.mjs \
  package.json package-lock.json

git commit -m "feat: add private PlantUML rendering support"

# 从已提交的 PlantUML 分支创建长期定制主线
git branch custom/main
git push -u origin custom/main
```

确认远端 `custom/main` 可用后，`add-plantuml-support` 可以保留作历史名称，或删除：

```bash
git branch -d add-plantuml-support
git push origin --delete add-plantuml-support  # 仅在此前曾推送该分支时执行
```

## 同步原仓库更新

### 1. 在 GitHub 同步 fork

打开 `loong95/pi-web`，选择 **Sync fork → Update branch**。这会将原仓库更新同步到你的 `origin/main`。

若 GitHub 提示 `main` 有私有提交，不要选择会丢弃它的操作；先将私有提交移到 `custom/main`。正常情况下 `main` 不应包含任何私有提交。

### 2. 在本地更新镜像分支

```bash
git fetch origin --prune --tags
git switch main
git pull --ff-only origin main
```

`--ff-only` 禁止本地为同步制造 merge commit；如果失败，先停止并检查为什么本地 `main` 不再是镜像。

### 3. 将私有定制重放到新 main

```bash
git switch custom/main
git rebase main
```

发生冲突时：

```bash
# 编辑并验证冲突文件
git add <resolved-files>
git rebase --continue
```

取消本次同步：

```bash
git rebase --abort
```

成功后运行验证，再更新远端定制分支：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
npm test
git push --force-with-lease origin custom/main
```

rebase 会重写 `custom/main` 的提交 ID，因此使用 `--force-with-lease` 是预期操作。它会在远端分支不是你上次获取的状态时拒绝推送，避免覆盖其他机器上的提交。

## 添加新的私有功能

始终从当前 `custom/main` 创建功能分支：

```bash
git switch custom/main
git switch -c feature/<short-name>
```

开发完成、测试通过后：

```bash
git add <files>
git commit -m "feat: <description>"
git push -u origin feature/<short-name>

git switch custom/main
git merge --no-ff feature/<short-name>
git push origin custom/main
```

`--no-ff` 保留功能分支的整合边界，方便以后查找、回退或迁移单个定制功能。若新功能仅是很小的修复，允许使用普通 fast-forward merge；关键是不要把它直接提交到 `main`。

当某个 `feature/*` 分支仍在开发而 `custom/main` 已因上游同步更新时：

```bash
git switch feature/<short-name>
git rebase custom/main
git push --force-with-lease origin feature/<short-name>
```

## 减少重复冲突

启用 Git 的冲突决议记忆一次即可：

```bash
git config rerere.enabled true
git config rerere.autoupdate true
```

每次上游同步后，重点检查：

```text
components/MarkdownBody.tsx
components/FileViewer.tsx
components/SettingsPanel.tsx
app/globals.css
app/settings.css
lib/i18n/messages/*.ts
package.json
package-lock.json
```

尤其要判断上游是否已经新增或重构 Markdown 图表渲染、Settings 结构或 PlantUML 支持；若存在，请优先复用上游扩展点，而不是同时保留两套实现。

## 上游已覆盖的定制改动（去重记录）

以下改动曾经在 `custom/main` 上自行实现，上游随后给出了等价实现。同步时**以上游为准**，删除本分支的版本，避免维护两套：

| 定制改动 | 上游实现 | 处理方式 |
| --- | --- | --- |
| 后台 subagent 完成通知加"非用户消息"标记 | `54aa49c` (#935) `SUBAGENT_NOTIFICATION_PREFIX` | 删除本分支实现，保留上游 |
| `get_subagent_result` 取回结果后抑制重复完成通知 | `12d3599` (#937) 已消费结果集合 + 父会话空闲轮询 | 删除本分支实现，保留上游 |
| 会话命名改走有界纯文本 transcript | `974c8bb` (#807) | 保留上游实现；本分支只保留它的上层改动（自动命名触发、实验设置、标题模型） |

判断原则：上游实现了同一能力时整块交给上游；本分支特有的部分（如自动命名触发与设置、标题模型选择）保留，但要改用上游的重构后接口，而不是把旧实现一起带回来。

反向的情况同样要记录：**上游没有对应实现的改动不要顺手删掉**。目前只有一条：

| 本分支保有的改动 | 上游现状 | 说明 |
| --- | --- | --- |
| `get_subagent_result` 对 `queued` 状态的等待与文本（`UNFINISHED_SUBAGENT_STATUSES`） | `get_subagent_result` 只把 `starting`/`running` 当未结束，`subagentFinalText()` 对 `queued` 落到 `failed: Unknown error` 分支 | 排队中的 run 会被报成失败，且 `wait: true` 不退让。上游修掉后按上面的原则交还给上游 |

## PlantUML 特有说明

PlantUML Server URL 存储在用户目录的 `~/.pi/agent/plantuml.json`，不属于仓库内容，不应提交。每次有较大上游更新（特别是 Next.js、React、Markdown 或 Settings 相关更新）后，按 [PlantUML 验收指南](./plantuml-acceptance.md) 用自托管 PlantUML Server 做一次冒烟验证。

## 发布前检查

```bash
git status
git log --oneline main..custom/main
node_modules/.bin/tsc --noEmit
npm run lint
npm test
```

确认：

- `main` 没有私有提交；
- `custom/main` 包含预期的私有提交；
- 工作区没有意外生成的 `.next`、临时日志或凭据文件；
- `~/.pi/agent/plantuml.json` 未被加入 Git；
- 真实 PlantUML Server 冒烟测试已通过。
