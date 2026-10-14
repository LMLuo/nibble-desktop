'use strict'
// pack-linux-tgz.js —— 把 dist/linux-unpacked 打成 dist/<name>-<version>.tar.gz
//
// 为什么不用 electron-builder 自带的 tar.gz target：
//   在 Windows 上打包时，NTFS 没有 POSIX 权限位，tar 会把所有成员记成 0644，
//   用户在 Linux 解压后执行 ./nibble 会直接 Permission denied。
//   GNU tar 的 --mode 能在「创建时」强制写入权限位，从而绕开 NTFS 的限制。
//   （在 Linux / CI 上同样用 GNU tar，行为一致；也不影响 AppImage，那是另一个 target）
//
// 用法：electron-builder --linux dir [--arm64] && node scripts/pack-linux-tgz.js [x64|arm64]

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const { name, version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const DIST = path.join(ROOT, 'dist')

// 目标架构（默认 x64）。tar.gz 制品名带上架构后缀，避免两个包同名混淆。
const ARCH = process.argv[2] || 'x64'
const ARCH_TAG = { x64: 'x86_64', arm64: 'aarch64' }[ARCH] || ARCH
const SRC_DIR = ARCH === 'x64' ? 'linux-unpacked' : `linux-${ARCH}-unpacked` // electron-builder --linux dir 的产物目录
const ROOT_NAME = `${name}-${version}-${ARCH_TAG}` // 解压后得到的顶层目录名
const OUT_NAME = `${ROOT_NAME}.tar.gz`

// Windows 上只有 Git for Windows 自带 GNU tar（System32 的 tar 是 bsdtar，没有 --mode）
const GIT_TAR_CANDIDATES = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'tar.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'usr', 'bin', 'tar.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'tar.exe'),
]

function resolveTar() {
  if (process.platform !== 'win32') return { tar: 'tar', binDir: null }
  const hit = GIT_TAR_CANDIDATES.find((p) => p && fs.existsSync(p))
  if (!hit) {
    throw new Error(
      '找不到 GNU tar。Windows 上请安装 Git for Windows（提供 --mode 所需的 GNU tar），' +
      '或改用 electron-builder --linux tar.gz（代价：成员权限位会丢失，用户需自行 chmod +x）。',
    )
  }
  return { tar: hit, binDir: path.dirname(hit) } // 同目录的 gzip 也要能被 tar 找到
}

function main() {
  if (!fs.existsSync(path.join(DIST, SRC_DIR))) {
    throw new Error(
      `没有找到 ${SRC_DIR}，请先执行：electron-builder --linux dir${ARCH === 'x64' ? '' : ' --' + ARCH}`,
    )
  }
  const { tar, binDir } = resolveTar()
  const env = binDir ? { ...process.env, PATH: binDir + ';' + process.env.PATH } : process.env

  // 关键：cwd 设为 dist、参数全用相对路径 —— 工程目录名里带中文，
  // 传给 MSYS2 程序做命令行参数容易被编码转换搞坏，交给进程工作目录最稳妥。
  // --mode=0755：Windows 读不到 POSIX 权限位，这里统一写死（数据文件多一个 x 位无副作用）
  execFileSync(
    tar,
    [
      '-czf', OUT_NAME,
      '--mode=0755',
      '--owner=0', '--group=0', '--numeric-owner',
      '--transform', `s,^${SRC_DIR},${ROOT_NAME},`,
      SRC_DIR,
    ],
    { cwd: DIST, env, stdio: 'inherit' },
  )

  const out = path.join(DIST, OUT_NAME)
  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1)
  console.log(`\n✔ ${OUT_NAME}  ${mb} MB\n  解压后顶层目录：${ROOT_NAME}/  入口：./nibble`)
}

main()
