import { useEffect, useRef } from 'react'

/**
 * 弹窗 Esc 的「层栈」（0.7.6 T-ESC）。
 *
 * 为什么需要栈，而不是每个弹窗各挂一个 keydown：
 * - 捕获阶段先于冒泡阶段，`window` 又处在传播路径最前端 —— 谁先注册谁先拿到按键。
 *   两个弹窗同时在场时（导入重复处置压在设置之上）靠注册顺序决定谁吃 Esc 是错的；
 *   Esc 必须归**最后打开的那一层**（栈顶），否则会「关掉底下那个、上面那个还在」。
 * - 分类选择器的一级/二级浮层是**弹窗内部的第二层**：浮层展开时 Esc 只应收起浮层、
 *   不关整个弹窗。它在 `Modal` 之后压栈，天然排在栈顶，正好表达这个语义。
 *
 * 约定：只有栈顶那一层可以 `stopPropagation()` 并消费按键。非栈顶的监听**必须原样放行**
 * （既不 stop 也不 close），否则下面的层永远收不到 Esc。
 *
 * 这个模块只维护「谁在上面」，不关心具体行为；行为由各层自己的 handler 决定
 * （`Modal` = onClose，导入重复处置 = 吃掉但不关，分类浮层 = 收起浮层）。
 */
const layers: number[] = []
let seq = 0

/** 压入一层，返回本层 token（卸载时用它出栈，不依赖压/弹顺序） */
export function pushEscLayer(): number {
  seq += 1
  layers.push(seq)
  return seq
}

/** 弹出指定层（token 已不在栈里时静默忽略：StrictMode 双挂载下清理可能重复跑） */
export function popEscLayer(token: number): void {
  const index = layers.indexOf(token)
  if (index >= 0) layers.splice(index, 1)
}

/** 本层是否是栈顶（只有栈顶能消费 Esc） */
export function isTopEscLayer(token: number): boolean {
  return layers[layers.length - 1] === token
}

/** 当前是否有任何一层在吃 Esc（App 的全局 Esc 据此让路，双保险见 `escPriority.ts`） */
export function hasEscLayer(): boolean {
  return layers.length > 0
}

/** 仅供测试：清空栈（避免用例之间互相污染） */
export function resetEscLayers(): void {
  layers.length = 0
}

/**
 * 事件目标是否声明了「Esc 归我」（`data-esc-own`）。
 *
 * 为什么需要：Esc 监听挂在 `window` **捕获**阶段，早于任何输入框自己的 `onKeyDown`
 * （React 的合成事件在冒泡阶段才跑）。设置 · 别名表格里的输入框要把 Esc 解释成
 * 「回滚这条草稿」而不是「关掉整个弹窗」——用属性把它标出来，消费方见到就让路
 * （不 stop、不关），按键继续传给控件自己的处理函数。
 *
 * 两个消费方**都必须**调它：`Modal`（含 `Modal` 外壳的弹窗）与 `useEscLayer`
 * （自绘 `dialog-scrim` 的弹窗）。少一处就会出现 0.7.6 真机那条缺陷：
 * 设置页是自绘外壳，只有 `Modal` 认这个标记 → 输入框回滚了、弹窗同时被 App 关掉。
 */
export function escOwnedByControl(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest('[data-esc-own]') !== null
}

/**
 * 给「不是 `Modal` 的第二层」用的 Esc 监听（分类浮层 / 自绘弹窗）。
 *
 * 监听挂在 `window` 捕获阶段，与 `Modal` 同阶段；只有自己是栈顶时才 stop + 回调。
 * handler 存 ref（依赖只写 `active`）：否则调用方每次 render 传内联箭头都会重挂监听，
 * 频繁 pop/push 会让本层在栈里的位置漂移。
 */
export function useEscLayer(handler: () => void, active: boolean): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!active) return
    const token = pushEscLayer()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (!isTopEscLayer(token)) return
      // 输入框声明了「Esc 归我」→ 不吃、不关，让控件自己回滚草稿。
      // 这里**不能** stopPropagation：按键要继续传给控件的 React onKeyDown；
      // 之后即使再冒泡到 App 的全局 Esc，也会因 `hasEscLayer()` 为真而不动作。
      if (escOwnedByControl(e.target)) return
      // 吃掉这次按键：否则 App 的全局 Esc（冒泡阶段）会顺手清掉选中 / 关掉下层视图
      e.stopPropagation()
      handlerRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      popEscLayer(token)
    }
  }, [active])
}
