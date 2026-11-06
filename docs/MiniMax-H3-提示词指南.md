# MiniMax H3 提示词指南

查阅日期：2026 年 10 月 14 日。面向分镜资产工作台的创作者与维护者。

本文整理 MiniMax 官方提示词资料，并提供自行编写的示例。最重要的结论是：先区分多参考模式和首尾帧模式，再建立稳定的人物、声音和素材对应关系。**中文界面标题与模型提示词中的正式标签应分开处理。**本文中的排错建议与工作台对接说明属于项目建议，不代表已经实测的生成效果。

## 官方资料入口

| 资料 | 用途 |
| --- | --- |
| [MiniMax H3 官方仓库](https://github.com/MiniMax-AI/MiniMax-H3) | 确认模型、工作流和提示词资料入口 |
| [官方提示词技能说明](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md) | 确认模式选择、字段顺序和语言要求 |
| [基础与关键帧提示词指南](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt) | 文生视频、首帧、首尾帧、尾帧模式 |
| [多参考提示词指南](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt) | 主体定义、图片、视频、音频、对白与一致性 |

以上链接均为 MiniMax 官方仓库内容。本次未使用同名第三方站点作为技术依据，也未安装技能或接入新的生成服务。

## 选择提示词格式

官方将基础关键帧任务与全参考任务分开；它们的主体描述字段不同，不能直接混为一套格式。[依据：官方技能说明](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md)

| 模式 | 输入含义 | 提示词组织方式 |
| --- | --- | --- |
| T2VA | 用文字建立视频 | 三段式基础格式 |
| I2VA | 图片约束开场 | 首帧对齐说明加三段式 |
| FL2VA | 图片分别约束开场和结尾 | 首尾帧对齐说明加三段式 |
| L2VA | 图片约束结尾 | 尾帧对齐说明加三段式 |
| Ref2VA | 素材提供角色、场景、动作或声音参考 | 六段式多参考格式 |

### 基础模式三段式

| 正式字段 | 中文含义 |
| --- | --- |
| `integrated_multimodal_description` | 按时间顺序写画面、动作、镜头和同步声音 |
| `overall_soundscape` | 全片环境声与物理音效 |
| `non_diegetic_music` | 仅观众听到的背景音乐 |

首尾帧任务应写清中间如何变化并到达结尾，不能只描述两张静态图片。开场使用 `[Shot 1]`，后续切镜使用带时间的镜头编号。[依据：基础指南](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt)

### 多参考模式六段式

| 正式字段 | 工作台可显示的中文标题 |
| --- | --- |
| `subject_definitions` | 主体定义 |
| `summary` | 内容概述 |
| `retention_analysis` | 一致性要求 |
| `detailed_description` | 详细描述 |
| `overall_soundscape` | 整体声景 |
| `non_diegetic_music` | 非叙事音乐 |

正式输出保留上述字段顺序。主体、图片、视频、音频分别使用 `<Subject N>`、`<Picture N>`、`<Video N>`、`<Audio N>`，各自编号；不要根据编号相同就推断它们属于同一角色。[依据：多参考指南](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt)

## 中文标题与正式标签

官方技能要求保留字段名、标签和时间写法，并用英文组织描述，保留对白、歌词和可见文字的原语言。因此，中文标题可用于阅读界面；正式提示词中的 `<d>` 不应写成 `<对白>`，`[Chinese]` 不应作为官方写法翻译成 `[中文]`。中文化格式是否同样有效，需要另行验证。[依据：官方输出规则](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md)

工作台的“生成 H3 结构与运镜草稿”已使用上述正式字段及标签，并按首次发声顺序绑定说话人。它保留源素材中的中文描述，不会自动翻译成英文，因此仍是结构草稿；可交给 AI 整理英文描述，中文对白保留原文。旧版中文草稿不会被自动覆盖，需要在对应组中重新生成、核对并保存。

草稿还会补充未填写的运镜：开场小幅慢推建立空间，中段有位移动作时跟拍、静态交流时固定机位，结尾小幅慢推后停稳；已有明确运镜保留。跨镜头保持轴线、视线与人物左右关系。这是本项目的基础设计，不是依据画面分析得到的逐镜头导演方案；不会修改原镜头字段。

## 人物与台词如何对应

`<Subject N>` 标识视觉主体，`(Sx)` 标识说话人。说话人按目标视频中实际发声的先后顺序编号，并跨镜头保持；主体编号与声音编号不必相同。音色参考应显式指向对应主体和同一个说话人编号。对白放在 `<d>[Chinese] ...</d>` 中，动作与音色说明放在标签外。[依据：多参考指南的说话人规则](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt)

例如，先定义女人为主体 1、男人为主体 2，但男人先开口，则映射可以是：

| 人物 | 视觉标签 | 声音编号 | 音色素材 |
| --- | --- | --- | --- |
| 男人，首先说话 | `<Subject 2>` | `(S1)` | `<Audio 2>` |
| 女人，随后回答 | `<Subject 1>` | `(S2)` | `<Audio 1>` |

以下属于本项目的编写建议：

1. 先列映射表，再写逐镜头内容；每句对白紧跟明确的说话人。
2. 同一人跨镜头保持全部编号，不因左右位置或景别变化重新分配。
3. 明确另一人此时聆听、不动嘴，避免两人同时表演同一句台词。
4. 把屏幕配文、转述、内心独白和现场对白分开；说话人未知时保留待确认，不猜测。
5. 音色参考只提供音色时，不应顺带把参考音频原本的台词带进故事。

这些约束有助于减少歧义，不构成对白与口型必然正确的保证。

## 双人对白多参考示例

下面是为本项目自行编写的示例，不是官方案例原文。假定上传顺序为：图片 1 提供女人外观、图片 2 提供男人外观、图片 3 提供客厅；音频 1 是女人音色、音频 2 是男人音色。目标为 12 秒。实际使用时必须先核对素材顺序。

```text
subject_definitions:
<Subject 1> is the woman in <Picture 1>. Keep her long dark hair, beige coat, cream dress, and small gold earrings.
<Subject 2> is the man in <Picture 2>. Keep his swept-back dark hair, charcoal overcoat, black turtleneck, and black trousers.
<Subject 3> is the living room in <Picture 3>. Keep the grey sofa, pale wooden floor, coffee table, window placement, and daylight direction.
<Audio 2> supplies the voice timbre for <Subject 2> (S1).
<Audio 1> supplies the voice timbre for <Subject 1> (S2).

summary:
[reference generation + audio reference] <Subject 2> returns home and greets <Subject 1> in <Subject 3>. They exchange two lines, then sit together. The audio references guide their respective voices rather than supplying a copied soundtrack.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - maintain her identity, clothing, and proportions.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - maintain his identity, clothing, and proportions.
<Subject 3> (appears in [Shot 1], [Shot 2]): fully_preserved - maintain the room layout and furnishings.
<Audio 1>: reference - use the woman's timbre without copying its spoken content.
<Audio 2>: reference - use the man's timbre without copying its spoken content.

detailed_description:
Live-action with warm window light and restrained camera movement.
[Shot 1] A wide view shows <Subject 1> seated on the right end of the sofa in <Subject 3>. <Subject 2> enters from the left, stops beside the coffee table, and looks at her. The camera slowly moves forward. <Subject 2> (S1), using the low male timbre from <Audio 2>, asks: <d>[Chinese] 今天下班还顺利吗？</d> <Subject 1> listens with her lips closed. After he finishes, <Subject 1> (S2) turns toward him and answers using the warm female timbre from <Audio 1>: <d>[Chinese] 一切都刚刚好，就等你回来了。</d> <Subject 2> remains silent during her reply. He sits beside her, leaving space between them. Her hands rest on her lap; his hands settle on his knees.
[Shot 2] At 00:08.000, cut to a closer two-person view from the coffee-table side. Keep the woman's position on the right and the man's position on the left. They exchange a small smile and maintain eye contact. Neither speaks again. Hold the composition through the end of the 12-second clip.

overall_soundscape:
Quiet room ambience, two soft footsteps, and coat fabric settling against the sofa.

non_diegetic_music:
N/A
```

示例用到了官方定义的标签和字段，但场景、动作及镜头文字为本文新编。主体保留状态和音频关系标记的解释见[多参考指南](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt)。

## 首尾帧场景写法

首尾帧模式改用三段式。下列为自行编写的“开门到入座”正文示例；发送前还应按[官方基础指南的 FL2VA 部分](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt)在最前面添加首尾帧对齐说明：图片 1 对齐 0.00 秒，图片 2 对齐 8.00 秒，均属于镜头 1。该说明需与实际首尾帧绑定一致。

```text
integrated_multimodal_description:
[Shot 1] In one continuous shot, the man starts at the open doorway shown in the first image. He closes the door, walks around the coffee table, turns toward the sofa, and lowers himself into the seat. The camera remains still. His final posture, hand placement, and position beside the woman match the last image. Neither character speaks.

overall_soundscape:
A quiet door latch, footsteps, and a soft rustle of clothing.

non_diegetic_music:
N/A
```

## 用于当前故事板工作台

这一节是结合项目实现的对接建议。

当前故事板在多参考模式中把已采用的四宫格绑定为参考图 1，并合并关联角色音频。因此，上面的三张图片示例不能原样当作当前组的素材映射使用。使用四宫格时，可自行改写主体定义为：

```text
<Picture 1> is a four-panel storyboard. The panels correspond to [Shot 1], [Shot 2], [Shot 3], and [Shot 4] in reading order: top-left, top-right, bottom-left, bottom-right.
<Subject 1> is the woman wearing the beige coat across the panels of <Picture 1>.
<Subject 2> is the man wearing the charcoal overcoat across the panels of <Picture 1>.
```

再按照页面的实际音频槽位定义 `<Audio N>`。四个主体无需四张图片；同一图片可以提供多个主体。四宫格应解释为镜头规划参考，不应直接当成视频开场整幅画面。[图片与主体关系依据：多参考指南](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt)

建议操作顺序：先核对已采用素材与音频槽位，将组合提示词交给 AI 整理为适当模式的官方结构，人工核对说话人后粘贴到最终提示词，再核对实际发送内容。不要仅按角色列表顺序推断音频编号。

官方模型能力、托管工作流开放的槽位、工作台允许的输入数量是不同层次。提示词中提到一份素材，并不会自动把它上传或绑定到后端。模型资料中的时长范围也不能替代当前工作流的参数校验。[模型与模式入口：官方仓库](https://github.com/MiniMax-AI/MiniMax-H3)

## 交给 AI 整理的任务模板

以下为本项目自拟的改写指令。方括号内容由实际任务填写，素材表是文本输入的一部分，不是自动绑定命令。

```text
请依据 MiniMax 官方 H3 提示词指南整理以下材料。

模式：[Ref2VA 或 FL2VA 等]
目标时长：[秒]
画面比例：[比例]
实际素材映射：[逐项列出图片与音频编号、用途、对应角色]
组合提示词：[粘贴全文]

要求：
保留所选模式的官方英文字段、标签和字段顺序。
用英文写视觉、动作和声音描述；对白和可见文字保留提供的原文。
先确定视觉主体、实际说话人和音色素材的映射，不能把三类编号直接等同。
每句对白明确对应角色，跨镜头保持身份与音色。
转述、配文和动作标记不得自动转成现场对白。
只使用素材表中的输入，不虚构额外素材。
保持故事与台词内容；原文说话人不清时，先列出待确认项，不猜测。
检查时间线与目标时长一致。
材料足够时输出可发送的完整提示词；存在歧义时先输出待确认项。
```

## 使用前核对

- 每个引用编号都能对应已上传的实际素材。
- 每个说话人都有稳定的视觉身份和声音身份。
- 切镜时间递增且小于总时长；最后的动作有时间完成。
- 现场对白、画外音与屏幕文字没有混用。
- 仅参考音色时，没有误复制参考音频的原台词。
- 最终提示词与页面实际参考槽位、生成时长相符。

本次完成的是官方资料核对与文档编写，没有运行视频生成。示例是写作模板，不是经过付费试片验证的成功案例。
