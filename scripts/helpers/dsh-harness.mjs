/**
 * 真机验证的公共部件 —— `verify-real-repair.mjs` 与 `verify-tarball-install.mjs` 共用。
 *
 * 这里只有一件事最容易出人命，所以单独抽出来并写清楚：
 * **子进程环境必须删掉继承来的 `DSH_PROFILE_DIR` / `DSH_PROFILE`。**
 * 本会话的父 shell 里就带着这两个变量，它们指向使用者**真实的** profile ——
 * 留着不改，验证脚本就会跑到真环境上去改东西。只设 `DSH_HOME` 指向临时目录还不够，
 * 那两个变量的优先级更高。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'

/**
 * 子进程环境：DSH_HOME 换成临时家目录，并**删掉**继承来的 DSH_PROFILE_DIR / DSH_PROFILE。
 * @param {string} home 临时 DSH_HOME
 */
export function childEnv(home) {
  const env = { ...process.env, DSH_HOME: home }
  delete env.DSH_PROFILE_DIR
  delete env.DSH_PROFILE
  return env
}

export function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}

export function linkDir(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  if (fs.existsSync(at)) return
  fs.symlinkSync(target, at, 'junction')
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 要一个空闲端口（绑定 0 让系统给，然后立刻释放）。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * 启动一个真 dsh web 服务，等它真的开始应答本插件的接口。
 *
 * 为什么不等端口：端口 listen 成功不代表插件已经被组合进去。
 * 只有 `/status` 返回 200，才能确定「宿主插件 + 页面接口」这条链路是通的。
 *
 * @param {{home:string,dshBin:string,port:number,label:string,apiPrefix:string,timeoutMs?:number}} options
 */
export async function startWeb({ home, dshBin, port, label, apiPrefix, timeoutMs = 90_000 }) {
  const child = spawn(process.execPath, [
    dshBin, 'web', '--port', String(port), '--no-open',
  ], { env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  let lastError = '尚未尝试'
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { child, output: () => output, base, ready: false, error: `${label}：dsh 进程提前退出（code ${child.exitCode}）` }
    }
    try {
      const response = await fetch(`${base}${apiPrefix}/status`, { headers: { accept: 'application/json' } })
      if (response.status === 200) return { child, output: () => output, base, ready: true }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return { child, output: () => output, base, ready: false, error: `${label}：等待就绪超时（最后错误：${lastError}）` }
}

export function stopWeb(handle) {
  if (!handle?.child) return
  try { handle.child.kill() } catch { /* 已经退了 */ }
}

/**
 * 按浏览器的方式过首页那道鉴权围栏，拿到 cookie。
 *
 * dsh 的首页要一个签名 cookie：先访问它打印出来的带凭证 URL（会 303 + Set-Cookie），
 * 再把 cookie 带上请求首页。`port` 用来从一堆打印出来的 URL 里认出本次这个实例。
 */
export async function handshake({ base, port, output }) {
  const printed = String(output ?? '').match(/https?:\/\/[^\s"']+/g) ?? []
  const appUrl = printed.find((one) => one.includes(String(port))) ?? `${base}/`
  const response = await fetch(appUrl, { redirect: 'manual' })
  const cookie = (response.headers.getSetCookie?.() ?? []).map((one) => one.split(';')[0]).join('; ')
  return { appUrl, cookie, status: response.status }
}

/** 用 dsh 自带的 web 模板建一个 profile 骨架（要 webServer 与 pluginManager 都在）。 */
export function prepareWebProfile({ home, dshBin, profileName = 'web' }) {
  const profileDir = path.join(home, 'profiles', profileName)
  try {
    execFileSync(process.execPath, [
      dshBin, '--profile', profileName, '--from-default-profile', 'web', '--dump-config',
    ], { env: childEnv(home), stdio: 'ignore', timeout: 180_000 })
  } catch {
    // --dump-config 的退出码不稳定，只要骨架落盘就算成功
  }
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    write(path.join(profileDir, 'package.json'), {
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    })
    write(path.join(profileDir, 'cordis.yml'), '[]\n')
    write(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
  }
  return profileDir
}
