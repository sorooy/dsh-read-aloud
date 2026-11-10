# 提交到「Awesome DSH Plugin」收录列表

`awesome-dsh-plugin.yml` 是准备好的一条目录条目，供向上游列表开 PR 使用。

## 上游规则（实测，来自清单仓库 contributing.md）

| 要求 | 本项目现状 |
| --- | --- |
| 仓库必须托管在 **GitHub**，`url` 与仓库路径完全一致 | ❌ 目前只在 Gitee（Gitee 上 `op00007/dsh-read-aloud` 的镜像位置：`dsh-minimax-autoread`） |
| 仓库需打上 `dsh-plugin` topic（GitHub 功能） | ❌ 同上，需 GitHub 仓库 |
| 仓库创建满 **1 天** 以上 | — |
| `package.json` 里声明 `dsh.bundle` 清单 | ✅ 已有 `dsh.bundle.patch` |
| 可选：发布到 npm 以获得版本号与下载量排序 | ❌ 尚未发布 |

> 目录索引（`dsh-plugin-catalog`）当前 4985 条，**仓库主机 100% 为 github.com，非 GitHub 条目为 0**。
> 也就是说：只有 Gitee 仓库无法进入这个市场。

## 提交步骤（需要 GitHub 账号与可访问 github.com 的网络）

1. 把本仓库镜像到 GitHub，仓库名建议与包名一致：`dsh-read-aloud`。
2. 在 GitHub 仓库设置里添加 topic：`dsh-plugin`。
3. Fork [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
4. 复制本目录的 `awesome-dsh-plugin.yml`，把 `<owner>/<repo>` 替换成真实的 GitHub 路径。
5. 放到上游仓库的 `data/plugins/<owner>__<repo>.yml`（文件名用双下划线连接）。
6. 提交 PR，等待自动校验（会检查 `dsh.bundle` 清单、仓库年龄、topic）。

## 关于 npm

收录**不要求**发布 npm，但：

- 发布后市场能显示版本号与下载量，安装命令变成 `dsh plugin --profile desktop add dsh-read-aloud`；
- 目录索引只覆盖「npm 上有已知版本」的条目，只有 GitHub 仓库的条目仍可安装，只是没有版本信息。

发布命令：

```bash
npm login
npm publish --access public
```
