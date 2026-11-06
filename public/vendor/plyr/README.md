# Plyr（第三方开源播放器）

粗剪预览里的视频段落用 Plyr 提供播放器控件（播放/暂停、进度拖动、时间、音量、画中画、全屏）。

- 项目：https://github.com/sampotts/plyr
- 版本：3.8.4
- 许可：MIT（全文见同目录 `LICENSE`，`Copyright (c) 2017 Sam Potts`）
- 来源：npm 包 `plyr@3.8.4`（`https://registry.npmjs.org/plyr/-/plyr-3.8.4.tgz`）

落地的三个文件与包内路径的对应关系：

| 本项目文件 | 原文件 | 说明 |
| --- | --- | --- |
| `plyr.min.js` | `dist/plyr.min.js` | UMD 构建，浏览器里暴露全局 `Plyr` |
| `plyr.css` | `dist/plyr.css` | 控件样式，可由 CSS 变量覆盖 |
| `plyr.svg` | 官网 `https://cdn.plyr.io/3.8.4/plyr.svg` | 图标精灵；`iconUrl` 默认指向 CDN，本项目改指本地路径以离线可用 |

本目录只做「原样落地 + 本地化图标地址」，没有修改 Plyr 自身代码。升级时按上表重新取三个文件，并同步 `public/app.js` 里的版本说明。
