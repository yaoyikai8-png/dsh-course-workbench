# AGENTS.md — 给接手这个仓库的会话

这是一个 **DSH（DeepSeek Harness）bundle**：侧边栏「课程」面板 + 三条斜杠命令 + 五个技能 + 一个
Markdown→PDF 转换器。改之前请先读完本文件，下面几条是踩过坑才定下来的，改了就会出事。

## 文件地图

| 路径 | 是什么 | 改完怎么生效 |
|---|---|---|
| `index.js` | **Host 半边**：`/dsh-course-workbench/*` 路由、三条斜杠命令、状态文件读写 | 要在 DSH 里 disable→enable 插件 |
| `client.js` | **Web 半边**：侧边栏入口 + 面板，`ctx.slots.register` 渲染 | 存盘即热更新（rev 自动 bump） |
| `cordis.patch.yml` | bundle 默认配置，`courseRoot` 是**占位路径** | 用户在自己的 profile 补丁里覆盖 |
| `skills/*/SKILL.md` | 五个技能，`install.ps1` 拷到 `~/.dsh/skills/` | 重跑 `install.bat` 或手动拷 |
| `tools/md2pdf.py` | 纯 Python 的 md→pdf（fpdf2 + 系统黑体） | 拷到 `~/.dsh/tools/` |
| `smoke-client.mjs` | 无头测试：桩掉 React 和 Cordis 上下文跑面板 | `npm run check` |
| `docs/` | README 用的截图 | — |

## 不许回退的行为（有测试守着）

1. **产物只有 Markdown + PDF**，写进 `<课程目录>/<课程名>笔记和复习/`。早期产出过 docx，已经废掉，别加回来。
2. **「打开课件」只浏览，不许注册 DSH 工作区。** 只有真正要干活（生成笔记 / 期末复习 / 提问）才
   `workspaces.create()`。用户明确抱怨过「看一眼课件侧边栏就多一个工作区」。
3. **每门课一个会话**，名字是 `<课程名> 笔记问答和期末复习`。
4. **`courseRoot` 只能来自配置**，仓库里那份必须是占位路径，不许写死某个人的目录。
5. **技能文件里不许出现绝对路径**，一律「由 `courseRoot` 决定，以会话工作目录为准」。

`smoke-client.mjs` 断言了第 1、2 条；改动这两块时先跑测试。

## 验证

```powershell
npm run check        # node --check 两个半边 + 无头冒烟测试
```

插件装好后还可以直接打 HTTP：

```
GET  /dsh-course-workbench/diagnostics   → {ok, packageId, rev, commands}
GET  /dsh-course-workbench/overview      → {root, roots[], courses[]}
POST /dsh-course-workbench/generate      → {coursePath, files[], mode}
```

参考实现见仓库根目录之外的 `C:\Users\Lenovo\Documents\dsh-dailywork\scripts\`（作者本机脚本，未入库）。

## 坑

- **`.bat` 必须是 CRLF**。写成 LF 会让 cmd 按字节截断中文，报一堆 `'rse-workbench' is not recognized`。
  `.gitattributes` 里已经锁了 `*.bat text eol=crlf`，git 存 LF、检出 CRLF 是正常的。
- **client.js 热更新，index.js 不热更新**。改 index.js 后要 `plugin_manager set_plugin enabled=false/true`
  走一轮，用户还要硬刷新 `Ctrl+Shift+R`。
- **push 需要凭据**。本机凭据在 Windows 凭据管理器里，沙箱下读不到，要用完整权限执行 git。
- **GitHub 直连不稳**。先 `Test-NetConnection github.com -Port 443`；不通就开代理，需要时用
  `git -c http.proxy=http://127.0.0.1:7897 push`（**不要**写进 `.git/config`，代理一换就卡死）。
- **PDF 只认 Markdown 子集**：标题、段落、列表、表格、`**粗体**`、行内代码、代码块、引用。
  HTML / 脚注 / mermaid / 图片语法会被当纯文本打出来，技能里都避开了。
- **截图脱敏**：`docs/panel.png` 里的学号和真名是手动遮掉的。换截图前先检查有没有个人信息。

## 发版

```powershell
# 1. 改 package.json 版本号
git add -A; git commit -m "..."
git push origin main
# 2. 建 Release（zip 会自动带上当前 commit），脚本见 dsh-dailywork/scripts/release-*.py
```

用户分享时发 `https://github.com/yaoyikai8-png/dsh-course-workbench/releases/latest`，不要发具体 tag 号。
