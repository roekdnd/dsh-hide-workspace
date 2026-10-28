# 代码审计 — 已知缺陷与故障场景

审计日期：2026-10-26。对象：`client.js`（仓库根目录）（约 980 行）。

功能已确认可用（隐藏/恢复/菜单/筛选/不卡死）。以下是**代码逻辑审计发现的缺陷**，
按严重程度排序，并标注修复状态。

**审计后已修复 7 项，明确保留 1 项（有技术理由）。最终 `node test/check-logic.mjs` 47 项全过。**

---

## 严重（会直接导致功能错误）

### D1. `menuOwnerRow` 从不失效 → 可能藏错工作区　✅ 已修复
`menuOwnerRow` 只在 `pointerdown` 命中工作区行或行内按钮时赋值，**之后永不清空**。

故障场景：
1. 点工作区 A 的 `⋯`（`menuOwnerRow = A`）
2. 关闭菜单
3. 用键盘或其他方式打开**别处**的菜单（不经过 pointerdown，或点在菜单外部）
4. 此时 `menuOwnerRow` 仍是 A，注入的「隐藏工作区」会把 **A** 藏掉，而不是你以为的那个

更隐蔽的一种：菜单是通过**不在工作区行内**的按钮打开的（比如以后 DSH 改了触发方式），
`menuOwnerRow` 保持上一次的值，菜单里会出现一行指向**错误工作区**的「隐藏工作区」。

### D2. 「联动重置」从未实现 → 两个筛选器叠加可能全空　✅ 已修复
我们讨论并在方案里写定了：

> 切到「仅显示已归档」时，自动把「筛选工作区」重置为「显示全部」

**代码里没有这段**（`grep archivedFilter` 只匹配到正则里的字面量）。
后果就是当时分析过的坑：

- DSH 在「仅显示已归档」下会把**没有归档会话的工作区从数据里整个丢弃**（`groupByWorkspace` L1040）
- 若此时工作区筛选又是「仅显示已隐藏」，而那个隐藏的工作区刚好没有归档会话
- → 列表全空，**且没有任何 `⋯` 可点**

空态提示有（`emptyStateHint`），所以不会永久锁死，但用户会看到一片空白。

### D3. `toggle()` 的语义与「有状态切换」不一致　✅ 已修复
当前实现：

```js
function toggle() {
  if (hidden.length > 0) { showAll(); return; }
  const id = selectedWorkspaceId();
  ...
}
```

故障场景：**隐藏列表为空、但筛选停在「仅显示已隐藏」**时按 `Ctrl+H`：
`showAll()` 走 `hidden.length === 0` 分支，只把 `filter` 改成 `show`——**没有任何提示**。
用户按了快捷键，界面可能只有细微变化，看起来像"没反应"。

---

## 中等（特定条件下出错）

### D4. `titleOf()` 可能取到错误文本　✅ 已修复
```js
const spans = [...workspaceRow.querySelectorAll('span')];
// 取"叶子 span 里最长的文本"
```
故障场景：
- 工作区标题很短（如「A」），而行的其他叶子 span 有更长的文本（如 `aria-label` 内容、
  或未来加入的时间/计数）→ 提示语里显示成错误的名字
- 工作区标题为空 → 返回空字符串，`|| id` 兜底成 UUID

影响：仅影响 toast 和命名，不影响隐藏行为本身。

### D5. `guardAnchors()` 的折叠态判定不可靠　✅ 已修复
```js
if (document.querySelector('[data-row-key^="session:"], [data-slot-error], input[type="search"]') != null) { reset; return; }
const region = document.querySelector('[data-row-key="empty"]')?.parentElement;
if (region != null && region.getBoundingClientRect().width === 0) { reset; return; }
```
故障场景：
- 侧栏折叠成 56px 轨道时，若**没有** `[data-row-key="empty"]` 元素（列表非空时就没有），
  第二个判定直接跳过
- 于是连续 4 次（约 4.8 秒）看不到工作区行 → **误判结构变化 → 清空隐藏列表**
- 用户在折叠态停留 5 秒再展开，隐藏全部丢失

### D6. `.closest('[role="treeitem"]')` 归属歧义　⚠️ 保留（见下）
`onPointerDown` 里用 `el.closest('[role="treeitem"]')` 找触发菜单的行。
故障场景：若点击的元素**同时**在会话行和工作区行的祖先链上（理论上不会，但嵌套工作区
模式下父子工作区都是 `role="treeitem"`），`closest` 返回的是**最近**的那个，
可能拿到子工作区而不是用户以为的父工作区。

---

## 轻微（不影响主要功能）

### D7. `SESSION_ROW` 常量未被使用　✅ 已修复
`const SESSION_ROW = '[data-row-key^="session:"]';` 定义了但没有任何引用（死代码）。

### D8. `anchorsPresent()` 与 `workspaceRows()` 重复　✅ 已修复
两个函数做同一件事，`anchorsPresent()` 只是 `workspaceRows().length > 0`。

### D9. 隐藏列表不做过期清理　❌ 已撤销修复（技术上不可靠）
工作区被**删除**后，它的 id 仍留在 `hidden` 数组里。
影响：数组无限增长（每次删工作区残留一条）；且若以后新建了同 id 的工作区会被误隐藏
（UUID 碰撞概率为零，实际无害）。

### D10. `findWorkspaceMenu()` 依赖中英文文案
靠 `/删除工作区|delete\.workspace/` 匹配。若 DSH 增加第三种语言，或改文案，
菜单注入失效（但**不会**破坏其他功能，`Ctrl+H` 仍可用）。

---

## 已经做到位的（审计确认无问题）

| 项 | 状态 |
|---|---|
| 存储读写有 try/catch | ✅ `safeGet` / `safeSet` 吞掉异常 |
| 隐藏状态与 DOM 解耦 | ✅ 状态在 localStorage，DOM 丢了重启也能恢复 |
| 渲染幂等（防死循环） | ✅ 每帧写入都有"值变了才写"检查 |
| 观察器不监听属性/文本 | ✅ 只看 childList |
| 渲染期间自我忽略 | ✅ `rendering` 标志 |
| `blockOf` 处理空工作区 | ✅ 按"是否含其他工作区行"判断，与会话无关 |
| 卸载时清理 | ✅ 移除 style/toast/empty、断观察器、清 interval |
| 失败开放 | ✅ 结构不符时清空隐藏并提示 |


---

## 修复明细

### D1 — 菜单归属改为实时解析
新增 `resolveMenuWorkspaceId()`，三重校验：行仍在文档内、记录未超过 10 秒、能解析出 id。
任一不满足就**不注入菜单行**（安全失败），而不是拿上次的值去藏错工作区。

### D2 — 联动重置已实现
新增 `readArchivedFilter(menu)`，通过 `aria-current="page"` 读官方菜单的当前选中项。
当官方处于「仅显示已归档」时，若工作区筛选不是「显示全部」，自动重置为「显示全部」。

### D3 — Ctrl+H 永远有反馈
- 有隐藏项 → 恢复全部
- 无隐藏项但筛选在限制 → 重置筛选并提示
- 无隐藏项、无选中会话 → 提示

任何一条都一定给出可见反馈。

### D4 — `titleOf()` 优先读标题元素
先找 `[data-hide-workspace-title]` 或 `[class*="title"]`，找不到才回退到
"最长的、不含 svg 的叶子 span"。避免将来行里多一个计数/时间就把名字取错。

### D5 — 折叠态判定改用尺寸
不再依赖 `[data-row-key="empty"]`（列表非空时它根本不存在），
改为测量侧栏容器的 `getBoundingClientRect()`：宽或高为 0 视为折叠，不作判断。

### D7 / D8 — 清理死代码
`SESSION_ROW` 常量（无引用）和 `anchorsPresent()`（与 `workspaceRows()` 重复）已删除。

### D9 — 撤销 DOM 清理（重要）
我最初加了"扫描现存行、删掉找不到的 id"的清理逻辑，**随后发现它不安全**：

- 在「仅显示已隐藏」筛选下，可见行**恰好就是**已隐藏的那些 → 判断会反转
- 在「显示全部」下，已删除工作区**也没有行** → 无法与"未渲染"区分
- 最坏情况：一次过滤视图就把整个隐藏列表删光

结论：**保留残留 id**。workspace id 是 UUID、永不复用，残留一条字符串的代价
远小于误删用户想保持隐藏的工作区。代码里写明了这个取舍。

### D6 — 为什么保留
`el.closest('[role="treeitem"]')` 理论上可能拿到子工作区而非父工作区。
但实测当前 DOM 下工作区行与会话行不会互为祖先，且修复它需要遍历祖先链判断
"哪个 treeitem 才是用户点的那一行"，在没有真实嵌套工作区样本前属于**过度设计**。
记为已知限制，等真出现嵌套工作区再处理。

---

## 剩余风险（无法在代码层消除）

| 风险 | 说明 | 缓解 |
|---|---|---|
| DSH 改 DOM 结构 | 选择器失配 | `guardAnchors()` 自动恢复全部显示并提示 |
| DSH 改菜单文案 | 菜单注入失效 | `Ctrl+H` 与视图选项仍可用 |
| nightly 更新频繁 | 需偶尔重新校准 | 失效时 fail-open，不会丢数据 |
| 隐藏列表不跨设备 | localStorage 本质 | 明确写在 README |


---

## 追加修复（视觉层）

### V1. toast 黑底黑字 + 压住输入框　✅ 已修复（两次尝试）

**第一次尝试（失败）**：把提示条从固定 `bottom:28px` 改到输入框上方，并"防御性地"
计算 `--dsw-alias-bg-module-platform` 与 `--dsw-alias-label-primary-foreground` 的对比度。
结果仍是黑底黑字——因为我在浅色主题下把填充色解析成了深色，而前景 token 也解析成深色。

**根本原因**：我自己发明了配色。`--dsw-alias-label-primary` 在浅色主题下是**深色墨**，
把它配在深色填充上必然不可读。

**正确的修法**：官方本来就有一对专用 token，且两种主题下都成对正确：

```css
background: var(--dsw-alias-toast-bg);
color:      var(--dsw-alias-toast-label);
```

并在源码 `_toast_l6cvn_6` 里确认了官方 toast 的真实样式：
`position: fixed; top: 40px; left: 50%; transform: translateX(-50%)`，
用的是 `--dsw-radius-lg`、`--dsw-shadow-lv3`、`font-size: 14px; line-height: 22px`。

于是直接照抄官方：**位置放到屏幕顶部**（top: 40px），彻底避开输入框，
配色也用官方 token。这样既解决了可读性，也和产品自身的 toast 一致。

同时删掉了因此不再需要的 composer 定位逻辑（包括一个残留的 `onResize` 引用，
它会导致 ReferenceError）。


---

## V2. 「撤销」按钮文字看不清　✅ 已修复

截图确认：提示条底色和文字正常了，但 **「撤销」几乎看不见**。

原因：我用了 `--dsw-alias-label-primary-bluish`，它在浅色主题下解析成偏灰的颜色，
压在深色 toast 上对比度不足。

查官方 toast 原语的 CSS 后确认，官方 action 用的是：

```css
._action { color: var(--dsw-static-deepseek-400); margin-inline: 3px; }
```

`--dsw-static-deepseek-400` = **#7aaaff**，是**静态品牌蓝**，不随主题变化
（这正是它叫 `static` 的原因）。改用它之后两种主题下都清晰。

同时把 action 的完整样式对齐官方：`display:inline`、`padding:0`、`border:0`、
`background:none`、`font:inherit`、`cursor:pointer`、`margin-inline:3px`。

至此 toast 的容器与 action **都直接照抄官方 toast 原语**，只有两处有意不同：
- `z-index` 更高（确保盖住其他浮层）
- `pointer-events:auto`（官方容器是 `none`，但这里需要能点「撤销」）

### 教训
配色相关的 bug 连续出了两次（黑底黑字、撤销看不清），两次都是**我自己发明颜色**。
官方每个 UI 元素都有对应的 token，且成对设计好对比度；照抄永远优于自创。


---

## V3. 缺分隔线、文字缩进未对齐　✅ 已修复

截图确认：新增的「筛选工作区」段**没有分隔线**，且三行文字比上面几段**略向右偏**。

### 分隔线
官方 `._separator_4ub78_80` 的实际样式是：

```css
height: .5px; margin: 3px 2px; background: var(--dsw-alias-border-l2);
```

我第一版从菜单里找 `role="separator"` 的元素去克隆，但**没找到**（不同构建/组合下
分隔线可能只带哈希类名），于是整段没有线。

现在的做法：
1. 先按 `role="separator"` 找，再按 `[class*="separator"]` 且无文本找
2. 找到就读它的 `getComputedStyle`，把 `height` 和 `backgroundColor` **实测值**复制过来
3. 找不到就直接写死官方那三行声明作为兜底

用计算样式而不是类名，是为了不受每版本哈希变化的影响。

### 缩进对齐
官方菜单行结构是 `[图标 span][文字 span][勾选]`，且 `item` 有 `gap:6px`。

我原来把行内**所有 svg 都删掉**，但图标 span 还在——看似没问题。
真正的问题是：如果删掉的是 `span` 本身，文字就会左移，和上面几段对不齐。

现在改为**只删 svg、保留 span 外壳**，这样图的宽度占位还在，文字起始 x 与
「隐藏已归档」「全部对话」完全一致。

小标题字号也从自写的 `12px` 改为官方的 `11px / line-height 15px / label-tertiary`。


---

## V4. 新增的三行缺少图标　✅ 已修复

截图确认：分隔线、对齐、字号都对了，但「筛选工作区」下三行**没有图标**，
而上面「筛选会话」的三行都有。

原因：我在做缩进对齐时把行内 `<svg>` 删掉了，却**没有补上对应的图标**。

修法：从官方「筛选会话」那一组里按语义取图标克隆过去，不自己画：

| 本插件行 | 取的官方图标来源 | 语义 |
|---|---|---|
| 隐藏已隐藏的工作区 | 「隐藏已归档」的图标 | 划掉的眼睛＝隐藏 |
| 全部工作区（显示已隐藏） | 「全部对话」的图标 | 队列/列表＝全部 |
| 仅显示已隐藏 | 「仅显示已归档」的图标 | 单项归档＝只显示 |

这样图标形状、尺寸、颜色都与上一段完全一致，也不受版本哈希影响。

另外给图标采样加了保护：**跳过我自己的注入行**，避免第二次渲染时从自己身上取图标
（那样会取到空，导致图标消失）。


---

## V5. 三行全是选中态、第一个还双勾　✅ 已修复

截图确认：「筛选工作区」下三行**全部带勾**，且第一行有两个勾。

### 根因
我把「隐藏已归档」这一行当作克隆模板，而它**当时正好是选中项**，自带官方的勾选元素。
于是三行克隆都继承了一个勾；选中行又被状态逻辑加了一个 → 双勾。

### 修法（两层）
1. **换模板**：克隆前先筛出**未选中**的归档筛选行（`aria-current !== 'page'`），
   从干净的源复制，勾在源头就不存在，而不是事后删。
2. **保险**：克隆后仍然显式清掉任何 `[class*="check"]` / `[data-hide-workspace-tick]`，
   防止未来版本用别的方式标记选中。

### 顺便加固
- `sampleTick` 的查找范围放宽到 `[class*="check"|"tick"|"Check"]`（无法确定官方 tick 是
  `<svg>` 还是 `<span>` 外壳），并且**只从选中行取**、**跳过自己注入的行**。
- 若真的取不到官方 tick，回退到自绘的小 SVG 勾，保证选中行**不会静默丢失标记**。

### 测试同步修正
自绘 tick 让每帧代码段多了一次 `appendChild`，测试因此报红。核查后确认这两次插入
都在 `if (selected && !hasMark)` 内，且分支末尾会把 `ticked` 置为 `'1'`，**只能执行一次**，
不存在循环。测试判定已更新为检查"单次状态翻转"这个真正的不变量。


---

## V6. 勾比官方的更深/更粗　✅ 已修复

截图确认：三行里只有一个勾了（数量对了），但**这个勾看起来比上面的重**。

### 根因
我自绘的备用勾和官方不是同一套参数。官方图标的真实定义（从 bundle 里读出来的）是：

```jsx
<svg viewBox="0 0 16 16" fill="none" strokeWidth={1}>
  <path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344
           6.95426 11.7018L13.75 4" stroke="currentColor"/>
</svg>
```

而我写的是 `stroke-width: 1.6` 和另一条路径 `M3 8.5l3.2 3.2L13 4.8` ——
线更粗、角度更陡，视觉上就"更深"。

### 修法
1. 备用勾**完全照抄**官方的 `strokeWidth: 1` 和那条精确路径
2. 补上官方勾的容器规则：`flex: none`（缺了它 svg 会被 flex 压扁，视觉上更粗）
   和 `color: var(--dsw-alias-label-primary)`

### 更根本的一步
真正该做的是**优先复用官方勾**而不是自绘。原来查找只扫"选中行"，且用 `querySelector`
查后代——但 `aria-current` 可能挂在行包裹层上，`querySelector` 也匹配不到元素自身，
所以经常取不到、只好走备用自绘。

现在改为**扫描整个菜单**里的 `[class*="check"/"tick"/"Check"]`，跳过自己注入的行，
并校验它确实是 svg 或含 svg。备用自绘只在真的找不到时才启用。

---

## D11. 「全部工作区（显示已隐藏）」等同于「隐藏已隐藏的工作区」　✅ 已修复

**这是三态筛选里唯一一个真正失效的分支。**

`applyHidden` 原本这样判定每一行是否要隐藏：

```js
const hide = filter === FILTER_ONLY ? !isHidden : isHidden;
```

三个模式的语义本应是：

| filter | 应该隐藏谁 |
|---|---|
| `hide`（默认） | 隐藏那些**已隐藏**的 |
| `show` | **谁都不隐藏** —— 让已隐藏的回到视野里，才有机会取消隐藏 |
| `only` | 隐藏那些**没被隐藏**的 |

但这个三元只特殊处理了 `only`，`show` 落进 `:` 分支拿到 `isHidden`，
**和 `hide` 完全相同**。

故障表现：选「全部工作区（显示已隐藏）」后，已隐藏的工作区仍然不出现。
而「仅显示已隐藏」工作正常，所以从界面上看三项都有勾选状态、都能点，
唯独中间那项点了没反应 —— 恰恰是唯一用来**找回**隐藏项的模式。
连带影响：`Ctrl+H` 之外，用户失去了从菜单恢复的路径；
`syncFilterMenu` 里那条 `archivedFilter === only && filter !== FILTER_SHOW` 的
自愈逻辑也因此永远不可能触发。

### 修法

把三个模式**分别写出来**，不要靠三元折叠：

```js
let hide;
if (filter === FILTER_SHOW) hide = false;
else if (filter === FILTER_ONLY) hide = !isHidden;
else hide = isHidden;
```

### 为什么之前 37 项测试没抓到

原来的测试全是**对源码做正则匹配**（`ok(/.../.test(src))`），只能验证
"这行代码长什么样"，无法验证"这个函数算出来的结果对不对"。
而 `const hide = filter === FILTER_ONLY ? !isHidden : isHidden;` 这一行
在结构上毫无破绽，正则永远通过。

### 补的测试

新增三项**行为测试**：把 `applyHidden` 用 `new Function` 注入假 DOM 真实执行，
断言三种模式各自留下的可见集合：

| filter | 期望可见 |
|---|---|
| `hide` | `BBB,CCC` |
| `show` | `AAA,BBB,CCC` |
| `only` | `AAA` |

并已在修复前复现失败（`show` FAIL），修复后转为 PASS —— 确认测试确实咬得住。

### 顺带修好的测试基础设施

写这组测试时暴露出假 DOM 的两处缺口，不补的话测试本身就是假的：

1. **`querySelectorAll` 不认识 `[attr]` 这种纯属性选择器**，一律返回 `[]`。
   而 `applyHidden` 正是靠 `document.querySelectorAll("[" + HIDDEN_ATTR + "]")`
   清理上一轮留下的标记 —— 认不出来，标记就永远残留，后续每一轮的计算都建立
   在脏状态上。
2. **`style.setProperty` 是空实现**，`style.display` 永远是 `undefined`，
   插件里那句 `if (el.getAttribute(HIDDEN_ATTR) === "1" && el.style.display === "none") continue;`
   因此永远走不到跳过分支。现已改为真实记录属性值。
