Nibble 桌面伴生版 · Linux
=========================

一、怎么跑起来

  0. 先确认架构对得上：文件名后缀 aarch64 = ARM64（飞腾 / 鲲鹏等），x86_64 = Intel / AMD。
     装错架构会在启动时直接报 Exec format error，换对应架构的包即可。

  1. 解压（文件名以实际拿到的为准）：
       tar -xzf nibble-desktop-0.4.0-*.tar.gz

  2. 进入解压出来的那个目录并运行：
       cd nibble-desktop-0.4.0-*
       ./nibble

  两种常见的启动问题：
   · 提示 Permission denied —— 解压时丢了可执行权限，补一下即可：
       chmod +x nibble
   · 提示沙箱相关错误（SUID sandbox / chrome-sandbox）—— 二选一：
       ./nibble --no-sandbox
     （最省事，跳过 Chromium 沙箱；本程序不加载任何外部网页，风险很低）
       sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
     （保留沙箱，需要管理员密码，设置一次即可）


二、首次运行必须知道的三件事

  1. 必须在 X11 会话下使用。
     Nibble 通过 X11 的 XRecord 扩展读取键盘（只看空格与回车），
     Wayland 出于安全设计不允许任何程序监听全局按键，所以 Wayland 会话下敲键盘不会有反应。
     做法：注销 → 登录界面右下角的会话菜单里选「X11」或「Ubuntu on Xorg」→ 重新登录。
     若当前会话是 Wayland，启动时会弹窗提示，托盘菜单里也会长期保留一条
     「⚠️ 键盘监听不可用（点这里看原因）」入口。

  2. 系统需要 X11 运行库：libX11、libXtst、libXinerama（绝大多数带桌面的发行版自带）。
     缺少时程序不会崩溃，但敲键盘不会触发攻击，原因同样在托盘的那条入口里能看到。

  3. 程序是常驻托盘的：关掉窗口不会退出，退出请用托盘菜单最下面那条「退出 Nibble」。
     如果系统托盘里看不到它（少数没有 AppIndicator 的桌面环境），悬浮窗会一直留在桌面上，
     此时用系统监视器结束 nibble 进程即可。


三、放心用 / 别期待

  · 只监听空格与回车两个按键，用来驱动攻击；不记录其他按键、不拦截、不联网、无任何统计上报。
  · 数据目录：~/.config/Nibble（存档 save/、配置 config.json、按键统计 keystats.json）。
  · 不做窗口透明度：Electron 在 Linux 上没有实现 setOpacity，所以界面上不提供相关入口。
  · 不提供「开机自启」：需要的话请自行配置 ~/.config/autostart/。
  · 攻击频率与 Windows 版一致：空格 / 回车每敲一次算一次攻击，长按自动重复只算一次。


四、卸载

  删除解压出来的目录，再删掉 ~/.config/Nibble 即可，不留其他痕迹。
