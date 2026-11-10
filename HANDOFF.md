# GitHub 上传交接说明

给帮忙上传的人/代理看的一页纸。**只做"推送 + 加 topic"，不要改代码、不要改包名。**

## 1. 要推的是什么

| 项 | 值 |
| --- | --- |
| 源目录 | `D:\所有缓存文件\日常\dsh-read-aloud` |
| Git 分支 | `main` |
| 当前 HEAD | `01de74d`（feat: skip code and links when speaking） |
| 未提交改动 | 无 |
| 仓库体积 | 工作区 0.1 MB，`.git` 0.2 MB，共 13 个跟踪文件 |
| 包名 / 版本 | `dsh-read-aloud` / `0.5.0` |
| 许可证 | MIT |
| 现有 remote | 只有 `origin` → `git@gitee.com:op00007/dsh-minimax-autoread.git`（Gitee 是主库，**不要动它**） |

## 2. 目标仓库

| 项 | 要求 |
| --- | --- |
| 名称 | **`dsh-read-aloud`**（必须与收录条目的 `url` / `name` 完全一致） |
| 可见性 | **Public** |
| 初始化 | **全部不勾**（README / .gitignore / LICENSE 都不要，否则 push 会被拒） |
| 地址 | `https://github.com/<GITHUB_USER>/dsh-read-aloud` |

## 3. 推送命令

```bash
cd /path/to/dsh-read-aloud
git remote add github git@github.com:<GITHUB_USER>/dsh-read-aloud.git
git push github main
```

用 HTTPS 时把地址换成 `https://github.com/<GITHUB_USER>/dsh-read-aloud.git`。

### 如果用 SSH

本机已配好 `Host github.com` → `~/.ssh/gitcode_logseq`，公钥如下（可以公开）：

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILo9eUzsX0IHC5Ry5pVRdHBNpgbh9JU+F8YRF5CKq2pO
```

需先加到 GitHub → Settings → SSH and GPG keys。

## 4. 推送后必做

1. 仓库 **Settings → Topics** 添加 `dsh-plugin` —— 这是收录列表的自动校验项，缺了 PR 会被拒。
2. 仓库保持 **Public**。

## 5. 不要做的事

- ❌ 不要改 `package.json` 的 `name`（收录条目与它绑定）
- ❌ 不要用 README 初始化仓库（会产生 non-fast-forward 冲突）
- ❌ 不要 force push 到 `origin`（Gitee 主库）
- ❌ 不要顺手改 `homepage` / `repository` 字段——它们目前**有意**指向 Gitee；需要改成 GitHub 的话先确认

## 6. 收录到插件市场（仓库满 1 天后）

上游要求仓库创建满 **1 天**才能提交。之后：

1. Fork [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
2. 新建文件 `data/plugins/<GITHUB_USER>__dsh-read-aloud.yml`
3. 内容（把 `<GITHUB_USER>` 换成真实用户名）：

```yaml
url: https://github.com/<GITHUB_USER>/dsh-read-aloud
name: <GITHUB_USER>/dsh-read-aloud
category: voice
description:
  en: Reads DeepSeek Harness replies aloud with MiniMax voices, with a per-message speaker button, optional auto-read and barge-in when you send a new message.
  zh: 用 MiniMax 音色朗读 DeepSeek Harness 的回复，每条回复一个喇叭按钮，支持每轮自动朗读与发消息立即打断。
```

4. 开 PR，等待自动校验（会检查 `dsh.bundle` 清单、仓库年龄、`dsh-plugin` topic）。

已存在的同分类竞品参考：`dsh-chatvoice`、`dsh-fish-tts`、`@goodandready/dsh-tts`、`@memef1f1y/dsh-plugin-tts`。

## 7. 可选：发布 npm

收录不要求 npm，但发布后市场能显示版本与下载量，安装命令变成 `dsh plugin --profile desktop add dsh-read-aloud`。

```bash
npm login
npm publish --access public
```

## 8. 自查

```bash
git ls-remote https://github.com/<GITHUB_USER>/dsh-read-aloud   # 应有 refs/heads/main
curl -sI https://github.com/<GITHUB_USER>/dsh-read-aloud | head -1   # 期望 200
```

完成标准：远端 `main` 指向 `01de74d`（或其后提交），仓库公开，带 `dsh-plugin` topic。
