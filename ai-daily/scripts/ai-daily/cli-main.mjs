// 宿主 Node CLI 入口判定（不 inline 进 workflow 产物）。
// argv[1] 可能是相对路径；path.resolve + pathToFileURL 才能和 import.meta.url 对齐。
// 裸 `file://` + argv[1] 在相对路径下永远对不上 → 脚本被当模块 import 时静默 no-op。
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const isCliMain = (metaUrl, argv1) => !!argv1 && metaUrl === pathToFileURL(path.resolve(argv1)).href
