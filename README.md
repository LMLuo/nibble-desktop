# Nibble Desktop

[nibble](https://github.com/LMLuo/nibble) 的 Windows 桌面伴生版：**在任何地方敲下空格 / 回车，桌面上那只像素小生物就会向野生 Bug 发动攻击。**

IDE 扩展版是「提问即攻击」，这一版把节拍交给你敲的每一个键 —— 写代码、聊天、搜索，攻击一直都在。

## 特性

- **战斗舞台恒定 + 弹出式面板**：悬浮窗永远是小挂件（像素场景随怪物档位换主题）；点武器库/怪物库 → 在悬浮窗**正上方弹出正常比例面板**（900×660，带关闭按钮），关掉即回舞台
- **全局键盘监听**：空格 / 回车 = 攻击一次。只观察、不拦截 —— 正常打字完全不受影响；最小间隔默认**无限制**，托盘可切 3 / 5 / 10 / 15 秒档位 + 长按去重
- **透明度 1~100 自定义**：托盘「透明度调节…」弹出小滑条窗拖动，或悬停悬浮窗滚轮微调
- **按键统计（悬浮日志）**：空格/回车按天计数，日志行常驻计数器 + 近 7 天明细
- **鼠标轨迹**：托盘「鼠标轨迹…」查看当天的发光热力图（越常去越亮）+ 移动路径细线 + 点击亮点，可切换近 7 天
- **全局键盘监听**：空格 / 回车 = 攻击一次。只观察、不拦截 —— 正常打字完全不受影响；最小间隔四档可调（3/5/10/15 秒，托盘切换）+ 长按去重，防止把怪秒掉
- **完整继承 nibble 收集玩法**：40 只「编程 Bug」怪物（遭遇 / 击败图鉴）、80 把带故事的武器（掉落 / 保底 / 装备 / 战力）、连击系统（10 分钟窗口，≥50 连超载演出）
- **独立存档**：与 IDE 扩展互不读写，本机从零开始养
- **托盘管理**：打开面板 / 直达武器库 / 怪物库 / 攻击一次 / 悬浮窗显隐 / 攻击间隔 / 开机自启 / 退出；首次启动自动打开面板引导上手
- **零联网**：没有统计、没有上报、没有更新检查

## 使用

下载 Release 里的 `Nibble-Portable-x.y.z.exe`，双击即用（免安装）。

| 操作 | 效果 |
| --- | --- |
| 敲空格 / 回车 | 攻击一次（任意程序里都算） |
| 点小生物 / 「武器库」「怪物库」按钮 / 武器槽 | 悬浮窗上方弹出面板（对应页） |
| 面板标题栏「─」或菜单里的「战斗」 | 关闭面板，回到战斗舞台 |
| 按住窗口任意位置拖动 | 移动悬浮窗（位置自动记住） |
| 悬停悬浮窗滚动滚轮 | 调窗口透明度（每格 5%） |
| 悬停 HUD | 查看战绩（攻击 / 击败 / 连击） |
| 托盘右键 | 打开面板 / 直达（攻击一次 · 武器库 · 怪物库）/ 显示悬浮窗 / 置顶 / 透明度调节… / 按键统计… / 鼠标轨迹… / 暂停键盘攻击 / 攻击间隔 / 开机自启 / 关于 / 退出 |

## 从源码运行

```bash
npm install
npm start
```

## 打包便携 exe

```bash
npm run dist
# 产物：dist/Nibble-Portable-<version>.exe
```

## 打包 Linux 包

```bash
# 在 Linux / CI 上（能顺带产出单文件 AppImage）
npm run dist:linux
# 产物：dist/Nibble-<version>-x86_64.AppImage + dist/nibble-desktop-<version>.tar.gz

# 在 Windows 上（AppImage 要用到 Linux 的 mksquashfs，做不出来；只出 tar.gz）
npm run dist:linux:tgz
```

Windows 上打 tar.gz 走 `scripts/pack-linux-tgz.js`，不是 electron-builder 自带的 tar.gz target：Windows 的 NTFS 没有 POSIX 权限位，打出来的包所有成员都是 `0644`，用户在 Linux 解压后 `./nibble` 会直接 `Permission denied`；脚本改用 GNU tar 的 `--mode` 在创建时强制写入权限位（依赖 Git for Windows 自带的 GNU tar）。

Linux 版与 Windows 版的运行时差异（都已在代码里处理，改动集中在 `main.js` 顶部那段平台开关）：

| 差异 | 处理 |
| --- | --- |
| 全局按键监听走 X11 的 XRecord | Wayland 会话下收不到按键：首次启动弹窗说明，托盘中长期保留「⚠️ 键盘监听不可用」入口（`libXtst` 等运行库缺失同理） |
| Electron 在 Linux 上未实现 `setOpacity` | 透明度相关 UI（滚轮 / 标题栏滑条 / 托盘项）整体隐藏，不给「拖了没反应」的假滑条 |
| `setLoginItemSettings` 仅 macOS / Windows | 隐藏「开机自启」托盘项 |
| 托盘可能创建失败（缺 AppIndicator） | 强制让悬浮窗留在桌面上，避免变成看不见也退不掉的进程 |

交叉编译 arm64 时必须加 `-c.npmRebuild=false`（`npm run dist:linux:tgz:arm64` 已带）：`@electron/rebuild` 会尝试用 node-gyp 从源码交叉编译原生模块并直接报错，而 uiohook 本来是 N-API 预编译产物，不需要 rebuild。

⚠️ **已知限制：uiohook-napi 1.5.5 的 Linux 预编译产物不能用**。实测（`e_machine` + SHA256）：`prebuilds/linux-arm64/`、`linux-loong64/`、`linux-x64/` 三个文件**完全相同**，且都是 **x86-64** 二进制；它要求 **glibc ≥ 2.34**（官方 Electron 只要 2.25，见 `GLIBC_2.25` 引用）。后果：

- arm64 机器（飞腾 / 鲲鹏）上，Electron 本体能启动，但全局按键监听加载失败；
- Debian 10 底子的国产发行版（麒麟 V10 SP1、UOS，glibc 2.28）上，x86-64 也一样加载不了；
- 1.5.0 ~ 1.5.4 连 `linux-arm64` 预编译产物都不存在（只有 win32 / darwin）。

程序不会因此崩溃：走 `hookErr` 路径，首启提示 + 托盘长期保留「⚠️ 键盘监听不可用」入口。要真正可用，只能在目标机上从源码编译该模块，再替换

```
resources/app.asar.unpacked/node_modules/uiohook-napi/prebuilds/<平台>-<架构>/uiohook-napi.node
```

编译需要 `gcc` + `libx11-dev libxtst-dev libxinerama-dev`（N-API 头文件可从 Electron 的 node headers 取）。打包时 `build/` 已被排除（`!node_modules/uiohook-napi/build/**`）：`node-gyp-build` 的解析顺序是**先 `build/Release/` 再 `prebuilds/`**，Windows 上编译出来的 `build/Release/uiohook_napi.node` 若混进 Linux 包，会在 Linux 上被优先加载并失败。


## 隐私

- **不发送任何数据**：本应用没有任何联网代码，无统计、无上报、无遥测。
- 数据只存在本机 `%APPDATA%\Nibble\` 下（游戏存档、配置、悬浮窗位置）。
- **键盘敲击计数与鼠标轨迹**（后两者仅用于本机的「按键统计 / 鼠标轨迹」浮窗展示）：滚动保留最近 7 天、自动清理、**绝不上传**；鼠标轨迹只记录主显示器的量化坐标（移动每 250ms 采样、点击记录位置），不记录窗口内容、不截屏。
- 全局键盘监听基于系统低级钩子，**只读取键码（是否为空格 / 回车），不读取按键内容、不截图、不写任何日志**；托盘可随时暂停。

## 项目结构

```
main.js              主进程：键盘监听 → 攻击 → 状态广播；双形态窗口/托盘/自启
preload.js           单一宿主桥（acquireVsCodeApi 兼容层 + 悬浮窗穿透/展开/拖动桥）
overlay/             悬浮窗页面：#compact 紧凑舞台 + #full 完整面板（同页双形态）
lib/                 游戏核心（拷贝自 nibble 扩展，单一数据源）
media/               面板资产（pet.js + scene.js/css + 像素字体；panel.html 为上游参考副本）
```

## 许可

- 代码与文档：MIT
- 像素素材与游戏设定来自 [nibble](https://github.com/LMLuo/nibble)（主角像素形象 MIT，其余素材 CC0），许可口径与主项目一致
- 设计灵感致谢 [spinlings](https://github.com/416rehman/spinlings)
