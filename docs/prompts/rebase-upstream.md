---
description: 把私有定制分支 rebase 到已同步上游的 main 上（保留我们的增量、以上游为准、功能冲突先问）
---
把私有分支 `custom/main` rebase 到 `main` 上。

分支名按实际仓库改：下面以 base=`main`、private=`custom/main` 为例。

冲突判定规则（按优先级，逐条执行）：

1. **上游没有的改动 → 保留我们的。** 纯新增（CSS 块、i18n 键、文档条目、新文件、新增函数/参数）两边都留。
2. **上游有的改动 → 以上游为准。** 上游重写、重构、删除同一段代码/测试/文档文字时，取上游版本，只把我们的“语义增量”补回去（例如上游重写了一个测试文件，就取上游版，再补回我们针对自己功能的那几条断言）。
3. **功能冲突 → 停下来问我。** 同一能力两边各自实现了、或语义互斥（上游删掉了我们依赖的调用、两边对同一行为有不同决定）时，不要自行取舍：列出「我们的实现 / 上游的实现 / 影响面」三个选项让我选。

硬约束：

- 不 squash、不 amend、不改写已有提交信息；每个私有提交保持独立（便于以后单独迁移或回退）。
- 不擅自 `git push`；只在汇报里给出 `git push --force-with-lease` 命令。
- 不 `git rebase --skip` 跳过提交，除非该提交的改动已完全被上游覆盖——这种情况要在汇报里说明。
- 不把私有提交合并进 `main`；`main` 必须保持上游镜像。
- 不使用 `next build`（会污染 `.next/`，破坏 dev server）。

## 阶段 0：预检与备份

```bash
git status --porcelain          # 必须为空；不干净先停下来问我
git branch "backup/custom-main-$(date +%Y%m%d-%H%M%S)"
git fetch --all --prune
git rev-list --left-right --count main...origin/main   # 左必须为 0（main 只能是镜像）
git switch main && git merge --ff-only origin/main
git rev-list --count main..custom/main
git log --oneline main..custom/main
```

- `main` 上有私有提交（左侧计数非 0）→ 立刻停下问我。
- 记录 merge-base：`git merge-base main custom/main`，后面三方对照要用。

## 阶段 1：预判冲突面（先看，别急着 rebase）

对每个待重放的提交：

```bash
git show --stat --format="" <sha>
```

找出「双方都改过」的文件：

```bash
git log --oneline <merge-base>..origin/main -- <file>
```

把冲突分到下面五类，后面按类处理：

| 类型 | 特征 | 处理 |
| --- | --- | --- |
| A 纯新增 | 双方在同一位置各加一块（CSS/i18n/文档/import） | 两边都留 |
| B 上游重写 | 上游把同一区域重构或删除，我们的改动只是叠加在上面 | 取上游，回填我们的增量 |
| C 上游删文件 | 上游删了整个文件，但它是我们功能的测试/文档 | 保留我们的文件，修掉依赖上游已删除代码的断言 |
| D 功能冲突 | 同一能力两边各实现一套，或语义互斥 | **停下来问我** |
| E 锁文件 | `package-lock.json` | 见阶段 3 |

## 阶段 2：执行 rebase

```bash
git switch custom/main     # 注意：不要在 main 上执行 rebase
git rebase main
```

每个冲突逐块处理，用三方对照，不要凭印象：

```bash
git show origin/main:<file>      # 上游版
git show <merge-base>:<file>     # 旧基点版
git show <sha>:<file>            # 我们的提交版（正在重放的那个）
```

- 解错了想重来：`git checkout --merge <file>`（重新生成冲突标记），别手改到无法回退。
- 想整份取上游版再补增量：`git show main:<file> > <file>`，然后只加回我们的块。
- 大块 `ours`/`theirs` 交错时用脚本按标记区间裁剪（保留 HEAD 侧、丢弃已过期的一侧），比手删可靠。
- 每个冲突文件处理完先自检：`grep -n '^<<<<<<< \|^=======$\|^>>>>>>> ' <file>` 必须无输出。
- 收尾：

```bash
git add <resolved-files>
GIT_EDITOR=true git rebase --continue
```

- 提交因冲突变成空（改动已被上游覆盖）→ 可 `--skip`，但汇报里要写清是哪一条、为什么。
- 计划明显跑偏（比如误在上游分支上 rebase、或解到无法判断）→ `git rebase --abort` 回到起点，重新规划。

## 阶段 3：锁文件（package-lock.json）

绝不合入带冲突标记的 lock，也不要整份取我们的版本（会把 registry 地址等噪音带回来）。

```bash
git show main:package-lock.json > package-lock.json
npm install --package-lock-only --registry https://registry.npmjs.org
```

校验「相对上游只有新增」：

```bash
git show main:package-lock.json > /tmp/base-lock.json
diff -u /tmp/base-lock.json package-lock.json | grep '^-' | grep -v '^---'   # 必须为空
```

- 若当前 npm 版本会删掉上游 lock 里的字段（例如 `@img/sharp-*`、`@next/swc-*` 的 `libc`），用脚本把这些字段按上游原样补回，让 diff 回到纯新增。
- 不改动 `node_modules/`，不提交 `.next/`。

## 阶段 4：测试与文档

- 上游删掉、但覆盖我们自有功能的测试文件 → 保留；把断言里「上游已删除的调用」改成仍存在的等价位置，并在汇报里注明。
- 上游重写过的测试文件 → 取上游版，只回填我们自己的断言（必要时把依赖旧结构的断言改成自读源码的形式，让它独立成立）。
- 文档（`AGENTS.md`、`docs/agents/*.md`）：上游改过的文字取上游，把我们的条目补回。
- 发现重复或已失效的文档条目（同一文件在清单里出现两次、描述指向已删除的代码）→ **报告给我**，不要顺手清理。

## 阶段 5：验证

```bash
node_modules/.bin/tsc --noEmit
npm run lint
npm test
```

- 有失败先判断是不是环境性的：只读 `HOME` 会让需要写 `~/.pi/agent/*.lock` 的测试报 `EROFS`。用可写临时 HOME 单独复跑该文件证明：

```bash
TMPH=$(mktemp -d) && mkdir -p "$TMPH/.pi/agent"
HOME=$TMPH node --experimental-strip-types --test <file>; rm -rf "$TMPH"
```

- 顺手跑一遍本次改动涉及的自有测试文件（PlantUML、searchExclude、session-title、subagent、worktree 等）。
- 不要在已有 dev server 跑着的时候再起一个 `next dev`（端口与 `.next/dev/lock` 冲突）；本机端口被占且无法确认归属时，以 typecheck + lint + 测试作为验收依据，并说明这一点。

## 阶段 6：汇报

用中文，包含：

1. 一张表：`文件 | 冲突类型（A–E） | 处理方式 | 依据（我们的哪条 / 上游哪个提交）`。
2. 与上游不同、**需要我拍板**的项（规则 3 的候选），每条给选项和影响面。
3. 验证结果：tsc / lint / 测试通过数；失败项的判定（环境性 or 代码问题）。
4. 备份分支名与最终提交清单（`git log --oneline main..custom/main`）。
5. 推送命令（不执行）：

```bash
git push --force-with-lease origin custom/main
```

6. 发现但未擅自处理的遗留问题（重复文档条目、上游新增了与我们功能重叠的实现、测试里被放宽的断言等）。

## 附：安装为 pi 命令

```bash
mkdir -p ~/.pi/agent/prompts
cp docs/prompts/rebase-upstream.md ~/.pi/agent/prompts/rebase-upstream.md
```

之后在 pi 里输入 `/rebase-upstream` 即可；改过模板后执行 `/reload`。
