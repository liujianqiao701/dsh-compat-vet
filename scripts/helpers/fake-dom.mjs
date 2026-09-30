/**
 * 最小假 DOM + 客户端加载器 —— **测试**和**横幅预览工具**共用同一份。
 *
 * 为什么要伪造浏览器环境，而不是用真的浏览器：
 * `lib/client.js` 决定用户在页面上看见什么、按键会触发什么，而它平时只跑在浏览器里。
 * 把环境伪造到足够真 —— 让**真正的 client.js** 自己跑一遍 —— 就能在 CI 里断言
 * 「横幅里必须同时有插件版本号和 dsh 版本号」「输入框里打字时不能抢按键」这些硬要求。
 *
 * 两个坑（都真的踩过，见 README §2.6）：
 *   1. `document` / `window` 必须在**调用时**可解析 —— 客户端不是在 import 时抓它们
 *      （`resolveAtCallTime()` 那步干了这件事）。所以这里**不还原**全局，
 *      每个用例自己新建一份 dom 覆盖即可。
 *   2. `FakeElement.textContent` 必须**可写** —— 客户端会给 `<style>` 赋 textContent，
 *      只有 getter 的话严格模式下会抛，而那个错会被客户端自己的 `.catch` 吞掉，
 *      表现成"横幅莫名其妙不出来"，极难查。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CLIENT_FILE = path.join(here, '..', '..', 'lib', 'client.js')

export class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = {}
    this.style = {}
    this.html = ''
    this.parentNode = null
    this.id = ''
    this.className = ''
    this.isContentEditable = false
  }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name) }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }
  get innerHTML() { return this.html }
  set innerHTML(value) { this.html = String(value) }
  get textContent() { return this._text !== undefined ? this._text : this.html.replace(/<[^>]*>/g, '') }
  set textContent(value) { this._text = String(value) }
  addEventListener() {}
  removeEventListener() {}
}

export function makeDom() {
  const byId = new Map()
  const listeners = new Map()
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    activeElement: null,
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    createElement(tag) { return new FakeElement(tag) },
    getElementById(id) { return byId.get(id) ?? null },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    fire(type, event) { for (const fn of listeners.get(type) ?? []) fn(event) },
    listenerCount(type) { return (listeners.get(type) ?? []).length },
    _byId: byId,
  }
  // appendChild 到 body 时按 id 登记，让 getElementById 找得到
  const origAppend = document.body.appendChild.bind(document.body)
  document.body.appendChild = (child) => {
    const result = origAppend(child)
    if (child.id) byId.set(child.id, child)
    return result
  }
  const origRemove = document.body.removeChild.bind(document.body)
  document.body.removeChild = (child) => {
    const result = origRemove(child)
    if (child.id) byId.delete(child.id)
    return result
  }

  const storage = new Map()
  const timers = []
  const window = {
    fetch: undefined,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearInterval: () => {},
    setTimeout: (fn) => { timers.push({ fn }); return timers.length },
    clearTimeout: () => {},
  }
  return { document, window, timers, listeners }
}

/** 装出浏览器环境，加载真模块，返回它的 exports。 */
export async function loadClient({ dom, fetchImpl }) {
  const registrations = []
  const window = dom.window
  window.__ModuleLoader__ = { load: (registration) => registrations.push(registration) }
  window.fetch = fetchImpl

  globalThis.window = window
  globalThis.document = dom.document
  // 每次换一个 query 让 ESM 重新求值，避免模块缓存串味
  await import(`${pathToFileURL(CLIENT_FILE).href}?t=${Date.now()}${Math.random()}`)
  assert.equal(registrations.length, 1, '客户端必须恰好注册一次')
  assert.equal(registrations[0].id, 'dsh-compat-vet', 'id 必须是包名')
  return registrations[0].factory(() => { throw new Error('本插件不请求任何外部模块') })
}

/** 假的键盘事件对象：支持 preventDefault/stopPropagation 的可观测性。 */
export function keyEvent(key, { alt = false, editing = false } = {}) {
  return {
    key,
    altKey: alt,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    prevented: false,
    stopped: false,
    target: null,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true },
  }
}

export const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * 造一个"被点到的按钮"。
 *
 * 客户端的点击处理是 `event.target.closest('#横幅 [data-dpd-…]')` ——
 * 它靠**属性白名单**认按钮，所以这里只要把属性挂上、并让 `closest()` 返回自己，
 * 就等于"点了那个按钮"。反过来也说明：新加的按钮属性**必须**同时加进那个选择器，
 * 否则按钮渲染出来了却点不动（这个坑真踩过）。
 */
export function clickTarget(attr, value = '1') {
  const attrs = { [attr]: String(value) }
  const el = {
    hasAttribute: (name) => Object.hasOwn(attrs, name),
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
  }
  el.closest = () => el
  return el
}
