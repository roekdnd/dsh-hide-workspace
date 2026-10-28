# dsh-hide-workspace — 隐藏工作区

语言：中文 | [English](README.md)

把暂时不需要的工作区从左侧栏收起来，随时恢复。不删除任何东西。

---

## 一、它做了什么

| 入口 | 行为 |
|---|---|
| 工作区行 `⋯` 菜单 → **隐藏工作区** | 整组（含子工作区与其会话）从侧栏消失 |
| 已隐藏的工作区 `⋯` 菜单 → **取消隐藏** | 放回来（该项文案自动切换） |
| 视图选项 → **筛选工作区**（三态） | 隐藏已隐藏 / 显示全部 / 仅显示已隐藏 |
| **Ctrl + H** | 无隐藏项 → 隐藏当前会话所在工作区；有隐藏项 → **恢复全部** |
| 隐藏后的 toast → **撤销** | 立即救回 |

被隐藏的工作区**仍然可以被搜索到**（搜索行不受影响），这是刻意保留的应急通道。

---

## 二、安装

本插件是一个 **bundle**，自带有 `cordis.patch.yml` 和 `dsh.bundle.patch` 声明，
所以它能出现在「设置 → 插件」面板里（有卡片、开关、卸载）。

### 方式一：从 GitHub 安装（推荐）

```sh
dsh plugin --profile desktop add github:roekdnd/dsh-hide-workspace
```

安装后**重启 DSH**。

### 方式二：从本地检出安装

```sh
dsh plugin --profile desktop add <本仓库的绝对路径>
```

安装后**重启 DSH**（新包首次可解析需要重启）。

改动 `client.js` 后刷新页面即可，源码无需构建——`client.js` 本身就是最终产物。

### 为什么不建议手改 profile

手改 `~/.dsh/profiles/desktop/cordis.patch.yml` + `pnpm add link:` 也能装，但有三个坑：

- 要走 `pnpm add link:`，别手写 node_modules 里的链接。
  实测 junction（`mklink /J`）在 Node 里同样满足 `isSymbolicLink() === true`，
  能正常工作；但让包管理器来建链接更稳妥，它同时会写进 lockfile。
- 走手改路线时插件**不会**出现在插件面板里（面板只管理 bundle）
- 官方明确说不要手写 profile 的 `package.json` / `cordis.patch.yml`，也不要自己跑 pnpm

---

## 三、数据存在哪

```
%USERPROFILE%\.dsh\... （不涉及）
浏览器 localStorage:
  dsh.hide-workspace.hidden.v1   ← 被隐藏的工作区 id 列表
  dsh.hide-workspace.filter.v1   ← 筛选工作区状态
```

**刻意不碰 `workspace.json`**。原因：它是 `dsh-workspace` 独占的存储域，
且其记录是 zod **strip 模式** —— 往里塞自定义字段会被**静默丢弃且不报错**。
用 localStorage 也符合 DSH 自身的边界：布局类偏好本来就是浏览器本地
（`ui-workspace` 自己的展开状态和会话排序就是存 localStorage 的）。

代价：**不跨设备同步**。同时在 Web 端和桌面端使用时会各有一份。

---

## 四、DSH 更新后会怎样（重要）

DSH 的界面会随版本变化。插件只依赖**显式字符串锚点**，不依赖任何哈希类名：

| 依赖对象 | 稳定性 |
|---|---|
| `data-row-key="workspace:<uuid>"` | 高（源码里写死的字符串，不是哈希） |
| `role="menuitem"` / `aria-selected` | 高 |
| 哈希类名（如 `XXXXXX_groupSection`） | **完全不依赖** |

### 自愈机制

插件每 1.2 秒做一次结构体检：**如果有隐藏项、但侧栏一条工作区行都渲染不出来**
（连续 4 次），就判定侧栏结构已变，此时：

1. **自动清空隐藏列表 → 全部恢复显示**（绝不让东西藏没了找不回来）
2. 弹出提示：「侧栏结构已变化，「隐藏工作区」暂不可用，已恢复全部显示。」

也就是最坏结果是**功能失效 + 用户能看见原因**，而不是**工作区凭空消失**。

### 如果自愈提示出现了

这条警告意味着侧栏 DOM 变了，选择器需要重新校准。
请带着提示内容开一个 [issue](https://github.com/roekdnd/dsh-hide-workspace/issues)，
并附上 DSH 版本号。最可能需要调整的是：

- 工作区行是否还是 `data-row-key="workspace:<id>"`
- 会话行是否还是 `aria-selected="true"`
- `⋯` 菜单是否还是 `role="menu"` + `role="menuitem"`

---

## 五、已知限制

1. **没有独立管理面板**。取消隐藏只能靠 `⋯` 菜单、`Ctrl+H` 或视图选项。
2. **不能右键工作区行**。DSH 没有工作区级菜单槽，右键菜单也没有注入点。
3. **隐藏模式下拖拽排序会不准**。被隐藏的组仍参与拖拽落点计算，
   对着看不见的兄弟节点拖会提交一个看不见的换序。隐藏期间请避免拖动排序。
4. **搜索仍能搜到已隐藏的工作区**（这是刻意的逃生通道）。
5. **「仅显示已归档」+「仅显示已隐藏」可能全空**。
   DSH 在"仅显示已归档"下会把没有归档会话的工作区整个不渲染，
   此时列表可能为空 → 会显示「当前筛选下没有工作区」+【显示全部工作区】按钮。
6. **树形模式**：隐藏父工作区会连子工作区一起隐藏（子行渲染在父块内部）。
7. **localStorage 被清空**（清除站点数据）后，隐藏列表会丢失，全部工作区重新显示。

---

## 六、自测

```
cd dsh-hide-workspace
node test/check-logic.mjs
```

47 项断言，零依赖（不需要 jsdom / Chrome），跑一次不到 1 秒：

- `blockOf` / `selectedWorkspaceId` 在真实同构节点树上解析正确（含有会话的工作区、
  **空工作区**、多工作区并列、会话归属）
- **防循环结构检查**：每帧执行的写入必须"值变了才写"、勾选靠状态属性切换、
  构建行必须由数量不符触发（因此不会每帧跑）

当前结果 **47 passed, 0 failed**。

完整缺陷清单与故障场景见 **`AUDIT.md`**。

### 实现上已修正的几个坑（都是实测发现的）

| 问题 | 原因 | 现在的做法 |
|---|---|---|
| 工作区行找不到 | 文件夹行被 `HoverCard` 包了一层，会话行是它的**兄弟**而非子节点 | 从会话行向上找“只含一个工作区行”的祖先 |
| 空工作区藏不掉 | 旧逻辑靠“有没有会话行”识别块边界 | 改为判断“是否含**其它**工作区行”，与会话无关 |
| 菜单项带边框、样式不一致 | 手搓 `<button>` 无法复现官方样式 | **克隆**官方「重命名」整行（普通行，天然无红色） |
| 菜单项是红色 | 克隆了「删除工作区」，它带 `_danger_<hash>` 类；按名字删类顶不住版本变化 | 改为克隆「重命名」行，并额外移除任何含 `danger` 的类 |
| 菜单文本匹配失效 | 只读了第一个 `<span>`，那是空的图标位 | 读整行 `textContent` |
| 「隐藏工作区」显示成原始 key | 从没注册 locale 字典 | 内联中英文字典并 `ctx.locale.register()` |
| 隐藏完全没生效 | 用 `requestAnimationFrame` 刷新，窗口不可见时不触发，标志位永久卡死 | 改用微任务调度 |
| **点「视图选项」整个界面卡死** | `MutationObserver` 监听整个 `body`，而每次渲染都写 DOM，写 → 观察 → 再写，无限循环 | 三重防护：①渲染期间加的 DOM 变更被忽略 ②所有写入改为"值变了才写" ③只监听节点增删，不监听属性/文本 |
| 筛选选项排成一行、带原生边框 | 直接 `createElement('button')`，没套用菜单行的结构 | 改为**克隆官方筛选行**（分隔线、小标题、行本身都克隆）|
| 选中项用 `✓` 字符，宽度会跳 | 官方是在末尾放独立图标位 | 复用官方的勾选元素，靠状态属性切换 |

---

## 七、为什么在 DOM 层做，而不是数据层

DSH 没有提供工作区级的扩展点，这一节记录实测结论（详见 `docs/research/`）。

### 没有可用的 slot

`sidebar.workspaces` 只声明了 **Session 级**的子 slot：

```
sidebar.workspaces
sidebar.workspaces.directoryFlow
sidebar.workspaces.session.menu.item      ← Session
sidebar.workspaces.session.row.action     ← Session
```

工作区行的 `⋯` 菜单和「视图选项」菜单都是**硬编码的闭合数组**，没有任何注入点。
本插件的两个入口因此是 DOM 注入的。

### 不能在数据层过滤

`groupByWorkspace()` 用传入的 `workspaces` 数组构建 `accounted` 集合，
再把没归属的会话收进「未分组」。所以**从一个工作区从列表里摘掉，它的会话会掉进「未分组」**，
变成一堆无主条目。

### 尝试过但不可行

| 方案 | 结果 |
|---|---|
| 用 `priority: -100` 覆盖 `sidebar.workspaces` | 会抛 `slot "<key>" is already declared`。省略 5 个子 slot 又会连带干掉会话菜单、悬停按钮和「添加工作区」流程。真要这么做等于 fork 约 4100 行 |
| `provideRoot({hooks:{workspaces}})` | 抛 `duplicate root standard hook`，`workspaces` 是 Cordis Service，重复注册直接报错 |
| 往 `workspace.json` 塞自定义字段 | 该记录是 zod **strip 模式**，多余字段**静默丢弃且不报错**（`tools/scratch/zod-strip-proof.mjs` 可复现） |

### 存储位置

隐藏集合是**设备本地的视图偏好**，存在 `localStorage`，
和 `ui-workspace` 自己持久化展开状态、会话排序的做法一致。

> 从旧版 `dsh-better-sidebar` 升级时，旧的 `dsh.better-sidebar.*` 键会被自动迁移一次，
> 已隐藏的工作区不会丢失。

---
## 八、文件结构

```
dsh-hide-workspace/
├─ package.json          dsh.bundle.patch + dsh.client 声明
├─ cordis.patch.yml      bundle 自带的挂载行
├─ index.js              host 半边（纯 UI 插件，故意为空）
├─ client.js             ← 全部逻辑
├─ icon.svg
├─ locale/{zh,en}.json   面板卡片文案
├─ test/check-logic.mjs  自测（不随包发布）
├─ docs/                 ← 调研与设计记录
│   ├─ research/         DSH 源码分析：打包、过滤可行性、持久化
│   └─ design/           方案讨论
└─ tools/                重新解包 DSH 的脚本（asar 本身不入库）
```

### package.json 的 `files` 只发布运行所需的 6 个路径

`index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`。
`docs/`、`tools/`、`test/` 留在仓库里供阅读，不会进入安装包。

---

## 九、License

MIT
