#!/usr/bin/env node
// Fetches the Node.js runtime binary used to run the extension-host sidecar,
// and places it at src-tauri/binaries/node-<target-triple>[.exe] — the name
// Tauri's sidecar resolution expects for the "node" externalBin entry.
//
// T18 only exercises the current host triple (this machine). T24 extends
// this to fetch every triple in the CI build matrix.
import { execFileSync, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE_VERSION = 'v24.19.0'

const TARGET_MAP = {
  'x86_64-unknown-linux-gnu': { dist: 'linux-x64', archive: 'tar.gz', binary: 'node' },
  'aarch64-unknown-linux-gnu': { dist: 'linux-arm64', archive: 'tar.gz', binary: 'node' },
  'x86_64-apple-darwin': { dist: 'darwin-x64', archive: 'tar.gz', binary: 'node' },
  'aarch64-apple-darwin': { dist: 'darwin-arm64', archive: 'tar.gz', binary: 'node' },
  'x86_64-pc-windows-msvc': { dist: 'win-x64', archive: 'zip', binary: 'node.exe' },
  'aarch64-pc-windows-msvc': { dist: 'win-arm64', archive: 'zip', binary: 'node.exe' },
}

function currentHostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf-8' })
  const match = out.match(/^host:\s*(\S+)$/m)
  if (!match) throw new Error('could not determine host triple from `rustc -vV`')
  return match[1]
}

async function fetchNodeBinary(targetTriple) {
  const mapping = TARGET_MAP[targetTriple]
  if (!mapping) throw new Error(`no Node dist mapping for target triple: ${targetTriple}`)

  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const binariesDir = join(repoRoot, 'src-tauri', 'binaries')
  const destName = `node-${targetTriple}${mapping.binary.endsWith('.exe') ? '.exe' : ''}`
  const destPath = join(binariesDir, destName)

  if (existsSync(destPath)) {
    console.log(`[fetch-node-sidecar] ${destName} already present, skipping`)
    return destPath
  }

  mkdirSync(binariesDir, { recursive: true })

  const archiveName = `node-${NODE_VERSION}-${mapping.dist}.${mapping.archive}`
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}`
  const workDir = join(tmpdir(), `openray-node-fetch-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  const archivePath = join(workDir, archiveName)

  console.log(`[fetch-node-sidecar] downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`)
  await pipeline(response.body, createWriteStream(archivePath))

  console.log(`[fetch-node-sidecar] extracting ${archiveName}`)
  const extractDir = join(workDir, 'extracted')
  mkdirSync(extractDir, { recursive: true })
  if (mapping.archive === 'zip') {
    // GNU tar (the default on Linux, e.g. when cross-fetching a Windows
    // binary from a Linux CI runner or dev machine) can't extract zip
    // archives at all ("does not look like a tar archive"). bsdtar (macOS,
    // and Windows' own bundled tar.exe since Win10 1803+) handles zip fine,
    // but `unzip` is the one tool guaranteed to handle it everywhere it's
    // installed — prefer it when present and fall back to tar otherwise.
    const hasUnzip = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0
    if (hasUnzip) {
      execFileSync('unzip', ['-q', archivePath, '-d', extractDir], { stdio: 'inherit' })
    } else {
      execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' })
    }
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' })
  }

  const extractedRoot = join(extractDir, `node-${NODE_VERSION}-${mapping.dist}`)
  const binarySrc = join(extractedRoot, mapping.archive === 'zip' ? mapping.binary : join('bin', mapping.binary))

  execFileSync('cp', [binarySrc, destPath])
  if (mapping.archive !== 'zip') chmodSync(destPath, 0o755)

  rmSync(workDir, { recursive: true, force: true })
  console.log(`[fetch-node-sidecar] wrote ${destPath}`)
  return destPath
}

const requestedTriple = process.argv[2] ?? currentHostTriple()
await fetchNodeBinary(requestedTriple)
